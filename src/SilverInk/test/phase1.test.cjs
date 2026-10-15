const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../ui/model.js");
const { Store, sessionPath, docKey } = require("../ui/store.js");

function stroke(id, points = [{ x: 10, y: 20, p: 0.5, t: 100 }]) {
  return { id, tool: "pen", width: 2.5, points };
}

class MemoryLocal {
  data = new Map();
  get length() { return this.data.size; }
  key(n) { return [...this.data.keys()][n] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}

class MemoryRemote {
  files = new Map();
  fail = false;
  async listFiles() {
    if (this.fail) throw Error("offline");
    return [...this.files.keys()].map(name => ({ name }));
  }
  async readFile(path) {
    if (this.fail) throw Error("offline");
    if (!this.files.has(path)) throw Error("not found");
    return this.files.get(path);
  }
  async writeFile(path, bytes) {
    if (this.fail) throw Error("offline");
    this.files.set(path, bytes);
  }
}

test("stroke serialization retains IDs, coordinates, pressure, and undo state", () => {
  const doc = M.create("Notes", "session-0001", 1);
  doc.inProgress = stroke("stroke-0001", [
    { x: 10.125, y: 20, p: 0.4, t: 100 },
    { x: 30, y: 40, p: 0.8, t: 110 },
  ]);
  assert.equal(M.finish(doc, 120), true);
  assert.equal(doc.revision, 1);
  assert.equal(M.undo(doc), true);
  assert.equal(M.validate(JSON.parse(JSON.stringify(doc))).redo[0].id, "stroke-0001");
  assert.equal(M.redo(doc), true);
  assert.deepEqual(doc.strokes[0].points[1], { x: 30, y: 40, p: 0.8, t: 110 });
  assert.equal(doc.revision, 3);
});

test("SVG is deterministic and contains only generated numeric geometry", () => {
  const doc = M.create("Notes", "session-0001", 1);
  doc.strokes.push(stroke("stroke-0001", [
    { x: 10.125, y: 20, p: 0.5, t: 100 },
    { x: 30, y: 40, p: 0.5, t: 110 },
  ]));
  const first = M.svg(doc);
  assert.equal(first, M.svg(JSON.parse(JSON.stringify(doc))));
  assert.match(first, /<path d="M10\.13 20 L30 40" fill="none" stroke-width="2\.5"\/>/);
  assert.equal(first.includes(doc.page), false);
  doc.strokes[0].points[0].x = Infinity;
  assert.throws(() => M.svg(doc), /Invalid/);
});

test("eraser removes a complete stroke without changing other stable IDs", () => {
  const doc = M.create("Notes", "session-0001", 1);
  doc.strokes.push(stroke("stroke-0001"), stroke("stroke-0002", [{ x: 100, y: 100, p: .5, t: 101 }]));
  assert.equal(M.eraseAt(doc, { x: 10, y: 20 }), true);
  assert.deepEqual(doc.strokes.map(s => s.id), ["stroke-0002"]);
  assert.equal(M.eraseAt(doc, { x: 10, y: 20 }), false);
});

test("buffered saves coalesce pen events and flush the newest recovery copy", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  let writes = 0;
  const originalWrite = remote.writeFile.bind(remote);
  remote.writeFile = async (...args) => { writes++; return originalWrite(...args); };
  const store = new Store(local, remote);
  const doc = M.create("Notes", "session-0001", 1);
  doc.inProgress = stroke("stroke-0001");
  store.bufferLocal(doc, () => {}, 100000);
  doc.inProgress.points.push({ x: 15, y: 25, p: 0.5, t: 101 });
  store.bufferLocal(doc, () => {}, 100000);
  assert.equal(local.getItem(docKey(doc.id)), null);
  M.finish(doc);
  const firstWrite = store.bufferRemote(doc, 100000);
  doc.inProgress = stroke("stroke-0002");
  store.bufferLocal(doc, () => {}, 100000);
  const secondWrite = store.bufferRemote(doc, 100000);
  assert.equal(firstWrite, secondWrite);
  assert.equal(await store.flush(), true);
  await firstWrite;
  assert.equal(writes, 1);
  assert.equal(JSON.parse(local.getItem(docKey(doc.id))).inProgress.id, "stroke-0002");
  const saved = JSON.parse(new TextDecoder().decode(remote.files.get(sessionPath(doc.id))));
  assert.equal(saved.strokes[0].points.length, 2);
  assert.equal(saved.inProgress, null);
});

test("local in-progress stroke recovers after Space write failure and reload", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  remote.fail = true;
  const firstStore = new Store(local, remote);
  const doc = M.create("Notes", "session-0001", 1);
  doc.inProgress = stroke("stroke-0001");
  firstStore.saveLocal(doc);
  await assert.rejects(firstStore.schedule(doc), /offline/);
  assert.equal(await firstStore.flush(), false);
  const reopened = new Store(local, remote);
  const result = await reopened.open("Notes");
  assert.equal(result.doc.inProgress.id, "stroke-0001");
  assert.match(result.warning, /offline/);
  remote.fail = false;
  M.finish(result.doc, 200);
  reopened.saveLocal(result.doc);
  await reopened.schedule(result.doc);
  const fromSpace = JSON.parse(new TextDecoder().decode(remote.files.get(sessionPath(doc.id))));
  assert.equal(fromSpace.strokes[0].id, "stroke-0001");
  assert.equal(fromSpace.revision, 1);
});

