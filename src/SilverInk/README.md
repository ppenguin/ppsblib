# SilverInk

**Handwrite naturally. Keep the strokes. Publish real Markdown.**

SilverInk is a SilverBullet plug for pen-first notes. It provides a
near-fullscreen writing surface, persistent vector strokes, interrupted-session
recovery, and local SVG/PNG exports. The review workflow supports per-block
insertion of editable Markdown or linked SVG/PNG, direct Ollama transcription,
and a command for editing one existing block's strokes. See
[the architecture note](docs/architecture.md) for the verified APIs and data
format.

## Local development and client-side testing

The repository includes a [SilverBullet test Space](../../_test/README.md).
Run `make -C _test start` from the repository root to build this plug and start a
LAN-reachable server with the plug already installed. Re-run it after code
changes, then use **Sync: Now** and **Plugs: Reload** in the client. The
test Space uses the local build directly; the repository page's GitHub links
are only for published installs.

This directory has a [devenv](https://devenv.sh/) with Node.js 24. From this
directory:

```sh
devenv shell
npm ci
npm run check
npm test
npm run build
```

Copy the resulting plug into your **local SilverBullet Space folder**. For
example, if that folder is `~/silverbullet-space`:

```sh
mkdir -p ~/silverbullet-space/Library/local/SilverInk
cp silverink.plug.js ~/silverbullet-space/Library/local/SilverInk/
```

In the SilverBullet client, run **Sync: Now**, then **Plugs: Reload**. Open a
Markdown page and choose **SilverInk: New handwritten** from the command palette.
For each code change, run `npm run build`, copy the bundle again, and reload
plugs. There is no need to push this repository or refresh Library input.
SilverBullet's [plug development guide](https://docs.silverbullet.md/Plugs/Development)
also describes symlinking a development folder into a Space.

### Offline setup

SilverInk uses SilverBullet's local Space and sync engine for drawing, saving,
reviewing, SVG/PNG insertion, block editing, and cleanup. SilverBullet syncs
plug bundles for offline use, but does not cache ordinary non-Markdown documents
by default. SilverInk's stroke sessions, block records, and graphics need
document sync. Add this to a `space-lua` block on
the Space's **CONFIG** page:

```space-lua
config.set("sync.documents", true)
```

Reload the client while online and wait for a full sync before going offline.
SilverBullet requires sync settings specifically in **CONFIG**; putting this in
the SilverInk Library page does not enable document sync. This setting caches
all Space documents, including other attachments, on the device. With its
normal service worker active, SilverInk's non-OCR actions use the local Space;
the server catches up through SilverBullet sync when the connection returns.
**Transcribe** and **Check OCR provider** still require access to Ollama. See
[SilverBullet's Sync documentation](https://docs.silverbullet.md/Sync).

If **New handwritten** reports **“Plug timed out during creation”** offline,
SilverBullet could not start the plug worker; SilverInk's session code has not
run yet. First check that the SilverBullet page is opened over HTTPS (or
`http://localhost` on the same device), then reconnect, run **Sync: Now**, wait
for it to finish, run **Plugs: Reload**, and test again offline. A LAN URL such
as `http://192.168.x.x:3001` cannot use the service worker that supplies
SilverBullet's offline cache. If ordinary pages work offline but this timeout
persists, check that `Library/ppenguin/silverink.plug.js` is present in the
Space and has synced to that browser; the worker loads this file from `/.fs/`.

## Capture and recovery

- Pen and left-button mouse draw. One finger pans by default; **Finger draws**
  explicitly enables touch drawing. Use **Fit**, **+**, and **−** to zoom.
  **Guides** cycles between no guide, writing lines, and a grid. The choice is
  saved in this browser and is only shown on the canvas, never in SVG, PNG, or OCR crops.
  Panel labels and status text cannot be selected; the optional split number is
  the only text-entry field.
- **Erase stroke** removes a complete stroke. The grouped **Undo** and **Redo**
  buttons undo and redo drawn strokes; Ctrl/⌘+Z and Ctrl/⌘+Shift+Z work while
  the drawing surface is active. Confirmed Clear is also available. The surface
  grows vertically as writing approaches its bottom.
- Strokes are saved automatically to `SilverInk/Sessions/<session-id>.json` in
  the Space. During drawing, the browser-local recovery copy is refreshed at
  most every 100 ms; Space writes are combined after 300 ms of pen inactivity.
  Closing, reviewing, and switching sessions flush pending work. Suspending the
  page also flushes the local copy. An abrupt browser crash can lose points
  drawn since the last local flush (up to about 100 ms).
  **New handwritten** starts with a fresh writing session when the previous one has
  ink. Use the session selector to resume earlier or unsynced work for that
  page; an interrupted stroke is completed when its session is selected.
  Sessions already linked to a page block are edited through **Edit handwritten**.
- **Source JSON** downloads a backup of the editable vectors. **SVG** and
  **PNG** download local display derivatives.
- **New session** keeps the previous session file and starts a fresh one.
  **Close** waits for pending Space writes; if a write failed, the dialog says
  that only the browser copy is available.

To restore a downloaded source backup after browser storage is lost, copy its
JSON bytes into the Space as `SilverInk/Sessions/<session-id>.json` (use the
`id` inside the file), then reopen **SilverInk: New handwritten** on the original
page and select that session. Keep the original ID so the saved vectors retain
their session reference.

Drawing and recovery do not call an AI service or require an external network
connection. The Space file syncs through SilverBullet's normal file handling.
If the local Space write fails, the separate browser recovery copy remains and
the status bar shows the failure. Browser storage can be exhausted or evicted; download the
source JSON for a separate backup. Sessions are deleted only by the confirmed
block or reviewed-capture deletion actions.

## Review and insert

1. Place the editor cursor in the body of the page where the result should go,
   then open **SilverInk: New handwritten**. Draw and choose **Choose block action**.
2. Review starts with one block containing all strokes, ordered from top to
   bottom. Leave the split number empty to keep that block intact; enter a
   stroke number and choose **Split** only when needed. Merge adjacent blocks.
   These operations
   change each block's stroke IDs; SVG is regenerated from those strokes.
3. The grouped **Transcribe**, **SVG**, and **Delete** buttons sit beside each
   stroke preview. **Transcribe** runs OCR and inserts its result as editable
   Markdown; edit the text on the page afterward. **SVG** inserts a linked
   drawing. **Delete** discards an uninserted block, or deletes the marker,
   source files, and image link of a published block. **PNG instead** is a
   secondary insert option. Each successful action closes SilverInk. Open
   **New handwritten** again and choose the
   capture marked **continue review** in Saved sessions for another block.
   Each inserted block saves its own stroke session, source record, and any
   drawing image. Text
   becomes normal editable Markdown; drawings use ordinary Markdown image
   links. A small `silverink:block` comment identifies each source block.
   The block action state stays in this browser while other blocks await
   insertion. Discarded strokes remain in the original capture until its
   confirmed cleanup.

Block records are stored at `SilverInk/Blocks/<block-id>.json`; drawing files
are at `SilverInk/Graphics/<block-id>.svg` or `.png`. On insertion, each block gets a
separate `SilverInk/Sessions/<block-id>.json` with only its strokes. The record
holds that session ID, revision, and stroke IDs. Split and merge are draft
changes until insertion. The original capture session stays available during
review. Once every block is inserted or discarded, **Delete reviewed capture** can remove
it after confirmation from a resumed review. For additional ink after this review, use **New
session** so existing strokes are not duplicated. An inserted block cannot be
split, merged, or inserted again
from the same review.
If the page changes while review is open, insertion stops and asks you to
reopen SilverInk. A failed asset write leaves the page untouched; previously
written asset files may remain and are not automatically deleted.

### Delete and clean up blocks

Place the cursor in a published SilverInk block and run **SilverInk: Delete
selected block** to remove it without entering stroke edit mode. The command
asks for confirmation, removes a drawing's Markdown image link, and deletes
the block record, private stroke session, and SVG or PNG. For a transcribed
block, it removes only the marker and source files; the Markdown text remains.
If another page still links to the image or block, deletion stops.

If you manually remove block markers and image links from Markdown, run
**SilverInk: Clean orphaned blocks**. It scans every Markdown page, reports
the number of unreferenced block records, and asks before deleting their
private stroke and image files. It leaves capture sessions and Markdown text
alone. An image link on any page keeps its block record and files. Files from
an interrupted insertion that have no block record are outside this cleanup;
inspect those manually if needed.

### Ollama transcription PoC

1. On the machine running Ollama, install a vision model with `ollama pull
   gemma3:4b`. The [model entry](https://ollama.com/library/gemma3) confirms
   that the 4B variant accepts images.
2. Make Ollama reachable from the **SilverBullet server**, for example by
   setting `OLLAMA_HOST=0.0.0.0:11434` for its service and allowing TCP 11434
   from that server. With the Docker test server, `localhost` means the Docker
   container; use the Ollama machine's LAN IP instead. Test from the server
   with `curl http://<ollama-LAN-IP>:11434/api/tags`.
3. In the Space's `CONFIG` page, set the Library options in a `space-lua`
   block, then run **System: Reload**:

   ```space-lua
   config.set("silverink.ocr.endpoint", "http://<ollama-LAN-IP>:11434")
   config.set("silverink.ocr.model", "gemma3:4b")
   ```

   The SilverInk Library defines these options for the Configuration Manager
   too. Open SilverInk again, choose **Check OCR provider**, and then use
   **Transcribe** on a block.

The settings are Space configuration and travel with its Library setup. The
selected block's PNG crop travels through SilverBullet's
[authenticated HTTP proxy](https://docs.silverbullet.md/HTTP%20API) to the
configured Ollama server; no provider key is stored in the Space. An existing
login in a separate provider website cannot normally be reused by this panel
because its cookies are bound to that website. A future provider adapter can
use a server-side authenticated endpoint. OCR failures leave the strokes and
page unchanged. The OCR result is inserted as plain, escaped Markdown; edit
any recognition mistakes directly in the page. This PoC has been tested with a mocked Ollama response, not
against a live model or iPad.

## Edit an existing block

Place the cursor in a SilverInk block in the Markdown page and run
**SilverInk: Edit handwritten**. The block at the cursor is chosen from its
`silverink:block` comment; before the first block, the first is chosen. Only
that block's referenced strokes are copied into an isolated editing session.
Edit them with the normal pen, erase, undo, and clear controls, then choose
**Save block edits** and confirm. The new source session and block record are
saved. Drawing blocks regenerate their linked SVG or PNG. Existing Markdown text is
left exactly as the user edited it.

To transcribe an SVG or PNG block later, including after working offline, put
the cursor on its image link and run **SilverInk: Edit handwritten**, then choose
**Transcribe / Re-OCR**. OCR replaces that image link with editable Markdown
and closes the panel. The existing `silverink:block` comment retains the block
ID, so **Edit handwritten** can still reopen its original strokes. If you drew
more strokes in the editor, save those edits and reopen the block before
transcribing. OCR failure leaves the published image and its source untouched.

The same button re-runs OCR on a Markdown block. If the page still contains
the accepted transcription, the new result replaces it. If the text has been
edited, SilverInk asks whether to insert the new OCR result before the block
as separate Markdown, keeping the edits and block record intact.

**Delete block strokes** confirms removal of the page marker and source
record. Transcribed Markdown stays on the page. For a drawing, the original
image link and file are removed. Private stroke sessions are deleted when no
other block record uses them. Older blocks that still share a capture session
leave that shared file in place. Deletion stops if the drawing link was edited
or another page still references the block or image. If file deletion fails
after the page is updated, some files may remain for manual cleanup.

Closing before **Save block edits** leaves a recoverable edit draft without
changing the existing block. Reopening **Edit handwritten** resumes that draft in
the same browser. The page comment records the block's original insertion;
the block record holds the current source session and revision after edits.

The canvas takes focus when the panel opens to dismiss a mobile text keyboard.
This is a best-effort browser behavior; it has not been verified on iPad Safari.
The refresh, copy, and edit icons in SilverBullet's rendered widget toolbar
belong to Space Lua/code widgets. That edit icon reveals the widget's source;
it does not run **Edit handwritten**. SilverInk drawings remain ordinary
Markdown image links for portability. Place the cursor in a SilverInk block
and use **Edit handwritten** from the command palette or QuickAccess.

## Current limits

Rapid consecutive Apple Pencil strokes may be missed on iPad Safari; this is
deferred for touch-polish work. Palm rejection is controlled partly by the
browser and device.
Simultaneous editing of one session in multiple tabs is not merged. If copies
diverge at the same revision, SilverInk stops recovery and preserves the local
copy. Very long canvases may hit browser canvas limits; this needs performance
work. A session is limited to a 12-megapixel canvas in this phase. Source JSON
is stored in plain text in the Space and in this browser's
local storage, so treat it like the handwritten content it contains.

## Planned workflow

The block editor reads the block record and shows only its stroke IDs;
the SVG remains a display file. Future
recognition can add provider adapters alongside the Ollama PoC. Secrets for
cloud providers should stay server-side. See [AGENTS.md](AGENTS.md) for the full
phase plan.
