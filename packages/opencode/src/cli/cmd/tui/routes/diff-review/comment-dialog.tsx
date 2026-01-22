import { createSignal, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes, type BoxRenderable, type TextareaRenderable } from "@opentui/core"
import { EmptyBorder } from "@tui/component/border"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { FileAutocomplete, type FileAutocompleteRef } from "./file-autocomplete"
import { useReviewTextarea, type ReviewImage } from "./use-review-textarea"

export type CommentImage = ReviewImage

interface CommentDialogProps {
  sessionID: string
  file: string
  startLine: number
  endLine: number
  originalCode?: string // The original code for the selected lines (for suggestions)
  initialValue?: string
  initialImages?: CommentImage[]
  initialSuggestion?: string
  editing: boolean
  onSubmit: (text: string, images: CommentImage[], suggestion?: string) => void
  onCancel: () => void
}

// Parse suggestion block from text content
function parseSuggestion(content: string): { text: string; suggestion?: string } {
  const regex = /```suggestion\n([\s\S]*?)```/
  const match = content.match(regex)
  if (!match) return { text: content }

  const suggestion = match[1].replace(/\n$/, "") // Remove trailing newline
  const text = content.replace(regex, "").trim()
  return { text, suggestion }
}

// Compose initial value from text + suggestion
function composeInitialValue(text?: string, suggestion?: string): string {
  if (!suggestion) return text ?? ""
  const parts: string[] = []
  if (text) parts.push(text)
  if (parts.length > 0) parts.push("")
  parts.push("```suggestion")
  parts.push(suggestion)
  parts.push("```")
  return parts.join("\n")
}

