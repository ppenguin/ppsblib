# Agent instructions — SilverInk

## Mission
Build a SilverBullet extension for pen-first, blockwise handwritten notes on touchscreen laptops and iPads. Recognize handwriting into **real, editable Markdown**; preserve non-text drawings as inline SVG; **always retain original vector strokes** with stable references so any block can be viewed, edited, or re-recognized.

Read `README.md` before coding. Treat its user-facing behavior and the invariants below as requirements. Work iteratively and keep the plugin installable at every milestone.

## First task: repository and API reconnaissance
1. Inspect this repository, its language/build conventions, existing tests, and supported SilverBullet version. Do not overwrite existing files or architecture without cause.
2. Inspect the actual SilverBullet source/documentation for its current extension model, Space Lua commands, widgets/panels/modals, editor selection/insertion, storage/attachments, HTTP/proxy options, and mobile behavior. Cite relevant upstream links in implementation notes or code comments where useful. **Do not assume an API exists because it is mentioned in this specification.**
3. Decide on the smallest compatible integration approach. Prefer a SilverBullet library/extension using documented APIs. If fullscreen overlay, cursor restoration, or inline editing is unsupported, implement a working fallback and document the limitation.
4. Produce a short `docs/architecture.md` recording confirmed APIs, major decisions, data format, and any deviations before implementing substantial functionality.

## Non-negotiable invariants
- Markdown is the canonical **rendered/editable document**, not a proprietary replacement editor.
- Strokes are never silently discarded on conversion, cancel, refresh, navigation, or recognition failure.
- Stroke data and recognition output are separate; recognition is an interpretation, not a destructive transformation.
- Each converted block has a stable ID and source revision. Re-recognition never silently overwrites Markdown edited since conversion.
- SVG is used for inline graphics; SVG output must be sanitized before rendering. Do not treat model-generated SVG as trusted.
- A network request is never required to **draw** or to recover saved strokes. Recognition may require a network connection.
- API secrets must never be embedded in client code or saved in SilverBullet pages.
- A user's existing SilverBullet content must not be modified except by an explicit, confirmed insertion/update operation.
- Preserve text readability and reasonable portability outside the plugin. Prefer ordinary Markdown syntax and standard image links; do not make a custom renderer necessary to read recognized prose.

## Target UX
- Command/shortcut opens a nearly fullscreen handwriting surface from a SilverBullet page; restore original editor position/selection after confirmation.
- Works with Apple Pencil on iPad and active stylus on touchscreen laptops, using browser Pointer Events; mouse support for testing.
- Prefer pen to draw and touch to navigate; offer an explicit finger-drawing toggle. Account for platform palm-rejection limitations. Support undo/redo, erase, clear with confirmation, zoom/pan, and responsive layout.
- Continuous writing surface, preferably vertically scrollable. Preserve strokes and their original spatial relationships.
- Explicit **Convert** action segments strokes into candidate blocks, classifies text/list/table/math/drawing/mixed, and returns editable Markdown plus SVG where appropriate.
- Show a review/preview before insertion. Users can accept, correct, switch a block between recognized Markdown and original ink, and retry recognition. Mixed content should preserve reading order.
- **Insert** commits native Markdown into the original page. Drawings appear inline through linked SVG files. Source strokes remain available for later editing.
- If recognition is unavailable, save the ink and allow the user to resume or insert a graphic representation.

## Data model (design target, refine after API reconnaissance)
- Store one versioned vector-stroke document per capture session, with canvas coordinate system, pen paths (x/y, optional pressure, timestamps), and optional page metadata.
- Store block records with stable ID, source session ID, source revision, stroke IDs or spatial region, reading order, classification, recognized content, recognition metadata, and last accepted content hash/revision.
- Preserve spatial context even when a block is resegmented. Prefer referencing strokes by stable stroke IDs over only bounding boxes; avoid duplicating raw strokes per block.
- Generate SVG from stored strokes deterministically, not from untrusted AI-provided markup. Keep originals editable; SVG is a display derivative.
- Suggested page serialization (subject to SilverBullet compatibility):

  ```md
  <!-- silverink:block=abc123;rev=2 -->
  ## Project timeline
  Prototype ready in December.

  <!-- silverink:block=def456;rev=1 -->
  ![](ink/def456.svg)
  ```

- References must be robust to moving blocks with their Markdown. Define what happens if users delete or duplicate a reference. Do not rely on page offsets alone. Implement safe orphan cleanup only after explicit confirmation, not automatic deletion.
- Use a sidecar manifest/index where needed, but retain a small stable ID in the Markdown. Define storage locations and a migration/versioning policy in `docs/architecture.md`.
- Manual edits to accepted Markdown are authoritative. On re-recognition, present a diff or overwrite warning; offer insert-as-new rather than silent replacement.

