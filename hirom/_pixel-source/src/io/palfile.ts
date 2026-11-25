import { CGRAM_SIZE } from '../core/cgram';
import { fromRgb8 } from '../core/color';

/** Raw SNES CGRAM dump: 256 little-endian BGR555 words = 512 bytes. */
export function encodePal(cgram: Uint16Array): Uint8Array {
  const out = new Uint8Array(CGRAM_SIZE * 2);
  for (let i = 0; i < CGRAM_SIZE; i++) {
    out[i * 2] = cgram[i] & 0xff;
    out[i * 2 + 1] = (cgram[i] >> 8) & 0x7f;
  }
  return out;
}

/**
 * Accepts a raw BGR555 dump (any even length ≤ 512 bytes) or a 768-byte RGB24 palette
 * (as written by YY-CHR and many other tools), quantized to 15-bit.
 */
export function decodePal(bytes: Uint8Array): Uint16Array {
  const out = new Uint16Array(CGRAM_SIZE);
  if (bytes.length === 768) {
    for (let i = 0; i < 256; i++) out[i] = fromRgb8(bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]);
    return out;
  }
  if (bytes.length % 2 !== 0 || bytes.length > 512 || bytes.length === 0) {
    throw new Error(`Unrecognized palette file (${bytes.length} bytes). Expected 512-byte BGR555 or 768-byte RGB.`);
  }
  for (let i = 0; i < bytes.length / 2; i++) out[i] = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) & 0x7fff;
  return out;
}
