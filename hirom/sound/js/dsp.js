// S-DSP (SNES sound chip) emulation core.
//
// Integer-exact model of the S-DSP's per-sample behaviour, following blargg's
// SPC_DSP (the reference used by bsnes/higan): BRR decoding with the four IIR
// filters, the 512-entry Gaussian interpolator, ADSR/GAIN envelopes driven by the
// shared rate counter, pitch modulation, the 15-bit noise LFSR, and the echo
// unit with its 8-tap FIR. Runs at a fixed 32 kHz. No allocation per sample.
//
// Instead of a 64 KB ARAM image, each voice points at its own BRR byte array.

export const DSP_RATE = 32000;

// Hardware Gaussian interpolation table (512 entries, from the S-DSP ROM).
export const GAUSS = new Int16Array([
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,
  2,2,3,3,3,3,3,4,4,4,4,4,5,5,5,5,
  6,6,6,6,7,7,7,8,8,8,9,9,9,10,10,10,
  11,11,11,12,12,13,13,14,14,15,15,15,16,16,17,17,
  18,19,19,20,20,21,21,22,23,23,24,24,25,26,27,27,
  28,29,29,30,31,32,32,33,34,35,36,36,37,38,39,40,
  41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,
  58,59,60,61,62,64,65,66,67,69,70,71,73,74,76,77,
  78,80,81,83,84,86,87,89,90,92,94,95,97,99,100,102,
  104,106,107,109,111,113,115,117,118,120,122,124,126,128,130,132,
  134,137,139,141,143,145,147,150,152,154,156,159,161,163,166,168,
  171,173,175,178,180,183,186,188,191,193,196,199,201,204,207,210,
  212,215,218,221,224,227,230,233,236,239,242,245,248,251,254,257,
  260,263,267,270,273,276,280,283,286,290,293,297,300,304,307,311,
  314,318,321,325,328,332,336,339,343,347,351,354,358,362,366,370,
  374,378,381,385,389,393,397,401,405,410,414,418,422,426,430,434,
  439,443,447,451,456,460,464,469,473,477,482,486,491,495,499,504,
  508,513,517,522,527,531,536,540,545,550,554,559,563,568,573,577,
  582,587,592,596,601,606,611,615,620,625,630,635,640,644,649,654,
  659,664,669,674,678,683,688,693,698,703,708,713,718,723,728,732,
  737,742,747,752,757,762,767,772,777,782,787,792,797,802,806,811,
  816,821,826,831,836,841,846,851,855,860,865,870,875,880,884,889,
  894,899,904,908,913,918,923,927,932,937,941,946,951,955,960,965,
  969,974,978,983,988,992,997,1001,1005,1010,1014,1019,1023,1027,1032,1036,
  1040,1045,1049,1053,1057,1061,1066,1070,1074,1078,1082,1086,1090,1094,1098,1102,
  1106,1109,1113,1117,1121,1125,1128,1132,1136,1139,1143,1146,1150,1153,1157,1160,
  1164,1167,1170,1174,1177,1180,1183,1186,1190,1193,1196,1199,1202,1205,1207,1210,
  1213,1216,1219,1221,1224,1227,1229,1232,1234,1237,1239,1241,1244,1246,1248,1251,
  1253,1255,1257,1259,1261,1263,1265,1267,1269,1270,1272,1274,1275,1277,1279,1280,
  1282,1283,1284,1286,1287,1288,1290,1291,1292,1293,1294,1295,1296,1297,1297,1298,
  1299,1300,1300,1301,1302,1302,1303,1303,1303,1304,1304,1304,1304,1304,1305,1305,
]);

// Envelope / noise rate counter (rate 0 never fires).
const COUNTER_RANGE = 30720;
export const COUNTER_RATES = new Int32Array([
  COUNTER_RANGE + 1, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128,
  96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1,
]);
const COUNTER_OFFSETS = new Int32Array([
  1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536,
  0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0,
]);

export const ENV_RELEASE = 0, ENV_ATTACK = 1, ENV_DECAY = 2, ENV_SUSTAIN = 3;

const EMPTY_BRR = new Uint8Array(9); // a silent block with no flags
const clamp16 = x => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);

