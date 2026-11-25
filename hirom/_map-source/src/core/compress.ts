/**
 * Simple, well-documented compressors for SNES level binaries. Both formats start with the
 * uncompressed length as a little-endian u16 (u32 if the length doesn't fit, flagged by 0xFFFF).
 *
 * RLE: control byte c.
 *   c < 0x80  → copy the next c + 1 literal bytes.
 *   c ≥ 0x80  → repeat the next byte (c − 0x7E) times (2–129).
 *
 * LZSS: flag byte, then 8 items, LSB first. Bit = 1 → one literal byte.
 *   Bit = 0 → 2-byte match: b0 = distance−1 low 8 bits, b1 = (distance−1 high 4 bits) << 4 | (length − 3).
 *   Distance 1–4096 bytes back in the output, length 3–18.
 */

function header(n: number): number[] {
  return n < 0xffff ? [n & 255, n >> 8] : [0xff, 0xff, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
}

function readHeader(d: Uint8Array): { n: number; p: number } {
  const n = d[0] | (d[1] << 8);
  if (n !== 0xffff) return { n, p: 2 };
  return { n: (d[2] | (d[3] << 8) | (d[4] << 16) | (d[5] << 24)) >>> 0, p: 6 };
}

export function rleCompress(src: Uint8Array): Uint8Array {
  const out: number[] = header(src.length);
  let i = 0;
  const lit: number[] = [];
  const flush = () => {
    while (lit.length) {
      const n = Math.min(128, lit.length);
      out.push(n - 1, ...lit.splice(0, n));
    }
  };
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && src[i + run] === src[i] && run < 129) run++;
    if (run >= 2) {
      flush();
      out.push(0x7e + run, src[i]);
      i += run;
    } else {
      lit.push(src[i++]);
    }
  }
  flush();
  return Uint8Array.from(out);
}

export function rleDecompress(d: Uint8Array): Uint8Array {
  const { n, p: start } = readHeader(d);
  const out = new Uint8Array(n);
  let p = start, o = 0;
  while (o < n && p < d.length) {
    const c = d[p++];
    if (c < 0x80) {
      for (let k = 0; k <= c && o < n; k++) out[o++] = d[p++];
    } else {
      const v = d[p++];
      for (let k = 0; k < c - 0x7e && o < n; k++) out[o++] = v;
    }
  }
  return out;
}

export function lzssCompress(src: Uint8Array): Uint8Array {
  const MIN = 3, MAX = 18, WINDOW = 4096, CHAIN = 128;
  const out: number[] = header(src.length);
  const head = new Map<number, number>();
  const prev = new Int32Array(src.length).fill(-1);
  const key = (i: number) => (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
  const insert = (i: number) => {
    if (i + 2 >= src.length) return;
    const k = key(i);
    prev[i] = head.get(k) ?? -1;
    head.set(k, i);
  };
  let i = 0;
  while (i < src.length) {
    const flagPos = out.length;
    out.push(0);
    let flags = 0;
    for (let bit = 0; bit < 8 && i < src.length; bit++) {
      let bestLen = 0, bestDist = 0;
      if (i + MIN <= src.length) {
        let cand = head.get(key(i)) ?? -1;
        let chain = 0;
        while (cand >= 0 && i - cand <= WINDOW && chain++ < CHAIN) {
          let len = 0;
          while (len < MAX && i + len < src.length && src[cand + len] === src[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = i - cand;
            if (len === MAX) break;
          }
          cand = prev[cand];
        }
      }
      if (bestLen >= MIN) {
        const d = bestDist - 1;
        out.push(d & 255, ((d >> 8) << 4) | (bestLen - MIN));
        for (let k = 0; k < bestLen; k++) insert(i + k);
        i += bestLen;
      } else {
        flags |= 1 << bit;
        out.push(src[i]);
        insert(i);
        i++;
      }
    }
    out[flagPos] = flags;
  }
  return Uint8Array.from(out);
}

export function lzssDecompress(d: Uint8Array): Uint8Array {
  const { n, p: start } = readHeader(d);
  const out = new Uint8Array(n);
  let p = start, o = 0;
  while (o < n && p < d.length) {
    const flags = d[p++];
    for (let bit = 0; bit < 8 && o < n; bit++) {
      if (flags & (1 << bit)) {
        out[o++] = d[p++];
      } else {
        const b0 = d[p++], b1 = d[p++];
        const dist = ((b1 >> 4) << 8 | b0) + 1;
        const len = (b1 & 15) + 3;
        for (let k = 0; k < len && o < n; k++, o++) out[o] = out[o - dist];
      }
    }
  }
  return out;
}
