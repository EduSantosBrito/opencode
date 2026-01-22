import { For, Show, createMemo, createEffect, on } from "solid-js"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import path from "path"
import { SplitBorder } from "@tui/component/border"
import { Locale } from "@/util/locale"
import type { Snapshot } from "@/snapshot"
import { useTheme } from "../../context/theme"

interface FileTreeProps {
  diffs: Snapshot.FileDiff[]
  selectedFile: number
  commentsPerFile: Record<string, number>
  focused: boolean
  onSelect: (index: number) => void
  onFocus: () => void
}

// Each file item is approximately 4 lines tall (filename + path + stats + margin)
const ITEM_HEIGHT = 4

export function FileTree(props: FileTreeProps) {
  const { theme } = useTheme()
  let scroll: ScrollBoxRenderable

  const total = createMemo(() => props.diffs.length)

  // Scroll to keep selected file visible
  createEffect(
    on(
      () => props.selectedFile,
      (index) => {
        if (!scroll) return
        const itemTop = index * ITEM_HEIGHT
        const itemBottom = itemTop + ITEM_HEIGHT
        const viewportHeight = scroll.viewport?.height ?? 10

        if (itemTop < scroll.scrollTop) {
          scroll.scrollTo(itemTop)
        } else if (itemBottom > scroll.scrollTop + viewportHeight) {
          scroll.scrollTo(itemBottom - viewportHeight)
        }
      },
    ),
  )

  return (
    <box
      width={38}
      flexShrink={0}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={1}
      flexDirection="column"
      {...SplitBorder}
      border={["right"]}
      borderColor={theme.border}
    >
      <box paddingBottom={1} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {total()} Change{total() !== 1 ? "s" : ""}
        </text>
      </box>

      <scrollbox flexGrow={1} ref={(r: ScrollBoxRenderable) => (scroll = r)}>
        <box flexDirection="column" flexShrink={0}>
          <For each={props.diffs}>
            {(diff, index) => {
              const selected = createMemo(() => index() === props.selectedFile)
              const filename = createMemo(() => {
                const splits = diff.file.split(path.sep).filter(Boolean)
                return splits.at(-1)!
              })
              const filepath = createMemo(() => {
                const splits = diff.file.split(path.sep).filter(Boolean)
                const rest = splits.slice(0, -1).join(path.sep)
                if (!rest) return ""
                return Locale.truncateMiddle(rest, 28)
              })
              const commentCount = createMemo(() => props.commentsPerFile[diff.file] || 0)

              return (
                <box
                  flexDirection="column"
                  flexShrink={0}
                  backgroundColor={selected() ? theme.backgroundElement : undefined}
                  paddingLeft={1}
                  paddingRight={1}
                  marginBottom={1}
                  onMouseUp={() => {
                    props.onSelect(index())
                    props.onFocus()
                  }}
                >
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <text fg={selected() && props.focused ? theme.primary : theme.textMuted} width={2} flexShrink={0}>
                      {selected() ? ">" : " "}
                    </text>
                    <text
                      fg={selected() ? theme.text : theme.textMuted}
                      attributes={selected() ? TextAttributes.BOLD : undefined}
                      flexShrink={0}
                    >
                      {filename()}
                    </text>
                    <Show when={commentCount() > 0}>
                      <text fg={theme.warning} flexShrink={0}>
                        [{commentCount()}]
                      </text>
                    </Show>
                  </box>

                  <Show when={filepath()}>
                    <box paddingLeft={3} flexShrink={0}>
                      <text fg={theme.textMuted} flexShrink={0}>
                        {filepath()}
                      </text>
                    </box>
                  </Show>

                  <box flexDirection="row" gap={1} paddingLeft={3} flexShrink={0}>
                    <text fg={theme.diffAdded} flexShrink={0}>
                      +{diff.additions}
                    </text>
                    <text fg={theme.diffRemoved} flexShrink={0}>
                      -{diff.deletions}
                    </text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}
