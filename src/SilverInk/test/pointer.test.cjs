const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const M = require("../ui/model.js");
const B = require("../ui/blocks.js");
const OCR = require("../ui/ocr.js");

function element() {
  const listeners = new Map();
  return {
    style: {}, children: [], classList: { toggle() {} },
    addEventListener(name, handler) {
      const handlers = listeners.get(name) || [];
      handlers.push(handler);
      listeners.set(name, handlers);
    },
    emit(name, event) { for (const handler of listeners.get(name) || []) handler(event); },
    setAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
  };
}

async function panel(selection = { from: 8, to: 8, text: "" }, options = {}) {
  const ids = ["ink", "surface", "status", "sessions", "undo", "redo", "pen", "eraser", "guides",
    "finger", "clear", "zoomout", "zoomin", "zoomfit", "new", "review", "review-panel",
    "review-back", "review-list", "delete-capture", "update-block", "transcribe-existing", "delete-block",
    "json", "svg", "png", "close", "ocr-config", "ocr-check", "offline-note"];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  elements["review-panel"].hidden = true;
  const canvas = elements.ink;
  let guideMoves = 0;
  const context = Object.fromEntries(["save", "scale", "translate", "fillRect", "beginPath", "arc", "fill",
    "moveTo", "lineTo", "stroke", "restore", "setTransform"].map(name => [name, () => {}]));
  context.moveTo = () => { guideMoves++; };
  canvas.getContext = () => context;
  canvas.focus = () => {};
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  canvas.setPointerCapture = () => {};
  let sizeWrites = 0, width = 0, height = 0;
  Object.defineProperty(canvas, "width", { get: () => width, set: n => { width = n; sizeWrites++; } });
  Object.defineProperty(canvas, "height", { get: () => height, set: n => { height = n; sizeWrites++; } });
  elements.surface.clientWidth = 1224;
  const window = element();
  window.requestAnimationFrame = callback => { callback(); return null; };
  let saved, pageText = options.pageText ?? "# Notes\n", onWrite = null, onSave = null;
  let insertCalls = 0, restoredSelection = null, hideCalls = 0;
  let editorSelection = selection;
  const files = new Map(options.files || []), local = options.storage || new Map();
  class Store {
    constructor() { this.queue = Promise.resolve(); }
    async open() {
      const doc = options.openDoc || M.create("Notes", "session-0001", 1);
      return { doc, sessions: options.openDoc ? [doc] : [], warning: null };
    }
    saveLocal(doc) { saved = structuredClone(doc); }
    bufferLocal(doc) { this.saveLocal(doc); }
    flushLocal() {}
    forget() {}
    newSession(page) { const doc = M.create(page); this.saveLocal(doc); return doc; }
    readLocal() { return null; }
    async readRemote(id) {
      const bytes = files.get(`SilverInk/Sessions/${id}.json`);
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    }
    schedule(doc) {
      if (options.mode === "edit") {
        files.set(`SilverInk/Sessions/${doc.id}.json`, new TextEncoder().encode(JSON.stringify(doc)));
      }
      return Promise.resolve();
    }
    bufferRemote(doc) { return this.schedule(doc); }
    async flush() { return true; }
  }
  const sandbox = {
    SilverInkModel: M, SilverInkOCR: OCR, SilverInkStore: { Store },
    silverInkContext: { scope: "test", page: options.page || "Notes", mode: options.mode || "new",
      syncDocuments: options.syncDocuments ?? true,
      ocr: { provider: "ollama", endpoint: "http://localhost:11434", model: "gemma3:4b" } },
    SilverInkBlocks: B,
    syscall: async (name, ...args) => {
      if (name === "editor.getCurrentPage") return options.page || "Notes";
      if (name === "editor.getText") return pageText;
      if (name === "editor.getSelection") return editorSelection;
      if (name === "space.readFile") {
        if (!files.has(args[0])) throw Error(`Missing file: ${args[0]}`);
        return files.get(args[0]);
      }
      if (name === "space.writeFile") {
        if (options.failWritePath === args[0]) throw Error("Simulated Space write failure");
        files.set(args[0], args[1]);
        if (onWrite) onWrite();
        return;
      }
      if (name === "space.listFiles") return [...files.keys()].map(name => ({ name }));
      if (name === "space.deleteFile") { files.delete(args[0]); return; }
      if (name === "editor.insertAtPos") {
        insertCalls++;
        pageText = pageText.slice(0, args[1]) + args[0] + pageText.slice(args[1]);
        return;
      }
      if (name === "editor.replaceRange") {
        pageText = pageText.slice(0, args[0]) + args[2] + pageText.slice(args[1]);
        return;
      }
      if (name === "editor.setSelection") {
        restoredSelection = args;
        editorSelection = { from: args[0], to: args[1], text: pageText.slice(args[0], args[1]) };
        return;
      }
      if (name === "editor.moveCursor") {
        editorSelection = { from: args[0], to: args[0], text: "" };
        return;
      }
      if (name === "editor.save") { if (onSave) onSave(); return; }
      if (name === "sandboxFetch.fetch") {
        if (options.ocrError) throw options.ocrError;
        return options.ocrResponse || {
          status: 200, base64Body: btoa(JSON.stringify({ response: "Handwritten words", done: true })),
        };
      }
      if (name === "editor.hidePanel") { hideCalls++; return; }
      if (name === "editor.focus") return;
      throw Error(`Unexpected syscall: ${name}`);
    },
    localStorage: {
      getItem: key => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, String(value)),
      removeItem: key => local.delete(key),
    },
    confirm: () => true,
    TextEncoder, TextDecoder, window, document: {
      getElementById: id => elements[id],
      createElement: tag => tag === "canvas" ? Object.assign(element(), {
        getContext: () => context,
        toBlob: callback => callback(new Blob([Uint8Array.of(137, 80, 78, 71)], { type: "image/png" })),
      }) : element(),
      querySelectorAll: () => [],
    },
    devicePixelRatio: 1, structuredClone, Date, Math, Promise, Blob, Uint8Array,
  };
  const source = fs.readFileSync(path.join(__dirname, "../ui/panel.js"), "utf8");
  vm.runInNewContext(source, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  const pointer = (id, x, y) => ({
    pointerId: id, pointerType: "pen", button: 0, clientX: x, clientY: y,
    pressure: 0.5, preventDefault() {},
  });
  return { canvas, window, elements, pointer, saved: () => saved,
    guideMoves: () => guideMoves,
    sizeWrites: () => sizeWrites, files, local, pageText: () => pageText,
    changePage: text => { pageText = text; }, onWrite: fn => { onWrite = fn; },
    onSave: fn => { onSave = fn; },
    insertCalls: () => insertCalls, hideCalls: () => hideCalls,
    restoredSelection: () => restoredSelection };
}