export class Voice {
  constructor(index) {
    this.index = index;
    this.bit = 1 << index;
    // Registers
    this.volL = 0;          // signed 8-bit
    this.volR = 0;          // signed 8-bit
    this.pitch = 0;         // 14-bit, 0x1000 = native rate
    this.adsr0 = 0;         // bit7 = ADSR enable, DR (3 bits), AR (4 bits)
    this.adsr1 = 0;         // SL (3 bits), SR (5 bits)
    this.gain = 0;
    // Sample source (stands in for SRCN + directory)
    this.brr = EMPTY_BRR;
    this.loopAddr = 0;      // byte offset of the loop block
    // Internal state
    this.buf = new Int32Array(24); // 12-sample decode ring + mirrored copy
    this.bufPos = 0;
    this.interpPos = 0;
    this.addr = 0;
    this.offset = 1;
    this.konDelay = 0;
    this.env = 0;
    this.hiddenEnv = 0;
    this.envMode = ENV_RELEASE;
    this.output = 0;        // last enveloped output (feeds the next voice's PMON)
    // Metering (not hardware)
    this.peakL = 0;
    this.peakR = 0;
  }
}

export class SDSP {
  constructor() {
    this.voices = Array.from({ length: 8 }, (_, i) => new Voice(i));
    this.mvolL = 127; this.mvolR = 127;
    this.evolL = 0; this.evolR = 0;
    this.efb = 0;
    this.edl = 0;
    this.fir = new Int8Array([127, 0, 0, 0, 0, 0, 0, 0]);
    this.flg = 0;           // bit7 reset, bit6 mute, bit5 echo-write disable, bits0-4 noise clock
    this.pmon = 0; this.non = 0; this.eon = 0;
    this.endx = 0;
    this.pendingKon = 0; this.pendingKoff = 0;
    this.everyOther = 1;
    this.counter = 0;
    this.noise = 0x4000;
    // Echo: max EDL 15 = 15 * 2048 bytes = 7680 stereo frames
    this.echoBuf = new Int16Array(15 * 512 * 2);
    this.echoOffset = 0;
    this.echoLength = 0;
    this.histL = new Int32Array(16);
    this.histR = new Int32Array(16);
    this.histPos = 0;
    // Output of the last step()
    this.outL = 0; this.outR = 0;
    // Metering
    this.peakL = 0; this.peakR = 0; this.clips = 0;
  }

  keyOn(mask) { this.pendingKon |= mask; this.pendingKoff &= ~mask; }
  keyOff(mask) { this.pendingKoff |= mask; }

  clearEcho() { this.echoBuf.fill(0); this.histL.fill(0); this.histR.fill(0); }

  readCounter(rate) {
    // true when the counter fires for this rate on this sample
    return (this.counter + COUNTER_OFFSETS[rate]) % COUNTER_RATES[rate] === 0;
  }

