const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../ui/model.js");
const B = require("../ui/blocks.js");

function stroke(id, x, y) {
  return { id, tool: "pen", width: 2.5, points: [
    { x, y, p: 0.5, t: 1 }, { x: x + 20, y: y + 8, p: 0.5, t: 2 },
  ] };
}

function document() {
  const doc = M.create("Projects/Notes", "session-0001", 1);
  doc.strokes = [stroke("stroke-0003", 10, 110), stroke("stroke-0001", 10, 10),
    stroke("stroke-0002", 60, 12)];
  M.touch(doc, 2);
  return doc;
}

function twoBlocks(doc) {
  return B.split(doc, B.start(doc, () => "block-0001"), 0, 2,
    () => "block-0002");
}

test("review starts with one block and manual splits keep page order and stroke IDs", () => {
  const doc = document();
  const review = B.start(doc, () => "block-0001");
  assert.deepEqual(review.blocks.map(b => b.strokeIds),
    [["stroke-0001", "stroke-0002", "stroke-0003"]]);
  const two = B.split(doc, review, 0, 2, () => "block-0002");
  const split = B.split(doc, two, 0, 1, () => "block-0003");
  assert.deepEqual(split.blocks.map(b => b.strokeIds),
    [["stroke-0001"], ["stroke-0002"], ["stroke-0003"]]);
  const merged = B.merge(doc, split, 0);
  assert.deepEqual(merged.blocks.map(b => b.strokeIds), two.blocks.map(b => b.strokeIds));
  assert.deepEqual(review.blocks[0].strokeIds, ["stroke-0001", "stroke-0002", "stroke-0003"]);
});

test("review rejects stale revisions and missing or duplicate source strokes", () => {
  const doc = document(), review = twoBlocks(doc);
  const missing = structuredClone(review);
  missing.blocks[0].strokeIds.pop();
  assert.throws(() => B.validate(doc, missing), /every stroke/);
  const duplicate = structuredClone(review);
  duplicate.blocks[1].strokeIds.push("stroke-0001");
  assert.throws(() => B.validate(doc, duplicate), /duplicate stroke/);
  M.touch(doc, 3);
  assert.throws(() => B.validate(doc, review), /stale/);
});

test("discarded blocks retain their source IDs but cannot be inserted or split", () => {
  const doc = document();
  const review = twoBlocks(doc);
  review.blocks[0].kind = "discarded";
  B.validate(doc, review);
  assert.throws(() => B.prepareBlock(doc, review, review.blocks[0].id,
    "drawing", "# Notes\n", 8), /discarded/);
  assert.throws(() => B.split(doc, review, 0, 1), /Choose a stroke/);
});

