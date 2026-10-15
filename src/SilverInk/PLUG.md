---
name: Library/ppenguin/SilverInk
tags: meta/library
author: ppenguin
description: Persistent handwriting capture with block review, Markdown/SVG insertion, and optional Ollama transcription
files:
  - silverink.plug.js
---

# SilverInk

SilverInk adds **SilverInk: New handwritten** for fresh ink and
**SilverInk: Edit handwritten** for the block at the editor cursor. Draw with
a pen or mouse, resume interrupted
sessions, review stroke blocks, and insert editable Markdown or linked SVG
drawings. The saved vectors can also be exported
as JSON, SVG, or PNG. Finger drawing is optional; one finger pans by default.

**SilverInk: Delete selected block** removes the block at the cursor and its
private source files while leaving transcribed Markdown in place. **SilverInk:
Clean orphaned blocks** finds block records whose markers and images are no
longer referenced by any Markdown page, then asks before removing them.

For offline drawing, block editing, insertion, and cleanup, set
`config.set("sync.documents", true)` in a `space-lua` block on your Space's
`CONFIG` page. SilverBullet only applies sync settings from `CONFIG`; reload
the client and let it sync once while online before using SilverInk offline.
Open the client over HTTPS (or `http://localhost` on the same device): plain
HTTP to a LAN address cannot use SilverBullet's offline service worker.

Strokes are stored in `SilverInk/Sessions/` in the Space. Transcribe sends the
selected block to Ollama and inserts the result as editable Markdown.

```space-lua
config.defineCategory {
  name = "SilverInk",
  description = "Handwriting transcription settings",
  priority = 10,
}

config.define("silverink.ocr.endpoint", {
  type = "string",
  default = "http://localhost:11434",
  description = "Ollama server URL reachable from the SilverBullet server",
  ui = { category = "SilverInk", label = "Ollama server URL", priority = 3 },
})

config.define("silverink.ocr.model", {
  type = "string",
  default = "gemma3:4b",
  description = "Installed Ollama vision model",
  ui = { category = "SilverInk", label = "Vision model", priority = 2 },
})

config.define("silverink.ocr.provider", {
  type = "string",
  default = "ollama",
  enum = { "ollama" },
  description = "Transcription provider",
  ui = { category = "SilverInk", label = "OCR provider", priority = 1 },
})
```

See the [project README](https://github.com/ppenguin/ppsblib/blob/main/src/SilverInk/README.md)
for development setup, use, and current limitations.
