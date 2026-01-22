import { createMemo, createSignal, createEffect, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { addDefaultParsers } from "@opentui/core"
import "opentui-spinner/solid"
import { SplitBorder } from "@tui/component/border"
import { Identifier } from "@/id/id"
import type { Snapshot } from "@/snapshot"
import { useTheme } from "../../context/theme"
import { useRoute, useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useLocal } from "../../context/local"
import { useKeybind } from "../../context/keybind"
import { useKV } from "../../context/kv"
import { useDialog } from "../../ui/dialog"
import { createFrames, createColors } from "../../ui/spinner"
import { FileTree } from "./file-tree"
import { DiffViewer, buildSplitRows } from "./diff-viewer"
import { SubmitDialog } from "./submit-dialog"
import { CommentDialog, type CommentImage } from "./comment-dialog"
import parsers from "../../../../../../parsers-config.ts"

// Register tree-sitter parsers for syntax highlighting (JSON, YAML, etc.)
addDefaultParsers(parsers.parsers)

export type DiffScope = "session" | "message" | "git"
export type ViewMode = "unified" | "split" | "before" | "after"
export type DiffSide = "left" | "right"

export interface Comment {
  id: string
  file: string
  startLine: number
  endLine: number
  text: string
  images: CommentImage[]
  suggestion?: string // Proposed code change (replaces the selected lines)
  originalCode?: string // Original code for the lines (needed to show diff for suggestions)
  side?: "before" | "after" // Which file stage this comment targets
}

export interface DiffReviewState {
  focus: "tree" | "viewer"
  scope: DiffScope
  viewMode: ViewMode
  viewModeOverride: boolean
  side: DiffSide
  selectedFile: number
  cursorLine: number
  selectionStart: number | null
  selectionEnd: number | null
  leftCursor: number
  rightCursor: number
  leftSelectionStart: number | null
  leftSelectionEnd: number | null
  rightSelectionStart: number | null
  rightSelectionEnd: number | null
  comments: Comment[]
  generalComment: string
  generalImages: CommentImage[]
}

export function DiffReview() {
  const route = useRouteData("diff-review")
  const { navigate } = useRoute()
  const { theme } = useTheme()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const dialog = useDialog()
  const keybind = useKeybind()

  const dimensions = useTerminalDimensions()

  const [store, setStore] = createStore<DiffReviewState>({
    focus: "tree",
    scope: "session",
    viewMode: "unified",
    viewModeOverride: false,
    side: "right",
    selectedFile: 0,
    cursorLine: 0,
    selectionStart: null,
    selectionEnd: null,
    leftCursor: 0,
    rightCursor: 0,
    leftSelectionStart: null,
    leftSelectionEnd: null,
    rightSelectionStart: null,
    rightSelectionEnd: null,
    comments: [],
    generalComment: "",
    generalImages: [],
  })

  const kv = useKV()

  const [hover, setHover] = createSignal<"submit" | "back" | "scope" | "view" | null>(null)

  const status = createMemo(() => sync.data.session_status?.[route.sessionID] ?? { type: "idle" as const })
  const scopeColor = createMemo(() =>
    store.scope === "session" ? theme.primary : store.scope === "message" ? theme.accent : theme.warning,
  )
  const spinner = createMemo(() => {
    const color = scopeColor()
    return {
      frames: createFrames({ color, style: "blocks", width: 5, inactiveFactor: 0.6, minAlpha: 0.3 }),
      color: createColors({ color, style: "blocks", width: 5, inactiveFactor: 0.6, minAlpha: 0.3 }),
    }
  })

  // Load session data including session_diff (needed for historical sessions)
  sync.session.sync(route.sessionID)

  // Session diffs from sync context
  const sessionDiffs = createMemo(() => sync.data.session_diff[route.sessionID] ?? [])

  // Message diffs: pin to the last user message with diffs found on mount.
  // Once pinned, it won't jump to a newer message (stable while agent works).
  // Re-entering diff review picks up the latest.
  const [pinnedMessage, setPinnedMessage] = createSignal<string>()
  createEffect(
    on(
      () => sync.data.message[route.sessionID],
      (messages) => {
        if (pinnedMessage() || !messages) return
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.role === "user" && msg.summary?.diffs?.length) {
            setPinnedMessage(msg.id)
            return
          }
        }
      },
    ),
  )
  const messageDiffs = createMemo((): Snapshot.FileDiff[] => {
    const id = pinnedMessage()
    if (!id) return []
    const messages = sync.data.message[route.sessionID] ?? []
    const msg = messages.find((m) => m.id === id)
    if (msg?.role === "user" && msg.summary?.diffs?.length) return msg.summary.diffs
    return []
  })

  // Git diffs stored separately to allow lazy loading of lines
  const [gitDiffList, setGitDiffList] = createStore<Snapshot.FileDiff[]>([])
  const [gitDiffsLoading, setGitDiffsLoading] = createSignal(false)
  const [prefetching, setPrefetching] = createSignal<Set<number>>(new Set())

  // Pre-fetch git diffs in background so they're ready if needed
  fetchGitDiffs()

  async function fetchGitDiffs() {
    setGitDiffsLoading(true)
    const result = await sdk.client.file.diff()
    if (!result.error && result.data) {
      setGitDiffList(result.data)
      // Start background prefetch
      prefetchAllDiffs(result.data)
    }
    setGitDiffsLoading(false)
  }

  // Fetch full diff for a single file
  async function fetchFileDiff(index: number) {
    const diff = gitDiffList[index]
    if (!diff || diff.lines.length > 0) return
    if (prefetching().has(index)) return

    setPrefetching((s) => new Set(s).add(index))
    const result = await sdk.client.file.diffFile({ filepath: diff.file })
    if (!result.error && result.data) {
      setGitDiffList(index, result.data)
    }
    setPrefetching((s) => {
      const next = new Set(s)
      next.delete(index)
      return next
    })
  }

  // Background prefetch all diffs with low priority
  async function prefetchAllDiffs(diffs: Snapshot.FileDiff[]) {
    // Fetch first file immediately (selected by default)
    await fetchFileDiff(0)

    // Prefetch rest in background with delays
    for (let i = 1; i < diffs.length; i++) {
      // Small delay between fetches to keep it low priority
      await new Promise((r) => setTimeout(r, 50))
      // Check if still in git mode
      if (store.scope !== "git") break
      await fetchFileDiff(i)
    }
  }

  const diffs = createMemo((): Snapshot.FileDiff[] => {
    if (store.scope === "git") return gitDiffList
    if (store.scope === "message") return messageDiffs()
    return sessionDiffs()
  })

  function toggleScope() {
    const scopes: DiffScope[] = ["session", "message", "git"]
    const idx = scopes.indexOf(store.scope)
    const next = scopes[(idx + 1) % scopes.length]
    setStore({
      scope: next,
      focus: "tree",
      selectedFile: 0,
      cursorLine: 0,
      selectionStart: null,
      selectionEnd: null,
      leftCursor: 0,
      rightCursor: 0,
      leftSelectionStart: null,
      leftSelectionEnd: null,
      rightSelectionStart: null,
      rightSelectionEnd: null,
    })
    if (next === "git" && gitDiffList.length === 0) fetchGitDiffs()
  }

  function toggleViewMode() {
    const modes: ViewMode[] = ["unified", "split", "before", "after"]
    const idx = modes.indexOf(store.viewMode)
    const next = modes[(idx + 1) % modes.length]
    const diff = currentDiff()

    // Find the raw line index at current cursor position
    let rawIndex = 0
    if (diff) {
      if (store.viewMode === "unified") {
        rawIndex = store.cursorLine
      } else if (store.viewMode === "split") {
        const rows = currentSplitRows()
        const cursor = store.side === "left" ? store.leftCursor : store.rightCursor
        const row = rows[cursor]
        const entry = store.side === "left" ? row?.left : row?.right
        rawIndex = entry?.index ?? 0
      } else {
        const filtered = diff.lines
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => (store.viewMode === "before" ? line.oldNum !== null : line.newNum !== null))
        rawIndex = filtered[store.cursorLine]?.i ?? 0
      }
    }

    // Convert raw line index to cursor in the target view
    let cursor = 0
    if (diff) {
      if (next === "unified") {
        cursor = rawIndex
      } else if (next === "split") {
        const rows = buildSplitRows(diff.lines)
        cursor = rows.findIndex((r) => (r.left && r.left.index >= rawIndex) || (r.right && r.right.index >= rawIndex))
        if (cursor < 0) cursor = 0
      } else {
        const filtered = diff.lines
          .map((l, i) => ({ l, i }))
          .filter(({ l }) => (next === "before" ? l.oldNum !== null : l.newNum !== null))
        cursor = filtered.findIndex(({ i }) => i >= rawIndex)
        if (cursor < 0) cursor = Math.max(0, filtered.length - 1)
      }
    }

    setStore({
      viewMode: next,
      viewModeOverride: true,
      leftCursor: cursor,
      rightCursor: cursor,
      leftSelectionStart: null,
      leftSelectionEnd: null,
      rightSelectionStart: null,
      rightSelectionEnd: null,
      selectionStart: null,
      selectionEnd: null,
      cursorLine: cursor,
      side: "right",
    })
  }

  function switchSide() {
    if (store.viewMode !== "split") return
    setStore("side", store.side === "left" ? "right" : "left")
  }

  // Auto-detect view mode based on terminal width
  createEffect(
    on(
      () => dimensions().width,
      (width) => {
        if (store.viewModeOverride) return
        setStore("viewMode", width > 120 ? "split" : "unified")
      },
    ),
  )

  // Track if we've already attempted auto-switch
  const [autoSwitchAttempted, setAutoSwitchAttempted] = createSignal(false)

  // Auto-switch to git scope if no session diffs after sync completes
  createEffect(
    on(
      () => sessionDiffs().length,
      (length) => {
        // If session has diffs, stay in session mode
        if (length > 0) return

        // Give sync a moment to complete, then check again
        if (!autoSwitchAttempted()) {
          setTimeout(() => {
            setAutoSwitchAttempted(true)
            // After delay, if still no session diffs and in session mode, switch to git
            if (sessionDiffs().length === 0 && store.scope === "session") {
              setStore("scope", "git")
              if (gitDiffList.length === 0) fetchGitDiffs()
            }
          }, 500)
        }
      },
    ),
  )

  // Prioritize fetching selected file if not yet loaded
  createEffect(
    on(
      () => store.selectedFile,
      (index) => {
        if (store.scope === "git" && gitDiffList[index]?.lines.length === 0) {
          fetchFileDiff(index)
        }
      },
    ),
  )

  // Refresh git diffs when session diffs change (agent modified files)
  createEffect(
    on(
      () => sessionDiffs(),
      () => {
        if (store.scope === "git" && gitDiffList.length > 0) {
          fetchGitDiffs()
        }
      },
      { defer: true },
    ),
  )

  // Clamp selected file when diffs change (e.g., agent modifies files)
  createEffect(
    on(
      () => diffs().length,
      (length) => {
        if (length === 0) return
        if (store.selectedFile >= length) {
          setStore("selectedFile", Math.max(0, length - 1))
        }
      },
    ),
  )

  const currentDiff = createMemo(() => diffs()[store.selectedFile])
  const currentSplitRows = createMemo(() => {
    const diff = currentDiff()
    if (!diff || store.viewMode !== "split") return []
    return buildSplitRows(diff.lines)
  })

  const totalComments = createMemo(() => store.comments.length)

  const fileComments = createMemo(() => {
    const file = currentDiff()?.file
    if (!file) return []
    return store.comments.filter((c) => c.file === file)
  })

  const commentsPerFile = createMemo(() => {
    const counts: Record<string, number> = {}
    for (const c of store.comments) {
      counts[c.file] = (counts[c.file] || 0) + 1
    }
    return counts
  })

  function selectFile(index: number, startLine?: number) {
    if (index < 0 || index >= diffs().length) return
    setStore({
      selectedFile: index,
      cursorLine: startLine ?? 0,
      selectionStart: null,
      selectionEnd: null,
      leftCursor: 0,
      rightCursor: 0,
      leftSelectionStart: null,
      leftSelectionEnd: null,
      rightSelectionStart: null,
      rightSelectionEnd: null,
    })
  }

  function focusViewer() {
    setStore("focus", "viewer")
  }

  function focusTree() {
    setStore({
      focus: "tree",
      selectionStart: null,
      selectionEnd: null,
    })
  }

  function close() {
    navigate({ type: "session", sessionID: route.sessionID })
  }

  // Get actual file line number from a cursor index
  function lineNum(index: number, side?: "before" | "after"): number {
    const diff = currentDiff()
    if (!diff) return index + 1

    // In split mode, index is a row index into splitRows
    if (store.viewMode === "split") {
      const rows = currentSplitRows()
      const row = rows[index]
      if (!row) return index + 1
      const entry = side === "before" ? row.left : row.right
      if (!entry) return index + 1
      if (side === "before") return entry.line.oldNum ?? entry.line.newNum ?? index + 1
      return entry.line.newNum ?? entry.line.oldNum ?? index + 1
    }

    // In before/after modes, cursor index is into the filtered array
    if (store.viewMode === "before" || store.viewMode === "after") {
      const filtered = diff.lines.filter((l) => (store.viewMode === "before" ? l.oldNum !== null : l.newNum !== null))
      const line = filtered[index]
      if (!line) return index + 1
      if (store.viewMode === "before") return line.oldNum ?? index + 1
      return line.newNum ?? index + 1
    }

    const line = diff.lines[index]
    if (!line) return index + 1
    if (side === "before") return line.oldNum ?? line.newNum ?? index + 1
    if (side === "after") return line.newNum ?? line.oldNum ?? index + 1
    return line.newNum ?? line.oldNum ?? index + 1
  }

  // Determine the comment side based on current view mode and active side
  function commentSide(): "before" | "after" {
    if (store.viewMode === "before") return "before"
    if (store.viewMode === "after") return "after"
    if (store.viewMode === "split") return store.side === "left" ? "before" : "after"
    return "after"
  }

  function addComment(
    text: string,
    images: CommentImage[],
    isFileLevel = false,
    suggestion?: string,
    originalCode?: string,
  ) {
    const diff = currentDiff()
    if (!diff) return

    const side = commentSide()
    const start = activeCursorStart()
    const end = activeCursorEnd()

    setStore("comments", [
      ...store.comments,
      {
        id: crypto.randomUUID(),
        file: diff.file,
        startLine: isFileLevel ? 0 : lineNum(Math.min(start, end), side),
        endLine: isFileLevel ? 0 : lineNum(Math.max(start, end), side),
        text,
        images,
        suggestion,
        originalCode: suggestion ? originalCode : undefined,
        side,
      },
    ])
    clearActiveSelection()
  }

  // Get cursor/selection for the active side
  function activeCursorStart(): number {
    if (store.viewMode === "split") {
      const sel = store.side === "left" ? store.leftSelectionStart : store.rightSelectionStart
      const cursor = store.side === "left" ? store.leftCursor : store.rightCursor
      return sel ?? cursor
    }
    return store.selectionStart ?? store.cursorLine
  }

  function activeCursorEnd(): number {
    if (store.viewMode === "split") {
      const sel = store.side === "left" ? store.leftSelectionEnd : store.rightSelectionEnd
      const cursor = store.side === "left" ? store.leftCursor : store.rightCursor
      return sel ?? cursor
    }
    return store.selectionEnd ?? store.cursorLine
  }

  function clearActiveSelection() {
    if (store.viewMode === "split") {
      if (store.side === "left") {
        setStore({ leftSelectionStart: null, leftSelectionEnd: null })
      } else {
        setStore({ rightSelectionStart: null, rightSelectionEnd: null })
      }
    } else {
      setStore({ selectionStart: null, selectionEnd: null })
    }
  }

  function editComment(id: string, text: string, images: CommentImage[], suggestion?: string, originalCode?: string) {
    setStore(
      "comments",
      store.comments.map((c) =>
        c.id === id ? { ...c, text, images, suggestion, originalCode: suggestion ? originalCode : undefined } : c,
      ),
    )
  }

  function deleteComment(id: string) {
    setStore(
      "comments",
      store.comments.filter((c) => c.id !== id),
    )
  }

  function getCommentAtCursor(): Comment | null {
    const file = currentDiff()?.file
    if (!file) return null

    const side = commentSide()
    const start = activeCursorStart()
    const end = activeCursorEnd()
    const rangeStart = lineNum(Math.min(start, end), side)
    const rangeEnd = lineNum(Math.max(start, end), side)

    // Find a comment that overlaps with the selection range (exclude file-level comments)
    // In split/before/after modes, only match comments on the same side
    return (
      store.comments.find(
        (c) =>
          c.file === file &&
          c.startLine > 0 &&
          rangeStart <= c.endLine &&
          rangeEnd >= c.startLine &&
          (store.viewMode === "unified" || c.side === side),
      ) ?? null
    )
  }

  function getFileComment(): Comment | null {
    const file = currentDiff()?.file
    if (!file) return null
    return store.comments.find((c) => c.file === file && c.startLine === 0) ?? null
  }

  // Get the original code content for the selected cursor range (for suggestions)
  // Note: startIndex and endIndex are 0-based cursor positions
  function getOriginalCodeByIndex(startIndex: number, endIndex: number): string | undefined {
    const diff = currentDiff()
    if (!diff || startIndex < 0) return undefined

    // In split mode, extract content from the active side's entries
    if (store.viewMode === "split") {
      const rows = currentSplitRows()
      const side = store.side
      const relevantLines: string[] = []
      for (let i = startIndex; i <= endIndex && i < rows.length; i++) {
        const entry = side === "left" ? rows[i]?.left : rows[i]?.right
        if (entry && entry.line.type !== "removed") {
          relevantLines.push(entry.line.content)
        }
      }
      return relevantLines.length > 0 ? relevantLines.join("\n") : undefined
    }

    // In before/after modes, indices reference the filtered array
    const source =
      store.viewMode === "before" || store.viewMode === "after"
        ? diff.lines.filter((l) => (store.viewMode === "before" ? l.oldNum !== null : l.newNum !== null))
        : diff.lines

    const relevantLines: string[] = []
    for (let i = startIndex; i <= endIndex && i < source.length; i++) {
      const line = source[i]
      if (line.type !== "removed") {
        relevantLines.push(line.content)
      }
    }
    return relevantLines.length > 0 ? relevantLines.join("\n") : undefined
  }

  function openCommentDialog(editingId?: string, isFileLevel = false) {
    const diff = currentDiff()
    if (!diff) return

    const existingComment = editingId ? store.comments.find((c) => c.id === editingId) : null
    const isFileLevelComment = isFileLevel || existingComment?.startLine === 0

    const side = existingComment?.side ?? commentSide()

    // For line numbers (display), use actual file line numbers
    const start = isFileLevelComment ? 0 : (existingComment?.startLine ?? lineNum(activeCursorStart(), side))
    const end = isFileLevelComment ? 0 : (existingComment?.endLine ?? lineNum(activeCursorEnd(), side))
    const startLine = Math.min(start, end)
    const endLine = Math.max(start, end)

    // For original code, use 0-based cursor indices
    const cursorStart = activeCursorStart()
    const cursorEnd = activeCursorEnd()
    const originalCode =
      existingComment?.originalCode ??
      getOriginalCodeByIndex(Math.min(cursorStart, cursorEnd), Math.max(cursorStart, cursorEnd))

    dialog.replace(() => (
      <CommentDialog
        sessionID={route.sessionID}
        file={diff.file}
        startLine={startLine}
        endLine={endLine}
        originalCode={originalCode}
        initialValue={existingComment?.text}
        initialImages={existingComment?.images}
        initialSuggestion={existingComment?.suggestion}
        editing={!!editingId}
        onSubmit={(text, images, suggestion) => {
          dialog.clear()
          if (editingId) {
            editComment(editingId, text, images, suggestion, originalCode)
          } else {
            addComment(text, images, isFileLevelComment, suggestion, originalCode)
          }
        }}
        onCancel={() => {
          dialog.clear()
        }}
      />
    ))
  }

  function openSubmitDialog() {
    dialog.replace(() => (
      <SubmitDialog
        sessionID={route.sessionID}
        commentCount={totalComments()}
        initialValue={store.generalComment}
        initialImages={store.generalImages}
        onSubmit={(generalComment, images, agent) => {
          dialog.clear()
          close()
          submit(generalComment, images, agent)
        }}
        onCancel={() => {
          dialog.clear()
        }}
        onChange={(text, images) => {
          setStore("generalComment", text)
          setStore("generalImages", images)
        }}
      />
    ))
  }

  async function submit(generalComment?: string, generalImages?: CommentImage[], agent?: string) {
    const markdown = formatReview(store.comments, generalComment)
    const model = local.model.current()
    if (!model) return

    const allImages: CommentImage[] = [...(generalImages ?? [])]
    for (const comment of store.comments) {
      allImages.push(...comment.images)
    }

    const textPart = { id: Identifier.ascending("part"), type: "text" as const, text: markdown }
    const imageParts = allImages.map((img) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: img.mime,
      url: `data:${img.mime};base64,${img.data}`,
    }))

    await sdk.client.session.prompt({
      sessionID: route.sessionID,
      ...model,
      messageID: Identifier.ascending("message"),
      agent: agent ?? local.agent.current().name,
      model,
      variant: local.model.variant.current(),
      parts: [textPart, ...imageParts],
    })
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (keybind.match("review_submit", evt)) {
      evt.preventDefault()
      openSubmitDialog()
      return
    }

    if (keybind.match("review_close", evt)) {
      evt.preventDefault()
      if (store.focus === "viewer") {
        focusTree()
      } else {
        close()
      }
      return
    }

    if (keybind.match("review_toggle_scope", evt)) {
      evt.preventDefault()
      toggleScope()
      return
    }

    if (store.focus === "viewer") {
      if (keybind.match("review_toggle_view", evt)) {
        evt.preventDefault()
        toggleViewMode()
        return
      }
      if (keybind.match("review_switch_side", evt)) {
        evt.preventDefault()
        switchSide()
        return
      }
    }

    if (store.focus === "tree") {
      if (keybind.match("review_file_next", evt)) {
        evt.preventDefault()
        selectFile(store.selectedFile + 1)
      }
      if (keybind.match("review_file_prev", evt)) {
        evt.preventDefault()
        selectFile(store.selectedFile - 1)
      }
      if (keybind.match("review_file_focus", evt) && currentDiff()) {
        evt.preventDefault()
        focusViewer()
      }
      // File-level comment when pressing comment keybind in file tree
      if (keybind.match("review_comment", evt) && currentDiff()) {
        evt.preventDefault()
        const existingFileComment = getFileComment()
        if (existingFileComment) {
          openCommentDialog(existingFileComment.id)
        } else {
          openCommentDialog(undefined, true)
        }
      }
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
      <box flexShrink={0}>
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={1}
          {...SplitBorder}
          border={["left"]}
          borderColor={
            store.scope === "session" ? theme.primary : store.scope === "message" ? theme.accent : theme.warning
          }
          flexShrink={0}
          backgroundColor={theme.backgroundPanel}
        >
          <box flexDirection="row" gap={2}>
            <text fg={theme.text}>
              <b>Diff review</b>
            </text>
            <Show when={status().type !== "idle"}>
              <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                <spinner color={spinner().color} frames={spinner().frames} interval={40} />
              </Show>
            </Show>
            <box
              onMouseOver={() => setHover("scope")}
              onMouseOut={() => setHover(null)}
              onMouseUp={toggleScope}
              backgroundColor={hover() === "scope" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text
                fg={
                  store.scope === "session" ? theme.primary : store.scope === "message" ? theme.accent : theme.warning
                }
              >
                [{store.scope === "session" ? "Session" : store.scope === "message" ? "Message" : "Local"}]{" "}
                <span style={{ fg: theme.textMuted }}>m</span>
              </text>
            </box>
            <Show when={store.focus === "viewer"}>
              <box
                onMouseOver={() => setHover("view")}
                onMouseOut={() => setHover(null)}
                onMouseUp={toggleViewMode}
                backgroundColor={hover() === "view" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.accent}>
                  [{store.viewMode}] <span style={{ fg: theme.textMuted }}>v</span>
                </text>
              </box>
            </Show>
            <box
              onMouseOver={() => setHover("submit")}
              onMouseOut={() => setHover(null)}
              onMouseUp={openSubmitDialog}
              backgroundColor={hover() === "submit" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Submit <span style={{ fg: theme.textMuted }}>ctrl+s</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("back")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => (store.focus === "viewer" ? focusTree() : close())}
              backgroundColor={hover() === "back" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                {store.focus === "viewer" ? "Back" : "Close"} <span style={{ fg: theme.textMuted }}>esc</span>
              </text>
            </box>
            <box flexGrow={1} flexShrink={1} />
            <Show when={totalComments() > 0}>
              <box
                onMouseOver={() => setHover("submit")}
                onMouseOut={() => setHover(null)}
                onMouseUp={openSubmitDialog}
                backgroundColor={hover() === "submit" ? theme.backgroundElement : "transparent"}
                flexShrink={0}
              >
                <text fg={hover() === "submit" ? theme.text : theme.textMuted} wrapMode="none">
                  {totalComments()} comment{totalComments() !== 1 ? "s" : ""}
                </text>
              </box>
            </Show>
          </box>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1}>
        <FileTree
          diffs={diffs()}
          selectedFile={store.selectedFile}
          commentsPerFile={commentsPerFile()}
          focused={store.focus === "tree"}
          onSelect={selectFile}
          onFocus={focusTree}
        />

        <Show when={currentDiff()}>
          <DiffViewer
            getDiff={() => currentDiff()!}
            comments={fileComments()}
            cursorLine={store.cursorLine}
            selectionStart={store.selectionStart}
            selectionEnd={store.selectionEnd}
            focused={store.focus === "viewer"}
            scopeColor={
              store.scope === "session" ? theme.primary : store.scope === "message" ? theme.accent : theme.warning
            }
            viewMode={store.viewMode}
            side={store.side}
            leftCursor={store.leftCursor}
            rightCursor={store.rightCursor}
            leftSelectionStart={store.leftSelectionStart}
            leftSelectionEnd={store.leftSelectionEnd}
            rightSelectionStart={store.rightSelectionStart}
            rightSelectionEnd={store.rightSelectionEnd}
            onCursorMove={(line: number) => setStore("cursorLine", line)}
            onSelectionChange={(start: number | null, end: number | null) =>
              setStore({ selectionStart: start, selectionEnd: end })
            }
            onLeftCursorMove={(line: number) => setStore("leftCursor", line)}
            onRightCursorMove={(line: number) => setStore("rightCursor", line)}
            onLeftSelectionChange={(start: number | null, end: number | null) =>
              setStore({ leftSelectionStart: start, leftSelectionEnd: end })
            }
            onRightSelectionChange={(start: number | null, end: number | null) =>
              setStore({ rightSelectionStart: start, rightSelectionEnd: end })
            }
            onStartComment={() => openCommentDialog()}
            onStartEdit={(id: string) => openCommentDialog(id)}
            onDeleteComment={deleteComment}
            commentAtCursor={getCommentAtCursor()}
            onFocus={() => setStore("focus", "viewer")}
          />
        </Show>
      </box>

      <box
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingBottom={1}
        gap={2}
        flexDirection="row"
        justifyContent="flex-end"
      >
        <Show when={store.focus === "tree"}>
          <text fg={theme.text}>
            ↑↓ <span style={{ fg: theme.textMuted }}>navigate</span>
          </text>
          <text fg={theme.text}>
            m{" "}
            <span style={{ fg: theme.textMuted }}>
              {store.scope === "session" ? "message" : store.scope === "message" ? "local" : "session"}
            </span>
          </text>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>focus file</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>close</span>
          </text>
        </Show>
        <Show when={store.focus === "viewer"}>
          <text fg={theme.text}>
            ↑↓ <span style={{ fg: theme.textMuted }}>navigate</span>
          </text>
          <text fg={theme.text}>
            shift+↑↓ <span style={{ fg: theme.textMuted }}>select</span>
          </text>
          <Show when={store.viewMode === "split"}>
            <text fg={theme.text}>
              tab <span style={{ fg: theme.textMuted }}>side</span>
            </text>
          </Show>
          <text fg={theme.text}>
            v <span style={{ fg: theme.textMuted }}>view</span>
          </text>
          <text fg={theme.text}>
            c <span style={{ fg: theme.textMuted }}>comment</span>
          </text>
          <text fg={theme.text}>
            d <span style={{ fg: theme.textMuted }}>delete</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>back</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

function formatReview(comments: Comment[], generalComment?: string): string {
  if (comments.length === 0 && !generalComment?.trim()) {
    return "Changes look good. No comments."
  }

  const parts: string[] = ["## Code Review"]

  // Explain side context if any comments reference "before" side
  const hasBefore = comments.some((c) => c.side === "before")
  const hasAfter = comments.some((c) => c.side === "after" || !c.side)
  if (hasBefore && hasAfter) {
    parts.push("")
    parts.push("> **Context:** Comments reference two stages of the code:")
    parts.push('> - **"before"** = the original code prior to your changes (what was removed or will be changed)')
    parts.push('> - **"after"** = the current code after your changes (what was added or is now present)')
    parts.push("> Line numbers correspond to the respective stage of the file.")
  } else if (hasBefore) {
    parts.push("")
    parts.push("> **Context:** All comments reference the **original code** (before your changes).")
    parts.push("> Line numbers correspond to the file as it existed prior to modification.")
  }

  if (generalComment?.trim()) {
    parts.push("")
    parts.push(generalComment.trim())
  }

  if (comments.length > 0) {
    // Group by file
    const byFile = new Map<string, Comment[]>()
    for (const c of comments) {
      if (!byFile.has(c.file)) byFile.set(c.file, [])
      byFile.get(c.file)!.push(c)
    }

    for (const [file, fileComments] of byFile) {
      parts.push("")
      parts.push(`### ${file}`)
      parts.push("")

      // Separate before/after comments for clarity
      const beforeComments = fileComments.filter((c) => c.side === "before").sort((a, b) => a.startLine - b.startLine)
      const afterComments = fileComments.filter((c) => c.side !== "before").sort((a, b) => a.startLine - b.startLine)

      if (beforeComments.length > 0 && afterComments.length > 0) {
        parts.push("#### On original code (before changes):")
        parts.push("")
        for (const c of beforeComments) {
          formatComment(parts, c)
        }
        parts.push("#### On current code (after changes):")
        parts.push("")
        for (const c of afterComments) {
          formatComment(parts, c)
        }
      } else {
        const all = [...beforeComments, ...afterComments]
        for (const c of all) {
          formatComment(parts, c, hasBefore && hasAfter)
        }
      }
    }
  }

  parts.push("")
  parts.push("Please address these comments.")
  parts.push("")
  parts.push("Guidelines:")
  parts.push("")
  parts.push("- Ask for clarification if a comment is ambiguous")
  parts.push("- If you disagree with a suggestion, explain why before making changes")
  parts.push("- Keep changes focused on what was requested")
  parts.push("- Maintain consistency with the existing code style")
  if (hasBefore) {
    parts.push(
      '- Comments on "before" code indicate issues with what was removed or changed — consider whether the concern applies to the replacement code',
    )
  }

  return parts.join("\n")
}

function formatComment(parts: string[], c: Comment, showSide = false) {
  const sideLabel = showSide && c.side === "before" ? " (original)" : showSide && c.side === "after" ? " (current)" : ""
  const lineRef =
    c.startLine === 0
      ? "**File comment:**"
      : c.startLine === c.endLine
        ? `**Line ${c.startLine}${sideLabel}:**`
        : `**Lines ${c.startLine}-${c.endLine}${sideLabel}:**`

  if (c.suggestion) {
    parts.push(`${lineRef} ${c.text || "Suggested change:"}`)
    parts.push("")
    parts.push("```suggestion")
    parts.push(c.suggestion)
    parts.push("```")
    parts.push("")
  } else {
    parts.push(`${lineRef} ${c.text}`)
    parts.push("")
  }
}

export default DiffReview