function blockButton(ui, index, title) {
  const card = ui.elements["review-list"].children[index];
  const visit = node => {
    if (node.type === "button" && node.textContent === title) return node;
    for (const child of node.children || []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const button = visit(card);
  assert.ok(button, `Expected block ${index + 1} button ${title}`);
  return button;
}

function splitFirstBlock(ui, after = 1) {
  const card = ui.elements["review-list"].children[0];
  const find = node => node.type === "number" ? node :
    (node.children || []).map(find).find(Boolean);
  const field = find(card);
  assert.ok(field);
  field.value = String(after);
  field.oninput();
  blockButton(ui, 0, "Split").onclick();
}

async function reopenReview(ui, capture = ui.saved()) {
  const reopened = await panel({ from: ui.pageText().length, to: ui.pageText().length, text: "" },
    { openDoc: capture, pageText: ui.pageText(), files: ui.files, storage: ui.local });
  await reopened.elements.sessions.onchange({ target: { value: capture.id } });
  if (reopened.elements["review-panel"].hidden) await reopened.elements.review.onclick();
  assert.equal(reopened.elements["review-panel"].hidden, false);
  return reopened;
}

function editingFixture() {
  const source = M.create("Notes", "source-0001", 1);
  source.strokes = [10, 110].map((y, index) => ({
    id: `stroke-000${index + 1}`, tool: "pen", width: 2.5,
    points: [{ x: 10, y, p: 0.5, t: 1 }, { x: 30, y: y + 8, p: 0.5, t: 2 }],
  }));
  M.touch(source, 2);
  const ids = ["block-0001", "block-0002"];
  const review = B.split(source, B.start(source, () => ids.shift()), 0, 1,
    () => ids.shift());
  const prepared = B.prepareBlock(source, review, "block-0001", "drawing", "# Notes\n", 8);
  const pageText = "# Notes\n" + prepared.insertion;
  const files = [[`SilverInk/Sessions/${source.id}.json`, new TextEncoder().encode(JSON.stringify(source))],
    ...prepared.files.map(file => [file.path, new TextEncoder().encode(file.content)])];
  const pos = pageText.indexOf("![SilverInk drawing]");
  return { source, pageText, files, selection: { from: pos, to: pos, text: "" } };
}

test("consecutive pen strokes start without waiting for a timer", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.canvas.emit("pointermove", ui.pointer(1, 20, 20));
  ui.window.emit("pointerup", ui.pointer(1, 20, 20));
  ui.canvas.emit("pointerdown", ui.pointer(2, 30, 30));
  ui.window.emit("pointerup", ui.pointer(2, 30, 30));
  assert.equal(ui.saved().strokes.length, 2);
  assert.equal(ui.saved().strokes[0].points.length, 2);
  assert.equal(ui.saved().strokes[1].points[0].x, 30);
  assert.equal(ui.sizeWrites(), 2, "redraws should not reset the canvas dimensions");
});

test("a new pen down completes a stroke whose pointerup was missed", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.canvas.emit("pointerdown", ui.pointer(2, 30, 30));
  ui.window.emit("pointerup", ui.pointer(2, 30, 30));
  assert.equal(ui.saved().strokes.length, 2);
  assert.equal(ui.saved().inProgress, null);
});

