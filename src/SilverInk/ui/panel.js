(async function () {
  "use strict";
  const M = globalThis.SilverInkModel;
  const B = globalThis.SilverInkBlocks;
  const OCR = globalThis.SilverInkOCR;
  const { Store } = globalThis.SilverInkStore;
  const $ = id => document.getElementById(id);
  const canvas = $("ink"), surface = $("surface"), status = $("status");
  $("offline-note").hidden = silverInkContext.syncDocuments === true;
  const ctx = canvas.getContext("2d");
  function focusCanvas() {
    // Move focus off SilverBullet's text editor so mobile keyboards can close.
    try { canvas.focus({ preventScroll: true }); }
    catch { canvas.focus(); }
  }
  focusCanvas();
  const remote = {
    listFiles: () => syscall("space.listFiles"),
    readFile: path => syscall("space.readFile", path),
    writeFile: (path, bytes) => syscall("space.writeFile", path, bytes),
    deleteFile: path => syscall("space.deleteFile", path),
  };
  const store = new Store(localStorage, remote, silverInkContext.scope);
  let doc, zoom = 1, tool = "pen", fingerDraw = false;
  const guideKey = `silverink:guides:${encodeURIComponent(silverInkContext.scope)}`;
  let guides = "off";
  try {
    const savedGuides = localStorage.getItem(guideKey);
    if (["off", "lines", "grid"].includes(savedGuides)) guides = savedGuides;
  } catch { /* guides still work for this panel */ }
  $("guides").textContent = `Guides: ${guides}`;
  let active = null, pan = null, busy = false;
  let review = null, editorBaseline = null;
  let insertBusy = false, insertUncertain = false, captureCleanupBusy = false, ocrBusy = false;
  let captureDeleted = false;
  let blockEdit = null, editCommitted = false;
  const sessionDocs = new Map();
  let renderFrame = null;

  function renderSoon() {
    if (renderFrame !== null) return;
    const request = window.requestAnimationFrame || (callback => setTimeout(callback, 16));
    renderFrame = request(() => { renderFrame = null; render(); });
  }

  function bufferRecovery() {
    store.bufferLocal(doc, e => say(`Local recovery save failed: ${e.message || e}. Download Source JSON and free storage.`, true));
  }

  function updateSessions() {
    const select = $("sessions");
    const items = [...sessionDocs.values()].filter(item => !item.blockEditOf)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    select.replaceChildren(...items.map(item => {
      const option = document.createElement("option");
      option.value = item.id;
      const linked = Boolean(item.blockEditOf) ||
        Boolean(editorBaseline && B.hasSessionMarker(editorBaseline.text, item.id));
      const reviewDraft = localStorage.getItem(`silverink:review:v1:${encodeURIComponent(silverInkContext.scope)}:${item.id}:${item.revision}`);
      option.disabled = linked && !reviewDraft;
      option.textContent = `${new Date(item.updatedAt).toLocaleString()} · ${item.id.slice(0, 8)} · ${item.strokes.length} strokes${linked ? reviewDraft ? " · continue review" : " · use Edit handwritten" : ""}`;
      return option;
    }));
    select.value = doc.id;
  }

  function say(message, error = false) {
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function redraw(context, scale, strokes = [...doc.strokes, ...(doc.inProgress ? [doc.inProgress] : [])],
    bounds = { left: 0, top: 0, width: doc.width, height: doc.height }, guide = "off") {
    context.save();
    context.scale(scale, scale);
    context.translate(-bounds.left, -bounds.top);
    context.fillStyle = "#fff";
    context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
    if (guide !== "off") {
      const step = 48;
      context.beginPath();
      context.strokeStyle = "#dfe8f1";
      context.lineWidth = 1 / scale;
      for (let y = step; y < bounds.height; y += step) {
        context.moveTo(0, y); context.lineTo(bounds.width, y);
      }
      if (guide === "grid") for (let x = step; x < bounds.width; x += step) {
        context.moveTo(x, 0); context.lineTo(x, bounds.height);
      }
      context.stroke();
    }
    context.strokeStyle = "#161b22";
    context.fillStyle = "#161b22";
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
      const points = stroke.points;
      if (!points.length) continue;
      if (points.length === 1) {
        context.beginPath();
        context.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
        context.lineWidth = stroke.width;
        context.stroke();
      }
    }
    context.restore();
  }

  async function pngStrokes(source, strokeIds, maxScale = 1) {
    const selection = M.selectStrokes(source, strokeIds);
    const { width, height } = selection;
    const scale = Math.min(maxScale, 8192 / Math.max(width, height), Math.sqrt(16000000 / (width * height)));
    const bitmap = document.createElement("canvas");
    bitmap.width = Math.max(1, Math.round(width * scale));
    bitmap.height = Math.max(1, Math.round(height * scale));
    redraw(bitmap.getContext("2d"), scale, selection.strokes, selection);
    const blob = await new Promise(resolve => bitmap.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG rendering failed");
    return new Uint8Array(await blob.arrayBuffer());
  }

  function render() {
    if (!doc) return;
    const w = Math.round(doc.width * zoom), h = Math.round(doc.height * zoom);
    const dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (w * h)));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const pixelWidth = Math.max(1, Math.round(w * dpr));
    const pixelHeight = Math.max(1, Math.round(h * dpr));
    // Changing these attributes resets the canvas and can disrupt an active pen.
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw(ctx, zoom, undefined, undefined, guides);
    $("undo").disabled = !doc.strokes.length;
    $("redo").disabled = !doc.redo.length;
  }

  function fit() {
    zoom = Math.max(0.25, Math.min(1.5, (surface.clientWidth - 24) / doc.width));
    render();
  }

  function point(event) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(doc.width, (event.clientX - r.left) / zoom)),
      y: Math.max(0, Math.min(doc.height, (event.clientY - r.top) / zoom)),
      p: event.pressure > 0 ? Math.min(1, event.pressure) : 0.5,
      t: Date.now(),
    };
  }

  function change(edit, sync = true) {
    const next = structuredClone(doc);
    const changed = edit(next);
    if (changed === false) return false;
    try { store.flushLocal(); store.saveLocal(next); }
    catch (e) { say(`Local save failed: ${e.message}. Download Source JSON and free storage.`, true); return false; }
    doc = next;
    sessionDocs.set(doc.id, doc);
    if (sync) updateSessions();
    render();
    if (sync) schedule();
    return true;
  }

  function schedule() {
    const session = doc.id;
    const revision = doc.revision;
    say(`Saving session ${session.slice(0, 8)}…`);
    store.schedule(doc).then(() => {
      if (doc.id === session && doc.revision === revision) say(`Saved session ${session.slice(0, 8)} · revision ${revision}`);
    }).catch(e => {
      if (doc.id === session) say(`Saved locally; Space write failed: ${e.message || e}`, true);
    });
  }

  function scheduleBuffered() {
    const session = doc.id, revision = doc.revision;
    say(`Saving session ${session.slice(0, 8)}…`);
    store.bufferRemote(doc).then(() => {
      if (doc.id === session && doc.revision === revision) {
        updateSessions();
        say(`Saved session ${session.slice(0, 8)} · revision ${revision}`);
      }
    }).catch(e => {
      if (doc.id === session) {
        updateSessions();
        say(`Saved locally; Space write failed: ${e.message || e}`, true);
      }
    });
  }

  function finish() {
    if (active === null) return;
    const wasDrawing = !active.erase;
    active = null;
    if (wasDrawing && M.finish(doc)) {
      bufferRecovery();
      sessionDocs.set(doc.id, doc);
      renderSoon();
      scheduleBuffered();
    }
  }

  function reviewKey() {
    return `silverink:review:v1:${encodeURIComponent(silverInkContext.scope)}:${doc.id}:${doc.revision}`;
  }

  function saveReview(next) {
    B.validate(doc, next);
    review = next;
    try { localStorage.setItem(reviewKey(), JSON.stringify(review)); return true; }
    catch (e) { say(`Review draft is only in this open panel: ${e.message}`, true); return false; }
  }

  function ocrSettings() {
    return silverInkContext.ocr;
  }
  $("ocr-config").textContent = `OCR: ${ocrSettings().model} at ${ocrSettings().endpoint} · configure in CONFIG`;
  $("ocr-check").onclick = async () => {
    if (ocrBusy) return;
    ocrBusy = true;
    $("ocr-check").disabled = true;
    if (review) renderReview();
    try {
      say(`Checking ${ocrSettings().model}…`);
      say(await OCR.check(ocrSettings().provider, ocrSettings(), (url, options) =>
        syscall("sandboxFetch.fetch", url, options)));
    } catch (e) { say(`Provider check failed: ${e.message || e}`, true); }
    finally { ocrBusy = false; $("ocr-check").disabled = false; if (review) renderReview(); }
  };

  async function ensureSourceSaved() {
    if (await store.flush()) return true;
    try { await store.schedule(doc); return true; }
    catch { return false; }
  }

  function editDraftKey(record) {
    return `silverink:block-edit:v1:${encodeURIComponent(silverInkContext.scope)}:${record.id}:${record.sessionId}:${record.sourceRevision}`;
  }

  async function openBlockEdit() {
    const marker = B.blockAt(editorBaseline.text, editorBaseline.selection.from);
    const recordPath = `SilverInk/Blocks/${marker.id}.json`;
    const decoder = new TextDecoder();
    const recordText = decoder.decode(await remote.readFile(recordPath));
    const record = B.validateRecord(JSON.parse(recordText));
    if (record.id !== marker.id) throw new Error("The page reference and block record do not match");
    const key = editDraftKey(record);
    const draftId = localStorage.getItem(key);
    if (draftId) {
      const local = store.readLocal(draftId);
      let remoteDoc = null;
      try { remoteDoc = await store.readRemote(draftId); }
      catch (e) { if (!local) throw e; }
      if (local && remoteDoc) {
        const committedLocal = local.inProgress ? { ...local, inProgress: null } : local;
        if (remoteDoc.revision > local.revision ||
            (remoteDoc.revision === local.revision &&
              JSON.stringify(committedLocal) !== JSON.stringify(remoteDoc))) {
          const error = new Error("The block edit draft has divergent copies; download the local source JSON before continuing");
          error.recovery = local;
          throw error;
        }
      }
      doc = local && (!remoteDoc || local.revision > remoteDoc.revision || local.inProgress)
        ? local : remoteDoc;
      if (!doc || doc.page !== record.page || doc.id === record.sessionId) {
        throw new Error("The block edit draft is missing or invalid; its reference was retained");
      }
      M.validate(doc);
    } else {
      const source = M.validate(JSON.parse(decoder.decode(await remote.readFile(`SilverInk/Sessions/${record.sessionId}.json`))));
      doc = B.editCopy(record, source);
      store.saveLocal(doc);
      localStorage.setItem(key, doc.id);
      store.schedule(doc).catch(e => say(`Block edit draft is local only: ${e.message || e}`, true));
    }
    blockEdit = { record, recordPath, recordText, draftKey: key };
    sessionDocs.set(doc.id, doc);
    updateSessions();
    $("sessions").disabled = true;
    $("sessions").hidden = true;
    $("new").disabled = true;
    $("new").hidden = true;
    $("review").hidden = true;
    $("update-block").hidden = false;
    $("transcribe-existing").hidden = false;
    $("delete-block").hidden = false;
    fit();
    say(`Editing block ${record.id.slice(0, 8)} · ${doc.strokes.length} source strokes. Save block edits to apply.`);
    if (doc.inProgress && change(next => M.finish(next))) {
      say("Recovered an interrupted block stroke; save block edits when ready.");
    }
  }

  async function saveBlockEdits() {
    if (!blockEdit || busy || editCommitted) return;
    finish();
    if (!doc.strokes.length) { say("Draw at least one stroke before saving this block.", true); return; }
    busy = true;
    $("update-block").disabled = true;
    $("transcribe-existing").disabled = true;
    let recordWritten = false;
    try {
      if (!await ensureSourceSaved()) throw new Error("Edited strokes have not been saved to the Space");
      await assertEditorUnchanged();
      const currentRecordText = new TextDecoder().decode(await remote.readFile(blockEdit.recordPath));
      if (currentRecordText !== blockEdit.recordText) {
        throw new Error("The block record changed elsewhere. Close and reopen before updating it.");
      }
      if (!confirm(`Save the edited strokes for this block? Its Markdown will remain unchanged${blockEdit.record.kind === "drawing" ? " and its drawing SVG will be updated" : blockEdit.record.kind === "png" ? " and its drawing PNG will be updated" : ""}.`)) return;
      const next = { ...blockEdit.record, sessionId: doc.id, sourceRevision: doc.revision,
        strokeIds: doc.strokes.map(stroke => stroke.id), updatedAt: Date.now() };
      B.validateRecord(next, blockEdit.record.page);
      const encoder = new TextEncoder();
      await remote.writeFile(blockEdit.recordPath, encoder.encode(JSON.stringify(next, null, 2)));
      recordWritten = true;
      if (next.kind === "drawing") {
        await remote.writeFile(next.svgPath, encoder.encode(M.svgStrokes(doc, next.strokeIds)));
      } else if (next.kind === "png") {
        await remote.writeFile(next.pngPath, await pngStrokes(doc, next.strokeIds));
      }
      let cleanupWarning = null;
      try { await deleteOwnedSource(blockEdit.record.sessionId, blockEdit.record.id,
        blockEdit.recordPath); }
      catch (e) { cleanupWarning = e; }
      try { localStorage.removeItem(blockEdit.draftKey); } catch { /* source is saved in the Space */ }
      try { store.forget(doc.id, doc.page); } catch { /* source is saved in the Space */ }
      editCommitted = true;
      say(cleanupWarning
        ? `Block updated; old source cleanup failed: ${cleanupWarning.message || cleanupWarning}`
        : "Block strokes updated. Markdown was left unchanged.", Boolean(cleanupWarning));
      $("delete-block").disabled = true;
      if (!cleanupWarning) {
        await syscall("editor.hidePanel", "modal");
        await syscall("editor.focus");
      }
    } catch (e) {
      say(recordWritten
        ? `Block source was updated, but the operation may be incomplete. Reopen this block to retry: ${e.message}`
        : `Block was not updated; its edit draft remains saved: ${e.message}`, true);
    } finally {
      busy = false;
      $("update-block").disabled = editCommitted || recordWritten;
      $("transcribe-existing").disabled = editCommitted || recordWritten;
    }
  }

  async function transcribeExistingBlock() {
    if (!blockEdit || busy || editCommitted) return;
    if (doc.revision !== 0 || doc.inProgress) {
      say("Save block edits and reopen this block before transcribing its changed strokes.", true);
      return;
    }
    busy = true;
    $("transcribe-existing").disabled = true;
    $("update-block").disabled = true;
    $("delete-block").disabled = true;
    let pageMutationAttempted = false, pageUpdated = false, recordWritten = false;
    let expected, original, from, replacement, originalRange;
    try {
      await assertEditorUnchanged();
      original = editorBaseline.text;
      const record = blockEdit.record;
      const marker = B.blockAt(original, editorBaseline.selection.from);
      const deletion = B.prepareDeletion(original, marker, record);
      if (record.kind !== "text") {
        const imageLink = `Graphics/${record.id}.${record.kind === "png" ? "png" : "svg"}`;
        if (original.slice(0, deletion.from).includes(imageLink) ||
            original.slice(deletion.to).includes(imageLink)) {
          throw new Error("This page also uses the image elsewhere; remove that link first");
        }
        await assertNoOtherPageReference(record);
      }
      if (!doc.strokes.length) throw new Error("This block has no source strokes to transcribe");
      say(`Transcribing saved block with ${ocrSettings().model}…`);
      const image = await pngStrokes(doc, doc.strokes.map(stroke => stroke.id), 8);
      const transcription = await OCR.recognize(ocrSettings().provider,
        { ...ocrSettings(), image }, (url, options) => syscall("sandboxFetch.fetch", url, options));
      await assertEditorUnchanged();
      const currentRecordText = new TextDecoder().decode(await remote.readFile(blockEdit.recordPath));
      if (currentRecordText !== blockEdit.recordText) {
        throw new Error("The block record changed elsewhere. Close and reopen before transcribing.");
      }
      let to, next = null;
      if (record.kind === "text") {
        const textStart = deletion.to;
        const textEnd = textStart + record.acceptedMarkdown.length;
        const tail = original.slice(textEnd);
        const unchanged = Boolean(record.acceptedMarkdown) &&
          original.slice(textStart, textEnd) === record.acceptedMarkdown &&
          (!tail || tail === "\n" || tail.startsWith("\n\n"));
        if (unchanged) {
          from = textStart;
          to = textStart + record.acceptedMarkdown.length;
          replacement = transcription;
          next = { ...record, acceptedMarkdown: transcription, updatedAt: Date.now() };
        } else {
          if (!confirm("This block's Markdown was edited. Insert the new OCR text before the existing block and keep your edits?")) {
            say("Re-OCR canceled. Existing Markdown and strokes remain unchanged.");
            return;
          }
          from = to = deletion.from;
          replacement = `${transcription}\n\n`;
        }
      } else {
        from = deletion.from;
        to = deletion.to;
        const markerText = original.slice(deletion.from,
          deletion.from + `<!-- silverink:block=${marker.id};session=${marker.sessionId};rev=${marker.sourceRevision} -->`.length);
        replacement = `${markerText}\n${transcription}`;
        next = { ...record, kind: "text", acceptedMarkdown: transcription,
          svgPath: null, pngPath: null, updatedAt: Date.now() };
      }
      if (next) B.validateRecord(next, record.page);
      await assertEditorUnchanged();
      originalRange = original.slice(from, to);
      expected = original.slice(0, from) + replacement + original.slice(to);
      pageMutationAttempted = true;
      await syscall("editor.replaceRange", from, to, replacement);
      await syscall("editor.save");
      const current = await editorState();
      if (current.page !== silverInkContext.page || current.text !== expected) {
        throw new Error("The page changed during transcription. Check it before continuing.");
      }
      pageUpdated = true;
      if (next) {
        await remote.writeFile(blockEdit.recordPath, new TextEncoder().encode(JSON.stringify(next, null, 2)));
        recordWritten = true;
      }
      editorBaseline = current;
      editCommitted = true;
      let cleanupWarning = null;
      try {
        if (record.kind !== "text") await remote.deleteFile(record.svgPath || record.pngPath);
        if (await deleteOwnedSource(doc.id, record.id, blockEdit.recordPath)) {
          store.forget(doc.id, doc.page);
        }
        localStorage.removeItem(blockEdit.draftKey);
      } catch (e) { cleanupWarning = e; }
      say(cleanupWarning
        ? `OCR text inserted; cleanup failed: ${cleanupWarning.message || cleanupWarning}`
        : next ? "Transcription inserted as Markdown. Source strokes remain saved."
          : "New OCR text inserted before your edited Markdown. Source strokes remain saved.", Boolean(cleanupWarning));
      await syscall("editor.hidePanel", "modal");
      await syscall("editor.focus");
    } catch (e) {
      if (pageUpdated && !recordWritten && !editCommitted) {
        try {
          const current = await editorState();
          if (current.page === silverInkContext.page && current.text === expected) {
            await syscall("editor.replaceRange", from, from + replacement.length, originalRange);
            await syscall("editor.save");
            const restored = await editorState();
            if (restored.page === silverInkContext.page && restored.text === original) {
              pageUpdated = false;
              pageMutationAttempted = false;
            }
          }
        } catch { /* report the uncertain page state below */ }
      }
      if (pageMutationAttempted) editCommitted = true;
      say(pageUpdated
        ? `The page has OCR text, but its block record may be stale. Check the page before retrying: ${e.message || e}`
        : pageMutationAttempted
          ? `The page change may have happened. Check it before retrying: ${e.message || e}`
          : `Transcription failed; the image and strokes remain: ${e.message || e}`, true);
    } finally {
      busy = false;
      $("transcribe-existing").disabled = editCommitted;
      $("update-block").disabled = editCommitted;
      $("delete-block").disabled = editCommitted;
    }
  }

  async function deleteOwnedSource(sessionId, blockId, excludedRecordPath) {
    const path = `SilverInk/Sessions/${sessionId}.json`;
    const source = M.validate(JSON.parse(new TextDecoder().decode(await remote.readFile(path))));
    if (source.blockEditOf !== blockId) return false;
    const files = await remote.listFiles();
    for (const file of files) {
      if (!/^SilverInk\/Blocks\/[\w-]{8,80}\.json$/.test(file.name) ||
          file.name === excludedRecordPath) continue;
      const other = JSON.parse(new TextDecoder().decode(await remote.readFile(file.name)));
      if (other.sessionId === sessionId) return false;
    }
    await remote.deleteFile(path);
    return true;
  }

  async function assertNoOtherPageReference(record) {
    const files = await remote.listFiles();
    const decoder = new TextDecoder();
    for (const file of files) {
      if (!file.name.endsWith(".md") || file.name === `${silverInkContext.page}.md`) continue;
      const text = decoder.decode(await remote.readFile(file.name));
      if (B.hasBlockMarker(text, record.id) ||
          ((record.svgPath || record.pngPath) && text.includes(`Graphics/${record.id}.${record.kind === "png" ? "png" : "svg"}`))) {
        throw new Error("Another page references this block or image; no files were removed");
      }
    }
  }

  async function deleteBlock(target = blockEdit, reviewIndex = null) {
    const fromReview = reviewIndex !== null;
    if (!target || (fromReview ? insertBusy || insertUncertain || captureCleanupBusy || ocrBusy : busy || editCommitted)) return;
    if (fromReview) { insertBusy = true; renderReview(); }
    else { busy = true; $("delete-block").disabled = true; $("transcribe-existing").disabled = true; }
    let pageMutationAttempted = false, pageRemoved = false, reviewSaved = true;
    try {
      await assertEditorUnchanged();
      const currentRecordText = new TextDecoder().decode(await remote.readFile(target.recordPath));
      if (currentRecordText !== target.recordText) {
        throw new Error("The block record changed elsewhere. Close and reopen before deleting it.");
      }
      const markerPos = fromReview
        ? editorBaseline.text.indexOf(`<!-- silverink:block=${target.record.id};`)
        : editorBaseline.selection.from;
      const marker = B.blockAt(editorBaseline.text, markerPos);
      const deletion = B.prepareDeletion(editorBaseline.text, marker, target.record);
      const graphicPath = target.record.svgPath || target.record.pngPath;
      const otherLink = `Graphics/${target.record.id}.${target.record.kind === "png" ? "png" : "svg"}`;
      if (graphicPath && (
          editorBaseline.text.slice(0, deletion.from).includes(otherLink) ||
          editorBaseline.text.slice(deletion.to).includes(otherLink))) {
        throw new Error("This page also uses the image elsewhere; remove that link first");
      }
      await assertNoOtherPageReference(target.record);
      const description = target.record.kind === "text"
        ? "Its transcribed Markdown will stay on the page."
        : "Its image link will be removed from the page.";
      if (!confirm(`Delete this block's strokes and source record? ${description}`)) return;
      if (!await store.flush()) throw new Error("The strokes have not been saved to the Space");
      await assertEditorUnchanged();
      pageMutationAttempted = true;
      await syscall("editor.replaceRange", deletion.from, deletion.to, deletion.replacement);
      await syscall("editor.save");
      const current = await editorState();
      if (current.page !== silverInkContext.page || current.text !== deletion.expected) {
        throw new Error("The page changed during deletion. Check it before continuing.");
      }
      pageRemoved = true;
      editorBaseline = current;
      if (fromReview) {
        const next = structuredClone(review);
        next.blocks[reviewIndex].kind = "discarded";
        reviewSaved = saveReview(next);
      } else editCommitted = true;
      await remote.deleteFile(target.recordPath);
      if (graphicPath) await remote.deleteFile(graphicPath);
      await deleteOwnedSource(target.record.sessionId, target.record.id, target.recordPath);
      if (!fromReview && doc.id !== target.record.sessionId) {
        if (await deleteOwnedSource(doc.id, target.record.id, target.recordPath)) {
          store.forget(doc.id, doc.page);
        }
      }
      if (target.draftKey) {
        try { localStorage.removeItem(target.draftKey); } catch { /* already unlinked */ }
      }
      say(reviewSaved ? "Block strokes deleted." : "Block deleted; review draft is only in this open panel.", !reviewSaved);
      if (reviewSaved) await syscall("editor.hidePanel", "modal");
      if (!fromReview) await syscall("editor.focus");
    } catch (e) {
      if (pageMutationAttempted) {
        if (fromReview) insertUncertain = true;
        else editCommitted = true;
      }
      say(pageRemoved
        ? `The page was updated, but file cleanup failed. Some SilverInk files may remain: ${e.message || e}`
        : pageMutationAttempted
          ? `The page change may have happened. Check the page before retrying: ${e.message || e}`
          : `Block was not deleted: ${e.message || e}`, true);
    } finally {
      if (fromReview) { insertBusy = false; renderReview(); }
      else {
        busy = false;
        $("delete-block").disabled = editCommitted;
        $("update-block").disabled = editCommitted;
        $("transcribe-existing").disabled = editCommitted;
      }
    }
  }

  async function deleteReviewBlock(index) {
    if (!review || insertBusy || insertUncertain || captureCleanupBusy || ocrBusy) return;
    const block = review.blocks[index];
    if (!block || block.kind === "discarded") return;
    if (!B.hasBlockMarker(editorBaseline.text, block.id)) {
      if (!confirm(`Discard block ${index + 1} from this review? Its strokes remain in the capture until you delete that capture.`)) return;
      const next = structuredClone(review);
      next.blocks[index].kind = "discarded";
      if (saveReview(next)) {
        say(`Block ${index + 1} discarded from review.`);
        await syscall("editor.hidePanel", "modal");
      } else renderReview();
      return;
    }
    try {
      const recordPath = `SilverInk/Blocks/${block.id}.json`;
      const recordText = new TextDecoder().decode(await remote.readFile(recordPath));
      const record = B.validateRecord(JSON.parse(recordText));
      if (record.id !== block.id) throw new Error("The block record and review do not match");
      await deleteBlock({ record, recordPath, recordText }, index);
    } catch (e) { say(`Could not delete block ${index + 1}: ${e.message || e}`, true); }
  }

  function reviewMode(enabled) {
    busy = enabled;
    $("surface").hidden = enabled;
    $("review-panel").hidden = !enabled;
    $("close").hidden = enabled;
    for (const id of ["pen", "eraser", "finger", "guides", "undo", "redo", "clear",
      "zoomout", "zoomin", "zoomfit", "new", "sessions", "review"]) $(id).disabled = enabled;
    if (!enabled) render();
  }

  function renderReview() {
    $("review-back").disabled = insertBusy || captureCleanupBusy || ocrBusy;
    $("close").disabled = insertBusy || captureCleanupBusy;
    const allResolved = review.blocks.every(block => block.kind === "discarded" ||
      B.hasBlockMarker(editorBaseline.text, block.id));
    $("delete-capture").hidden = !allResolved || captureDeleted;
    $("delete-capture").disabled = insertBusy || captureCleanupBusy || insertUncertain || ocrBusy;
    $("ocr-check").disabled = ocrBusy;
    const list = $("review-list");
    list.replaceChildren();
    review.blocks.forEach((block, index) => {
      const inserted = B.hasBlockMarker(editorBaseline.text, block.id);
      const locked = inserted || block.kind === "discarded" || insertBusy || insertUncertain || captureCleanupBusy || ocrBusy;
      const card = document.createElement("article");
      card.className = "review-block";
      const title = document.createElement("strong");
      title.textContent = `Block ${index + 1} · ${block.strokeIds.length} stroke${block.strokeIds.length === 1 ? "" : "s"}`;
      card.append(title);
      if (inserted) {
        const note = document.createElement("p");
        note.textContent = `Inserted as ${block.kind}. The source strokes remain in the session.`;
        card.append(note);
      } else if (block.kind === "discarded") {
        const note = document.createElement("p");
        note.textContent = "Discarded from review. Capture strokes remain until capture cleanup.";
        card.append(note);
      }

      const preview = document.createElement("div");
      preview.className = "block-preview";
      preview.innerHTML = M.svgStrokes(doc, block.strokeIds);
      const media = document.createElement("div");
      media.className = "block-media";
      const actions = document.createElement("div");
      actions.className = "block-actions";
      for (const [title, action] of [["Transcribe", () => transcribeBlock(index)],
        ["SVG", () => insertBlock(index, "drawing")], ["Delete", () => deleteReviewBlock(index)]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = title;
        button.disabled = title === "Delete"
          ? block.kind === "discarded" || insertBusy || insertUncertain || captureCleanupBusy || ocrBusy
          : locked;
        button.onclick = action;
        actions.append(button);
      }
      media.append(preview, actions);
      card.append(media);
      const pngButton = document.createElement("button");
      pngButton.type = "button";
      pngButton.className = "secondary-action";
      pngButton.textContent = "PNG instead";
      pngButton.disabled = locked;
      pngButton.onclick = () => insertBlock(index, "png");
      card.append(pngButton);

      const controls = document.createElement("div");
      controls.className = "block-controls";

      if (block.strokeIds.length > 1) {
        const splitLabel = document.createElement("label");
        splitLabel.textContent = "Split after stroke ";
        const splitAt = document.createElement("input");
        splitAt.type = "number"; splitAt.min = "1";
        splitAt.max = String(block.strokeIds.length - 1);
        splitAt.value = "";
        splitLabel.append(splitAt);
        controls.append(splitLabel);
        const boundary = document.createElement("div");
        boundary.className = "split-boundary";
        let splitButton;
        const showBoundary = () => {
          const after = Number(splitAt.value);
          const valid = splitAt.value !== "" && Number.isInteger(after) &&
            after >= 1 && after < block.strokeIds.length;
          if (splitButton) splitButton.disabled = locked || !valid;
          if (!valid) {
            boundary.textContent = "Enter a stroke number only if you want to split this block.";
            return;
          }
          boundary.replaceChildren();
          for (const [caption, strokeId] of [
            [`Stroke ${after} (before split)`, block.strokeIds[after - 1]],
            [`Stroke ${after + 1} (after split)`, block.strokeIds[after]],
          ]) {
            const item = document.createElement("div");
            const heading = document.createElement("span");
            heading.textContent = caption;
            const preview = document.createElement("div");
            preview.className = "split-stroke";
            preview.innerHTML = M.svgStrokes(doc, [strokeId]);
            item.append(heading, preview);
            boundary.append(item);
          }
        };
        splitAt.oninput = showBoundary;
        splitButton = document.createElement("button");
        splitButton.type = "button"; splitButton.textContent = "Split";
        splitButton.disabled = true;
        splitButton.onclick = () => {
          if (locked) return;
          try { saveReview(B.split(doc, review, index, Number(splitAt.value))); renderReview(); }
          catch (e) { say(e.message, true); }
        };
        controls.append(splitButton);
        splitAt.disabled = locked;
        card.append(controls, boundary);
        showBoundary();
      } else {
        card.append(controls);
      }
      if (index < review.blocks.length - 1) {
        const mergeButton = document.createElement("button");
        mergeButton.type = "button"; mergeButton.textContent = "Merge with next";
        mergeButton.disabled = locked || B.hasBlockMarker(editorBaseline.text, review.blocks[index + 1].id);
        mergeButton.onclick = () => {
          if (locked || B.hasBlockMarker(editorBaseline.text, review.blocks[index + 1].id)) return;
          try { saveReview(B.merge(doc, review, index)); renderReview(); }
          catch (e) { say(e.message, true); }
        };
        controls.append(mergeButton);
      }

      list.append(card);
    });
  }

  async function transcribeBlock(index) {
    if (!review || ocrBusy || insertBusy || captureCleanupBusy || insertUncertain) return;
    const block = review.blocks[index];
    if (!block || block.kind === "discarded" || B.hasBlockMarker(editorBaseline.text, block.id)) return;
    const sessionId = doc.id, revision = doc.revision, blockId = block.id;
    let recognized = false;
    ocrBusy = true;
    renderReview();
    try {
      say(`Transcribing block ${index + 1} with ${ocrSettings().model}…`);
      const image = await pngStrokes(doc, block.strokeIds, 8);
      const transcription = await OCR.recognize(ocrSettings().provider,
        { ...ocrSettings(), image }, (url, options) => syscall("sandboxFetch.fetch", url, options));
      if (doc.id !== sessionId || doc.revision !== revision || review.blocks[index]?.id !== blockId) {
        throw new Error("The block changed while transcription was running");
      }
      const next = structuredClone(review);
      next.blocks[index].markdown = transcription;
      saveReview(next);
      recognized = true;
    } catch (e) { say(`Transcription failed: ${e.message || e}`, true); }
    finally { ocrBusy = false; renderReview(); }
    if (recognized) await insertBlock(index, "text");
  }

  async function editorState() {
    const [page, text, selection] = await Promise.all([
      syscall("editor.getCurrentPage"), syscall("editor.getText"), syscall("editor.getSelection"),
    ]);
    return { page, text, selection };
  }

  async function assertEditorUnchanged() {
    const current = await editorState();
    if (current.page !== silverInkContext.page || current.text !== editorBaseline.text) {
      throw new Error("The page changed during review. Close and reopen SilverInk before inserting.");
    }
  }

  async function insertBlock(index, kind) {
    if (!review || !editorBaseline || insertBusy || insertUncertain || captureCleanupBusy || ocrBusy) return;
    const block = review.blocks[index];
    if (!block) return;
    let attemptedPageInsert = false, committed = false;
    insertBusy = true;
    renderReview();
    try {
      B.validate(doc, review);
      if (!await ensureSourceSaved()) throw new Error("Source strokes have not been saved to the Space");
      await assertEditorUnchanged();
      const pos = editorBaseline.selection.from;
      const prepared = B.prepareBlock(doc, review, block.id, kind, editorBaseline.text, pos);
      say(`Saving block ${index + 1} source and drawing…`);
      const pngBytes = kind === "png" ? await pngStrokes(doc, block.strokeIds) : null;
      const encoder = new TextEncoder();
      for (const file of prepared.files) await remote.writeFile(file.path, encoder.encode(file.content));
      if (pngBytes) await remote.writeFile(`SilverInk/Graphics/${block.id}.png`, pngBytes);
      await assertEditorUnchanged();
      attemptedPageInsert = true;
      await syscall("editor.insertAtPos", prepared.insertion, pos);
      await syscall("editor.moveCursor", pos + prepared.insertion.length, true);
      if (editorBaseline.selection.to !== pos) {
        await syscall("editor.setSelection", pos + prepared.insertion.length,
          editorBaseline.selection.to + prepared.insertion.length);
      }
      await syscall("editor.save");
      const expected = editorBaseline.text.slice(0, pos) + prepared.insertion + editorBaseline.text.slice(pos);
      const current = await editorState();
      if (current.page !== silverInkContext.page || current.text !== expected) {
        throw new Error("The page changed while this block was inserted. Close and reopen SilverInk.");
      }
      editorBaseline = current;
      const next = structuredClone(review);
      next.blocks[index].kind = kind;
      const reviewSaved = saveReview(next);
      committed = true;
      if (reviewSaved) {
        say(`Block ${index + 1} inserted as ${kind}.`);
        await syscall("editor.hidePanel", "modal");
      } else say(`Block ${index + 1} inserted, but the review draft is only in this open panel.`, true);
    } catch (e) {
      if (attemptedPageInsert && !committed) insertUncertain = true;
      say(committed
        ? `Block was inserted, but the panel could not close: ${e.message}`
        : attemptedPageInsert
        ? `Block insertion may have happened. Check the page and reopen SilverInk: ${e.message}`
        : `Nothing was inserted into the page: ${e.message}`, true);
    } finally {
      insertBusy = false;
      renderReview();
    }
  }

  async function deleteReviewedCapture() {
    if (!review || insertBusy || insertUncertain || captureCleanupBusy || ocrBusy || captureDeleted ||
        !review.blocks.every(block => block.kind === "discarded" ||
          B.hasBlockMarker(editorBaseline.text, block.id))) return;
    captureCleanupBusy = true;
    renderReview();
    try {
      B.validate(doc, review);
      await assertEditorUnchanged();
      if (!await store.flush()) throw new Error("The capture has not been saved to the Space");
      const files = await remote.listFiles();
      const decoder = new TextDecoder();
      for (const file of files) {
        if (/^SilverInk\/Blocks\/[\w-]{8,80}\.json$/.test(file.name)) {
          const record = JSON.parse(decoder.decode(await remote.readFile(file.name)));
          if (record.sessionId === doc.id) {
            throw new Error("A block record still uses this capture session");
          }
        } else if (file.name.endsWith(".md") && file.name !== `${doc.page}.md`) {
          const page = decoder.decode(await remote.readFile(file.name));
          if (B.hasSessionMarker(page, doc.id)) {
            throw new Error("Another page still references this capture session");
          }
        }
      }
      if (!confirm("All published blocks have their own stroke files. Delete the original capture session and its local recovery copy?")) return;
      await assertEditorUnchanged();
      await remote.deleteFile(`SilverInk/Sessions/${doc.id}.json`);
      captureDeleted = true;
      store.forget(doc.id, doc.page);
      try { localStorage.removeItem(reviewKey()); } catch { /* capture was removed from the Space */ }
      sessionDocs.delete(doc.id);
      say("Original capture removed. Each inserted block keeps its own strokes.");
      await syscall("editor.hidePanel", "modal");
      await syscall("editor.focus");
    } catch (e) {
      say(captureDeleted
        ? `Capture file was removed, but local cleanup failed: ${e.message || e}`
        : `Capture was not removed: ${e.message || e}`, true);
    } finally {
      captureCleanupBusy = false;
      renderReview();
    }
  }

  canvas.addEventListener("pointerdown", event => {
    focusCanvas();
    if (busy || !doc || pan !== null) return;
    if (event.pointerType === "touch" && !fingerDraw) {
      if (active !== null) return;
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: surface.scrollLeft, top: surface.scrollTop };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (active !== null) {
      if (event.pointerType === "touch") return;
      // A new pen or mouse down proves the previous stroke has ended, even if
      // its pointerup was lost (for example when the pointer left this frame).
      finish();
    }
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    if (tool === "erase" || event.button === 5) {
      active = { id: event.pointerId, erase: true };
      change(next => M.eraseAt(next, point(event)));
    } else {
      active = { id: event.pointerId, erase: false };
      const stroke = { id: M.freshId(), tool: "pen", width: 2.5, points: [point(event)] };
      doc.inProgress = stroke;
      bufferRecovery();
      renderSoon();
    }
  });

  canvas.addEventListener("pointermove", event => {
    if (pan && pan.id === event.pointerId) {
      surface.scrollLeft = pan.left + pan.x - event.clientX;
      surface.scrollTop = pan.top + pan.y - event.clientY;
      return;
    }
    if (!active || active.id !== event.pointerId) return;
    event.preventDefault();
    if (active.erase) {
      change(next => M.eraseAt(next, point(event)));
    } else {
      const p = point(event);
      const points = doc.inProgress.points;
      const last = points[points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return;
      points.push(p);
      if (p.y > doc.height - 150) doc.height = Math.min(10000, doc.height + 1200);
      bufferRecovery();
      renderSoon();
    }
  });

  function endPointer(event) {
    if (pan && pan.id === event.pointerId) { pan = null; return; }
    if (active && active.id === event.pointerId) finish();
  }
  // Capture at window level so a release outside the canvas ends the stroke.
  window.addEventListener("pointerup", endPointer, true);
  window.addEventListener("pointercancel", endPointer, true);
  canvas.addEventListener("lostpointercapture", endPointer);
  function saveRecoveryOnSuspend() {
    try { store.flushLocal(); }
    catch (e) { say(`Local recovery save failed: ${e.message || e}`, true); }
  }
  window.addEventListener("pagehide", saveRecoveryOnSuspend);
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveRecoveryOnSuspend();
  });

  function setTool(value) {
    tool = value;
    $("pen").setAttribute("aria-pressed", String(tool === "pen"));
    $("eraser").setAttribute("aria-pressed", String(tool === "erase"));
  }
  $("pen").onclick = () => setTool("pen");
  $("eraser").onclick = () => setTool("erase");
  $("finger").onclick = () => {
    fingerDraw = !fingerDraw;
    $("finger").textContent = `Finger draws: ${fingerDraw ? "on" : "off"}`;
    $("finger").setAttribute("aria-pressed", String(fingerDraw));
  };
  $("guides").onclick = () => {
    guides = guides === "off" ? "lines" : guides === "lines" ? "grid" : "off";
    $("guides").textContent = `Guides: ${guides}`;
    try { localStorage.setItem(guideKey, guides); } catch { /* preference stays in this panel */ }
    render();
  };
  $("undo").onclick = () => change(next => M.undo(next));
  $("redo").onclick = () => change(next => M.redo(next));
  window.addEventListener("keydown", event => {
    if (!doc || busy || !(event.ctrlKey || event.metaKey) || event.altKey ||
        ["TEXTAREA", "INPUT", "SELECT"].includes(event.target?.tagName)) return;
    const key = event.key.toLowerCase();
    const redo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
    if (!(key === "z" || redo)) return;
    event.preventDefault();
    finish();
    change(next => redo ? M.redo(next) : M.undo(next));
  });
  $("clear").onclick = () => {
    if (!confirm(blockEdit
      ? "Clear all strokes in this block edit? The original block source remains saved until you choose Save block edits."
      : "Clear all strokes in this session? You can still recover them from a previously downloaded source file.")) return;
    change(next => {
      if (!next.strokes.length && !next.inProgress) return false;
      next.strokes = []; next.redo = []; next.inProgress = null; M.touch(next);
    });
  };
  $("zoomout").onclick = () => { zoom = Math.max(0.25, zoom / 1.25); render(); };
  $("zoomin").onclick = () => { zoom = Math.min(2, zoom * 1.25); render(); };
  $("zoomfit").onclick = fit;
  $("review").onclick = async () => {
    if (!doc || busy || blockEdit) return;
    if (insertUncertain) { say("Close and reopen SilverInk before inserting another block.", true); return; }
    finish();
    if (!doc.strokes.length) { say("Draw at least one stroke before reviewing.", true); return; }
    busy = true;
    if (!await ensureSourceSaved()) {
      busy = false;
      say("The source strokes are only saved in this browser. Retry after the Space write succeeds.", true);
      return;
    }
    try {
      const draft = localStorage.getItem(reviewKey());
      if (draft) {
        try { review = B.validate(doc, JSON.parse(draft)); }
        catch (e) {
          if (!confirm(`The saved review draft is invalid (${e.message}). Discard it and start a new review?`)) {
            throw new Error("Review draft kept; no changes made");
          }
          localStorage.removeItem(reviewKey());
          review = B.start(doc);
        }
      } else review = B.start(doc);
      saveReview(review);
      reviewMode(true);
      renderReview();
      say(`Reviewing ${review.blocks.length} block${review.blocks.length === 1 ? "" : "s"}. Source revision ${doc.revision}.`);
    } catch (e) { busy = false; say(`Could not start review: ${e.message}`, true); }
  };
  $("review-back").onclick = () => {
    if (insertBusy || ocrBusy) return;
    reviewMode(false);
    say("Review draft saved in this browser; strokes remain editable.");
  };
  $("delete-capture").onclick = deleteReviewedCapture;
  $("update-block").onclick = saveBlockEdits;
  $("transcribe-existing").onclick = transcribeExistingBlock;
  $("delete-block").onclick = () => deleteBlock();
  $("new").onclick = async () => {
    if (blockEdit) return;
    if (!confirm("Start a new session? The current session remains saved and can be resumed later.")) return;
    finish();
    await store.flush();
    try { doc = store.newSession(silverInkContext.page); sessionDocs.set(doc.id, doc); updateSessions(); fit(); schedule(); }
    catch (e) { say(`Could not create session: ${e.message}`, true); }
  };
  $("sessions").onchange = async event => {
    if (blockEdit) return;
    const target = event.target.value;
    if (!sessionDocs.has(target) || target === doc.id) return;
    finish();
    if (!await store.flush() && !confirm("The current session is only saved locally. Switch sessions anyway?")) {
      updateSessions(); return;
    }
    const selected = sessionDocs.get(target);
    if (selected.blockEditOf) {
      updateSessions();
      say("Use SilverInk: Edit handwritten for ink already linked to the page.", true);
      return;
    }
    if (B.hasSessionMarker(editorBaseline.text, selected.id)) {
      try {
        const key = `silverink:review:v1:${encodeURIComponent(silverInkContext.scope)}:${selected.id}:${selected.revision}`;
        const draft = localStorage.getItem(key);
        if (!draft) {
          updateSessions();
          say("Use SilverInk: Edit handwritten for ink already linked to the page.", true);
          return;
        }
        review = B.validate(selected, JSON.parse(draft));
        doc = selected;
        updateSessions();
        reviewMode(true);
        renderReview();
        say(`Continuing review of session ${doc.id.slice(0, 8)}.`);
      } catch (e) { updateSessions(); say(`Cannot continue review: ${e.message}`, true); }
      return;
    }
    try {
      store.saveLocal(selected);
      doc = selected;
      fit();
      if (doc.inProgress && change(next => M.finish(next))) {
        say("Recovered an interrupted stroke; saving it now.");
      } else say(`Opened session ${doc.id.slice(0, 8)} · revision ${doc.revision}`);
    } catch (e) { updateSessions(); say(`Cannot open session: ${e.message}`, true); }
  };

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  $("json").onclick = () => download(`${doc.id}.silverink.json`, JSON.stringify(doc, null, 2), "application/json");
  $("svg").onclick = () => download(`${doc.id}.svg`, M.svg(doc), "image/svg+xml");
  $("png").onclick = () => {
    const scale = Math.min(1, 8192 / Math.max(doc.width, doc.height), Math.sqrt(16000000 / (doc.width * doc.height)));
    const bitmap = document.createElement("canvas");
    bitmap.width = Math.round(doc.width * scale);
    bitmap.height = Math.round(doc.height * scale);
    redraw(bitmap.getContext("2d"), scale);
    bitmap.toBlob(blob => {
      if (blob) download(`${doc.id}.png`, blob, "image/png");
      else say("PNG export failed", true);
    }, "image/png");
  };
  $("close").onclick = async () => {
    if (insertBusy) return;
    finish();
    if (blockEdit && !editCommitted && doc.revision > 0 &&
        !confirm("Block edits are saved as a draft but have not been applied. Close anyway?")) return;
    busy = true;
    say("Finishing save…");
    const saved = await store.flush();
    busy = false;
    if (!saved && !confirm("The Space write failed. A local recovery copy remains in this browser. Close anyway?")) {
      say("Saved locally; Space write failed", true); return;
    }
    await syscall("editor.focus");
    await syscall("editor.hidePanel", "modal");
  };

  try {
    editorBaseline = await editorState();
    if (editorBaseline.page !== silverInkContext.page) {
      throw new Error("The active page changed before SilverInk opened");
    }
    if (silverInkContext.mode === "edit") {
      await openBlockEdit();
    } else {
      const result = await store.open(silverInkContext.page);
      doc = result.doc;
      for (const item of result.sessions) sessionDocs.set(item.id, item);
      if (doc.strokes.length || doc.inProgress || doc.blockEditOf ||
          B.hasSessionMarker(editorBaseline.text, doc.id)) {
        doc = store.newSession(silverInkContext.page);
        sessionDocs.set(doc.id, doc);
        schedule();
      }
      updateSessions();
      fit();
      if (result.warning) say(`${result.warning}. Drawing will be saved locally.`, true);
      else say(`New session ${doc.id.slice(0, 8)} · revision ${doc.revision}`);
      store.queue.catch(e => say(`Saved locally; Space write failed: ${e.message || e}`, true));
    }
  } catch (e) {
    say(`Cannot open session: ${e.message || e}`, true);
    for (const control of document.querySelectorAll("button, select")) control.disabled = true;
    $("close").disabled = false;
    if (e.recovery) { doc = e.recovery; $("json").disabled = false; }
  }
})();
