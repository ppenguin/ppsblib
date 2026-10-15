import { asset, editor, space, system } from "@silverbulletmd/silverbullet/syscalls";
import { cleanOrphanedBlocks, deleteSelectedBlock, type BlockAdminBridge } from "./block_admin.ts";

const blockAdminBridge: BlockAdminBridge = {
  getCurrentPage: editor.getCurrentPage,
  getText: editor.getText,
  getSelection: editor.getSelection,
  replaceRange: editor.replaceRange,
  save: editor.save,
  confirm: editor.confirm,
  flashNotification: editor.flashNotification,
  listFiles: space.listFiles,
  readFile: space.readFile,
  deleteFile: space.deleteFile,
};

async function showInk(mode: "new" | "edit"): Promise<void> {
  const [html, model, blocks, store, ocr, panel, page, baseURI, profile,
    ocrProvider, ocrEndpoint, ocrModel, syncDocuments] = await Promise.all([
    asset.readAsset("silverink", "ui/panel.html", "utf8"),
    asset.readAsset("silverink", "ui/model.js", "utf8"),
    asset.readAsset("silverink", "ui/blocks.js", "utf8"),
    asset.readAsset("silverink", "ui/store.js", "utf8"),
    asset.readAsset("silverink", "ui/ocr.js", "utf8"),
    asset.readAsset("silverink", "ui/panel.js", "utf8"),
    editor.getCurrentPage(),
    system.getBaseURI(),
    system.getProfile(),
    system.getConfig("silverink.ocr.provider", "ollama"),
    system.getConfig("silverink.ocr.endpoint", "http://localhost:11434"),
    system.getConfig("silverink.ocr.model", "gemma3:4b"),
    system.getConfig("sync.documents", false),
  ]);
  // Escape for embedding as a JavaScript string literal in the iframe script.
  const context = JSON.stringify({ page, mode, scope: `${baseURI}|${profile.username}`,
    syncDocuments,
    ocr: { provider: ocrProvider, endpoint: ocrEndpoint, model: ocrModel } }).replace(/</g, "\\u003c");
  await editor.showPanel(
    "modal",
    12,
    html,
    `globalThis.silverInkContext = ${context};\n${model}\n${blocks}\n${store}\n${ocr}\n${panel}`,
  );
}

export async function handwrite(): Promise<void> {
  await showInk("new");
}

export async function editBlock(): Promise<void> {
  await showInk("edit");
}

export async function deleteBlock(): Promise<void> {
  await deleteSelectedBlock(blockAdminBridge);
}

export async function cleanBlocks(): Promise<void> {
  await cleanOrphanedBlocks(blockAdminBridge);
}