test("review starts as one block with no split number and guides cycle without a text field", async () => {
  const ui = await panel();
  assert.equal(ui.elements.guides.textContent, "Guides: off");
  const before = ui.guideMoves();
  ui.elements.guides.onclick();
  assert.equal(ui.elements.guides.textContent, "Guides: lines");
  const lines = ui.guideMoves() - before;
  assert.ok(lines > 0);
  ui.elements.guides.onclick();
  assert.equal(ui.elements.guides.textContent, "Guides: grid");
  assert.ok(ui.guideMoves() - before - lines > lines);
  ui.elements.guides.onclick();
  assert.equal(ui.elements.guides.textContent, "Guides: off");
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  ui.canvas.emit("pointerdown", ui.pointer(2, 10, 110));
  ui.window.emit("pointerup", ui.pointer(2, 10, 110));
  await ui.elements.review.onclick();
  assert.equal(ui.elements["review-list"].children.length, 1);
  const card = ui.elements["review-list"].children[0];
  const find = node => node.type === "number" ? node :
    (node.children || []).map(find).find(Boolean);
  assert.equal(find(card).value, "");
  assert.equal(blockButton(ui, 0, "Split").disabled, true);
});

test("panel identifies when document sync is disabled for offline use", async () => {
  const ui = await panel(undefined, { syncDocuments: false });
  assert.equal(ui.elements["offline-note"].hidden, false);
  const enabled = await panel(undefined, { syncDocuments: true });
  assert.equal(enabled.elements["offline-note"].hidden, true);
});

test("stroke undo and redo buttons and shortcuts restore the last stroke", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  assert.equal(ui.saved().strokes.length, 1);
  ui.elements.undo.onclick();
  assert.equal(ui.saved().strokes.length, 0);
  ui.elements.redo.onclick();
  assert.equal(ui.saved().strokes.length, 1);
  const shortcut = key => ({ key, ctrlKey: true, shiftKey: false, altKey: false,
    target: { tagName: "CANVAS" }, preventDefault() {} });
  ui.window.emit("keydown", shortcut("z"));
  assert.equal(ui.saved().strokes.length, 0);
  ui.window.emit("keydown", shortcut("y"));
  assert.equal(ui.saved().strokes.length, 1);
});

