(function (root) {
  "use strict";
  const PROMPT = "Transcribe only the handwritten text in this image. Preserve line breaks. Do not describe drawings, infer missing words, or add commentary. Return plain text only.";

  function base64(bytes) {
    let result = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      result += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(result);
  }

  function decode64(value) {
    const binary = atob(value || "");
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function origin(endpoint) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("Enter an Ollama server origin, such as http://localhost:11434");
    }
    return url.origin;
  }

  async function checkOllama({ endpoint, model }, request) {
    const result = await request(`${origin(endpoint)}/api/tags`, { method: "GET" });
    const responseText = new TextDecoder().decode(decode64(result.base64Body));
    if (result.status !== 200) throw new Error(`Ollama returned HTTP ${result.status}`);
    const response = JSON.parse(responseText);
    if (!Array.isArray(response.models)) throw new Error("Ollama model list is invalid");
    if (!response.models.some(item => item.name === model || item.model === model)) {
      throw new Error(`Ollama is reachable, but ${model} is not installed. Run: ollama pull ${model}`);
    }
    return `${model} is available`;
  }

  async function ollama({ image, endpoint, model }, request) {
    if (!/^[\w.:-]{1,120}$/.test(model)) throw new Error("Enter a valid Ollama model name");
    const body = JSON.stringify({ model, prompt: PROMPT, images: [base64(image)], stream: false });
    const result = await request(`${origin(endpoint)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      base64Body: base64(new TextEncoder().encode(body)),
    });
    const responseText = new TextDecoder().decode(decode64(result.base64Body));
    if (result.status !== 200) throw new Error(`Ollama returned HTTP ${result.status}: ${responseText.slice(0, 300)}`);
    const response = JSON.parse(responseText);
    if (response.done !== true || typeof response.response !== "string") {
      throw new Error("Ollama did not return a completed transcription");
    }
    return response.response;
  }

  const providers = { ollama };
  const checks = { ollama: checkOllama };
  async function check(provider, input, request) {
    if (!Object.hasOwn(checks, provider)) throw new Error("Unknown transcription provider");
    return checks[provider](input, request);
  }
  async function recognize(provider, input, request) {
    if (!Object.hasOwn(providers, provider)) throw new Error("Unknown transcription provider");
    if (!(input.image instanceof Uint8Array) || !input.image.length) throw new Error("No image to transcribe");
    const text = (await providers[provider](input, request)).trim();
    if (!text || text.length > 100000 || text.includes("\0")) {
      throw new Error("Provider returned empty or oversized text");
    }
    // Keep provider output as literal transcription, not active Markdown or HTML.
    return text.replace(/\\/g, "\\\\").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/[\[\]{}*_`]/g, char => `\\${char}`);
  }

  const api = { recognize, check, providers };
  root.SilverInkOCR = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
