(function (root) {
  "use strict";
  const FORMAT = 1;
  const MAX_STROKES = 20000;
  const MAX_POINTS = 1000000;

  function freshId() {
    if (root.crypto.randomUUID) return root.crypto.randomUUID();
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function create(page, id = freshId(), now = Date.now()) {
    return {
      format: FORMAT, id, page, revision: 0, updatedAt: now,
      width: 1200, height: 2400, strokes: [], redo: [], inProgress: null,
    };
  }

  function validPoint(p) {
    return p && [p.x, p.y, p.p, p.t].every(Number.isFinite) &&
      p.x >= 0 && p.y >= 0 && p.p >= 0 && p.p <= 1 && p.t >= 0;
  }

  function validStroke(s) {
    return s && typeof s.id === "string" && /^[\w-]{8,80}$/.test(s.id) &&
      s.tool === "pen" && Number.isFinite(s.width) && s.width > 0 && s.width <= 100 &&
      Array.isArray(s.points) && s.points.length > 0 && s.points.every(validPoint);
  }

  function validate(doc) {
    if (!doc || doc.format !== FORMAT || typeof doc.id !== "string" ||
      !/^[\w-]{8,80}$/.test(doc.id) || typeof doc.page !== "string" ||
      doc.page.length > 1000 || !Number.isSafeInteger(doc.revision) ||
      doc.revision < 0 || !Number.isFinite(doc.updatedAt) ||
      !Number.isFinite(doc.width) || !Number.isFinite(doc.height) ||
      doc.width < 100 || doc.width > 8000 || doc.height < 100 || doc.height > 10000 ||
      doc.width * doc.height > 12000000 ||
      !Array.isArray(doc.strokes) || !Array.isArray(doc.redo) ||
      doc.strokes.length + doc.redo.length > MAX_STROKES ||
      !doc.strokes.every(validStroke) || !doc.redo.every(validStroke) ||
      (doc.inProgress !== null && doc.inProgress !== undefined && !validStroke(doc.inProgress))) {
      throw new Error("Invalid or unsupported SilverInk session format");
    }
    const all = [...doc.strokes, ...doc.redo, ...(doc.inProgress ? [doc.inProgress] : [])];
    if (all.reduce((n, s) => n + s.points.length, 0) > MAX_POINTS ||
      new Set(all.map(s => s.id)).size !== all.length ||
      all.some(s => s.points.some(p => p.x > doc.width || p.y > doc.height))) {
      throw new Error("SilverInk session exceeds limits or contains invalid stroke coordinates or IDs");
    }
    return doc;
  }

  function touch(doc, now = Date.now()) {
    doc.revision += 1;
    doc.updatedAt = now;
    return doc;
  }

  function finish(doc, now = Date.now()) {
    if (!doc.inProgress) return false;
    doc.strokes.push(doc.inProgress);
    doc.inProgress = null;
    doc.redo = [];
    touch(doc, now);
    return true;
  }

  function undo(doc) {
    if (!doc.strokes.length) return false;
    doc.redo.push(doc.strokes.pop());
    touch(doc);
    return true;
  }

  function redo(doc) {
    if (!doc.redo.length) return false;
    doc.strokes.push(doc.redo.pop());
    touch(doc);
    return true;
  }

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const u = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
    return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
  }

  function eraseAt(doc, point, radius = 12) {
    for (let i = doc.strokes.length - 1; i >= 0; i--) {
      const s = doc.strokes[i];
      if (s.points.some((p, j) => distanceToSegment(point, p, s.points[Math.min(j + 1, s.points.length - 1)]) <= radius + s.width / 2)) {
        doc.strokes.splice(i, 1);
        doc.redo = [];
        touch(doc);
        return true;
      }
    }
    return false;
  }

  function number(n) {
    return Number(n.toFixed(2)).toString();
  }

  function svg(doc) {
    validate(doc);
    return svgFromStrokes(doc.strokes, 0, 0, doc.width, doc.height);
  }

  function svgFromStrokes(strokes, x, y, width, height) {
    const paths = strokes.map(s => {
      const p = s.points;
      if (p.length === 1) {
        return `<circle cx="${number(p[0].x)}" cy="${number(p[0].y)}" r="${number(s.width / 2)}" stroke="none"/>`;
      }
      const d = p.map((v, i) => `${i ? "L" : "M"}${number(v.x)} ${number(v.y)}`).join(" ");
      return `<path d="${d}" fill="none" stroke-width="${number(s.width)}"/>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${number(x)} ${number(y)} ${number(width)} ${number(height)}" width="${number(width)}" height="${number(height)}"><g fill="#161b22" stroke="#161b22" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
  }

  function selectStrokes(doc, strokeIds) {
    validate(doc);
    if (!Array.isArray(strokeIds) || !strokeIds.length ||
        new Set(strokeIds).size !== strokeIds.length) throw new Error("Invalid stroke selection");
    const byId = new Map(doc.strokes.map(s => [s.id, s]));
    const selected = strokeIds.map(id => byId.get(id));
    if (selected.some(s => !s)) throw new Error("Stroke selection is stale");
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, pad = 8;
    for (const stroke of selected) {
      pad = Math.max(pad, stroke.width / 2 + 4);
      for (const point of stroke.points) {
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
      }
    }
    const left = minX - pad, top = minY - pad;
    const width = Math.max(1, maxX + pad - left);
    const height = Math.max(1, maxY + pad - top);
    return { strokes: selected, left, top, width, height };
  }

  function svgStrokes(doc, strokeIds) {
    const { strokes, left, top, width, height } = selectStrokes(doc, strokeIds);
    return svgFromStrokes(strokes, left, top, width, height);
  }

  const api = { create, validate, touch, finish, undo, redo, eraseAt, svg, svgStrokes, selectStrokes, freshId };
  root.SilverInkModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