test("Handwrite starts fresh ink while keeping the previous session selectable", async () => {
  const old = M.create("Notes", "session-old1", 1);
  old.strokes = [{ id: "stroke-old1", tool: "pen", width: 2.5,
    points: [{ x: 10, y: 10, p: 0.5, t: 1 }] }];
  M.touch(old, 2);
  const ui = await panel(undefined, { openDoc: old });
  assert.equal(ui.saved().strokes.length, 0);
  assert.notEqual(ui.saved().id, old.id);
  await ui.elements.sessions.onchange({ target: { value: old.id } });
  assert.equal(ui.saved().id, old.id);
  assert.equal(ui.saved().strokes.length, 1);
});

test("Handwrite directs published session edits to Edit block", async () => {
  const old = M.create("Notes", "session-old1", 1);
  old.strokes = [{ id: "stroke-old1", tool: "pen", width: 2.5,
    points: [{ x: 10, y: 10, p: 0.5, t: 1 }] }];
  M.touch(old, 2);
  const pageText = "# Notes\n\n<!-- silverink:block=block-0001;session=session-old1;rev=1 -->\nText";
  const ui = await panel(undefined, { openDoc: old, pageText });
  const newId = ui.saved().id;
  await ui.elements.sessions.onchange({ target: { value: old.id } });
  assert.equal(ui.saved().id, newId);
  assert.match(ui.elements.status.textContent, /Edit handwritten/);
});

test("review inserts linked SVG only after source files are written", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  await blockButton(ui, 0, "SVG").onclick();
  assert.equal(ui.insertCalls(), 1);
  assert.match(ui.pageText(), /silverink:block=/);
  assert.match(ui.pageText(), /!\[SilverInk drawing\]/);
  assert.equal([...ui.files.keys()].filter(path => path.endsWith(".svg")).length, 1);
  assert.equal([...ui.files.keys()].filter(path => path.endsWith(".json")).length, 2);
  assert.equal(ui.hideCalls(), 1);
});

test("PNG insertion writes a cropped image and closes the panel", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  await blockButton(ui, 0, "PNG instead").onclick();
  assert.equal(ui.hideCalls(), 1);
  assert.match(ui.pageText(), /Graphics\/.*\.png/);
  const png = [...ui.files.entries()].find(([name]) => name.endsWith(".png"));
  assert.deepEqual([...png[1]], [137, 80, 78, 71]);
  const record = JSON.parse(new TextDecoder().decode(
    [...ui.files.entries()].find(([name]) => name.startsWith("SilverInk/Blocks/"))[1]));
  assert.equal(record.pngPath, png[0]);
});

test("Transcribe runs OCR, inserts editable Markdown, and closes the panel", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  await blockButton(ui, 0, "Transcribe").onclick();
  assert.match(ui.pageText(), /Handwritten words/);
  assert.equal(ui.hideCalls(), 1);
});

test("an OCR failure leaves the page and strokes untouched", async () => {
  const ui = await panel(undefined, { ocrResponse: {
    status: 503, base64Body: btoa("provider unavailable"),
  } });
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  await blockButton(ui, 0, "Transcribe").onclick();
  assert.equal(ui.pageText(), "# Notes\n");
  assert.equal(ui.saved().strokes.length, 1);
  assert.equal(ui.hideCalls(), 0);
});