export function CommentDialog(props: CommentDialogProps) {
  const { theme, syntax } = useTheme()
  const dialog = useDialog()
  let textarea: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: FileAutocompleteRef | undefined
  const fileStyleId = syntax().getStyleId("extmark.file")!
  let fileTypeId: number

  const initialContent = composeInitialValue(props.initialValue, props.initialSuggestion)
  const [inputValue, setInputValue] = createSignal(initialContent)
  const [hover, setHover] = createSignal(false)

  const [store, setStore] = createStore({
    focused: "textarea" as "textarea" | "submit" | "cancel" | "suggest",
  })

  const { images, handlePaste, handleCtrlV, initExtmarks } = useReviewTextarea({
    textarea: () => textarea,
    initialImages: props.initialImages,
  })

  // Can only suggest changes for line-specific comments (not file-level)
  const canSuggest = () => props.startLine > 0 && props.originalCode !== undefined

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => {
      textarea?.focus()
      const { pasteStyleId, pasteTypeId } = initExtmarks()
      fileTypeId = textarea?.extmarks.registerType("file")

      if (initialContent && textarea) {
        const regex = /\[Image \d+\]/g
        let match
        while ((match = regex.exec(initialContent)) !== null) {
          textarea.extmarks.create({
            start: match.index,
            end: match.index + match[0].length,
            virtual: true,
            styleId: pasteStyleId,
            typeId: pasteTypeId,
          })
        }
      }
    }, 10)
  })

  function insertSuggestion() {
    if (!props.originalCode || !textarea) return
    const block = "\n```suggestion\n" + props.originalCode + "\n```"
    textarea.insertText(block)
    setInputValue(textarea.plainText ?? "")
    setStore("focused", "textarea")
    setTimeout(() => textarea?.focus(), 1)
  }

  function submit() {
    const raw = textarea?.plainText?.trim()
    if (!raw) {
      props.onCancel()
      return
    }
    const { text, suggestion } = parseSuggestion(raw)
    const filtered = images().filter((_, i) => raw.includes(`[Image ${i + 1}]`))
    props.onSubmit(text, filtered, suggestion)
  }

  const isFileLevel = props.startLine === 0 && props.endLine === 0
  const lineRef = isFileLevel
    ? "File comment"
    : props.startLine === props.endLine
      ? `Line ${props.startLine}`
      : `Lines ${props.startLine}-${props.endLine}`

  useKeyboard(async (evt) => {
    if (autocomplete && autocomplete.onKeyDown(evt)) return

    if (evt.name === "escape") {
      evt.preventDefault()
      props.onCancel()
      return
    }

    if (evt.ctrl && evt.name === "v" && store.focused === "textarea") {
      const handled = await handleCtrlV()
      if (handled) {
        evt.preventDefault()
        return
      }
    }

    if (evt.name === "tab" && !(autocomplete && autocomplete.visible)) {
      evt.preventDefault()
      const focusOrder: Array<typeof store.focused> = ["textarea", "submit", "cancel"]
      if (canSuggest()) focusOrder.push("suggest")

      const currentIndex = focusOrder.indexOf(store.focused)
      const nextIndex = (currentIndex + 1) % focusOrder.length
      const nextFocus = focusOrder[nextIndex]

      textarea?.blur()
      setStore("focused", nextFocus)

      if (nextFocus === "textarea") setTimeout(() => textarea?.focus(), 1)
      return
    }

    if (evt.name === "return" && store.focused !== "textarea") {
      evt.preventDefault()
      if (store.focused === "submit") submit()
      else if (store.focused === "suggest") insertSuggestion()
      else props.onCancel()
    }
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.editing ? "Edit Comment" : "Add Comment"}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <box flexDirection="column">
        <text fg={theme.textMuted}>{props.file}</text>
        <text fg={theme.primary}>{lineRef}</text>
      </box>

      <box flexDirection="column" gap={0}>
        <text fg={theme.text}>Comment:</text>
        <FileAutocomplete
          sessionID={props.sessionID}
          value={inputValue()}
          anchor={() => anchor}
          input={() => textarea}
          fileStyleId={fileStyleId}
          fileTypeId={() => fileTypeId}
          ref={(r) => (autocomplete = r)}
        />
        <box ref={(r: BoxRenderable) => (anchor = r)}>
          <box
            border={["left"]}
            borderColor={store.focused === "textarea" ? theme.primary : hover() ? theme.primary : theme.border}
            customBorderChars={{
              ...EmptyBorder,
              vertical: "┃",
              bottomLeft: "╹",
            }}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseDown={() => {
              setStore("focused", "textarea")
              setTimeout(() => textarea?.focus(), 1)
            }}
          >
            <box
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              flexShrink={0}
              backgroundColor={theme.backgroundElement}
              flexGrow={1}
            >
              <textarea
                ref={(r: TextareaRenderable) => (textarea = r)}
                height={10}
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.primary}
                syntaxStyle={syntax()}
                initialValue={initialContent}
                placeholder="Enter comment (use ```suggestion block to propose changes)..."
                onPaste={handlePaste}
                onContentChange={() => {
                  const value = textarea?.plainText ?? ""
                  setInputValue(value)
                  autocomplete?.onInput(value)
                }}
                keyBindings={[{ name: "return", ctrl: true, action: "submit" }]}
                onSubmit={submit}
              />
            </box>
          </box>
        </box>
      </box>

      <box flexDirection="row" justifyContent="flex-end" gap={2} paddingTop={1}>
        {/* Insert suggestion button - only if we can suggest */}
        <Show when={canSuggest()}>
          <box
            backgroundColor={store.focused === "suggest" ? theme.backgroundElement : undefined}
            onMouseUp={insertSuggestion}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={store.focused === "suggest" ? theme.warning : theme.textMuted}>[Suggest]</text>
          </box>
        </Show>
        <box
          backgroundColor={store.focused === "cancel" ? theme.backgroundElement : undefined}
          onMouseUp={props.onCancel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={store.focused === "cancel" ? theme.text : theme.textMuted}>[Cancel]</text>
        </box>
        <box
          backgroundColor={store.focused === "submit" ? theme.backgroundElement : undefined}
          onMouseUp={submit}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={store.focused === "submit" ? theme.primary : theme.text} attributes={TextAttributes.BOLD}>
            [{props.editing ? "Save" : "Add"}]
          </text>
        </box>
      </box>

      <box paddingBottom={1} gap={2} flexDirection="row">
        <text fg={theme.text}>
          tab <span style={{ fg: theme.textMuted }}>navigate</span>
        </text>
        <text fg={theme.text}>
          ctrl+enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
      </box>
    </box>
  )
}