## Recognition architecture
- Define a provider-neutral interface: image/crop + optional context -> structured recognized blocks with type, ordering, Markdown, uncertainty indicators, and source-region references.
- Begin with a configurable vision-capable model via a **server-side** endpoint/proxy. Keep credentials server-side. Do not hard-code a vendor.
- Render stroke crops locally from trusted source data; send only necessary images and minimal context. Explain privacy implications in settings/docs.
- Treat model output as untrusted: validate schema, bound sizes, sanitize Markdown/links and any rendered HTML, and never execute returned code.
- Instruct recognition to transcribe faithfully, preserve headings/lists/tables/equations where possible, mark ambiguous text rather than invent content, and classify diagrams as graphics.
- Recognition should be explicit, not triggered on every stroke. Make it possible to retry one block without rerunning all blocks.
- Provide a mock provider and fixtures for offline tests. Real-model tests should be opt-in and never required for CI.

## Implementation phases

### Phase 0 — Verify feasibility
- Confirm extension and editor APIs; document fallback strategies.
- Create basic scaffolding, lint/typecheck/test commands, and a minimal command that opens/closes a view.
- Define a storage schema and an explicit persistence/recovery strategy before adding recognition.

### Phase 1 — Reliable ink capture
- Responsive fullscreen or near-fullscreen canvas with pen/mouse, touch navigation, undo/redo, and erase.
- Persist and restore vector strokes; handle tab suspension, reload, and interrupted sessions. Prefer server persistence with local recovery buffering where feasible.
- Export deterministic SVG and raster image for recognition.
- No AI dependency in this phase.

### Phase 2 — Blockwise conversion
- Initial block segmentation using geometric heuristics; preserve reading order and support manual split/merge/reclassification. Avoid overengineering perfect automatic segmentation.
- Provider interface, mock recognizer, optional real vision endpoint, and strict structured-output validation.
- Preview Markdown/SVG blocks and commit them to a SilverBullet page without losing existing content.
- Store stable source references and revisions.

### Phase 3 — Round-trip editing
- Reopen source strokes for a block, change representation between Markdown/ink, and retry recognition.
- Protect user-edited Markdown; display conflicts/diffs when updating.
- Improve mixed text/drawing layouts and per-block conversion.

### Phase 4 — Polish
- iPad Safari and laptop touchscreen usability, performance on long sessions, keyboard shortcuts, accessibility, error handling, privacy controls, and storage cleanup UI.
- Inline editing in the document itself only if the verified SilverBullet API makes it robust. Otherwise retain fullscreen capture + blockwise document integration.

## Testing and acceptance
- Automated tests: stroke serialization round-trip; stable IDs; deterministic SVG; segmentation ordering; Markdown/reference serialization; escaping/sanitization; failed recognition; merge/split; duplicate/missing references; edit-conflict detection; migration.
- Browser/manual matrix: iPad Safari with Pencil; touchscreen laptop in Chromium; mouse fallback; reload during drawing; offline drawing; recognition timeout; long page; mixed diagram and prose; existing page content and cursor position.
- An end-to-end demonstration must show: handwritten heading + list -> native editable Markdown; hand-drawn diagram -> inline SVG; original strokes preserved; a block reopened and re-recognized; manually edited Markdown not silently overwritten.
- No destructive actions without confirmation. No hidden reliance on a single AI provider.

## Working conventions
- Favor small modules: canvas/input, stroke store, segmentation, rendering, recognition adapter, SilverBullet bridge, document serialization, review UI.
- Prefer TypeScript where compatible with repo conventions. Avoid heavyweight UI frameworks unless justified by the existing repo.
- Add tests with each milestone. Run existing test/lint/build checks and report results accurately.
- Keep `README.md` up to date with installation, configuration, limitations, privacy, and user workflow as features become real.
- Do not claim iPad/pen support has been tested unless actually tested on hardware. Distinguish implemented behavior from planned behavior.
- When blocked by a missing SilverBullet API, document evidence and implement the simplest viable fallback rather than inventing an API.

## First Codex execution request
Start with **Phase 0**, then implement **Phase 1** if the verified APIs permit. Create `docs/architecture.md`, scaffold the plugin, and make a working persistent handwriting canvas. Do not start cloud recognition until ink persistence and recovery work. Summarize what is working, how to run it, tests executed, and remaining risks.
