type File = { name: string };
type Selection = { from: number; to: number; text: string };

export type BlockAdminBridge = {
  getCurrentPage(): Promise<string>;
  getText(): Promise<string>;
  getSelection(): Promise<Selection>;
  replaceRange(from: number, to: number, text: string): Promise<void>;
  save(): Promise<void>;
  confirm(message: string, options: { destructive: boolean }): Promise<boolean>;
  flashNotification(message: string, type?: "info" | "error" | "warning"): Promise<void>;
  listFiles(): Promise<File[]>;
  readFile(path: string): Promise<Uint8Array>;
  deleteFile(path: string): Promise<void>;
};

type Record = {
  format: number;
  id: string;
  page: string;
  sessionId: string;
  kind: "text" | "drawing" | "png";
  acceptedMarkdown: string;
  svgPath: string | null;
  pngPath: string | null;
};

const idPattern = /^[\w-]{8,80}$/;
const recordPattern = /^SilverInk\/Blocks\/([\w-]{8,80})\.json$/;
const markerPattern = /<!-- silverink:block=([\w-]{8,80});session=([\w-]{8,80});rev=(\d+) -->/g;
const graphicPattern = /SilverInk\/Graphics\/([\w-]{8,80})\.(?:svg|png)/g;
const decoder = new TextDecoder();

function recordPath(id: string): string { return `SilverInk/Blocks/${id}.json`; }

function parseRecord(bytes: Uint8Array, id: string): Record {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!value || typeof value !== "object") throw new Error(`Invalid block record ${id}`);
  const record = value as Record;
  if (record.format !== 1 || record.id !== id || !idPattern.test(record.sessionId) ||
      typeof record.page !== "string" || typeof record.acceptedMarkdown !== "string" ||
      !["text", "drawing", "png"].includes(record.kind) ||
      (record.kind === "drawing" && (record.svgPath !== `SilverInk/Graphics/${id}.svg` || record.pngPath)) ||
      (record.kind === "png" && (record.pngPath !== `SilverInk/Graphics/${id}.png` || record.svgPath)) ||
      (record.kind === "text" && (record.svgPath || record.pngPath))) {
    throw new Error(`Invalid block record ${id}`);
  }
  return record;
}

type References = { markers: Set<string>; graphics: Set<string> };

async function references(bridge: BlockAdminBridge, files: File[], currentPage: string,
  currentText: string): Promise<References> {
  const markers = new Set<string>(), graphics = new Set<string>();
  let currentSeen = false;
  for (const file of files) {
    if (!file.name.endsWith(".md")) continue;
    const text = file.name === `${currentPage}.md`
      ? (currentSeen = true, currentText)
      : decoder.decode(await bridge.readFile(file.name));
    for (const match of text.matchAll(markerPattern)) markers.add(match[1]);
    for (const match of text.matchAll(graphicPattern)) graphics.add(match[1]);
  }
  if (!currentSeen) {
    for (const match of currentText.matchAll(markerPattern)) markers.add(match[1]);
    for (const match of currentText.matchAll(graphicPattern)) graphics.add(match[1]);
  }
  return { markers, graphics };
}

function markerAt(text: string, position: number) {
  const markers = [...text.matchAll(markerPattern)];
  const selected = markers.filter(match => match.index <= position).at(-1);
  if (!selected) throw new Error("Place the cursor in or after a SilverInk block marker");
  return { id: selected[1], start: selected.index, marker: selected[0] };
}

function prepareDeletion(text: string, marker: ReturnType<typeof markerAt>, record: Record) {
  if (record.id !== marker.id || text.indexOf(`<!-- silverink:block=${marker.id};`) !== marker.start) {
    throw new Error("The selected block marker is missing or duplicated");
  }
  let end = marker.start + marker.marker.length;
  if (record.kind === "text") {
    if (text[end] === "\n") end++;
  } else {
    const drawing = `\n${record.acceptedMarkdown}`;
    if (text.slice(end, end + drawing.length) !== drawing) {
      throw new Error("The drawing link has changed; review the Markdown before deleting");
    }
    end += drawing.length;
  }
  return { from: marker.start, to: end,
    expected: text.slice(0, marker.start) + text.slice(end) };
}

async function readRecords(bridge: BlockAdminBridge, files: File[]) {
  const records = new Map<string, { record: Record; bytes: string }>();
  for (const file of files) {
    const match = file.name.match(recordPattern);
    if (!match) continue;
    const bytes = await bridge.readFile(file.name);
    records.set(match[1], { record: parseRecord(bytes, match[1]), bytes: decoder.decode(bytes) });
  }
  return records;
}

async function deleteOwnedFiles(bridge: BlockAdminBridge, record: Record,
  records: Map<string, { record: Record; bytes: string }>, files: Set<string>) {
  const sourcePath = `SilverInk/Sessions/${record.sessionId}.json`;
  if (files.has(sourcePath) &&
      ![...records.values()].some(other => other.record.id !== record.id &&
        other.record.sessionId === record.sessionId)) {
    const source: unknown = JSON.parse(decoder.decode(await bridge.readFile(sourcePath)));
    if (source && typeof source === "object" &&
        (source as { blockEditOf?: string }).blockEditOf === record.id) {
      await bridge.deleteFile(sourcePath);
    }
  }
  const graphic = record.svgPath || record.pngPath;
  if (graphic && files.has(graphic)) await bridge.deleteFile(graphic);
  await bridge.deleteFile(recordPath(record.id));
}

