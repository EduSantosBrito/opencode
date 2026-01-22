import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  TextAttributes,
  MacOSScrollAccel,
  RGBA,
  type ColorInput,
  type ScrollAcceleration,
  type ScrollBoxRenderable,
} from "@opentui/core"
import path from "path"
import { SplitBorder } from "@tui/component/border"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { createPatch } from "diff"
import type { Snapshot } from "@/snapshot"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useKeybind } from "../../context/keybind"
import { useKV } from "../../context/kv"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { Clipboard } from "../../util/clipboard"
import { deriveTrailColors, deriveInactiveColor } from "../../ui/spinner"
import type { Comment, ViewMode, DiffSide } from "./index"

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}
  tick(_now?: number): number {
    return this.speed
  }
  reset(): void {}
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

// Virtualization constants
const BUFFER_LINES = 30 // Extra lines above/below viewport for smooth scrolling

// Split view types
export interface SplitRow {
  left: { line: Snapshot.DiffLine; index: number } | null
  right: { line: Snapshot.DiffLine; index: number } | null
}

// Build paired rows for side-by-side diff view
export function buildSplitRows(lines: Snapshot.DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.type === "context") {
      rows.push({
        left: { line, index: i },
        right: { line, index: i },
      })
      i++
    } else {
      // Collect consecutive removes and adds
      const removes: { line: Snapshot.DiffLine; index: number }[] = []
      const adds: { line: Snapshot.DiffLine; index: number }[] = []

      while (i < lines.length && lines[i].type !== "context") {
        if (lines[i].type === "removed") {
          removes.push({ line: lines[i], index: i })
        } else if (lines[i].type === "added") {
          adds.push({ line: lines[i], index: i })
        }
        i++
      }

      // Align removes and adds, pad shorter side with null
      const max = Math.max(removes.length, adds.length)
      for (let j = 0; j < max; j++) {
        rows.push({
          left: j < removes.length ? removes[j] : null,
          right: j < adds.length ? adds[j] : null,
        })
      }
    }
  }

  return rows
}

// Single diff line component - memoized to avoid re-renders
function DiffLine(props: {
  line: Snapshot.DiffLine
  index: number
  isCursor: boolean
  isSelected: boolean
  hasComment: boolean
  focused: boolean
  filetype: string
  syntax: any
  enableSyntax: boolean
  preferOld?: boolean
  onClick: (e: any) => void
  onHover: () => void
}) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  const lineNum = () =>
    props.preferOld ? (props.line.oldNum ?? props.line.newNum ?? "") : (props.line.newNum ?? props.line.oldNum ?? "")
  const sign = () => (props.line.type === "added" ? "+" : props.line.type === "removed" ? "-" : " ")

  // Background color priority: hover > cursor > selection > comment > diff type
  const bgColor = createMemo(() => {
    if (hover() && props.focused) return theme.backgroundMenu
    if (props.isCursor && props.focused) return theme.backgroundElement
    if (props.isSelected && props.focused) return theme.backgroundPanel
    if (props.hasComment) return theme.backgroundPanel
    if (props.line.type === "added") return theme.diffAddedBg
    if (props.line.type === "removed") return theme.diffRemovedBg
    return "transparent"
  })

  // Left indicator: > for cursor, * for comment, space otherwise
  const indicator = createMemo(() => {
    if (props.isCursor && props.focused) return ">"
    if (props.hasComment) return "*"
    return " "
  })

  const indicatorColor = createMemo(() => {
    if (props.isCursor && props.focused) return theme.primary
    if (props.isSelected && props.focused) return theme.accent
    if (props.hasComment) return theme.warning
    return "transparent"
  })

  const signColor = createMemo(() => {
    if (props.line.type === "added") return theme.diffAdded
    if (props.line.type === "removed") return theme.diffRemoved
    return theme.textMuted
  })

  return (
    <box
      flexDirection="row"
      backgroundColor={bgColor()}
      onMouseDown={(e: any) => props.onClick(e)}
      onMouseOver={() => {
        setHover(true)
        props.onHover()
      }}
      onMouseOut={() => setHover(false)}
    >
      <text fg={indicatorColor()} width={1}>
        {indicator()}
      </text>
      <box width={5} justifyContent="flex-end" paddingRight={1}>
        <text fg={theme.textMuted}>{lineNum()}</text>
      </box>
      <text fg={signColor()} width={2}>
        {sign()}{" "}
      </text>
      <Show
        when={props.enableSyntax}
        fallback={
          <text fg={theme.text} wrapMode="none">
            {props.line.content}
          </text>
        }
      >
        <code
          content={props.line.content}
          filetype={props.filetype}
          syntaxStyle={props.syntax}
          wrapMode="none"
          fg={theme.text}
        />
      </Show>
    </box>
  )
}

