const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../block_admin.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const adminExports = {};
vm.runInNewContext(compiled, { exports: adminExports, TextDecoder, Set, Map });
const { deleteSelectedBlock, cleanOrphanedBlocks } = adminExports;

function fixture(kind = "drawing", extraPages = {}) {
  const id = "block-0001", captureId = "capture-0001";
  const graphic = `SilverInk/Graphics/${id}.svg`;
  const markdown = kind === "text" ? "Recognized and edited words" :
    `![SilverInk drawing](<${graphic}>)`;
  const marker = `<!-- silverink:block=${id};session=${captureId};rev=1 -->`;
  const page = `# Notes\n\n${marker}\n${markdown}\n\nMore notes`;
  const record = { format: 1, id, page: "Notes", sessionId: id,
    kind, acceptedMarkdown: markdown, svgPath: kind === "drawing" ? graphic : null,
    pngPath: null };
  const encoder = new TextEncoder();
  const files = new Map([
    ["Notes.md", encoder.encode(page)],
    [`SilverInk/Blocks/${id}.json`, encoder.encode(JSON.stringify(record))],
    [`SilverInk/Sessions/${id}.json`, encoder.encode(JSON.stringify({ id, blockEditOf: id }))],
    [`SilverInk/Sessions/${captureId}.json`, encoder.encode(JSON.stringify({ id: captureId }))],
  ]);
  if (kind === "drawing") files.set(graphic, encoder.encode("<svg/>"));
  for (const [name, contents] of Object.entries(extraPages)) files.set(`${name}.md`, encoder.encode(contents));
  let text = page, confirmResult = true, writes = 0;
  const notifications = [];
  const bridge = {
    getCurrentPage: async () => "Notes",
    getText: async () => text,
    getSelection: async () => ({ from: page.indexOf(markdown), to: page.indexOf(markdown), text: "" }),
    replaceRange: async (from, to, replacement) => { text = text.slice(0, from) + replacement + text.slice(to); },
    save: async () => { files.set("Notes.md", encoder.encode(text)); writes++; },
    confirm: async () => confirmResult,
    flashNotification: async (message, type) => notifications.push({ message, type }),
    listFiles: async () => [...files.keys()].map(name => ({ name })),
    readFile: async name => {
      if (!files.has(name)) throw Error(`Missing ${name}`);
      return files.get(name);
    },
    deleteFile: async name => { files.delete(name); },
  };
  return { bridge, files, notifications, id, captureId, graphic,
    pageText: () => text, writes: () => writes, cancel: () => { confirmResult = false; } };
}

test("Delete selected block removes drawing link, record, graphic, and private source", async () => {
  const f = fixture();
  await deleteSelectedBlock(f.bridge);
  assert.doesNotMatch(f.pageText(), /silverink:block|SilverInk drawing/);
  assert.match(f.pageText(), /More notes/);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), false);
  assert.equal(f.files.has(`SilverInk/Sessions/${f.id}.json`), false);
  assert.equal(f.files.has(f.graphic), false);
  assert.equal(f.files.has(`SilverInk/Sessions/${f.captureId}.json`), true);
  assert.equal(f.writes(), 1);
});

test("Delete selected text block keeps editable Markdown", async () => {
  const f = fixture("text");
  await deleteSelectedBlock(f.bridge);
  assert.match(f.pageText(), /Recognized and edited words/);
  assert.doesNotMatch(f.pageText(), /silverink:block/);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), false);
});

test("Delete selected block refuses a graphic linked elsewhere", async () => {
  const f = fixture("drawing", { Other: "![shared](<SilverInk/Graphics/block-0001.svg>)" });
  await deleteSelectedBlock(f.bridge);
  assert.match(f.pageText(), /silverink:block/);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), true);
  assert.equal(f.writes(), 0);
});

test("Cleanup removes orphan block assets after manual page deletion and keeps capture", async () => {
  const f = fixture();
  await f.bridge.replaceRange(0, f.pageText().length, "# Notes\n\nMore notes");
  await f.bridge.save();
  await cleanOrphanedBlocks(f.bridge);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), false);
  assert.equal(f.files.has(`SilverInk/Sessions/${f.id}.json`), false);
  assert.equal(f.files.has(f.graphic), false);
  assert.equal(f.files.has(`SilverInk/Sessions/${f.captureId}.json`), true);
});

test("Cleanup keeps blocks whose image link remains on another page", async () => {
  const f = fixture("drawing", { Other: "![shared](<SilverInk/Graphics/block-0001.svg>)" });
  await f.bridge.replaceRange(0, f.pageText().length, "# Notes");
  await cleanOrphanedBlocks(f.bridge);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), true);
  assert.equal(f.files.has(f.graphic), true);
});

test("Cleanup confirmation can be canceled", async () => {
  const f = fixture();
  await f.bridge.replaceRange(0, f.pageText().length, "# Notes");
  f.cancel();
  await cleanOrphanedBlocks(f.bridge);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), true);
});

test("Cleanup rechecks page references after confirmation", async () => {
  const f = fixture();
  await f.bridge.replaceRange(0, f.pageText().length, "# Notes");
  const originalConfirm = f.bridge.confirm;
  f.bridge.confirm = async (...args) => {
    f.files.set("Other.md", new TextEncoder().encode(`![drawing](<${f.graphic}>)`));
    return originalConfirm(...args);
  };
  await cleanOrphanedBlocks(f.bridge);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), true);
  assert.equal(f.files.has(f.graphic), true);
});

test("Failed page save retains block files and reports uncertain deletion", async () => {
  const f = fixture();
  f.bridge.save = async () => { throw Error("save failed"); };
  await deleteSelectedBlock(f.bridge);
  assert.equal(f.files.has(`SilverInk/Blocks/${f.id}.json`), true);
  assert.match(f.notifications.at(-1).message, /page deletion may have happened/);
});