test("prepared text and drawing retain stable references and safe SVG", () => {
  const doc = document();
  const review = twoBlocks(doc);
  review.blocks[0].kind = "text";
  review.blocks[0].markdown = "## Heading\n\n- First item";
  const original = "# Existing\n";
  const text = B.prepareBlock(doc, review, "block-0001", "text", original, original.length, 42);
  assert.match(text.insertion, /<!-- silverink:block=block-0001;session=session-0001;rev=1 -->\n## Heading/);
  assert.equal(text.files.length, 2);
  const withText = original + text.insertion;
  const drawing = B.prepareBlock(doc, review, "block-0002", "drawing", withText, withText.length, 43);
  assert.match(drawing.insertion, /!\[SilverInk drawing\]\(<\.\.\/SilverInk\/Graphics\/block-0002\.svg>\)/);
  assert.equal(drawing.files.length, 3);
  const svg = drawing.files.find(f => f.path.endsWith(".svg")).content;
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(svg.includes(doc.page), false);
  assert.equal(svg, M.svgStrokes(doc, ["stroke-0003"]));
  const textRecord = JSON.parse(text.files.find(f => f.path.endsWith("Blocks/block-0001.json")).content);
  assert.deepEqual(textRecord.strokeIds, ["stroke-0001", "stroke-0002"]);
  assert.equal(textRecord.sessionId, "block-0001");
  assert.equal(textRecord.sourceRevision, 0);
  assert.equal(textRecord.acceptedMarkdown, "## Heading\n\n- First item");
  const textSource = JSON.parse(text.files.find(f => f.path.endsWith("Sessions/block-0001.json")).content);
  const drawingSource = JSON.parse(drawing.files.find(f => f.path.endsWith("Sessions/block-0002.json")).content);
  assert.deepEqual(textSource.strokes.map(s => s.id), ["stroke-0001", "stroke-0002"]);
  assert.deepEqual(drawingSource.strokes.map(s => s.id), ["stroke-0003"]);
  assert.equal(textSource.blockEditOf, "block-0001");
  assert.equal(textSource.captureSessionId, doc.id);
  assert.equal(B.hasSessionMarker(withText, doc.id), true);
  assert.equal(B.hasBlockMarker(withText, "block-0001"), true);
  assert.throws(() => B.prepareBlock(doc, review, "block-0001", "text", withText, withText.length), /already on the page/);
});

test("preparation protects frontmatter and refuses unreviewed text", () => {
  const doc = document();
  const ids = ["block-0001", "block-0002"];
  const review = B.start(doc, () => ids.shift());
  const page = "---\ntitle: Notes\n---\n# Existing\n";
  assert.throws(() => B.prepareBlock(doc, review, "block-0001", "drawing", page, 5), /cursor in the page body/);
  review.blocks[0].kind = "text";
  assert.throws(() => B.prepareBlock(doc, review, "block-0001", "text", page, page.length), /needs reviewed Markdown/);
  review.blocks[0].markdown = "Reviewed text";
  const prepared = B.prepareBlock(doc, review, "block-0001", "text", page, page.length);
  assert.match(prepared.insertion, /Reviewed text/);
  assert.equal(page, "---\ntitle: Notes\n---\n# Existing\n");
});

test("a new review cannot duplicate strokes from an earlier review of the same session", () => {
  const doc = document();
  const ids = ["block-0001", "block-0002"];
  const review = B.start(doc, () => ids.shift());
  const page = "<!-- silverink:block=oldblock-0001;session=session-0001;rev=1 -->\nOld drawing";
  assert.throws(() => B.prepareBlock(doc, review, "block-0001", "drawing", page, page.length),
    /another review/);
});

test("page context selects the containing block and edit copy contains only its strokes", () => {
  const doc = document();
  const review = twoBlocks(doc);
  const first = B.prepareBlock(doc, review, "block-0001", "drawing", "", 0, 42);
  const page = first.insertion + "\n\nBetween\n\n" +
    B.prepareBlock(doc, review, "block-0002", "drawing", "", 0, 43).insertion;
  assert.equal(B.blockAt(page, page.indexOf("Between")).id, "block-0001");
  assert.equal(B.blockAt(page, page.length).id, "block-0002");
  const record = B.validateRecord(JSON.parse(
    B.prepareBlock(doc, review, "block-0002", "drawing", "", 0).files
      .find(file => file.path.endsWith("Blocks/block-0002.json")).content), doc.page);
  const source = B.blockSource(doc, review.blocks[1]);
  const copy = B.editCopy(record, source, () => "session-edit-0001");
  assert.deepEqual(copy.strokes.map(stroke => stroke.id), ["stroke-0003"]);
  assert.equal(copy.strokes[0].points[0].y, 40);
  assert.equal(source.strokes[0].points[0].y, 110);
  assert.equal(copy.id, "session-edit-0001");
  assert.equal(copy.blockEditOf, "block-0002");
});

test("deleting text keeps Markdown; deleting a drawing removes only its own link", () => {
  const doc = document();
  const review = twoBlocks(doc);
  review.blocks[0].kind = "text";
  review.blocks[0].markdown = "Edited text";
  const text = B.prepareBlock(doc, review, "block-0001", "text", "", 0, 42);
  const textRecord = JSON.parse(text.files.find(f => f.path.endsWith("Blocks/block-0001.json")).content);
  const textPage = text.insertion + "\nUnrelated text";
  const textPlan = B.prepareDeletion(textPage, B.blockAt(textPage, 0), textRecord);
  assert.equal(textPlan.expected.includes("Edited text"), true);
  assert.equal(textPlan.expected.includes("silverink:block"), false);
  assert.equal(textPlan.expected.includes("Unrelated text"), true);

  const drawing = B.prepareBlock(doc, review, "block-0002", "drawing", "", 0, 43);
  const drawingRecord = JSON.parse(drawing.files.find(f => f.path.endsWith("Blocks/block-0002.json")).content);
  const drawingPage = drawing.insertion + "\nOther content";
  const drawingPlan = B.prepareDeletion(drawingPage, B.blockAt(drawingPage, 0), drawingRecord);
  assert.equal(drawingPlan.expected.includes("SilverInk/Graphics/block-0002.svg"), false);
  assert.equal(drawingPlan.expected.includes("Other content"), true);
  assert.throws(() => B.prepareDeletion(drawingPage.replace("SilverInk drawing", "Edited link"),
    B.blockAt(drawingPage, 0), drawingRecord), /drawing link has changed/);
});

test("PNG blocks use a normal image link and deletion removes only that link", () => {
  const doc = document();
  const ids = ["block-0001", "block-0002"];
  const review = B.start(doc, () => ids.shift());
  const prepared = B.prepareBlock(doc, review, "block-0001", "png", "# Notes\n", 8, 42);
  const record = B.validateRecord(JSON.parse(prepared.files.find(file =>
    file.path.endsWith("Blocks/block-0001.json")).content));
  assert.equal(record.pngPath, "SilverInk/Graphics/block-0001.png");
  assert.match(prepared.insertion, /Graphics\/block-0001\.png/);
  const page = "# Notes\n" + prepared.insertion + "\nOther text";
  const removed = B.prepareDeletion(page, B.blockAt(page, 8), record);
  assert.equal(removed.expected.includes("Graphics/block-0001.png"), false);
  assert.equal(removed.expected.includes("Other text"), true);
});