// Single side cell in split view - renders one half of a split row
function SplitCell(props: {
  entry: { line: Snapshot.DiffLine; index: number } | null
  isCursor: boolean
  isPeerCursor: boolean // lighter highlight on the other side
  isSelected: boolean
  hasComment: boolean
  focused: boolean
  active: boolean // is this the active side
  preferOld?: boolean
  filetype: string
  syntax: any
  enableSyntax: boolean
  onClick: (e: any) => void
  onHover: () => void
}) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  const lineNum = () => {
    if (!props.entry) return ""
    const line = props.entry.line
    return props.preferOld ? (line.oldNum ?? line.newNum ?? "") : (line.newNum ?? line.oldNum ?? "")
  }

  const sign = () => {
    if (!props.entry) return " "
    return props.entry.line.type === "added" ? "+" : props.entry.line.type === "removed" ? "-" : " "
  }

  const bgColor = createMemo(() => {
    if (!props.entry) return "transparent"
    if (hover() && props.focused && props.active) return theme.backgroundMenu
    if (props.isCursor && props.focused && props.active) return theme.backgroundElement
    if (props.isPeerCursor && props.focused && !props.active) return theme.backgroundPanel
    if (props.isSelected && props.focused && props.active) return theme.backgroundPanel
    if (props.hasComment) return theme.backgroundPanel
    if (props.entry.line.type === "added") return theme.diffAddedBg
    if (props.entry.line.type === "removed") return theme.diffRemovedBg
    return "transparent"
  })

  const indicator = createMemo(() => {
    if (props.isCursor && props.focused && props.active) return ">"
    if (props.hasComment) return "*"
    return " "
  })

  const indicatorColor = createMemo(() => {
    if (props.isCursor && props.focused && props.active) return theme.primary
    if (props.isPeerCursor && props.focused && !props.active) return theme.textMuted
    if (props.isSelected && props.focused && props.active) return theme.accent
    if (props.hasComment) return theme.warning
    return "transparent"
  })

  const signColor = createMemo(() => {
    if (!props.entry) return theme.textMuted
    if (props.entry.line.type === "added") return theme.diffAdded
    if (props.entry.line.type === "removed") return theme.diffRemoved
    return theme.textMuted
  })

  return (
    <box
      flexDirection="row"
      backgroundColor={bgColor()}
      width="50%"
      onMouseDown={(e: any) => props.onClick(e)}
      onMouseOver={() => {
        setHover(true)
        props.onHover()
      }}
      onMouseOut={() => setHover(false)}
    >
      <Show when={props.entry} fallback={<text fg={theme.textMuted}> </text>}>
        <text fg={indicatorColor()} width={1}>
          {indicator()}
        </text>
        <box width={5} justifyContent="flex-end" paddingRight={1}>
          <text fg={theme.textMuted}>{lineNum()}</text>
        </box>
        <text fg={signColor()} width={2}>
          {sign()}{" "}
        </text>
        <Show
          when={props.enableSyntax}
          fallback={
            <text fg={theme.text} wrapMode="none">
              {props.entry!.line.content}
            </text>
          }
        >
          <code
            content={props.entry!.line.content}
            filetype={props.filetype}
            syntaxStyle={props.syntax}
            wrapMode="none"
            fg={theme.text}
          />
        </Show>
      </Show>
    </box>
  )
}

// Change minimap showing added/removed/modified lines alongside scrollbar
function ChangeMinimap(props: {
  lines: Snapshot.DiffLine[]
  height: number
  addedColor: ColorInput
  removedColor: ColorInput
  modifiedColor: ColorInput
  commentColor: ColorInput
  commentLines: Set<number>
}) {
  const rows = createMemo(() => {
    const total = props.lines.length
    const h = props.height
    if (total === 0 || h === 0) return []

    const result: Array<"added" | "removed" | "modified" | "comment" | null> = []
    for (let row = 0; row < h; row++) {
      const startLine = Math.floor((row / h) * total)
      const endLine = Math.floor(((row + 1) / h) * total)

      let hasAdded = false
      let hasRemoved = false
      let hasComment = false
      for (let i = startLine; i < endLine && i < total; i++) {
        const type = props.lines[i]?.type
        if (type === "added") hasAdded = true
        if (type === "removed") hasRemoved = true
        if (props.commentLines.has(i)) hasComment = true
      }

      // Comments take priority in display
      if (hasComment) result.push("comment")
      else if (hasAdded && hasRemoved) result.push("modified")
      else if (hasRemoved) result.push("removed")
      else if (hasAdded) result.push("added")
      else result.push(null)
    }
    return result
  })

  const getColor = (type: "added" | "removed" | "modified" | "comment" | null) => {
    if (type === "comment") return props.commentColor
    if (type === "added") return props.addedColor
    if (type === "removed") return props.removedColor
    if (type === "modified") return props.modifiedColor
    return undefined
  }

  return (
    <box flexDirection="column" width={1} flexShrink={0}>
      <For each={rows()}>
        {(type) => (
          <text fg={getColor(type)} height={1}>
            {type ? "▐" : " "}
          </text>
        )}
      </For>
    </box>
  )
}

