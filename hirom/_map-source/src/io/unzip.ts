/**
 * Minimal zip reader (stored and deflate entries) using the browser's DecompressionStream, so
 * HiROM Map can open .hiromsound bundles without a zip library.
 */
export interface ZipEntry {
  name: string;
  read(): Promise<Uint8Array>;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the end-of-central-directory record (it sits within the last 64 KB + 22 bytes).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, ZipEntry>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip directory.');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = v.getUint16(local + 26, true), lExtraLen = v.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + csize);
    out.set(name, {
      name,
      read: async () => {
        if (method === 0) return data.slice();
        if (method === 8) return inflateRaw(data);
        throw new Error(`Unsupported zip compression (${method}) in ${name}.`);
      },
    });
  }
  return out;
}
