import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { $ } from "bun"
import type { BunFile } from "bun"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import fs from "fs"
import ignore from "ignore"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Ripgrep } from "./ripgrep"
import fuzzysort from "fuzzysort"
import { Global } from "../global"
import { Snapshot } from "../snapshot"

export namespace File {
  const log = Log.create({ service: "file" })

  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
    })
    .meta({
      ref: "File",
    })

  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
    })
    .meta({
      ref: "FileNode",
    })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.literal("text"),
      content: z.string(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
    })
    .meta({
      ref: "FileContent",
    })
  export type Content = z.infer<typeof Content>

  async function shouldEncode(file: BunFile): Promise<boolean> {
    const type = file.type?.toLowerCase()
    log.info("shouldEncode", { type })
    if (!type) return false

    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false

    const parts = type.split("/", 2)
    const top = parts[0]
    const rest = parts[1] ?? ""
    const sub = rest.split(";", 1)[0]

    const tops = ["image", "audio", "video", "font", "model", "multipart"]
    if (tops.includes(top)) return true

    const bins = [
      "zip",
      "gzip",
      "bzip",
      "compressed",
      "binary",
      "pdf",
      "msword",
      "powerpoint",
      "excel",
      "ogg",
      "exe",
      "dmg",
      "iso",
      "rar",
    ]
    if (bins.some((mark) => sub.includes(mark))) return true

    return false
  }

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
  }

  const state = Instance.state(async () => {
    type Entry = { files: string[]; dirs: string[] }
    let cache: Entry = { files: [], dirs: [] }
    let fetching = false

    const isGlobalHome = Instance.directory === Global.Path.home && Instance.project.id === "global"

    const fn = async (result: Entry) => {
      // Disable scanning if in root of file system
      if (Instance.directory === path.parse(Instance.directory).root) return
      fetching = true

      if (isGlobalHome) {
        const dirs = new Set<string>()
        const ignore = new Set<string>()

        if (process.platform === "darwin") ignore.add("Library")
        if (process.platform === "win32") ignore.add("AppData")

        const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
        const shouldIgnore = (name: string) => name.startsWith(".") || ignore.has(name)
        const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)

        const top = await fs.promises
          .readdir(Instance.directory, { withFileTypes: true })
          .catch(() => [] as fs.Dirent[])

        for (const entry of top) {
          if (!entry.isDirectory()) continue
          if (shouldIgnore(entry.name)) continue
          dirs.add(entry.name + "/")

          const base = path.join(Instance.directory, entry.name)
          const children = await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
          for (const child of children) {
            if (!child.isDirectory()) continue
            if (shouldIgnoreNested(child.name)) continue
            dirs.add(entry.name + "/" + child.name + "/")
          }
        }

        result.dirs = Array.from(dirs).toSorted()
        cache = result
        fetching = false
        return
      }

      const set = new Set<string>()
      for await (const file of Ripgrep.files({ cwd: Instance.directory })) {
        result.files.push(file)
        let current = file
        while (true) {
          const dir = path.dirname(current)
          if (dir === ".") break
          if (dir === current) break
          current = dir
          if (set.has(dir)) continue
          set.add(dir)
          result.dirs.push(dir + "/")
        }
      }
      cache = result
      fetching = false
    }
    fn(cache)

    return {
      async files() {
        if (!fetching) {
          fn({
            files: [],
            dirs: [],
          })
        }
        return cache
      },
    }
  })

  export function init() {
    state()
  }

  export async function status() {
    const project = Instance.project
    if (project.vcs !== "git") return []

    const diffOutput = await $`git diff --numstat HEAD`.cwd(Instance.directory).quiet().nothrow().text()

    const changedFiles: Info[] = []

    if (diffOutput.trim()) {
      const lines = diffOutput.trim().split("\n")
      for (const line of lines) {
        const [added, removed, filepath] = line.split("\t")
        changedFiles.push({
          path: filepath,
          added: added === "-" ? 0 : parseInt(added, 10),
          removed: removed === "-" ? 0 : parseInt(removed, 10),
          status: "modified",
        })
      }
    }

    const untrackedOutput = await $`git ls-files --others --exclude-standard`
      .cwd(Instance.directory)
      .quiet()
      .nothrow()
      .text()

    if (untrackedOutput.trim()) {
      const untrackedFiles = untrackedOutput.trim().split("\n")
      for (const filepath of untrackedFiles) {
        try {
          const content = await Bun.file(path.join(Instance.directory, filepath)).text()
          const lines = content.split("\n").length
          changedFiles.push({
            path: filepath,
            added: lines,
            removed: 0,
            status: "added",
          })
        } catch {
          continue
        }
      }
    }

    // Get deleted files
    const deletedOutput = await $`git diff --name-only --diff-filter=D HEAD`
      .cwd(Instance.directory)
      .quiet()
      .nothrow()
      .text()

    if (deletedOutput.trim()) {
      const deletedFiles = deletedOutput.trim().split("\n")
      for (const filepath of deletedFiles) {
        changedFiles.push({
          path: filepath,
          added: 0,
          removed: 0, // Could get original line count but would require another git command
          status: "deleted",
        })
      }
    }

    return changedFiles.map((x) => ({
      ...x,
      path: path.relative(Instance.directory, x.path),
    }))
  }

  type VcsType = "git" | "jj" | null

  // Detect which VCS is available in the directory
  async function detectVcs(directory: string): Promise<{ type: VcsType; root: string }> {
    // Check for jj first (it can coexist with git but takes priority when present)
    const jjRoot = (await $`jj root`.cwd(directory).quiet().nothrow().text()).trim()
    if (jjRoot) return { type: "jj", root: jjRoot }

    // Fall back to git
    const gitRoot = (await $`git rev-parse --show-toplevel`.cwd(directory).quiet().nothrow().text()).trim()
    if (gitRoot) return { type: "git", root: gitRoot }

    return { type: null, root: "" }
  }

  // Quick file list for instant UI - returns files with empty lines (lazy loading)
  export async function diff(): Promise<Snapshot.FileDiff[]> {
    const directory = Instance.directory
    const vcs = await detectVcs(directory)
    if (!vcs.type) return []

    if (vcs.type === "jj") return diffJj(vcs.root)
    return diffGit(vcs.root)
  }

  async function diffGit(root: string): Promise<Snapshot.FileDiff[]> {
    const result: Snapshot.FileDiff[] = []

    // Get all uncommitted changes (working directory vs HEAD)
    const diffOutput = await $`git diff --numstat HEAD`.cwd(root).quiet().nothrow().text()

    const allLines = diffOutput.trim().split("\n").filter(Boolean)
    const seen = new Set<string>()

    for (const line of allLines) {
      const [additions, deletions, filepath] = line.split("\t")
      if (!filepath || seen.has(filepath)) continue
      seen.add(filepath)

      const isBinary = additions === "-" && deletions === "-"
      if (isBinary) continue

      result.push({
        file: filepath,
        additions: parseInt(additions) || 0,
        deletions: parseInt(deletions) || 0,
        firstChangedLine: 0,
        lines: [],
      })
    }

    // Get untracked files
    const untrackedOutput = await $`git ls-files --others --exclude-standard`.cwd(root).quiet().nothrow().text()

    if (untrackedOutput.trim()) {
      for (const filepath of untrackedOutput.trim().split("\n")) {
        if (seen.has(filepath)) continue
        result.push({
          file: filepath,
          additions: 0,
          deletions: 0,
          firstChangedLine: 0,
          lines: [],
        })
      }
    }

    return result
  }

  async function diffJj(root: string): Promise<Snapshot.FileDiff[]> {
    const result: Snapshot.FileDiff[] = []

    // jj diff --stat shows unstaged changes in working copy
    // Format: "file.ts | 10 ++++---" or "file.ts | 3 +++"
    const diffOutput = await $`jj diff --stat`.cwd(root).quiet().nothrow().text()

    const lines = diffOutput.trim().split("\n").filter(Boolean)
    // Last line is summary like "2 files changed, 10 insertions(+), 5 deletions(-)"
    const fileLines = lines.slice(0, -1)

    for (const line of fileLines) {
      // Parse: "path/to/file.ts | 10 ++++---"
      const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)/)
      if (!match) continue

      const filepath = match[1].trim()
      const plusses = (match[3].match(/\+/g) || []).length
      const minuses = (match[3].match(/-/g) || []).length
      const total = parseInt(match[2]) || 0

      // Approximate additions/deletions from the +/- symbols ratio
      const ratio = plusses + minuses > 0 ? plusses / (plusses + minuses) : 0.5
      const additions = Math.round(total * ratio)
      const deletions = total - additions

      result.push({
        file: filepath,
        additions,
        deletions,
        firstChangedLine: 0,
        lines: [],
      })
    }

    return result
  }

  // Compute diff lines for a single file (called on demand when file is selected)
  export async function diffFile(filepath: string): Promise<Snapshot.FileDiff | null> {
    const directory = Instance.directory
    const vcs = await detectVcs(directory)
    if (!vcs.type) return null

    if (vcs.type === "jj") return diffFileJj(vcs.root, filepath)
    return diffFileGit(vcs.root, filepath)
  }

  async function diffFileGit(root: string, filepath: string): Promise<Snapshot.FileDiff | null> {
    // Check if file is tracked
    const isTracked =
      (await $`git ls-files ${filepath}`.cwd(root).quiet().nothrow().text()).trim() !== "" ||
      (await $`git diff --name-only HEAD -- ${filepath}`.cwd(root).quiet().nothrow().text()).trim() !== ""

    // Get stats from git diff --numstat HEAD for consistency with file list
    const numstatOutput = await $`git diff --numstat HEAD -- ${filepath}`.cwd(root).quiet().nothrow().text()
    let additions = 0
    let deletions = 0
    if (numstatOutput.trim()) {
      const [add, del] = numstatOutput.trim().split("\t")
      additions = add === "-" ? 0 : parseInt(add) || 0
      deletions = del === "-" ? 0 : parseInt(del) || 0
    }

    const before = isTracked ? await $`git show HEAD:${filepath}`.cwd(root).quiet().nothrow().text() : ""
    const after = await Bun.file(path.join(root, filepath))
      .text()
      .catch(() => "")

    const { lines, firstChangedLine } = Snapshot.computeDiffLines(before, after)

    // For untracked files, count from lines since numstat won't have data
    if (!numstatOutput.trim() && lines.length > 0) {
      for (const line of lines) {
        if (line.type === "added") additions++
        if (line.type === "removed") deletions++
      }
    }

    return {
      file: filepath,
      additions,
      deletions,
      firstChangedLine,
      lines,
      before,
      after,
    }
  }

  async function diffFileJj(root: string, filepath: string): Promise<Snapshot.FileDiff | null> {
    // Get stats from jj diff --stat for consistency with file list
    const statOutput = await $`jj diff --stat ${filepath}`.cwd(root).quiet().nothrow().text()
    let additions = 0
    let deletions = 0

    // Parse jj diff --stat output: "file.ts | 10 ++++---"
    const statLines = statOutput.trim().split("\n").filter(Boolean)
    if (statLines.length > 0) {
      const match = statLines[0].match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)/)
      if (match) {
        const plusses = (match[3].match(/\+/g) || []).length
        const minuses = (match[3].match(/-/g) || []).length
        const total = parseInt(match[2]) || 0
        const ratio = plusses + minuses > 0 ? plusses / (plusses + minuses) : 0.5
        additions = Math.round(total * ratio)
        deletions = total - additions
      }
    }

    // Get the file content from parent revision (before changes)
    // jj file show shows file content at a specific revision, @- is parent of working copy
    const before = await $`jj file show ${filepath} -r @-`.cwd(root).quiet().nothrow().text()

    const after = await Bun.file(path.join(root, filepath))
      .text()
      .catch(() => "")

    const { lines, firstChangedLine } = Snapshot.computeDiffLines(before, after)

    // If no stat data, count from lines
    if (!statOutput.trim() && lines.length > 0) {
      for (const line of lines) {
        if (line.type === "added") additions++
        if (line.type === "removed") deletions++
      }
    }

    return {
      file: filepath,
      additions,
      deletions,
      firstChangedLine,
      lines,
      before,
      after,
    }
  }

  export async function read(file: string): Promise<Content> {
    using _ = log.time("read", { file })
    const project = Instance.project
    const full = path.join(Instance.directory, file)

    // TODO: Filesystem.contains is lexical only - symlinks inside the project can escape.
    // TODO: On Windows, cross-drive paths bypass this check. Consider realpath canonicalization.
    if (!Instance.containsPath(full)) {
      throw new Error(`Access denied: path escapes project directory`)
    }

    const bunFile = Bun.file(full)

    if (!(await bunFile.exists())) {
      return { type: "text", content: "" }
    }

    const encode = await shouldEncode(bunFile)

    if (encode) {
      const buffer = await bunFile.arrayBuffer().catch(() => new ArrayBuffer(0))
      const content = Buffer.from(buffer).toString("base64")
      const mimeType = bunFile.type || "application/octet-stream"
      return { type: "text", content, mimeType, encoding: "base64" }
    }

    const content = await bunFile
      .text()
      .catch(() => "")
      .then((x) => x.trim())

    if (project.vcs === "git") {
      let diff = await $`git diff ${file}`.cwd(Instance.directory).quiet().nothrow().text()
      if (!diff.trim()) diff = await $`git diff --staged ${file}`.cwd(Instance.directory).quiet().nothrow().text()
      if (diff.trim()) {
        const original = await $`git show HEAD:${file}`.cwd(Instance.directory).quiet().nothrow().text()
        const patch = structuredPatch(file, file, original, content, "old", "new", {
          context: Infinity,
          ignoreWhitespace: true,
        })
        const diff = formatPatch(patch)
        return { type: "text", content, patch, diff }
      }
    }
    return { type: "text", content }
  }

  export async function list(dir?: string) {
    const exclude = [".git", ".DS_Store"]
    const project = Instance.project
    let ignored = (_: string) => false
    if (project.vcs === "git") {
      const ig = ignore()
      const gitignore = Bun.file(path.join(Instance.worktree, ".gitignore"))
      if (await gitignore.exists()) {
        ig.add(await gitignore.text())
      }
      const ignoreFile = Bun.file(path.join(Instance.worktree, ".ignore"))
      if (await ignoreFile.exists()) {
        ig.add(await ignoreFile.text())
      }
      ignored = ig.ignores.bind(ig)
    }
    const resolved = dir ? path.join(Instance.directory, dir) : Instance.directory

    // TODO: Filesystem.contains is lexical only - symlinks inside the project can escape.
    // TODO: On Windows, cross-drive paths bypass this check. Consider realpath canonicalization.
    if (!Instance.containsPath(resolved)) {
      throw new Error(`Access denied: path escapes project directory`)
    }

    const nodes: Node[] = []
    for (const entry of await fs.promises
      .readdir(resolved, {
        withFileTypes: true,
      })
      .catch(() => [])) {
      if (exclude.includes(entry.name)) continue
      const fullPath = path.join(resolved, entry.name)
      const relativePath = path.relative(Instance.directory, fullPath)
      const type = entry.isDirectory() ? "directory" : "file"
      nodes.push({
        name: entry.name,
        path: relativePath,
        absolute: fullPath,
        type,
        ignored: ignored(type === "directory" ? relativePath + "/" : relativePath),
      })
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    const query = input.query.trim()
    const limit = input.limit ?? 100
    const kind = input.type ?? (input.dirs === false ? "file" : "all")
    log.info("search", { query, kind })

    const result = await state().then((x) => x.files())

    const hidden = (item: string) => {
      const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
      return normalized.split("/").some((p) => p.startsWith(".") && p.length > 1)
    }
    const preferHidden = query.startsWith(".") || query.includes("/.")
    const sortHiddenLast = (items: string[]) => {
      if (preferHidden) return items
      const visible: string[] = []
      const hiddenItems: string[] = []
      for (const item of items) {
        const isHidden = hidden(item)
        if (isHidden) hiddenItems.push(item)
        if (!isHidden) visible.push(item)
      }
      return [...visible, ...hiddenItems]
    }
    if (!query) {
      if (kind === "file") return result.files.slice(0, limit)
      return sortHiddenLast(result.dirs.toSorted()).slice(0, limit)
    }

    const items =
      kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]

    const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
    const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((r) => r.target)
    const output = kind === "directory" ? sortHiddenLast(sorted).slice(0, limit) : sorted

    log.info("search", { query, kind, results: output.length })
    return output
  }
}