test("a proxy permission failure identifies the SilverBullet route and keeps the capture", async () => {
  const ui = await panel(undefined, { ocrError: new Error("You do not have permission to do that") });
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  await blockButton(ui, 0, "Transcribe").onclick();
  assert.match(ui.elements.status.textContent, /SilverBullet refused the OCR proxy request/);
  assert.match(ui.elements.status.textContent, /\/\.proxy\//);
  assert.equal(ui.pageText(), "# Notes\n");
  assert.equal(ui.saved().strokes.length, 1);
  assert.equal(ui.hideCalls(), 0);
});

test("Delete discards an uninserted block and closes without changing the page", async () => {
  let ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  ui.canvas.emit("pointerdown", ui.pointer(2, 10, 110));
  ui.window.emit("pointerup", ui.pointer(2, 10, 110));
  const capture = ui.saved();
  await ui.elements.review.onclick();
  splitFirstBlock(ui);
  await blockButton(ui, 0, "Delete").onclick();
  assert.equal(ui.pageText(), "# Notes\n");
  assert.equal(ui.hideCalls(), 1);
  ui = await reopenReview(ui, capture);
  assert.equal(blockButton(ui, 0, "SVG").disabled, true);
  await blockButton(ui, 1, "SVG").onclick();
  assert.equal(ui.insertCalls(), 1);
});

test("Delete removes an inserted SVG block and its private files", async () => {
  let ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  const capture = ui.saved();
  await ui.elements.review.onclick();
  await blockButton(ui, 0, "SVG").onclick();
  ui = await reopenReview(ui, capture);
  await blockButton(ui, 0, "Delete").onclick();
  assert.equal(ui.hideCalls(), 1);
  assert.doesNotMatch(ui.pageText(), /silverink:block=/);
  assert.equal([...ui.files.keys()].some(name => name.startsWith("SilverInk/Blocks/")), false);
  assert.equal([...ui.files.keys()].some(name => name.endsWith(".svg")), false);
});

test("blocks insert separately and an inserted block cannot be inserted twice", async () => {
  let ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  ui.canvas.emit("pointerdown", ui.pointer(2, 10, 110));
  ui.window.emit("pointerup", ui.pointer(2, 10, 110));
  await ui.elements.review.onclick();
  splitFirstBlock(ui);
  assert.equal(ui.elements["review-list"].children.length, 2);
  await blockButton(ui, 0, "SVG").onclick();
  assert.equal(ui.insertCalls(), 1);
  assert.equal(ui.hideCalls(), 1);
  ui = await reopenReview(ui);
  assert.equal(blockButton(ui, 0, "SVG").disabled, true);
  await blockButton(ui, 0, "SVG").onclick();
  assert.equal(ui.insertCalls(), 0);
  await blockButton(ui, 1, "SVG").onclick();
  assert.equal(ui.insertCalls(), 1);
  assert.equal((ui.pageText().match(/silverink:block=/g) || []).length, 2);
  assert.equal([...ui.files.keys()].filter(path => path.endsWith(".svg")).length, 2);
  assert.equal([...ui.files.keys()].filter(path => path.startsWith("SilverInk/Sessions/")).length, 2);
  assert.equal(ui.elements["delete-capture"].hidden, false);
});

test("confirmed capture cleanup waits until every block owns separate strokes", async () => {
  let ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  ui.canvas.emit("pointerdown", ui.pointer(2, 10, 110));
  ui.window.emit("pointerup", ui.pointer(2, 10, 110));
  const captureId = ui.saved().id;
  const capture = ui.saved();
  ui.files.set(`SilverInk/Sessions/${captureId}.json`,
    new TextEncoder().encode(JSON.stringify(ui.saved())));
  await ui.elements.review.onclick();
  splitFirstBlock(ui);
  assert.equal(ui.elements["delete-capture"].hidden, true);
  await blockButton(ui, 0, "SVG").onclick();
  ui = await reopenReview(ui, capture);
  assert.equal(ui.elements["delete-capture"].hidden, true);
  await blockButton(ui, 1, "SVG").onclick();
  ui = await reopenReview(ui, capture);
  await ui.elements["delete-capture"].onclick();
  assert.equal(ui.files.has(`SilverInk/Sessions/${captureId}.json`), false);
  const blockSources = [...ui.files.keys()].filter(path => path.startsWith("SilverInk/Sessions/"));
  assert.equal(blockSources.length, 2);
});

test("one block can be transcribed while another remains a drawing", async () => {
  let ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  ui.canvas.emit("pointerdown", ui.pointer(2, 10, 110));
  ui.window.emit("pointerup", ui.pointer(2, 10, 110));
  await ui.elements.review.onclick();
  splitFirstBlock(ui);
  await blockButton(ui, 0, "Transcribe").onclick();
  assert.match(ui.pageText(), /Handwritten words/);
  assert.doesNotMatch(ui.pageText(), /!\[SilverInk drawing\]/);
  const record = JSON.parse(new TextDecoder().decode(
    [...ui.files.entries()].find(([path]) => path.includes("/Blocks/") && path.endsWith(".json"))[1]));
  assert.equal(record.kind, "text");
  assert.equal(record.strokeIds.length, 1);
  ui = await reopenReview(ui);
  await blockButton(ui, 1, "SVG").onclick();
  assert.match(ui.pageText(), /!\[SilverInk drawing\]/);
});

test("insertion preserves the selected original page text", async () => {
  const ui = await panel({ from: 2, to: 7, text: "Notes" });
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  await blockButton(ui, 0, "SVG").onclick();
  const selected = ui.restoredSelection();
  assert.ok(selected);
  assert.equal(ui.pageText().slice(selected[0], selected[1]), "Notes");
});

test("a page edit during asset writes aborts insertion", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  ui.onWrite(() => ui.changePage("# Changed elsewhere\n"));
  await blockButton(ui, 0, "SVG").onclick();
  assert.equal(ui.insertCalls(), 0);
  assert.equal(ui.pageText(), "# Changed elsewhere\n");
});

