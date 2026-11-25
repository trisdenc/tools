// Runs libwebp (WebAssembly) off the main thread so the page stays responsive.
import encode, { init } from "./vendor/jsquash-webp/encode.js";

const ready = init().then(() => true, err => { throw err; });

self.onmessage = async ({ data }) => {
  if (data.type === "ping") {
    try { await ready; self.postMessage({ type: "ready" }); }
    catch (e) { self.postMessage({ type: "unavailable", error: String(e) }); }
    return;
  }
  const { id, width, height, buffer, options } = data;
  try {
    await ready;
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const out = await encode(img, options);
    self.postMessage({ type: "done", id, buffer: out }, [out]);
  } catch (e) {
    self.postMessage({ type: "error", id, error: String(e && e.message || e) });
  }
};