  runEnvelope(v) {
    let env = v.env;
    if (v.envMode === ENV_RELEASE) {
      env -= 8;
      v.env = env < 0 ? 0 : env;
      return;
    }
    let rate, envData = v.adsr1;
    if (v.adsr0 & 0x80) {
      if (v.envMode >= ENV_DECAY) {
        env--;
        env -= env >> 8;
        rate = envData & 0x1F;
        if (v.envMode === ENV_DECAY) rate = ((v.adsr0 >> 3) & 0x0E) + 0x10;
      } else {
        rate = (v.adsr0 & 0x0F) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = v.gain;
      const mode = envData >> 5;
      if (mode < 4) {
        env = envData * 0x10;
        rate = 31;
      } else {
        rate = envData & 0x1F;
        if (mode === 4) env -= 0x20;
        else if (mode < 6) { env--; env -= env >> 8; }
        else {
          env += 0x20;
          if (mode > 6 && v.hiddenEnv >>> 0 >= 0x600) env += 0x8 - 0x20;
        }
      }
    }
    if ((env >> 8) === (envData >> 5) && v.envMode === ENV_DECAY) v.envMode = ENV_SUSTAIN;
    v.hiddenEnv = env;
    if (env >>> 0 > 0x7FF) {
      env = env < 0 ? 0 : 0x7FF;
      if (v.envMode === ENV_ATTACK) v.envMode = ENV_DECAY;
    }
    if (this.readCounter(rate)) v.env = env;
  }

  decodeBrr(v, header) {
    const data = v.brr;
    const a = v.addr + v.offset;
    let nybbles = ((data[a] | 0) << 8) | (data[a + 1] | 0);
    const shift = header >> 4;
    const filter = header & 0x0C;
    const buf = v.buf;
    let pos = v.bufPos;
    v.bufPos = pos + 4 >= 12 ? 0 : pos + 4;
    for (let n = 0; n < 4; n++, pos++, nybbles <<= 4) {
      let s = ((nybbles << 16) >> 16) >> 12;          // sign-extended nybble
      s = (s << shift) >> 1;
      if (shift >= 0xD) s = (s >> 25) << 11;          // invalid shift: 0 or -2048
      const p1 = buf[pos + 11];
      const p2 = buf[pos + 10] >> 1;
      if (filter >= 8) {
        s += p1;
        s -= p2;
        if (filter === 8) { s += p2 >> 4; s += (p1 * -3) >> 6; }
        else { s += (p1 * -13) >> 7; s += (p2 * 3) >> 4; }
      } else if (filter) {
        s += p1 >> 1;
        s += (-p1) >> 5;
      }
      s = clamp16(s);
      s = ((s * 2) << 16) >> 16;
      buf[pos] = s;
      buf[pos + 12] = s;
    }
  }

  interpolate(v) {
    const off = (v.interpPos >> 4) & 0xFF;
    const b = v.buf;
    const i = (v.interpPos >> 12) + v.bufPos;
    let out = (GAUSS[255 - off] * b[i]) >> 11;
    out += (GAUSS[511 - off] * b[i + 1]) >> 11;
    out += (GAUSS[256 + off] * b[i + 2]) >> 11;
    out = (out << 16) >> 16;
    out += (GAUSS[off] * b[i + 3]) >> 11;
    return clamp16(out) & ~1;
  }

  // Produce one 32 kHz stereo sample into outL/outR.
  step() {
    // Key on/off are latched every other sample, like the hardware.
    this.everyOther ^= 1;
    let kon = 0, koff = 0;
    if (this.everyOther) {
      kon = this.pendingKon; koff = this.pendingKoff;
      this.pendingKon = 0; this.pendingKoff = 0;
    }

    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
    if (this.readCounter(this.flg & 0x1F)) {
      const fb = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (fb & 0x4000) ^ (this.noise >> 1);
    }

    const flg = this.flg, pmon = this.pmon & 0xFE, non = this.non, eon = this.eon;
    let mainL = 0, mainR = 0, echoOutL = 0, echoOutR = 0, prevOut = 0;

    for (let i = 0; i < 8; i++) {
      const v = this.voices[i];
      let pitch = v.pitch & 0x3FFF;
      let header = v.brr[v.addr] | 0;

      if (pmon & v.bit) pitch += ((prevOut >> 5) * pitch) >> 10;

      if (v.konDelay) {
        if (v.konDelay === 5) {
          v.addr = 0;
          v.offset = 1;
          v.bufPos = 0;
          header = 0;
          this.endx &= ~v.bit;
        }
        v.env = 0;
        v.hiddenEnv = 0;
        v.interpPos = 0;
        if (--v.konDelay & 3) v.interpPos = 0x4000;
        pitch = 0;
      }

      let output = this.interpolate(v);
      if (non & v.bit) output = ((this.noise * 2) << 16) >> 16;
      output = ((output * v.env) >> 11) & ~1;

      if ((flg & 0x80) || (header & 3) === 1) {
        v.envMode = ENV_RELEASE;
        v.env = 0;
      }
      if (this.everyOther) {
        if (koff & v.bit) v.envMode = ENV_RELEASE;
        if (kon & v.bit) { v.konDelay = 5; v.envMode = ENV_ATTACK; }
      }
      if (!v.konDelay) this.runEnvelope(v);

      // Decode the next four BRR samples when needed
      if (v.interpPos >= 0x4000) {
        this.decodeBrr(v, header);
        if ((v.offset += 2) >= 9) {
          v.addr += 9;
          if (header & 1) {
            v.addr = v.loopAddr;
            this.endx |= v.bit;
          }
          if (v.addr + 9 > v.brr.length) v.addr = v.loopAddr < v.brr.length ? v.loopAddr : 0;
          v.offset = 1;
        }
      }
      v.interpPos = (v.interpPos & 0x3FFF) + pitch;
      if (v.interpPos > 0x7FFF) v.interpPos = 0x7FFF;

      // Mix
      const ampL = (output * v.volL) >> 7;
      const ampR = (output * v.volR) >> 7;
      mainL = clamp16(mainL + ampL);
      mainR = clamp16(mainR + ampR);
      if (eon & v.bit) {
        echoOutL = clamp16(echoOutL + ampL);
        echoOutR = clamp16(echoOutR + ampR);
      }
      v.output = output;
      prevOut = output;
      const aL = ampL < 0 ? -ampL : ampL, aR = ampR < 0 ? -ampR : ampR;
      if (aL > v.peakL) v.peakL = aL;
      if (aR > v.peakR) v.peakR = aR;
    }

    // Echo: read, FIR, output, feedback write
    const ptr = this.echoOffset * 2;
    const hp = this.histPos = (this.histPos + 1) & 7;
    const hl = this.histL, hr = this.histR, fir = this.fir;
    hl[hp] = hl[hp + 8] = this.echoBuf[ptr] >> 1;
    hr[hp] = hr[hp + 8] = this.echoBuf[ptr + 1] >> 1;
    let el = 0, er = 0;
    for (let t = 0; t < 7; t++) {
      el += (hl[hp + 1 + t] * fir[t]) >> 6;
      er += (hr[hp + 1 + t] * fir[t]) >> 6;
    }
    el = (el << 16) >> 16;
    er = (er << 16) >> 16;
    el += (((hl[hp + 8] * fir[7]) >> 6) << 16) >> 16;
    er += (((hr[hp + 8] * fir[7]) >> 6) << 16) >> 16;
    const echoInL = clamp16(el) & ~1;
    const echoInR = clamp16(er) & ~1;

    const rawL = ((((mainL * this.mvolL) >> 7) << 16) >> 16) + ((((echoInL * this.evolL) >> 7) << 16) >> 16);
    const rawR = ((((mainR * this.mvolR) >> 7) << 16) >> 16) + ((((echoInR * this.evolR) >> 7) << 16) >> 16);
    let outL = clamp16(rawL), outR = clamp16(rawR);
    if (outL !== rawL || outR !== rawR) this.clips++;
    if (flg & 0x40) { outL = 0; outR = 0; }
    this.outL = outL;
    this.outR = outR;
    const pl = outL < 0 ? -outL : outL, pr = outR < 0 ? -outR : outR;
    if (pl > this.peakL) this.peakL = pl;
    if (pr > this.peakR) this.peakR = pr;

    const wl = clamp16(echoOutL + ((((echoInL * this.efb) >> 7) << 16) >> 16)) & ~1;
    const wr = clamp16(echoOutR + ((((echoInR * this.efb) >> 7) << 16) >> 16)) & ~1;
    if (this.echoOffset === 0) this.echoLength = (this.edl & 0x0F) * 512;
    if (++this.echoOffset >= this.echoLength) this.echoOffset = 0;
    if (!(flg & 0x20)) {
      this.echoBuf[ptr] = wl;
      this.echoBuf[ptr + 1] = wr;
    }
  }
}

// Decode a whole BRR stream to PCM (for previews and tests). Returns Int16Array.
// Follows the hardware decoder exactly, starting from silent history.
export function decodeBrrStream(data) {
  const blocks = Math.floor(data.length / 9);
  const out = new Int16Array(blocks * 16);
  let p1 = 0, p2 = 0, o = 0;
  for (let b = 0; b < blocks; b++) {
    const header = data[b * 9];
    const shift = header >> 4, filter = header & 0x0C;
    for (let k = 0; k < 16; k++) {
      const byte = data[b * 9 + 1 + (k >> 1)];
      let s = (k & 1) ? (byte & 0x0F) : (byte >> 4);
      if (s >= 8) s -= 16;
      s = (s << shift) >> 1;
      if (shift >= 0xD) s = s < 0 ? -2048 : 0;
      const q2 = p2 >> 1;
      if (filter >= 8) {
        s += p1; s -= q2;
        if (filter === 8) { s += q2 >> 4; s += (p1 * -3) >> 6; }
        else { s += (p1 * -13) >> 7; s += (q2 * 3) >> 4; }
      } else if (filter) {
        s += p1 >> 1; s += (-p1) >> 5;
      }
      s = clamp16(s);
      s = ((s * 2) << 16) >> 16;
      out[o++] = s;
      p2 = p1; p1 = s;
    }
  }
  return out;
}