// Smooth rotating scanner
function GridSpinner(props: { color: ColorInput }) {
  const [frame, setFrame] = createSignal(0)
  const FRAMES_PER_POSITION = 8
  const TOTAL_FRAMES = 4 * FRAMES_PER_POSITION

  const trailColors = createMemo(() => deriveTrailColors(props.color, 4))
  const inactiveColor = createMemo(() => deriveInactiveColor(props.color, 0.25))

  onMount(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % TOTAL_FRAMES)
    }, 30)
    onCleanup(() => clearInterval(interval))
  })

  const getIntensity = (pos: number): number => {
    const f = frame()
    const activePos = f / FRAMES_PER_POSITION
    let dist = Math.abs(pos - activePos)
    if (dist > 2) dist = 4 - dist
    if (dist < 0.1) return 1.0
    if (dist < 1.0) return Math.cos((dist / 1.0) * Math.PI * 0.5) * 0.85 + 0.15
    if (dist < 1.5) return 0.15 - (dist - 1.0) * 0.2
    return 0.05
  }

  const getColor = (pos: number) => {
    const intensity = getIntensity(pos)
    const trail = trailColors()
    const inactive = inactiveColor()
    if (intensity > 0.9) return trail[0]
    if (intensity > 0.6) return trail[1]
    if (intensity > 0.3) return trail[2]
    if (intensity > 0.1) return trail[3]
    return inactive
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={getColor(0)}>{"■"}</text>
        <text fg={getColor(1)}>{"■"}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={getColor(3)}>{"■"}</text>
        <text fg={getColor(2)}>{"■"}</text>
      </box>
    </box>
  )
}

// Inline comment display (GitHub-style but with opencode styling)
function InlineComment(props: { comment: Comment; onEdit: () => void; scopeColor: ColorInput; filetype?: string }) {
  const { theme, syntax } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)

  const isFileLevel = () => props.comment.startLine === 0
  const hasSuggestion = () => !!props.comment.suggestion
  const label = () => {
    if (isFileLevel()) return "File"
    if (props.comment.startLine !== props.comment.endLine) return `L${props.comment.startLine}-${props.comment.endLine}`
    return `L${props.comment.startLine}`
  }

  // Compute unified diff for suggestion display
  const suggestionDiff = createMemo(() => {
    if (!props.comment.suggestion || !props.comment.originalCode) return null
    return createPatch("file", props.comment.originalCode + "\n", props.comment.suggestion + "\n", "", "", {
      context: 3,
    })
  })

  return (
    <box flexDirection="column" width="100%">
      {/* Background strip to connect with commented lines */}
      <box
        marginLeft={isFileLevel() ? 1 : 7}
        marginTop={1}
        marginBottom={1}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border={["left"]}
        borderColor={hover() ? theme.warning : hasSuggestion() ? theme.diffAdded : props.scopeColor}
        customBorderChars={{ ...SplitBorder.customBorderChars, vertical: "┃" }}
        backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          props.onEdit()
        }}
      >
        <box flexDirection="column" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={hasSuggestion() ? theme.diffAdded : theme.warning} attributes={TextAttributes.BOLD}>
              {label()}
            </text>
            <text fg={theme.textMuted}>{hasSuggestion() ? "suggestion" : "comment"}</text>
            <Show when={props.comment.side}>
              <text fg={props.comment.side === "before" ? theme.diffRemoved : theme.diffAdded}>
                ({props.comment.side === "before" ? "original" : "current"})
              </text>
            </Show>
          </box>
          <Show when={props.comment.text}>
            <text fg={hover() ? theme.text : theme.textMuted} wrapMode="word">
              {props.comment.text}
            </text>
          </Show>
          <Show when={hasSuggestion() && suggestionDiff()}>
            <box marginTop={1} flexDirection="column">
              <diff
                diff={suggestionDiff()!}
                view="unified"
                filetype={props.filetype ?? "typescript"}
                syntaxStyle={syntax()}
                showLineNumbers={false}
                addedBg={theme.diffAddedBg}
                removedBg={theme.diffRemovedBg}
                addedSignColor={theme.diffAdded}
                removedSignColor={theme.diffRemoved}
                lineNumberFg={theme.textMuted}
                lineNumberBg="transparent"
                width="100%"
              />
            </box>
          </Show>
        </box>
      </box>
    </box>
  )
}

interface DiffViewerProps {
  getDiff: () => Snapshot.FileDiff
  comments: Comment[]
  cursorLine: number
  selectionStart: number | null
  selectionEnd: number | null
  focused: boolean
  commentAtCursor: Comment | null
  scopeColor: ColorInput
  viewMode: ViewMode
  side: DiffSide
  leftCursor: number
  rightCursor: number
  leftSelectionStart: number | null
  leftSelectionEnd: number | null
  rightSelectionStart: number | null
  rightSelectionEnd: number | null
  onCursorMove: (line: number) => void
  onSelectionChange: (start: number | null, end: number | null) => void
  onLeftCursorMove: (line: number) => void
  onRightCursorMove: (line: number) => void
  onLeftSelectionChange: (start: number | null, end: number | null) => void
  onRightSelectionChange: (start: number | null, end: number | null) => void
  onStartComment: () => void
  onStartEdit: (id: string) => void
  onDeleteComment: (id: string) => void
  onFocus: () => void
}

