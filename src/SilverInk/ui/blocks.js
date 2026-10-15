(function (root) {
  "use strict";
  const M = root.SilverInkModel || (typeof require === "function" ? require("./model.js") : null);
  const ID = /^[\w-]{8,80}$/;
  const MAX_BLOCKS = 500;

  function bounds(stroke) {
    let top = Infinity, left = Infinity;
    for (const point of stroke.points) {
      top = Math.min(top, point.y);
      left = Math.min(left, point.x);
    }
    return { top, left };
  }

  function start(doc, makeId = M.freshId) {
    M.validate(doc);
    const sorted = doc.strokes.map(stroke => ({ stroke, box: bounds(stroke) }))
      .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
    const blocks = sorted.length ? [{ id: makeId(), kind: "drawing", markdown: "",
      strokeIds: sorted.map(item => item.stroke.id) }] : [];
    return { format: 1, sessionId: doc.id, sourceRevision: doc.revision,
      blocks };
  }

  function validate(doc, review) {
    M.validate(doc);
    if (!review || review.format !== 1 || review.sessionId !== doc.id ||
        review.sourceRevision !== doc.revision || !Array.isArray(review.blocks) ||
        !review.blocks.length || review.blocks.length > MAX_BLOCKS) {
      throw new Error("Review is stale or contains no blocks");
    }
    const strokeIds = new Set(doc.strokes.map(s => s.id));
    const seen = new Set(), blockIds = new Set();
    for (const block of review.blocks) {
      if (!block || !ID.test(block.id) || blockIds.has(block.id) ||
          !["text", "drawing", "png", "discarded"].includes(block.kind) ||
          typeof block.markdown !== "string" || block.markdown.length > 100000 ||
          !Array.isArray(block.strokeIds) || !block.strokeIds.length) {
        throw new Error("Invalid review block");
      }
      blockIds.add(block.id);
      for (const id of block.strokeIds) {
        if (!strokeIds.has(id) || seen.has(id)) throw new Error("Missing or duplicate stroke reference");
        seen.add(id);
      }
    }
    if (seen.size !== strokeIds.size) throw new Error("Review does not include every stroke");
    return review;
  }

  function split(doc, review, blockIndex, after, makeId = M.freshId) {
    validate(doc, review);
    const next = structuredClone(review);
    const block = next.blocks[blockIndex];
    if (!block || block.kind === "discarded" || !Number.isInteger(after) || after < 1 || after >= block.strokeIds.length ||
        next.blocks.length >= MAX_BLOCKS) throw new Error("Choose a stroke inside the block");
    const second = { id: makeId(), kind: block.kind, markdown: "",
      strokeIds: block.strokeIds.splice(after) };
    next.blocks.splice(blockIndex + 1, 0, second);
    return validate(doc, next);
  }

  function merge(doc, review, blockIndex) {
    validate(doc, review);
    const next = structuredClone(review);
    const first = next.blocks[blockIndex], second = next.blocks[blockIndex + 1];
    if (!first || !second || first.kind === "discarded" || first.kind !== second.kind) {
      throw new Error("Choose the same type for both blocks before merging");
    }
    first.strokeIds.push(...second.strokeIds);
    first.markdown = [first.markdown.trim(), second.markdown.trim()].filter(Boolean).join("\n\n");
    next.blocks.splice(blockIndex + 1, 1);
    return validate(doc, next);
  }

  function relativePath(page, path) {
    return "../".repeat(Math.max(0, page.split("/").length - 1)) + path;
  }

  function inFrontmatter(text, pos) {
    if (!text.startsWith("---\n")) return false;
    const end = text.indexOf("\n---", 4);
    return end !== -1 && pos <= end + 4;
  }

  function wrapInsertion(pageText, pos, content) {
    if (!Number.isInteger(pos) || pos < 0 || pos > pageText.length || inFrontmatter(pageText, pos)) {
      throw new Error("Place the cursor in the page body before opening SilverInk");
    }
    const before = pageText.slice(0, pos), after = pageText.slice(pos);
    const prefix = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const suffix = !after || after.startsWith("\n\n") ? "\n" : after.startsWith("\n") ? "\n" : "\n\n";
    return prefix + content + suffix;
  }

  function hasSessionMarker(pageText, sessionId) {
    return pageText.includes(`;session=${sessionId};rev=`);
  }

  function hasBlockMarker(pageText, blockId) {
    return pageText.includes(`<!-- silverink:block=${blockId};`);
  }

  function blockAt(pageText, pos) {
    if (typeof pageText !== "string" || !Number.isInteger(pos) || pos < 0 || pos > pageText.length) {
      throw new Error("Current page position is unavailable");
    }
    const markers = [...pageText.matchAll(/<!-- silverink:block=([\w-]{8,80});session=([\w-]{8,80});rev=(\d+) -->/g)];
    if (!markers.length) throw new Error("This page has no SilverInk block to edit");
    const marker = markers.filter(item => item.index <= pos).at(-1) || markers[0];
    return { id: marker[1], sessionId: marker[2], sourceRevision: Number(marker[3]),
      markerStart: marker.index };
  }

  function validateRecord(record, page) {
    if (!record || record.format !== 1 || !ID.test(record.id) ||
        typeof record.page !== "string" || record.page.length > 1000 ||
        (page !== undefined && record.page !== page) || !ID.test(record.sessionId) ||
        !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0 ||
        !Array.isArray(record.strokeIds) || !record.strokeIds.length ||
        new Set(record.strokeIds).size !== record.strokeIds.length ||
        !record.strokeIds.every(id => typeof id === "string" && ID.test(id)) ||
        !["text", "drawing", "png"].includes(record.kind) ||
        typeof record.acceptedMarkdown !== "string" ||
        record.acceptedMarkdown.length > 100000 ||
        (record.kind === "drawing" && (record.svgPath !== `SilverInk/Graphics/${record.id}.svg` || record.pngPath)) ||
        (record.kind === "png" && (record.svgPath !== null ||
          record.pngPath !== `SilverInk/Graphics/${record.id}.png`)) ||
        (record.kind === "text" && (record.svgPath !== null || record.pngPath))) {
      throw new Error("Invalid or unsupported SilverInk block record");
    }
    return record;
  }

  function editCopy(record, source, makeId = M.freshId) {
    validateRecord(record, source.page);
    M.validate(source);
    if (source.id !== record.sessionId || source.revision !== record.sourceRevision) {
      throw new Error("Block source revision no longer matches its record");
    }
    const byId = new Map(source.strokes.map(stroke => [stroke.id, stroke]));
    const selected = record.strokeIds.map(id => byId.get(id));
    if (selected.some(stroke => !stroke)) throw new Error("Block source is missing strokes");
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of selected) for (const point of stroke.points) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    const offsetX = Math.max(0, minX - 40), offsetY = Math.max(0, minY - 40);
    const copy = M.create(source.page, makeId());
    copy.blockEditOf = record.id;
    copy.width = Math.max(1200, Math.min(source.width, Math.ceil(maxX - offsetX + 40)));
    copy.height = Math.max(800, Math.min(source.height, Math.ceil(maxY - offsetY + 160)));
    copy.strokes = structuredClone(selected);
    for (const stroke of copy.strokes) for (const point of stroke.points) {
      point.x -= offsetX; point.y -= offsetY;
    }
    return M.validate(copy);
  }

  function blockSource(doc, block) {
    M.validate(doc);
    if (!block || !ID.test(block.id) || !Array.isArray(block.strokeIds) ||
        !block.strokeIds.length) throw new Error("Invalid source block");
    const byId = new Map(doc.strokes.map(stroke => [stroke.id, stroke]));
    const strokes = block.strokeIds.map(id => byId.get(id));
    if (strokes.some(stroke => !stroke) || new Set(block.strokeIds).size !== strokes.length) {
      throw new Error("Block source is missing or has duplicate strokes");
    }
    const source = M.create(doc.page, block.id, doc.updatedAt);
    source.width = doc.width;
    source.height = doc.height;
    source.strokes = structuredClone(strokes);
    source.blockEditOf = block.id;
    source.captureSessionId = doc.id;
    source.captureRevision = doc.revision;
    return M.validate(source);
  }

  function assertCanInsert(doc, review, pageText, blockId) {
    validate(doc, review);
    if (typeof pageText !== "string") throw new Error("Current page text is unavailable");
    if (!review.blocks.some(block => block.id === blockId)) throw new Error("Unknown review block");
    if (hasBlockMarker(pageText, blockId)) throw new Error("This block is already on the page");
    const markers = pageText.matchAll(/<!-- silverink:block=([\w-]{8,80});session=([\w-]{8,80});rev=(\d+) -->/g);
    for (const match of markers) {
      if (match[2] === doc.id && (Number(match[3]) !== doc.revision ||
          !review.blocks.some(block => block.id === match[1]))) {
        throw new Error("This session was inserted from another review. Start a new session for more ink.");
      }
    }
  }

  function prepareBlock(doc, review, blockId, kind, pageText, pos, now = Date.now()) {
    assertCanInsert(doc, review, pageText, blockId);
    if (!["text", "drawing", "png"].includes(kind)) throw new Error("Choose Text, SVG, or PNG");
    const block = review.blocks.find(item => item.id === blockId);
    if (block.kind === "discarded") throw new Error("This block was discarded from review");
    const source = blockSource(doc, block);
    const files = [{ path: `SilverInk/Sessions/${source.id}.json`,
      content: JSON.stringify(source, null, 2) }];
    let acceptedMarkdown, svgPath = null, pngPath = null;
    if (kind === "text") {
      acceptedMarkdown = block.markdown.trim();
      if (!acceptedMarkdown) throw new Error("This block needs reviewed Markdown");
    } else if (kind === "drawing") {
      svgPath = `SilverInk/Graphics/${block.id}.svg`;
      files.push({ path: svgPath, content: M.svgStrokes(doc, block.strokeIds) });
      acceptedMarkdown = `![SilverInk drawing](<${relativePath(doc.page, svgPath)}>)`;
    } else {
      pngPath = `SilverInk/Graphics/${block.id}.png`;
      acceptedMarkdown = `![SilverInk drawing](<${relativePath(doc.page, pngPath)}>)`;
    }
    const record = { format: 1, id: block.id, page: doc.page, sessionId: source.id,
      sourceRevision: source.revision, strokeIds: [...block.strokeIds], kind,
      acceptedMarkdown, svgPath, pngPath, createdAt: now };
    files.push({ path: `SilverInk/Blocks/${block.id}.json`, content: JSON.stringify(record, null, 2) });
    const snippet = `<!-- silverink:block=${block.id};session=${doc.id};rev=${doc.revision} -->\n${acceptedMarkdown}`;
    return { files, insertion: wrapInsertion(pageText, pos, snippet) };
  }

  function prepareDeletion(pageText, marker, record) {
    if (typeof pageText !== "string" || !marker || !Number.isInteger(marker.markerStart)) {
      throw new Error("Current page is unavailable");
    }
    validateRecord(record);
    if (marker.id !== record.id) throw new Error("The selected block changed");
    const exactMarker = `<!-- silverink:block=${marker.id};session=${marker.sessionId};rev=${marker.sourceRevision} -->`;
    const from = marker.markerStart;
    if (pageText.slice(from, from + exactMarker.length) !== exactMarker ||
        pageText.indexOf(`<!-- silverink:block=${record.id};`) !== from) {
      throw new Error("The block marker is missing or duplicated");
    }
    let to = from + exactMarker.length;
    if (record.kind !== "text") {
      const drawing = `\n${record.acceptedMarkdown}`;
      if (pageText.slice(to, to + drawing.length) !== drawing) {
        throw new Error("The drawing link has changed; review it in Markdown before deleting");
      }
      to += drawing.length;
    } else if (pageText[to] === "\n") {
      to += 1;
    }
    return { from, to, replacement: "", expected: pageText.slice(0, from) + pageText.slice(to) };
  }

  const api = { start, validate, split, merge, prepareBlock, assertCanInsert,
    blockAt, validateRecord, editCopy, blockSource, prepareDeletion,
    hasBlockMarker, hasSessionMarker, relativePath };
  root.SilverInkBlocks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