export async function deleteSelectedBlock(bridge: BlockAdminBridge): Promise<void> {
  let pageMutationAttempted = false;
  try {
    const [page, text, selection, files] = await Promise.all([
      bridge.getCurrentPage(), bridge.getText(), bridge.getSelection(), bridge.listFiles(),
    ]);
    const marker = markerAt(text, selection.from);
    const records = await readRecords(bridge, files);
    const entry = records.get(marker.id);
    if (!entry) throw new Error(`Source record for block ${marker.id} is missing`);
    const deletion = prepareDeletion(text, marker, entry.record);
    const pageRefs = await references(bridge, files, page, deletion.expected);
    if (pageRefs.markers.has(marker.id) || pageRefs.graphics.has(marker.id)) {
      throw new Error("Another page location still references this block or image");
    }
    const detail = entry.record.kind === "text"
      ? "The transcribed Markdown will remain on the page."
      : "Its image link will be removed from the page.";
    if (!await bridge.confirm(`Delete SilverInk block ${marker.id} and its source strokes? ${detail}`,
      { destructive: true })) return;
    if (await bridge.getCurrentPage() !== page || await bridge.getText() !== text ||
        decoder.decode(await bridge.readFile(recordPath(marker.id))) !== entry.bytes) {
      throw new Error("The page or block changed; run the command again");
    }
    const freshRefs = await references(bridge, await bridge.listFiles(), page, deletion.expected);
    if (freshRefs.markers.has(marker.id) || freshRefs.graphics.has(marker.id)) {
      throw new Error("Another page location now references this block or image");
    }
    pageMutationAttempted = true;
    await bridge.replaceRange(deletion.from, deletion.to, "");
    await bridge.save();
    if (await bridge.getCurrentPage() !== page || await bridge.getText() !== deletion.expected) {
      throw new Error("The page change needs review before source cleanup");
    }
    try {
      await deleteOwnedFiles(bridge, entry.record, records, new Set(files.map(file => file.name)));
      await bridge.flashNotification("SilverInk block deleted");
    } catch (error) {
      await bridge.flashNotification(`Page updated; run SilverInk: Clean orphaned blocks to finish cleanup: ${error}`, "warning");
    }
  } catch (error) {
    await bridge.flashNotification(pageMutationAttempted
      ? `SilverInk page deletion may have happened; check the page, then run orphan cleanup if needed: ${error}`
      : `SilverInk block was not deleted: ${error}`, "error");
  }
}

export async function cleanOrphanedBlocks(bridge: BlockAdminBridge): Promise<void> {
  let cleaned = 0;
  try {
    await bridge.save();
    const [page, text, files] = await Promise.all([
      bridge.getCurrentPage(), bridge.getText(), bridge.listFiles(),
    ]);
    if (files.some(file => file.name === `${page}.md`) &&
        decoder.decode(await bridge.readFile(`${page}.md`)) !== text) {
      throw new Error("The current page has not finished saving");
    }
    const records = await readRecords(bridge, files);
    const refs = await references(bridge, files, page, text);
    const orphanIds = [...records.keys()].filter(id => !refs.markers.has(id) && !refs.graphics.has(id));
    if (!orphanIds.length) {
      await bridge.flashNotification("No orphaned SilverInk blocks found");
      return;
    }
    if (!await bridge.confirm(`Delete ${orphanIds.length} orphaned SilverInk block record(s) and their private stroke/image files? Capture sessions and Markdown text will remain.`,
      { destructive: true })) return;
    const currentPage = await bridge.getCurrentPage(), currentText = await bridge.getText();
    if (currentPage !== page || currentText !== text) {
      throw new Error("The current page changed during cleanup; run the command again");
    }
    const freshFiles = await bridge.listFiles();
    const freshRefs = await references(bridge, freshFiles, currentPage, currentText);
    const freshRecords = await readRecords(bridge, freshFiles);
    const names = new Set(freshFiles.map(file => file.name));
    let skipped = 0;
    for (const id of orphanIds) {
      const oldEntry = records.get(id), entry = freshRecords.get(id);
      if (!oldEntry || !entry || oldEntry.bytes !== entry.bytes ||
          freshRefs.markers.has(id) || freshRefs.graphics.has(id)) { skipped++; continue; }
      try {
        await deleteOwnedFiles(bridge, entry.record, freshRecords, names);
        cleaned++;
      } catch { skipped++; }
    }
    await bridge.flashNotification(`Cleaned ${cleaned} orphaned SilverInk block(s)${skipped ? `; ${skipped} skipped or failed` : ""}`,
      skipped ? "warning" : "info");
  } catch (error) {
    await bridge.flashNotification(`SilverInk cleanup stopped after deleting ${cleaned} block(s): ${error}`, "error");
  }
}
