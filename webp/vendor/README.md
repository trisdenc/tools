Third-party code bundled so the WebP converter works without a CDN.

- `jsquash-webp/` — @jsquash/webp 1.5.0 (libwebp compiled to WebAssembly), Apache-2.0. `encode.js` edited only to import `../wasm-feature-detect.js` instead of the bare package name.
- `wasm-feature-detect.js` — wasm-feature-detect 1.8.0, Apache-2.0.
- `jszip.min.js` — JSZip 3.10.1, MIT (dual MIT/GPLv3).
