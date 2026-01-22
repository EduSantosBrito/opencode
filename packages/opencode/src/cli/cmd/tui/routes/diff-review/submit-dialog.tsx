import { createSignal, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes, type BoxRenderable, type TextareaRenderable } from "@opentui/core"
import { EmptyBorder } from "@tui/component/border"
import { useTheme } from "../../context/theme"
import { useLocal } from "../../context/local"
import { useDialog } from "../../ui/dialog"
import type { CommentImage } from "./comment-dialog"
import { FileAutocomplete, type FileAutocompleteRef } from "./file-autocomplete"
import { useReviewTextarea } from "./use-review-textarea"

interface SubmitDialogProps {
  sessionID: string
  commentCount: number
  initialValue?: string
  initialImages?: CommentImage[]
  onSubmit: (generalComment: string | undefined, images: CommentImage[], agent: string) => void
  onCancel: () => void
  onChange: (text: string, images: CommentImage[]) => void
}

export function SubmitDialog(props: SubmitDialogProps) {
  const { theme, syntax } = useTheme()
  const local = useLocal()
  const dialog = useDialog()
  let textarea: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: FileAutocompleteRef | undefined
  const fileStyleId = syntax().getStyleId("extmark.file")!
  let fileTypeId: number

  const agents = createMemo(() => local.agent.list())
  const [agentIndex, setAgentIndex] = createSignal(
    Math.max(
      0,
      local.agent.list().findIndex((a) => a.name === local.agent.current().name),
    ),
  )
  const agent = createMemo(() => agents()[agentIndex()])
  const agentColor = createMemo(() => local.agent.color(agent().name))

  const [inputValue, setInputValue] = createSignal(props.initialValue ?? "")

  const [store, setStore] = createStore({
    focused: "textarea" as "textarea" | "agent" | "submit" | "cancel",
  })

  const { images, handlePaste, handleCtrlV, initExtmarks } = useReviewTextarea({
    textarea: () => textarea,
    initialImages: props.initialImages,
    onImagesChange: (imgs) => props.onChange(inputValue(), imgs),
  })

  function cancel() {
    props.onCancel()
  }

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      textarea?.focus()
      const { pasteStyleId, pasteTypeId } = initExtmarks()
      fileTypeId = textarea?.extmarks.registerType("file")

      if (props.initialValue && textarea) {
        const regex = /\[Image \d+\]/g
        let match
        while ((match = regex.exec(props.initialValue)) !== null) {
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

  function submit() {
    const text = textarea?.plainText?.trim()
    const filtered = text ? images().filter((_, i) => text.includes(`[Image ${i + 1}]`)) : []
    props.onSubmit(text || undefined, filtered, agent().name)
  }

  useKeyboard(async (evt) => {
    if (autocomplete && autocomplete.onKeyDown(evt)) return

    if (evt.name === "escape") {
      evt.preventDefault()
      cancel()
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
      if (store.focused === "textarea") {
        textarea?.blur()
        setStore("focused", "agent")
      } else if (store.focused === "agent") {
        setStore("focused", "submit")
      } else if (store.focused === "submit") {
        setStore("focused", "cancel")
      } else {
        setStore("focused", "textarea")
        setTimeout(() => textarea?.focus(), 1)
      }
      return
    }

    if (evt.name === "space" && store.focused === "agent") {
      evt.preventDefault()
      setAgentIndex((i) => (i + 1) % agents().length)
      return
    }

    if (evt.name === "return" && store.focused !== "textarea") {
      evt.preventDefault()
      if (store.focused === "submit") submit()
      else if (store.focused === "cancel") cancel()
    }
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Submit Review
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <text fg={theme.textMuted}>
        {props.commentCount > 0 ? (
          <>
            <span style={{ fg: theme.primary }}>{props.commentCount}</span> comment
            {props.commentCount !== 1 ? "s" : ""} will be sent.
          </>
        ) : (
          "No comments added."
        )}
      </text>

      <box flexDirection="column" gap={0}>
        <text fg={theme.text}>General comment (optional):</text>
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
            borderColor={store.focused === "textarea" ? theme.primary : theme.border}
            customBorderChars={{
              ...EmptyBorder,
              vertical: "┃",
              bottomLeft: "╹",
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
                height={8}
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.primary}
                syntaxStyle={syntax()}
                initialValue={props.initialValue}
                placeholder="Add overall feedback (markdown supported)..."
                onPaste={handlePaste}
                onContentChange={() => {
                  const value = textarea?.plainText ?? ""
                  setInputValue(value)
                  autocomplete?.onInput(value)
                  props.onChange(value, images())
                }}
                keyBindings={[{ name: "return", ctrl: true, action: "submit" }]}
                onSubmit={submit}
              />
            </box>
          </box>
        </box>
      </box>

      <box flexDirection="row" justifyContent="flex-end" gap={2} paddingTop={1} alignItems="center">
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={store.focused === "agent" ? theme.backgroundElement : undefined}
          onMouseUp={() => setAgentIndex((i) => (i + 1) % agents().length)}
        >
          <text fg={theme.textMuted}>
            Agent: <span style={{ fg: store.focused === "agent" ? agentColor() : theme.text }}>{agent().name}</span>{" "}
            <span style={{ fg: theme.textMuted }}>space</span>
          </text>
        </box>
        <box flexGrow={1} />
        <box
          backgroundColor={store.focused === "cancel" ? theme.backgroundElement : undefined}
          onMouseUp={cancel}
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
            [Submit Review]
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
