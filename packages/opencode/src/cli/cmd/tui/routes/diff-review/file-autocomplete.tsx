import { createEffect, createMemo, createResource, createSignal, Index, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { BoxRenderable, KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { SplitBorder } from "@tui/component/border"
import { useSDK } from "../../context/sdk"
import { useTheme, selectedForeground } from "../../context/theme"

export type FileAutocompleteRef = {
  onInput: (value: string) => void
  onKeyDown: (e: KeyEvent) => boolean
  visible: boolean
}

export function FileAutocomplete(props: {
  sessionID: string
  value: string
  anchor: () => BoxRenderable | undefined
  input: () => TextareaRenderable | undefined
  fileStyleId: number
  fileTypeId: () => number
  ref: (ref: FileAutocompleteRef) => void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()

  const [store, setStore] = createStore({
    visible: false,
    index: 0,
    selected: 0,
  })

  const [positionTick, setPositionTick] = createSignal(0)

  createEffect(() => {
    if (store.visible) {
      let lastPos = { x: 0, y: 0, width: 0 }
      const interval = setInterval(() => {
        const anchor = props.anchor()
        if (anchor && (anchor.x !== lastPos.x || anchor.y !== lastPos.y || anchor.width !== lastPos.width)) {
          lastPos = { x: anchor.x, y: anchor.y, width: anchor.width }
          setPositionTick((t) => t + 1)
        }
      }, 50)

      onCleanup(() => clearInterval(interval))
    }
  })

  const filter = createMemo(() => {
    if (!store.visible) return null
    props.value
    const input = props.input()
    if (!input) return null
    return input.getTextRange(store.index + 1, input.cursorOffset)
  })

  const [files] = createResource(
    () => (store.visible ? filter() : null),
    async (query) => {
      if (query === null) return []
      const result = await sdk.client.find.files({ query: query ?? "" })
      if (result.error || !result.data) return []
      return result.data.slice(0, 20)
    },
    { initialValue: [] },
  )

  const options = createMemo(() => {
    const fileList = files() ?? []
    return fileList.map((file) => ({ display: "@" + file, path: file }))
  })

  function show() {
    const input = props.input()
    if (!input) return
    setStore({
      visible: true,
      index: input.cursorOffset - 1,
      selected: 0,
    })
  }

  function hide() {
    setStore("visible", false)
  }

  function select() {
    const selected = options()[store.selected]
    if (!selected) return

    const input = props.input()
    if (!input) return

    const currentCursorOffset = input.cursorOffset

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)

    const virtualText = "@" + selected.path
    input.insertText(virtualText + " ")

    // Create extmark to highlight the file mention
    const extmarkStart = store.index
    const extmarkEnd = extmarkStart + Bun.stringWidth(virtualText)
    input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: props.fileStyleId,
      typeId: props.fileTypeId(),
    })

    hide()
  }

  function moveTo(next: number) {
    const max = options().length - 1
    if (max < 0) return
    let clamped = next
    if (clamped < 0) clamped = max
    if (clamped > max) clamped = 0
    setStore("selected", clamped)
    // Scroll to keep selected item visible
    if (scroll) {
      const viewportHeight = height()
      const scrollBottom = scroll.scrollTop + viewportHeight
      if (clamped < scroll.scrollTop) {
        scroll.scrollBy(clamped - scroll.scrollTop)
      } else if (clamped + 1 > scrollBottom) {
        scroll.scrollBy(clamped + 1 - scrollBottom)
      }
    }
  }

  onMount(() => {
    props.ref({
      get visible() {
        return store.visible
      },
      onInput(value) {
        if (store.visible) {
          const input = props.input()
          if (!input) return
          if (input.cursorOffset <= store.index || input.getTextRange(store.index, input.cursorOffset).match(/\s/)) {
            hide()
          }
          return
        }

        const input = props.input()
        if (!input) return
        const offset = input.cursorOffset
        if (offset === 0) return

        const text = value.slice(0, offset)
        const idx = text.lastIndexOf("@")
        if (idx === -1) return

        const between = text.slice(idx)
        const before = idx === 0 ? undefined : value[idx - 1]
        if (!between.match(/\s/) && (before === undefined || before.match(/\s/))) {
          show()
        }
      },
      onKeyDown(e) {
        if (!store.visible) return false

        if (e.name === "escape") {
          e.preventDefault()
          hide()
          return true
        }
        if (e.name === "up" || (e.ctrl && e.name === "p")) {
          e.preventDefault()
          moveTo(store.selected - 1)
          return true
        }
        if (e.name === "down" || (e.ctrl && e.name === "n")) {
          e.preventDefault()
          moveTo(store.selected + 1)
          return true
        }
        if (e.name === "return" || e.name === "tab") {
          e.preventDefault()
          select()
          return true
        }
        return false
      },
    })
  })

  const position = createMemo(() => {
    if (!store.visible) return { x: 0, y: 0, width: 0 }
    positionTick()
    const anchor = props.anchor()
    if (!anchor) return { x: 0, y: 0, width: 0 }
    const parent = anchor.parent
    const parentX = parent?.x ?? 0
    const parentY = parent?.y ?? 0
    return {
      x: anchor.x - parentX,
      y: anchor.y - parentY,
      width: anchor.width,
    }
  })

  const height = createMemo(() => {
    const count = options().length || 1
    if (!store.visible) return Math.min(10, count)
    positionTick()
    const anchor = props.anchor()
    return Math.min(10, count, Math.max(1, anchor?.y ?? 10))
  })

  let scroll: ScrollBoxRenderable

  return (
    <box
      visible={store.visible}
      position="absolute"
      top={position().y - height()}
      left={position().x}
      width={position().width}
      zIndex={100}
      {...SplitBorder}
      borderColor={theme.border}
    >
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        backgroundColor={theme.backgroundMenu}
        height={height()}
        scrollbarOptions={{ visible: false }}
      >
        <Index
          each={options()}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.textMuted}>No matching items</text>
            </box>
          }
        >
          {(option, index) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={index === store.selected ? theme.primary : undefined}
              flexDirection="row"
              onMouseOver={() => moveTo(index)}
              onMouseUp={() => select()}
            >
              <text fg={index === store.selected ? selectedForeground(theme) : theme.text} flexShrink={0}>
                {option().display}
              </text>
            </box>
          )}
        </Index>
      </scrollbox>
    </box>
  )
}