test("a failed asset write leaves the page unchanged", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  ui.onWrite(() => { throw Error("Space unavailable"); });
  await blockButton(ui, 0, "SVG").onclick();
  assert.equal(ui.insertCalls(), 0);
  assert.equal(ui.pageText(), "# Notes\n");
  assert.match(ui.elements.status.textContent, /Nothing was inserted/);
});

test("a failed page save locks further insertion until the panel is reopened", async () => {
  const ui = await panel();
  ui.canvas.emit("pointerdown", ui.pointer(1, 10, 10));
  ui.window.emit("pointerup", ui.pointer(1, 10, 10));
  await ui.elements.review.onclick();
  ui.onSave(() => { throw Error("Save failed"); });
  await blockButton(ui, 0, "SVG").onclick();
  assert.equal(ui.insertCalls(), 1);
  assert.match(ui.elements.status.textContent, /may have happened/);
  assert.equal(blockButton(ui, 0, "SVG").disabled, true);
  await blockButton(ui, 0, "SVG").onclick();
  assert.equal(ui.insertCalls(), 1);
});

test("Edit block opens only that block's strokes and keeps page Markdown unchanged", async () => {
  const fixture = editingFixture();
  const ui = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: fixture.files });
  assert.equal(ui.saved().strokes.length, 1);
  assert.equal(ui.saved().strokes[0].id, "stroke-0001");
  assert.equal(ui.elements.review.hidden, true);
  assert.equal(ui.elements["update-block"].hidden, false);
  ui.canvas.emit("pointerdown", ui.pointer(1, 50, 50));
  ui.window.emit("pointerup", ui.pointer(1, 50, 50));
  await ui.elements["update-block"].onclick();
  assert.equal(ui.pageText(), fixture.pageText);
  const record = JSON.parse(new TextDecoder().decode(ui.files.get("SilverInk/Blocks/block-0001.json")));
  assert.equal(record.strokeIds.length, 2);
  assert.notEqual(record.sessionId, fixture.source.id);
  assert.equal(record.sourceRevision, 1);
  assert.equal(ui.files.has(`SilverInk/Sessions/${record.sessionId}.json`), true);
  assert.equal(JSON.parse(new TextDecoder().decode(
    ui.files.get(`SilverInk/Sessions/${fixture.source.id}.json`))).strokes.length, 2);
});

test("a block moved to another page can still open and save its source strokes", async () => {
  const fixture = editingFixture();
  const ui = await panel(fixture.selection,
    { mode: "edit", page: "Archive/Notes", pageText: fixture.pageText, files: fixture.files });
  assert.equal(ui.saved().strokes.length, 1);
  await ui.elements["update-block"].onclick();
  const record = JSON.parse(new TextDecoder().decode(ui.files.get("SilverInk/Blocks/block-0001.json")));
  assert.equal(record.page, "Notes");
  assert.notEqual(record.sessionId, fixture.source.id);
  assert.equal(ui.pageText(), fixture.pageText);
});

