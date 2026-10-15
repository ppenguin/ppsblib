# SilverInk architecture (Phases 0–2 and scoped block editing)

## Verified SilverBullet surface

Target: SilverBullet 2.12.0. A plug is a `*.plug.js` bundle built from a
`*.plug.yaml` manifest. It runs in a Web Worker, with commands and editor/space
access through syscalls ([plug development](https://docs.silverbullet.md/Plugs/Development),
[reference](https://docs.silverbullet.md/Plugs/Development/Reference)).
`editor.showPanel("modal", inset, html, script)` presents an HTML iframe panel;
the panel script has `globalThis.syscall` and DOM access, while plug code has no
DOM access ([editor API](https://docs.silverbullet.md/API/editor),
[panel implementation](https://github.com/silverbulletmd/silverbullet/blob/main/client/components/panel.tsx),
[panel script bridge](https://github.com/silverbulletmd/silverbullet/blob/main/client/components/panel_html.ts)).
For a modal, the numeric mode is a pixel inset
([PanelMode source](https://github.com/silverbulletmd/silverbullet/blob/main/plug-api/types/client.ts)).

The panel calls `space.listFiles`, `space.readFile`, `space.writeFile`, and
`space.deleteFile` via
`syscall`; the latter accepts a `Uint8Array`
([space syscall](https://github.com/silverbulletmd/silverbullet/blob/main/plug-api/syscalls/space.ts)).
`editor.getCurrentPage`, `getText`, `getSelection`, `insertAtPos`, `replaceRange`,
`moveCursor`, `setSelection`, and `save` are available for page edits. `insertAtPos`
inserts without replacing a selection; the review flow captures a cursor
position and compares the entire current page text before insertion. If text
was selected, it restores that selection over the original content after the
inserted blocks
([editor syscall source](https://github.com/silverbulletmd/silverbullet/blob/main/client/plugos/syscalls/editor.ts)).
SilverBullet resolves relative Markdown media links from the page location
([link documentation](https://docs.silverbullet.md/Link)). SilverBullet's client datastore is
IndexedDB backed ([datastore architecture](https://docs.silverbullet.md/Architecture/Datastore));
this implementation uses synchronous local storage for the in-flight recovery
buffer and a Space file for durable, synced storage.
The `.json`, `.svg`, `.png`, and plug bundle files are SilverBullet documents.
SilverBullet does not sync documents offline by default, so the Space must set
`config.set("sync.documents", true)` in **CONFIG** and complete an online sync.
Thereafter all non-OCR operations use the client-local Space and its normal sync
queue; the localStorage copy remains a recovery layer for an interrupted pen
stroke or failed local Space write.

The current v2 plug runtime is client-side only
([ADR 007](https://docs.silverbullet.md/ADR/007%20Core%20Application%20Logic%20on%20the%20Client)).
The HTTP API proxy is used by the transcription PoC
([HTTP API](https://docs.silverbullet.md/HTTP%20API)). SilverBullet's
authenticated proxy call avoids browser CORS restrictions and sends a request
from the SilverBullet server to a configured LAN Ollama instance. Other
providers can be added behind the same adapter interface; services requiring
secrets should use a dedicated server endpoint.

## Integration and data

The `SilverInk: New handwritten` and `SilverInk: Edit handwritten` commands
open a 12-pixel-inset modal. Its assets are bundled in the plug. Pointer Events capture
strokes in an iframe canvas; touch pans unless finger drawing is explicitly
enabled. Mouse draws for tests.
Handwrite opens fresh ink by default when the prior session contains strokes;
the selector can resume an earlier unlinked session or a linked capture with a
saved review draft. Block edit forks are reserved for Edit handwritten. Edit handwritten uses the
page context to open an isolated edit of one existing block. The normal Markdown editor
remains the canonical page editor. Review can insert Markdown, SVG, or PNG;
Transcribe sends a block crop to Ollama and inserts the result as editable Markdown.

Each session lives at `SilverInk/Sessions/<uuid>.json` in the Space. Format 1
contains `id`, `page`, `revision`, `updatedAt`, `width`, `height`, `strokes`,
and `redo`. Each stroke has a stable UUID, tool, width, and ordered `{x,y,p,t}`
points. A block edit fork adds `blockEditOf` so Handwrite will not reopen it as
general ink. Coordinates are world pixels independent of display zoom. Unknown
format
versions are rejected and retained; there is no automatic migration or cleanup.
Offline Phase 2 block IDs reference stroke IDs and a source revision, with a
small stable block reference in Markdown. Format 1 stroke sessions remain
unchanged, so older sessions can be reviewed without migration.

The panel buffers point updates and writes a Space-and-account-scoped `localStorage`
recovery copy every 100 ms during drawing. Completed strokes buffer a Space write
for 300 ms, coalescing quick consecutive strokes; editor actions and closing
flush pending work. Page suspension synchronously flushes the local copy.
Completed strokes, undo, redo, erase, clear, or new session increments the
document revision. The saved file is read back on opening. The copy
with the higher revision wins; an in-progress local stroke also wins at equal
revision if the committed portion matches. An acknowledged-revision marker in
browser storage distinguishes stale local copies from unsynced edits. Divergence
stops recovery and offers the local JSON for download. Unsynced local work is
listed for resumption in Handwrite. A failed Space write leaves the local copy
and a visible error. SilverBullet may sync the Space file to its server later; a
resolved `space.writeFile` means the client accepted the write, not that the
server has confirmed it.
Selecting an earlier session after reload restores its unfinished stroke as a
completed stroke; drawing can then continue with a new stroke.
Close waits for pending writes and warns if a Space write failed. A user can
download the source JSON at any time. SVG and PNG exports are derived locally;
the SVG generator emits only fixed markup and numeric path data.

## Offline block review and insertion

`ui/blocks.js` starts each review as one block, ordering its strokes by their
vertical position. An empty split field leaves it intact. Manual split and merge
change the blocks' stroke ID lists, with each committed
stroke assigned to exactly one block. SVG is generated later from those IDs;
it is never the data used for splitting. The user can transcribe a block with
Ollama or insert it as an SVG or PNG drawing. A block action draft is stored in browser local
storage under the Space/account, session ID, and source revision; changing the
source revision starts a new review without deleting the old draft.

On an explicit per-block insertion action, the panel flushes the capture session, checks
that the current page is still the page and text captured when the panel
opened or last inserted, copies only that block's strokes into a private
`SilverInk/Sessions/<block-id>.json`, writes that block's record to
`SilverInk/Blocks/<id>.json`, writes a deterministic SVG crop or PNG raster
to `SilverInk/Graphics/<id>.<svg|png>`, checks the page again, and inserts only
that block. A successful insert closes the panel. The saved review draft lets
the user reopen New handwritten and select the linked capture to insert another
block or delete the reviewed capture.
The block record holds `id`, `page`, `sessionId`, `sourceRevision`, `strokeIds`,
`kind`, exact `acceptedMarkdown`, optional `svgPath` or `pngPath`, and `createdAt`. Text
blocks use the escaped OCR text directly. Drawing blocks use a relative
Markdown media link, so nested pages can resolve the file in and outside
SilverBullet. Each block begins with
`<!-- silverink:block=<id>;session=<id>;rev=<n> -->`.
The comment keeps the original capture session ID and revision for review
provenance and duplicate-insertion checks; the record points to the private
block session. Split and merge change only review data until insertion. Once
all blocks have been inserted or discarded, a confirmed **Delete reviewed capture** checks
for block records or other pages still using the capture before removing its
Space file and local recovery copy.

`SilverInk: Delete selected block` uses the current editor selection and
checks all Markdown pages for other block markers or image links before
removing the page marker/link and private files. Text Markdown remains.
`SilverInk: Clean orphaned blocks` scans block records against all Markdown
pages and removes only records with no marker or graphic link anywhere, after
confirmation. Capture sessions are intentionally outside this sweep.

The page text comparison prevents known stale-page inserts; the editor syscall
has no conditional compare-and-swap, so another tab could still change the
page between the last check and insertion. A failed asset write stops before
page insertion. Already written assets are retained for recovery and never
cleaned up automatically. A block marker already on the page prevents its
second insertion; an older or different review of the same session is also
rejected to prevent duplicate strokes. Inserted blocks cannot be split or
merged in the current review. Use New session for additional ink after a
review has been inserted. **Delete** on an uninserted block marks it discarded
without revising the capture session, which preserves the reference revision
of already inserted blocks. **Delete** on a published block uses the confirmed
page and private-file deletion path. Each action closes the panel on success.

## Scoped block editing

`SilverInk: Edit handwritten` chooses the block marker at or before the editor
cursor, or the first marker when the cursor precedes all blocks. It validates
the block record, reads its source session, and copies only the referenced
stroke IDs into a new Space-backed edit session. The original session and its
other blocks remain untouched. The block ID still resolves if its Markdown is
moved to another page; the record's `page` names the original source page. A
browser-local pointer resumes an uncommitted
edit draft. On explicit **Save block edits**, it confirms the page and record
have not changed since opening, saves the new session, then updates the block
record's `sessionId`, `sourceRevision`, and `strokeIds`. Drawing blocks also
regenerate the SVG or PNG at the existing path. The Markdown page is not rewritten;
user-edited prose stays authoritative. The page comment's session/revision
therefore remains the original insertion reference, while the block record
contains the current source. A failed record or SVG write leaves the edit
session available for recovery. After a successful save, the prior private
block session is removed if no other block record uses it. **Delete block
strokes** removes the page marker and block record; transcribed Markdown stays,
while a drawing's original link and image are removed. Private stroke files are
deleted only if no other block record uses them. Legacy shared capture files
are retained. The operation checks other pages for duplicate markers and SVG
references before modifying the page; a failed post-page file deletion can
leave orphan files for manual cleanup.

The block marker also serves as the handle for later OCR. **Transcribe /
Re-OCR** rasterizes the saved strokes. For SVG or PNG, it replaces the exact
image link with Markdown, updates the same block record to `text`, and removes
the old graphic. For an unchanged text block, it replaces only the last
accepted transcription and updates the record. When the page text differs,
SilverInk offers to insert the new OCR result before the existing block as
separate Markdown, keeping the edited text and record intact. The source
strokes stay available in all cases. Page and record changes are checked
against their opening versions; a failed record write attempts to restore
the original page text.

## Transcription PoC

`ui/ocr.js` is a provider adapter registry with an Ollama implementation. The
panel rasterizes only the selected stroke block and sends its PNG bytes to
Ollama's `/api/generate` through SilverBullet 2.12's authenticated
`sandboxFetch.fetch` proxy syscall. Ollama receives base64 image data and a
prompt; **Transcribe** escapes the returned text and inserts it as editable
Markdown. The user can correct recognition errors in the page. **Check OCR
provider** calls `/api/tags` to verify the configured model exists. The server
origin and model come from the Library's Space Lua configuration schema and
can be set in the Space's `CONFIG` page. No API
secret is accepted by this PoC. See the [SilverBullet proxy API](https://docs.silverbullet.md/HTTP%20API),
[Ollama generate API](https://docs.ollama.com/api/generate), and
[Ollama model list API](https://docs.ollama.com/api/tags). A separate website's
login cookie cannot be reused by the proxy, so a later cloud adapter should
use a dedicated authenticated server endpoint with credentials kept there.

SilverBullet's block widget toolbar has fixed Reload, Copy, and Edit controls.
The Edit control calls `moveCursorToWidgetStart`; it reveals the widget source
instead of invoking a plug command
([widget implementation](https://github.com/silverbulletmd/silverbullet/blob/main/client/codemirror/lua_widget.ts)).
SilverInk SVGs use standard Markdown image links, so they do not get this
widget toolbar. A widget-specific button could call SilverInk, but would add a
plugin-dependent rendering wrapper around the portable image. The existing
cursor-based command and QuickAccess entry remain the edit path.

The panel focuses its non-editable canvas on opening to move focus away from
SilverBullet's text editor and help dismiss mobile software keyboards. This is
best effort; iPad Safari behavior still needs device testing.

## Limits and follow-up

- Browser storage can be evicted or exhausted. A failed local write stops a
  mutation and displays an error. Download JSON is a manual fallback.
- To bound bitmap allocation in phase 1, the world canvas has a 12-megapixel
  limit. Additional sessions can be created without deleting prior ones.
- `space.writeFile` is not a conditional compare-and-swap API. Concurrent edits
  to the same session in multiple tabs are not merged. Use New session in the
  second tab until conflict handling is added.
- The modal and Pointer Events are supported by the API, but Apple Pencil,
  iPad Safari palm rejection, and touchscreen laptop behavior need hardware
  testing. Touch scrolling and zoom buttons are provided as fallbacks.
- SVG is generated only from validated numeric strokes; it never accepts
  provider-supplied markup. Capture and block records are removed only by
  confirmed user actions; a superseded private source is cleaned up after a
  confirmed block edit succeeds.
