const test = require("node:test");
const assert = require("node:assert/strict");
const OCR = require("../ui/ocr.js");

test("Ollama adapter sends a PNG crop and returns reviewable text", async () => {
  let sent;
  const text = await OCR.recognize("ollama", {
    endpoint: "http://192.168.1.20:11434", model: "gemma3:4b",
    image: Uint8Array.of(137, 80, 78, 71),
  }, async (url, options) => {
    sent = { url, options };
    return { status: 200, base64Body: btoa(JSON.stringify({ done: true, response: "  Hello\nworld  " })) };
  });
  assert.equal(text, "Hello\nworld");
  assert.equal(sent.url, "http://192.168.1.20:11434/api/generate");
  const body = JSON.parse(atob(sent.options.base64Body));
  assert.equal(body.model, "gemma3:4b");
  assert.equal(body.images[0], btoa(String.fromCharCode(137, 80, 78, 71)));
  assert.equal(body.stream, false);
});

test("provider check reports a missing model", async () => {
  await assert.rejects(() => OCR.check("ollama", {
    endpoint: "http://localhost:11434", model: "gemma3:4b",
  }, async () => ({ status: 200, base64Body: btoa(JSON.stringify({ models: [] })) })),
  /ollama pull gemma3:4b/);
});

test("provider markup remains literal in the transcription draft", async () => {
  const text = await OCR.recognize("ollama", {
    endpoint: "http://localhost:11434", model: "gemma3:4b", image: Uint8Array.of(1),
  }, async () => ({ status: 200, base64Body: btoa(JSON.stringify({
    done: true, response: "[link](javascript:alert(1)) <img src=x> {{widget}}",
  })) }));
  assert.equal(text, "\\[link\\](javascript:alert(1)) &lt;img src=x&gt; \\{\\{widget\\}\\}");
});