test("an unapplied block edit draft resumes with only its block strokes", async () => {
  const fixture = editingFixture();
  const first = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: fixture.files });
  first.canvas.emit("pointerdown", first.pointer(1, 50, 50));
  first.window.emit("pointerup", first.pointer(1, 50, 50));
  await first.elements.close.onclick();
  const reopened = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: first.files, storage: first.local });
  assert.equal(reopened.elements.status.textContent.includes("2 source strokes"), true);
  assert.equal(reopened.elements["update-block"].hidden, false);
});

test("a saved SVG block can later be transcribed while retaining its source strokes", async () => {
  const fixture = editingFixture();
  const ui = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: fixture.files });
  assert.equal(ui.elements["transcribe-existing"].hidden, false);
  await ui.elements["transcribe-existing"].onclick();
  assert.match(ui.pageText(), /<!-- silverink:block=block-0001;/);
  assert.match(ui.pageText(), /Handwritten words/);
  assert.doesNotMatch(ui.pageText(), /!\[SilverInk drawing\]/);
  const record = JSON.parse(new TextDecoder().decode(ui.files.get("SilverInk/Blocks/block-0001.json")));
  assert.equal(record.kind, "text");
  assert.equal(record.acceptedMarkdown, "Handwritten words");
  assert.equal(record.sessionId, "block-0001");
  assert.equal(ui.files.has("SilverInk/Sessions/block-0001.json"), true);
  assert.equal(ui.files.has("SilverInk/Graphics/block-0001.svg"), false);
  assert.equal(ui.hideCalls(), 1);
  const reopened = await panel({ from: ui.pageText().indexOf("Handwritten words"), to: ui.pageText().indexOf("Handwritten words"), text: "" },
    { mode: "edit", pageText: ui.pageText(), files: ui.files, storage: ui.local });
  assert.equal(reopened.elements["transcribe-existing"].hidden, false);
  assert.equal(reopened.saved().strokes.length, 1);
});

test("a text block can be re-OCRed from its retained strokes", async () => {
  const fixture = editingFixture();
  const first = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: fixture.files });
  await first.elements["transcribe-existing"].onclick();
  const prior = first.pageText();
  const pos = prior.indexOf("Handwritten words");
  const response = { status: 200,
    base64Body: btoa(JSON.stringify({ response: "Corrected text", done: true })) };
  const second = await panel({ from: pos, to: pos, text: "" },
    { mode: "edit", pageText: prior, files: first.files, storage: first.local, ocrResponse: response });
  await second.elements["transcribe-existing"].onclick();
  assert.match(second.pageText(), /Corrected text/);
  assert.doesNotMatch(second.pageText(), /Handwritten words/);
  const record = JSON.parse(new TextDecoder().decode(second.files.get("SilverInk/Blocks/block-0001.json")));
  assert.equal(record.acceptedMarkdown, "Corrected text");
  assert.equal(second.files.has(`SilverInk/Sessions/${record.sessionId}.json`), true);
});

test("re-OCR preserves manually edited Markdown by inserting a separate candidate", async () => {
  const fixture = editingFixture();
  const first = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: fixture.files });
  await first.elements["transcribe-existing"].onclick();
  const edited = first.pageText().replace("Handwritten words", "My edited words");
  const pos = edited.indexOf("My edited words");
  const second = await panel({ from: pos, to: pos, text: "" },
    { mode: "edit", pageText: edited, files: first.files, storage: first.local });
  await second.elements["transcribe-existing"].onclick();
  assert.match(second.pageText(), /Handwritten words\n\n<!-- silverink:block=block-0001;/);
  assert.match(second.pageText(), /My edited words/);
  const record = JSON.parse(new TextDecoder().decode(second.files.get("SilverInk/Blocks/block-0001.json")));
  assert.equal(record.acceptedMarkdown, "Handwritten words");
});

test("failed later OCR keeps the published SVG and its source", async () => {
  const fixture = editingFixture();
  const ui = await panel(fixture.selection, { mode: "edit", pageText: fixture.pageText,
    files: fixture.files, ocrResponse: { status: 503, base64Body: "" } });
  await ui.elements["transcribe-existing"].onclick();
  assert.equal(ui.pageText(), fixture.pageText);
  assert.equal(JSON.parse(new TextDecoder().decode(
    ui.files.get("SilverInk/Blocks/block-0001.json"))).kind, "drawing");
  assert.equal(ui.files.has("SilverInk/Graphics/block-0001.svg"), true);
  assert.equal(ui.hideCalls(), 0);
});

