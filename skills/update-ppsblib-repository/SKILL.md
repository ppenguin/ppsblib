---
name: update-ppsblib-repository
description: Update the ppenguin SilverBullet repository page when installable libraries or plugs are added, renamed, or removed in ppsblib.
---

# Update the ppenguin SilverBullet repository

`Repositories/ppenguin.md` is the canonical repository index. Its
`#meta/library/remote` block should list every installable library page under
`src/`, including plug libraries. Keep one entry per library and preserve
unrelated page metadata.

1. Inventory Markdown pages under `src/` tagged `meta/library`; inspect their
   frontmatter rather than relying only on file names. Also inspect
   `*.plug.yaml` manifests so a plug missing an installable library page is
   caught.
2. For each plug, ensure its library page has `name` equal to the destination
   Space page path, lists its compiled `.plug.js` under `files`, and sits beside
   the publishable bundle. Build the bundle and check that it is not Git
   ignored. SilverBullet downloads listed files relative to the library page.
3. Reconcile the remote entries in `Repositories/ppenguin.md` with that
   inventory. Use `https://github.com/ppenguin/ppsblib/blob/main/<path>` for
   each `uri`, and point `website` to useful documentation in this repo. Use
   the library page's actual name and description. Remove an entry only when
   its library has really been removed or superseded.
4. Keep `_test/Makefile` in sync: it should copy every local library page and
   required plug bundle into `_test/testspace/Library/` using the page's
   `name` path. Give each destination its source as a Make prerequisite so
   unchanged files are not recopied. It copies the canonical repository page
   into the test Space, so do not hand-edit the generated copy.
5. Check each local URI path and each listed asset exists; run the relevant
   build and tests, and `docker compose -f _test/compose.yaml config --quiet`.
   Do not push or publish as part of an index update unless requested.

See SilverBullet's [repository](https://docs.silverbullet.md/Repository) and
[library development](https://docs.silverbullet.md/Library/Development)
documentation for the index and asset formats.