test("newer local revision wins and is written back to Space on open", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const doc = M.create("Notes", "session-0001", 1);
  remote.files.set(sessionPath(doc.id), new TextEncoder().encode(JSON.stringify(doc)));
  doc.strokes.push(stroke("stroke-0001"));
  M.touch(doc, 2);
  new Store(local, remote).saveLocal(doc);
  const store = new Store(local, remote);
  assert.equal((await store.open("Notes")).doc.revision, 1);
  assert.equal(await store.flush(), true);
  assert.equal(JSON.parse(new TextDecoder().decode(remote.files.get(sessionPath(doc.id)))).revision, 1);
});

test("equal-revision divergent copies stop recovery rather than overwrite", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const doc = M.create("Notes", "session-0001", 1);
  new Store(local, remote).saveLocal(doc);
  const other = structuredClone(doc);
  other.strokes.push(stroke("stroke-0001"));
  remote.files.set(sessionPath(doc.id), new TextEncoder().encode(JSON.stringify(other)));
  await assert.rejects(new Store(local, remote).open("Notes"), /divergent copies/);
  assert.equal(JSON.parse(local.getItem(docKey(doc.id))).strokes.length, 0);
});

test("unfinished local stroke is preserved if the Space revision advanced", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const doc = M.create("Notes", "session-0001", 1);
  doc.inProgress = stroke("stroke-0001");
  new Store(local, remote).saveLocal(doc);
  const newer = M.create("Notes", "session-0001", 1);
  newer.strokes.push(stroke("stroke-0002"));
  M.touch(newer, 2);
  remote.files.set(sessionPath(doc.id), new TextEncoder().encode(JSON.stringify(newer)));
  await assert.rejects(new Store(local, remote).open("Notes"), e => {
    assert.equal(e.recovery.inProgress.id, "stroke-0001");
    return true;
  });
  assert.equal(JSON.parse(local.getItem(docKey(doc.id))).inProgress.id, "stroke-0001");
});

test("browser recovery keys are isolated by SilverBullet space and account", () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const doc = M.create("Notes", "session-0001", 1);
  new Store(local, remote, "space-a|user-a").saveLocal(doc);
  assert.equal(new Store(local, remote, "space-a|user-b").readLocal(doc.id), null);
  assert.equal(new Store(local, remote, "space-b|user-a").readLocal(doc.id), null);
  assert.equal(new Store(local, remote, "space-a|user-a").readLocal(doc.id).id, doc.id);
});

test("a newer Space revision cannot hide unacknowledged local edits", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const doc = M.create("Notes", "session-0001", 1);
  doc.strokes.push(stroke("stroke-0001"));
  M.touch(doc, 2);
  const store = new Store(local, remote);
  store.saveLocal(doc);
  const other = M.create("Notes", "session-0001", 1);
  other.strokes.push(stroke("stroke-0002"));
  M.touch(other, 3);
  M.touch(other, 4);
  remote.files.set(sessionPath(doc.id), new TextEncoder().encode(JSON.stringify(other)));
  await assert.rejects(new Store(local, remote).open("Notes"), e => {
    assert.equal(e.recovery.strokes[0].id, "stroke-0001");
    return true;
  });
  assert.equal(JSON.parse(local.getItem(docKey(doc.id))).strokes[0].id, "stroke-0001");
});

test("a newer Space revision replaces an acknowledged older local snapshot", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const store = new Store(local, remote);
  const doc = M.create("Notes", "session-0001", 1);
  store.saveLocal(doc);
  await store.schedule(doc);
  const newer = structuredClone(doc);
  newer.strokes.push(stroke("stroke-0001"));
  M.touch(newer, 2);
  remote.files.set(sessionPath(doc.id), new TextEncoder().encode(JSON.stringify(newer)));
  assert.equal((await new Store(local, remote).open("Notes")).doc.revision, 1);
});

test("session selection resumes the last selected page session", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const oldDoc = M.create("Notes", "session-0001", 1);
  const newDoc = M.create("Notes", "session-0002", 2);
  const store = new Store(local, remote);
  store.saveLocal(oldDoc);
  await store.schedule(oldDoc);
  store.saveLocal(newDoc);
  await store.schedule(newDoc);
  store.saveLocal(oldDoc);
  const reopened = await new Store(local, remote).open("Notes");
  assert.equal(reopened.doc.id, "session-0001");
  assert.equal(reopened.sessions.length, 2);
});

test("Handwrite ignores block-owned sessions and forgotten captures", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const store = new Store(local, remote);
  const capture = M.create("Notes", "session-0001", 1);
  const block = M.create("Notes", "block-0001", 2);
  block.blockEditOf = "block-0001";
  store.saveLocal(capture);
  await store.schedule(capture);
  store.saveLocal(block);
  await store.schedule(block);
  assert.deepEqual((await new Store(local, remote).open("Notes")).sessions.map(s => s.id),
    [capture.id]);
  store.forget(capture.id, capture.page);
  remote.files.delete(sessionPath(capture.id));
  assert.equal((await new Store(local, remote).open("Notes")).doc.blockEditOf, undefined);
  assert.equal(local.getItem(docKey(capture.id)), null);
});

test("a divergent private edit draft does not block Handwrite", async () => {
  const local = new MemoryLocal(), remote = new MemoryRemote();
  const block = M.create("Notes", "block-0001", 1);
  block.blockEditOf = "block-0001";
  new Store(local, remote).saveLocal(block);
  const other = structuredClone(block);
  other.strokes.push(stroke("stroke-0001"));
  remote.files.set(sessionPath(block.id), new TextEncoder().encode(JSON.stringify(other)));
  const result = await new Store(local, remote).open("Notes");
  assert.notEqual(result.doc.id, block.id);
  assert.equal(new Store(local, remote).readLocal(block.id).strokes.length, 0);
});
