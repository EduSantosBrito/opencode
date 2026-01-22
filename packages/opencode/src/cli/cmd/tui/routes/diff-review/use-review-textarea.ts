import { createSignal, type Accessor } from "solid-js"
import type { PasteEvent, TextareaRenderable } from "@opentui/core"
import { useSync } from "../../context/sync"
import { Clipboard } from "../../util/clipboard"

export interface ReviewImage {
  mime: string
  data: string
}

interface UseReviewTextareaOptions {
  textarea: () => TextareaRenderable | undefined
  initialImages?: ReviewImage[]
  onImagesChange?: (images: ReviewImage[]) => void
}

interface UseReviewTextareaResult {
  images: Accessor<ReviewImage[]>
  setImages: (images: ReviewImage[]) => void
  handlePaste: (event: PasteEvent) => Promise<void>
  handleCtrlV: () => Promise<boolean>
  insertImagePlaceholder: (imageNum: number) => void
  initExtmarks: () => { pasteStyleId: number; pasteTypeId: number }
}

export function useReviewTextarea(opts: UseReviewTextareaOptions): UseReviewTextareaResult {
  const sync = useSync()
  const [images, setImagesInternal] = createSignal<ReviewImage[]>(opts.initialImages ?? [])

  let pasteStyleId = 0
  let pasteTypeId = 0

  function setImages(newImages: ReviewImage[]) {
    setImagesInternal(newImages)
    opts.onImagesChange?.(newImages)
  }

  function initExtmarks() {
    const textarea = opts.textarea()
    if (!textarea) return { pasteStyleId: 0, pasteTypeId: 0 }

    // Get syntax style from textarea's syntaxStyle
    const syntaxStyle = textarea.syntaxStyle
    if (syntaxStyle) {
      pasteStyleId = syntaxStyle.getStyleId("extmark.paste") ?? 0
    }
    pasteTypeId = textarea.extmarks.registerType("paste")

    return { pasteStyleId, pasteTypeId }
  }

  function insertImagePlaceholder(imageNum: number) {
    const textarea = opts.textarea()
    if (!textarea) return

    const placeholder = `[Image ${imageNum}]`
    const start = textarea.visualCursor.offset
    const end = start + placeholder.length
    textarea.insertText(placeholder + " ")
    textarea.extmarks.create({
      start,
      end,
      virtual: true,
      styleId: pasteStyleId,
      typeId: pasteTypeId,
    })
  }

  async function handlePaste(event: PasteEvent) {
    const textarea = opts.textarea()
    if (!textarea) return

    const normalizedText = event.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    if (!pastedContent) return

    const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
    const isUrl = /^(https?):\/\//.test(filepath)

    if (!isUrl) {
      try {
        const file = Bun.file(filepath)

        // Handle SVG as raw text content, not as base64 image (matching main prompt)
        if (file.type === "image/svg+xml") {
          event.preventDefault()
          const content = await file.text().catch(() => {})
          if (content) {
            textarea.insertText(content)
          }
          return
        }

        if (file.type.startsWith("image/")) {
          event.preventDefault()
          const content = await file
            .arrayBuffer()
            .then((buf) => Buffer.from(buf).toString("base64"))
            .catch(() => {})
          if (content) {
            const currentImages = images()
            const imageNum = currentImages.length + 1
            setImages([...currentImages, { mime: file.type, data: content }])
            insertImagePlaceholder(imageNum)
          }
          return
        }

        if (file.type.startsWith("text/") || file.name?.endsWith(".md") || file.name?.endsWith(".txt")) {
          event.preventDefault()
          const content = await file.text().catch(() => {})
          if (content) {
            textarea.insertText(content)
          }
          return
        }
      } catch {}
    }

    // Match main prompt threshold: lineCount >= 3 || length > 150
    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && !sync.data.config.experimental?.disable_paste_summary) {
      event.preventDefault()
      textarea.insertText("```\n" + pastedContent + "\n```")
    }
  }

  async function handleCtrlV(): Promise<boolean> {
    const content = await Clipboard.read()
    if (content?.mime.startsWith("image/")) {
      const currentImages = images()
      const imageNum = currentImages.length + 1
      setImages([...currentImages, { mime: content.mime, data: content.data }])
      insertImagePlaceholder(imageNum)
      return true
    }
    return false
  }

  return {
    images,
    setImages,
    handlePaste,
    handleCtrlV,
    insertImagePlaceholder,
    initExtmarks,
  }
}