export function DiffViewer(props: DiffViewerProps) {
  const { theme, syntax } = useTheme()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const kv = useKV()
  const toast = useToast()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable

  const [isDragging, setIsDragging] = createSignal(false)

  // Scroll tracking for virtualization
  onMount(() => {
    // Initial sync
    if (scroll) setScrollTop(scroll.scrollTop)

    // Poll for scroll changes (only updates signal when value changes)
    const interval = setInterval(() => {
      if (scroll) {
        const current = scroll.scrollTop
        if (current !== scrollTop()) setScrollTop(current)
      }
    }, 30)

    onCleanup(() => clearInterval(interval))
  })

  // Immediate scroll sync on keyboard navigation
  createEffect(
    on(
      () => [props.cursorLine, props.leftCursor, props.rightCursor],
      () => {
        if (scroll) setScrollTop(scroll.scrollTop)
      },
      { defer: true },
    ),
  )

  const diff = () => props.getDiff()
  const lines = () => diff()?.lines ?? []
  const ft = createMemo(() => filetype(diff().file))

  // Deferred syntax rendering: show loading spinner while preparing, then render content
  const primedFiles = new Set<string>()
  const [contentReady, setContentReady] = createSignal(false)

  createEffect(
    on(
      () => diff().file,
      (file) => {
        if (primedFiles.has(file)) {
          setContentReady(true)
          return
        }
        setContentReady(false)
        // Allow spinner to paint before heavy syntax render
        setTimeout(() => {
          setContentReady(true)
          primedFiles.add(file)
        }, 30)
      },
    ),
  )

  // Split view: paired rows for side-by-side
  const splitRows = createMemo(() => buildSplitRows(lines()))

  // Before/After view: filtered lines showing full file content
  const filteredLines = createMemo((): Array<{ line: Snapshot.DiffLine; originalIndex: number }> => {
    const mode = props.viewMode
    if (mode !== "before" && mode !== "after") return []
    return lines()
      .map((line, i) => ({ line, originalIndex: i }))
      .filter(({ line }) => {
        if (mode === "before") return line.oldNum !== null
        return line.newNum !== null
      })
  })

  // Scroll position tracking for virtualization
  const [scrollTop, setScrollTop] = createSignal(0)

  const scrollAcceleration = createMemo(() => {
    const tui = sync.data.config.tui
    if (tui?.scroll_acceleration?.enabled) return new MacOSScrollAccel()
    if (tui?.scroll_speed) return new CustomSpeedScroll(tui.scroll_speed)
    return new CustomSpeedScroll(3)
  })

  // Actual viewport: terminal height minus all chrome
  // Parent route: paddingTop(1) + header(3) + gap(1) + gap(1) + footer(2) = 8
  // DiffViewer: header paddingTop(1) + filename(1) + stats(1) + paddingBottom(1) = 4
  const viewportHeight = createMemo(() => Math.max(10, dimensions().height - 12))
  const minimapHeight = createMemo(() => Math.max(5, viewportHeight() - 2))

  // Virtualization: calculate visible range based on scroll position
  const visibleRange = createMemo(() => {
    const top = scrollTop()
    const height = viewportHeight()
    return {
      start: Math.max(0, top - BUFFER_LINES),
      end: top + height + BUFFER_LINES,
    }
  })

  // Map of line numbers to comments for quick lookup (exclude file-level comments)
  // In unified mode: "after" comments keyed by newNum, "before" comments keyed by oldNum
  const afterCommentsByNum = createMemo(() => {
    const map = new Map<number, Comment>()
    for (const c of props.comments) {
      if (c.startLine === 0) continue
      if (c.side === "before") continue
      for (let i = c.startLine; i <= c.endLine; i++) map.set(i, c)
    }
    return map
  })

  const beforeCommentsByNum = createMemo(() => {
    const map = new Map<number, Comment>()
    for (const c of props.comments) {
      if (c.startLine === 0) continue
      if (c.side !== "before") continue
      for (let i = c.startLine; i <= c.endLine; i++) map.set(i, c)
    }
    return map
  })

  // Unified combined lookup (used for hasCommentAtIndex)
  const commentsByLine = createMemo(() => afterCommentsByNum())

  // Separate comment maps for split view left/right sides
  const leftCommentsByLine = createMemo(() => {
    if (props.viewMode !== "split") return new Map<number, Comment>()
    const map = new Map<number, Comment>()
    for (const c of props.comments) {
      if (c.startLine === 0 || c.side !== "before") continue
      for (let i = c.startLine; i <= c.endLine; i++) map.set(i, c)
    }
    return map
  })

  const rightCommentsByLine = createMemo(() => {
    if (props.viewMode !== "split") return new Map<number, Comment>()
    const map = new Map<number, Comment>()
    for (const c of props.comments) {
      if (c.startLine === 0 || c.side !== "after") continue
      for (let i = c.startLine; i <= c.endLine; i++) map.set(i, c)
    }
    return map
  })

  // Set of raw line indices that have comments (for minimap)
  const commentLineIndices = createMemo(() => {
    const indices = new Set<number>()
    const afterNums = afterCommentsByNum()
    const beforeNums = beforeCommentsByNum()
    const leftNums = leftCommentsByLine()
    const rightNums = rightCommentsByLine()
    for (let i = 0; i < lines().length; i++) {
      const line = lines()[i]
      if (line.newNum !== null && (afterNums.has(line.newNum) || rightNums.has(line.newNum))) {
        indices.add(i)
      }
      if (line.oldNum !== null && (beforeNums.has(line.oldNum) || leftNums.has(line.oldNum))) {
        indices.add(i)
      }
    }
    return indices
  })

  // For before/after views, comment map filtered to the appropriate side
  const filteredCommentsByLine = createMemo(() => {
    if (props.viewMode !== "before" && props.viewMode !== "after") return new Map<number, Comment>()
    const side = props.viewMode === "before" ? "before" : "after"
    const map = new Map<number, Comment>()
    for (const c of props.comments) {
      if (c.startLine === 0) continue
      if (c.side && c.side !== side) continue
      for (let i = c.startLine; i <= c.endLine; i++) map.set(i, c)
    }
    return map
  })

  // File-level comment (startLine === 0)
  const fileComment = createMemo(() => props.comments.find((c) => c.startLine === 0))

  // Get actual line number for an index
  const getLineNum = (index: number) => {
    const line = lines()[index]
    if (!line) return index + 1
    return line.newNum ?? line.oldNum ?? index + 1
  }

  // Selection range normalized
  const selectionRange = createMemo(() => {
    if (props.selectionStart === null || props.selectionEnd === null) return null
    const start = Math.min(props.selectionStart, props.selectionEnd)
    const end = Math.max(props.selectionStart, props.selectionEnd)
    return { start, end }
  })

  const isLineSelected = (index: number) => {
    const range = selectionRange()
    if (!range) return false
    return index >= range.start && index <= range.end
  }

  const hasCommentAtIndex = (index: number) => {
    const line = lines()[index]
    if (!line) return false
    if (line.newNum !== null && afterCommentsByNum().has(line.newNum)) return true
    if (line.oldNum !== null && beforeCommentsByNum().has(line.oldNum)) return true
    return false
  }

  const getCommentAtIndex = (index: number): Comment | undefined => {
    const line = lines()[index]
    if (!line) return undefined
    if (line.newNum !== null && afterCommentsByNum().has(line.newNum)) return afterCommentsByNum().get(line.newNum)
    if (line.oldNum !== null && beforeCommentsByNum().has(line.oldNum)) return beforeCommentsByNum().get(line.oldNum)
    return undefined
  }

  // Scroll to first changed line when file changes
  createEffect(
    on(
      () => diff().file,
      () => {
        const rawLine = diff().firstChangedLine ?? 0
        let target = rawLine

        // Convert raw index to the appropriate index for current view mode
        if (props.viewMode === "split") {
          // Find the row in splitRows that contains this raw line index
          const rows = splitRows()
          target = rows.findIndex((r) => (r.left && r.left.index >= rawLine) || (r.right && r.right.index >= rawLine))
          if (target < 0) target = 0
          props.onLeftCursorMove(target)
          props.onRightCursorMove(target)
        } else if (props.viewMode === "before" || props.viewMode === "after") {
          // Find index in filtered lines
          const filtered = filteredLines()
          target = filtered.findIndex((f) => f.originalIndex >= rawLine)
          if (target < 0) target = 0
          props.onCursorMove(target)
        } else {
          props.onCursorMove(target)
        }

        const targetScroll = Math.max(0, target - 2)
        setScrollTop(targetScroll)
        setTimeout(() => {
          if (scroll) {
            scroll.scrollTo(targetScroll)
            setScrollTop(scroll.scrollTop)
          }
        }, 10)
      },
    ),
  )

  function scrollToLine(line: number) {
    if (!scroll) return
    const height = viewportHeight()
    const buffer = Math.min(5, Math.floor(height / 4))
    if (line < scroll.scrollTop + buffer) {
      scroll.scrollTo(Math.max(0, line - buffer))
    } else if (line >= scroll.scrollTop + height - buffer - 1) {
      scroll.scrollTo(line - height + buffer + 2)
    }
    // Immediate sync for virtualization
    setScrollTop(scroll.scrollTop)
  }

  async function copySelection() {
    if (props.viewMode === "split") {
      const range = splitSelectionRange()
      if (!range) return
      const rows = splitRows()
      const isLeft = props.side === "left"
      const selected: string[] = []
      for (let i = range.start; i <= range.end && i < rows.length; i++) {
        const entry = isLeft ? rows[i]?.left : rows[i]?.right
        if (entry) selected.push(entry.line.content)
      }
      const content = selected.join("\n")
      if (content) {
        await Clipboard.copy(content)
        toast.show({ message: `Copied ${selected.length} line${selected.length > 1 ? "s" : ""}`, variant: "info" })
      }
      return
    }

    const range = selectionRange()
    if (!range) return
    const source =
      props.viewMode === "before" || props.viewMode === "after" ? filteredLines().map((f) => f.line) : lines()
    const selected = source.slice(range.start, range.end + 1).map((line) => line.content)
    const content = selected.join("\n")
    if (content) {
      await Clipboard.copy(content)
      const count = range.end - range.start + 1
      toast.show({ message: `Copied ${count} line${count > 1 ? "s" : ""}`, variant: "info" })
    }
  }

  // Selection range for the active side in split mode
  function splitSelectionRange() {
    const isLeft = props.side === "left"
    const start = isLeft ? props.leftSelectionStart : props.rightSelectionStart
    const end = isLeft ? props.leftSelectionEnd : props.rightSelectionEnd
    if (start === null || end === null) return null
    return { start: Math.min(start, end), end: Math.max(start, end) }
  }

  function moveCursor(delta: number, extend: boolean) {
    if (props.viewMode === "split") {
      moveSplitCursor(delta, extend)
      return
    }

    const viewLines = props.viewMode === "unified" ? lines() : filteredLines()
    const max = viewLines.length - 1
    const next = Math.max(0, Math.min(max, props.cursorLine + delta))

    if (extend) {
      if (props.selectionStart === null) {
        props.onSelectionChange(props.cursorLine, next)
      } else {
        props.onSelectionChange(props.selectionStart, next)
      }
    } else {
      props.onSelectionChange(null, null)
    }

    props.onCursorMove(next)
    scrollToLine(next)
  }

  function moveSplitCursor(delta: number, extend: boolean) {
    const rows = splitRows()
    const max = rows.length - 1
    const isLeft = props.side === "left"
    const cursor = isLeft ? props.leftCursor : props.rightCursor
    const onMove = isLeft ? props.onLeftCursorMove : props.onRightCursorMove
    const onSelection = isLeft ? props.onLeftSelectionChange : props.onRightSelectionChange
    const selStart = isLeft ? props.leftSelectionStart : props.rightSelectionStart

    // Skip null entries on the active side
    let next = cursor + delta
    while (next >= 0 && next <= max) {
      const row = rows[next]
      const entry = isLeft ? row?.left : row?.right
      if (entry) break
      next += delta > 0 ? 1 : -1
    }
    next = Math.max(0, Math.min(max, next))

    if (extend) {
      if (selStart === null) {
        onSelection(cursor, next)
      } else {
        onSelection(selStart, next)
      }
    } else {
      onSelection(null, null)
    }

    onMove(next)
    scrollToLine(next)
  }

  function handleLineClick(index: number, e?: any) {
    // Check for ctrl/meta modifier on the mouse event
    const hasModifier = e?.ctrl || e?.meta
    if (hasModifier && props.focused) {
      // Ctrl+click: extend selection from cursor (anchor) to clicked line
      props.onSelectionChange(props.cursorLine, index)
    } else {
      // Regular click: clear selection and move cursor
      props.onSelectionChange(null, null)
      props.onCursorMove(index)
    }
    props.onFocus()
  }

  function handleLineEnter(index: number) {
    if (isDragging()) {
      props.onSelectionChange(props.selectionStart ?? props.cursorLine, index)
      props.onCursorMove(index)
    }
  }

  // Split view helpers
  function isSplitLineSelected(rowIdx: number, side: DiffSide): boolean {
    const selStart = side === "left" ? props.leftSelectionStart : props.rightSelectionStart
    const selEnd = side === "left" ? props.leftSelectionEnd : props.rightSelectionEnd
    if (selStart === null || selEnd === null) return false
    const start = Math.min(selStart, selEnd)
    const end = Math.max(selStart, selEnd)
    return rowIdx >= start && rowIdx <= end
  }

  function handleSplitClick(rowIdx: number, side: DiffSide, e?: any) {
    const row = splitRows()[rowIdx]
    const entry = side === "left" ? row?.left : row?.right
    if (!entry) return // Can't click on empty padding

    const onMove = side === "left" ? props.onLeftCursorMove : props.onRightCursorMove
    const onSelection = side === "left" ? props.onLeftSelectionChange : props.onRightSelectionChange
    const cursor = side === "left" ? props.leftCursor : props.rightCursor
    const hasModifier = e?.ctrl || e?.meta

    if (hasModifier && props.focused) {
      onSelection(cursor, rowIdx)
    } else {
      onSelection(null, null)
      onMove(rowIdx)
    }
    props.onFocus()
  }

  function handleSplitHover(rowIdx: number, _side: DiffSide) {
    if (!isDragging()) return
    const side = props.side
    const onMove = side === "left" ? props.onLeftCursorMove : props.onRightCursorMove
    const onSelection = side === "left" ? props.onLeftSelectionChange : props.onRightSelectionChange
    const selStart = side === "left" ? props.leftSelectionStart : props.rightSelectionStart
    const cursor = side === "left" ? props.leftCursor : props.rightCursor
    onSelection(selStart ?? cursor, rowIdx)
    onMove(rowIdx)
  }

  function handleComment() {
    if (props.commentAtCursor) {
      props.onStartEdit(props.commentAtCursor.id)
    } else {
      props.onStartComment()
    }
  }

  function handleDelete() {
    if (props.commentAtCursor) {
      props.onDeleteComment(props.commentAtCursor.id)
    }
  }

  // Handle mouse events globally
  onMount(() => {
    const handleMouseUp = async () => {
      const wasDragging = isDragging()
      setIsDragging(false)

      if (renderer.getSelection()?.getSelectedText()) return

      if (props.viewMode === "split") {
        const range = splitSelectionRange()
        if (range && range.start !== range.end) {
          await copySelection()
          const clearSel = props.side === "left" ? props.onLeftSelectionChange : props.onRightSelectionChange
          clearSel(null, null)
        } else if (wasDragging && range) {
          const clearSel = props.side === "left" ? props.onLeftSelectionChange : props.onRightSelectionChange
          clearSel(null, null)
        }
        return
      }

      const range = selectionRange()
      if (range && range.start !== range.end) {
        await copySelection()
        props.onSelectionChange(null, null)
      } else if (wasDragging && range) {
        props.onSelectionChange(null, null)
      }
    }

    const handleMouseDown = () => setIsDragging(true)

    globalThis.addEventListener?.("mouseup", handleMouseUp)
    globalThis.addEventListener?.("mousedown", handleMouseDown)
    onCleanup(() => {
      globalThis.removeEventListener?.("mouseup", handleMouseUp)
      globalThis.removeEventListener?.("mousedown", handleMouseDown)
    })
  })

  useKeyboard((evt) => {
    if (!props.focused) return
    if (dialog.stack.length > 0) return

    if (keybind.match("review_line_down", evt)) {
      evt.preventDefault()
      moveCursor(1, false)
    }
    if (keybind.match("review_line_up", evt)) {
      evt.preventDefault()
      moveCursor(-1, false)
    }
    if (keybind.match("review_select_down", evt)) {
      evt.preventDefault()
      moveCursor(1, true)
    }
    if (keybind.match("review_select_up", evt)) {
      evt.preventDefault()
      moveCursor(-1, true)
    }
    if (keybind.match("review_scroll_down", evt)) {
      evt.preventDefault()
      moveCursor(10, evt.shift)
    }
    if (keybind.match("review_scroll_up", evt)) {
      evt.preventDefault()
      moveCursor(-10, evt.shift)
    }
    if (keybind.match("review_comment", evt)) {
      evt.preventDefault()
      handleComment()
    }
    if (keybind.match("review_comment_delete", evt)) {
      evt.preventDefault()
      handleDelete()
    }
  })

  // Map line index → comments that should render after this line (unified mode)
  const commentsAfterLine = createMemo(() => {
    const map = new Map<number, Comment[]>()
    const shown = new Set<string>()
    const nonFile = props.comments.filter((c) => c.startLine > 0)

    for (let i = 0; i < lines().length; i++) {
      const line = lines()[i]
      const after: Comment[] = []
      for (const c of nonFile) {
        if (shown.has(c.id)) continue
        const matches = c.side === "before" ? line.oldNum === c.endLine : line.newNum === c.endLine
        if (matches) {
          after.push(c)
          shown.add(c.id)
        }
      }
      if (after.length > 0) map.set(i, after)
    }
    return map
  })

  // Virtualized line range for unified view
  const visibleLines = createMemo(() => {
    const all = lines()
    const { end } = visibleRange()
    const clampedEnd = Math.min(end, all.length)
    return {
      items: all.slice(0, clampedEnd),
      after: Math.max(0, all.length - clampedEnd),
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="column" paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {diff().file}
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.diffAdded}>+{diff().additions}</text>
          <text fg={theme.diffRemoved}>-{diff().deletions}</text>
          <Show when={props.comments.length > 0}>
            <text fg={theme.warning}>
              {props.comments.length} comment{props.comments.length > 1 ? "s" : ""}
            </text>
          </Show>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" flexGrow={1}>
          <scrollbox
            ref={(r: ScrollBoxRenderable) => (scroll = r)}
            flexGrow={1}
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{
              paddingLeft: 1,
              visible: true,
              trackOptions: {
                backgroundColor: theme.backgroundElement,
                foregroundColor: theme.border,
              },
            }}
            horizontalScrollbarOptions={{
              visible: true,
              trackOptions: {
                backgroundColor: theme.backgroundElement,
                foregroundColor: theme.border,
              },
            }}
            scrollAcceleration={scrollAcceleration()}
          >
            <Show
              when={contentReady()}
              fallback={
                <box flexGrow={1} justifyContent="center" alignItems="center">
                  <box flexDirection="column" alignItems="center" gap={1}>
                    <Show
                      when={kv.get("animations_enabled", true)}
                      fallback={
                        <box flexDirection="column">
                          <box flexDirection="row" gap={1}>
                            <text fg={props.scopeColor}>■</text>
                            <text fg={theme.textMuted}>■</text>
                          </box>
                          <box flexDirection="row" gap={1}>
                            <text fg={theme.textMuted}>■</text>
                            <text fg={theme.textMuted}>■</text>
                          </box>
                        </box>
                      }
                    >
                      <GridSpinner color={props.scopeColor} />
                    </Show>
                  </box>
                </box>
              }
            >
              <Show
                when={lines().length > 0}
                fallback={
                  <box flexGrow={1} justifyContent="center" alignItems="center">
                    <text fg={theme.textMuted}>Empty file</text>
                  </box>
                }
              >
                {/* File-level comment at the top (all modes) */}
                <Show when={fileComment()}>
                  <InlineComment
                    comment={fileComment()!}
                    onEdit={() => props.onStartEdit(fileComment()!.id)}
                    scopeColor={props.scopeColor}
                    filetype={ft()}
                  />
                </Show>

                {/* === UNIFIED VIEW === */}
                <Show when={props.viewMode === "unified"}>
                  <box flexDirection="column" width="100%">
                    <For each={visibleLines().items}>
                      {(line, index) => (
                        <>
                          <DiffLine
                            line={line}
                            index={index()}
                            isCursor={props.cursorLine === index()}
                            isSelected={isLineSelected(index())}
                            hasComment={hasCommentAtIndex(index())}
                            focused={props.focused}
                            filetype={ft()}
                            syntax={syntax()}
                            enableSyntax={true}
                            onClick={(e: any) => handleLineClick(index(), e)}
                            onHover={() => handleLineEnter(index())}
                          />
                          <For each={commentsAfterLine().get(index()) ?? []}>
                            {(comment) => (
                              <InlineComment
                                comment={comment}
                                onEdit={() => props.onStartEdit(comment.id)}
                                scopeColor={props.scopeColor}
                                filetype={ft()}
                              />
                            )}
                          </For>
                        </>
                      )}
                    </For>
                    <Show when={visibleLines().after > 0}>
                      <box height={visibleLines().after} />
                    </Show>
                  </box>
                </Show>

                {/* === SPLIT VIEW === */}
                <Show when={props.viewMode === "split"}>
                  <box flexDirection="column" width="100%">
                    <For each={splitRows()}>
                      {(row, rowIdx) => {
                        const leftLineNum = () => (row.left ? (row.left.line.oldNum ?? row.left.line.newNum ?? 0) : 0)
                        const rightLineNum = () =>
                          row.right ? (row.right.line.newNum ?? row.right.line.oldNum ?? 0) : 0
                        const leftHasComment = () => leftCommentsByLine().has(leftLineNum())
                        const rightHasComment = () => rightCommentsByLine().has(rightLineNum())
                        const leftComment = () => leftCommentsByLine().get(leftLineNum())
                        const rightComment = () => rightCommentsByLine().get(rightLineNum())

                        // Show inline comments after the last line of their range
                        const showLeftComment = () => {
                          const c = leftComment()
                          return c && leftLineNum() === c.endLine
                        }
                        const showRightComment = () => {
                          const c = rightComment()
                          return c && rightLineNum() === c.endLine
                        }

                        return (
                          <>
                            <box flexDirection="row" width="100%">
                              <SplitCell
                                entry={row.left}
                                isCursor={props.leftCursor === rowIdx()}
                                isPeerCursor={props.rightCursor === rowIdx()}
                                isSelected={isSplitLineSelected(rowIdx(), "left")}
                                hasComment={leftHasComment()}
                                focused={props.focused}
                                active={props.side === "left"}
                                preferOld={true}
                                filetype={ft()}
                                syntax={syntax()}
                                enableSyntax={true}
                                onClick={(e: any) => handleSplitClick(rowIdx(), "left", e)}
                                onHover={() => handleSplitHover(rowIdx(), "left")}
                              />
                              <box width={1} flexShrink={0}>
                                <text fg={theme.border}>│</text>
                              </box>
                              <SplitCell
                                entry={row.right}
                                isCursor={props.rightCursor === rowIdx()}
                                isPeerCursor={props.leftCursor === rowIdx()}
                                isSelected={isSplitLineSelected(rowIdx(), "right")}
                                hasComment={rightHasComment()}
                                focused={props.focused}
                                active={props.side === "right"}
                                filetype={ft()}
                                syntax={syntax()}
                                enableSyntax={true}
                                onClick={(e: any) => handleSplitClick(rowIdx(), "right", e)}
                                onHover={() => handleSplitHover(rowIdx(), "right")}
                              />
                            </box>
                            <Show when={showLeftComment() || showRightComment()}>
                              <box flexDirection="row" width="100%">
                                <box width="50%">
                                  <Show when={showLeftComment()}>
                                    <InlineComment
                                      comment={leftComment()!}
                                      onEdit={() => props.onStartEdit(leftComment()!.id)}
                                      scopeColor={props.scopeColor}
                                      filetype={ft()}
                                    />
                                  </Show>
                                </box>
                                <box width={1} flexShrink={0} />
                                <box width="50%">
                                  <Show when={showRightComment()}>
                                    <InlineComment
                                      comment={rightComment()!}
                                      onEdit={() => props.onStartEdit(rightComment()!.id)}
                                      scopeColor={props.scopeColor}
                                      filetype={ft()}
                                    />
                                  </Show>
                                </box>
                              </box>
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </box>
                </Show>

                {/* === BEFORE / AFTER VIEW === */}
                <Show when={props.viewMode === "before" || props.viewMode === "after"}>
                  <box flexDirection="column" width="100%">
                    <For each={filteredLines()}>
                      {(item, idx) => {
                        const num = () =>
                          props.viewMode === "before"
                            ? (item.line.oldNum ?? item.line.newNum ?? 0)
                            : (item.line.newNum ?? item.line.oldNum ?? 0)
                        const hasComment = () => filteredCommentsByLine().has(num())
                        const comment = () => filteredCommentsByLine().get(num())
                        const showComment = () => {
                          const c = comment()
                          return c && num() === c.endLine
                        }
                        const isChanged = () =>
                          (props.viewMode === "before" && item.line.type === "removed") ||
                          (props.viewMode === "after" && item.line.type === "added")

                        return (
                          <>
                            <DiffLine
                              line={{
                                ...item.line,
                                type: isChanged() ? item.line.type : "context",
                              }}
                              index={idx()}
                              isCursor={props.cursorLine === idx()}
                              isSelected={isLineSelected(idx())}
                              hasComment={hasComment()}
                              focused={props.focused}
                              filetype={ft()}
                              syntax={syntax()}
                              enableSyntax={true}
                              preferOld={props.viewMode === "before"}
                              onClick={(e: any) => handleLineClick(idx(), e)}
                              onHover={() => handleLineEnter(idx())}
                            />
                            <Show when={showComment()}>
                              <InlineComment
                                comment={comment()!}
                                onEdit={() => props.onStartEdit(comment()!.id)}
                                scopeColor={props.scopeColor}
                                filetype={ft()}
                              />
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </box>
                </Show>
              </Show>
            </Show>
          </scrollbox>
        </box>

        <ChangeMinimap
          lines={lines()}
          height={minimapHeight()}
          addedColor={theme.diffAdded}
          removedColor={theme.diffRemoved}
          modifiedColor={theme.warning}
          commentColor={theme.accent}
          commentLines={commentLineIndices()}
        />
      </box>
    </box>
  )
}