test("a failed block record write rolls back later OCR page replacement", async () => {
  const fixture = editingFixture();
  const recordPath = "SilverInk/Blocks/block-0001.json";
  const ui = await panel(fixture.selection, { mode: "edit", pageText: fixture.pageText,
    files: fixture.files, failWritePath: recordPath });
  await ui.elements["transcribe-existing"].onclick();
  assert.equal(ui.pageText(), fixture.pageText);
  assert.equal(JSON.parse(new TextDecoder().decode(ui.files.get(recordPath))).kind, "drawing");
  assert.equal(ui.files.has("SilverInk/Graphics/block-0001.svg"), true);
  assert.equal(ui.hideCalls(), 0);
});

test("later OCR waits until edited strokes have been saved", async () => {
  const fixture = editingFixture();
  const ui = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: fixture.files });
  ui.canvas.emit("pointerdown", ui.pointer(1, 50, 50));
  ui.window.emit("pointerup", ui.pointer(1, 50, 50));
  await ui.elements["transcribe-existing"].onclick();
  assert.equal(ui.pageText(), fixture.pageText);
  assert.equal(ui.files.has("SilverInk/Graphics/block-0001.svg"), true);
});

test("deleting drawing strokes removes its link, SVG, record and private session", async () => {
  const fixture = editingFixture();
  const ui = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files: fixture.files });
  await ui.elements["delete-block"].onclick();
  assert.doesNotMatch(ui.pageText(), /silverink:block|SilverInk drawing/);
  assert.match(ui.pageText(), /# Notes/);
  assert.equal(ui.files.has("SilverInk/Blocks/block-0001.json"), false);
  assert.equal(ui.files.has("SilverInk/Graphics/block-0001.svg"), false);
  assert.equal(ui.files.has("SilverInk/Sessions/block-0001.json"), false);
  assert.equal(ui.files.has(`SilverInk/Sessions/${fixture.source.id}.json`), true);
});

test("deleting text strokes preserves transcribed Markdown", async () => {
  const fixture = editingFixture();
  const recordPath = "SilverInk/Blocks/block-0001.json";
  const record = JSON.parse(new TextDecoder().decode(fixture.files.find(([path]) => path === recordPath)[1]));
  record.kind = "text";
  record.acceptedMarkdown = "Edited transcription";
  record.svgPath = null;
  const files = fixture.files.filter(([path]) => path !== recordPath && !path.endsWith("block-0001.svg"));
  files.push([recordPath, new TextEncoder().encode(JSON.stringify(record))]);
  const pageText = fixture.pageText.replace(/!\[SilverInk drawing\]\(<[^>]+>\)/, "Edited transcription");
  const pos = pageText.indexOf("Edited transcription");
  const ui = await panel({ from: pos, to: pos, text: "" },
    { mode: "edit", pageText, files });
  await ui.elements["delete-block"].onclick();
  assert.match(ui.pageText(), /Edited transcription/);
  assert.doesNotMatch(ui.pageText(), /silverink:block/);
  assert.equal(ui.files.has(recordPath), false);
  assert.equal(ui.files.has("SilverInk/Sessions/block-0001.json"), false);
});

test("deleting a legacy block leaves its shared capture session", async () => {
  const fixture = editingFixture();
  const recordPath = "SilverInk/Blocks/block-0001.json";
  const record = JSON.parse(new TextDecoder().decode(fixture.files.find(([path]) => path === recordPath)[1]));
  record.sessionId = fixture.source.id;
  record.sourceRevision = fixture.source.revision;
  const files = fixture.files.filter(([path]) => path !== recordPath);
  files.push([recordPath, new TextEncoder().encode(JSON.stringify(record))]);
  const ui = await panel(fixture.selection,
    { mode: "edit", pageText: fixture.pageText, files });
  await ui.elements["delete-block"].onclick();
  assert.equal(ui.files.has(recordPath), false);
  assert.equal(ui.files.has(`SilverInk/Sessions/${fixture.source.id}.json`), true);
});
