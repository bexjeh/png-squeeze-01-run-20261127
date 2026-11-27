// png-squeeze: losslessly re-encode 1280x720 RGBA screenshots as the smallest PNG.
// Own design: colour-type reduction (palette / grey / grey+alpha / RGB / RGBA, with a
// tRNS key when a single fully-transparent value can stand in for an alpha channel),
// per-row filter choice by minimum signed sum, and a from-scratch optimal-parsing
// DEFLATE (shortest-path LZ77 with hash chains, dynamic Huffman built by
// package-merge, fixed Huffman as the fallback) in pure JavaScript. Deterministic:
// no clock, no randomness, no environment-dependent branching anywhere.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const WIDTH = 1280;
const HEIGHT = 720;

// ---------- CRC-32 (PNG) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- PNG decode (to RGBA) ----------
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, colourType = 6;
  let palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0); height = dv.getUint32(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG header');
      colourType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('unexpected inflated size');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter type ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3]; rgba[d + 1] = palette[e * 3 + 1]; rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { rgba, width, height };
}

// ---------- PNG write ----------
function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  d[8] = 8; d[9] = colourType;
  return d;
}

// ---------- image analysis ----------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const key = ((rgba[d] * 256 + rgba[d + 1]) * 256 + rgba[d + 2]) * 256 + rgba[d + 3];
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else counts.set(key, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [];
    for (const [key, count] of counts) {
      colours.push({ r: (key >>> 24) & 255, g: (key >>> 16) & 255, b: (key >>> 8) & 255, a: key & 255, word: key, count });
    }
  }
  return { opaque, grey, colours };
}
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0, tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = ((rgba[d] * 256 + rgba[d + 1]) * 256 + rgba[d + 2]) * 256 + rgba[d + 3];
    indices[i] = index.get(key);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

// ---------- filters ----------
// Filter one row; out has stride bytes. Rewritten from the PNG spec's filter definitions.
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}
// All filter variants of one form in a single pass over the rows: each row is
// filtered five times, once per filter, and the minimum-sum choice, the
// fewest-pairs choice, the unfiltered row and the Paeth row are all written
// out from those same five filtered rows, instead of filtering four times.
function filteredVariants(samples, width, height, bpp) {
  const stride = width * bpp;
  const out0 = new Uint8Array(height * (stride + 1));
  const outMin = new Uint8Array(height * (stride + 1));
  const outPairs = new Uint8Array(height * (stride + 1));
  const outPaeth = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let minType = 0, minSum = Infinity, pairsType = 0, pairsBest = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const row = trial[t];
      let s = 0;
      stamp++;
      let n = 0;
      for (let i = 0; i < row.length; i++) {
        const v = row[i];
        s += v < 128 ? v : 256 - v;
        if (i > 0) {
          const pair = (row[i - 1] << 8) | v;
          if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
        }
      }
      if (s < minSum) { minSum = s; minType = t; }
      if (n < pairsBest) { pairsBest = n; pairsType = t; }
    }
    out0[at] = 0; out0.set(trial[0], at + 1);
    outMin[at] = minType; outMin.set(trial[minType], at + 1);
    outPairs[at] = pairsType; outPairs.set(trial[pairsType], at + 1);
    outPaeth[at] = 4; outPaeth.set(trial[4], at + 1);
  }
  return { filter0: out0, minsum: outMin, pairs: outPairs, paeth: outPaeth };
}
// ---------- DEFLATE: tables ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function lenCodeOf(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return lo;
}
function distCodeOf(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  return lo;
}
// Fixed-Huffman code lengths (RFC 1951 section 3.2.6).
const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(32);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
for (let i = 0; i < 32; i++) FIXED_DIST_LEN[i] = 5;

// ---------- Huffman codes, length-limited by package-merge ----------
// ---------- Huffman codes, length-limited ----------
// Heap Huffman: build the optimal tree, measure its depths; when a depth
// exceeds `limit`, flatten the frequencies (f' = 1 + (f >> k), larger k flattens
// more) and rebuild — with every frequency 1 the depth is at most ceil(log2 n),
// so this always terminates with a complete code of depth at most `limit`.
function huffmanLengths(freq, limit) {
  const n = freq.length;
  const build = (f) => {
    const lens = new Uint8Array(n);
    const syms = [];
    for (let s = 0; s < n; s++) if (f[s] > 0) syms.push(s);
    if (syms.length === 0) return lens;
    if (syms.length === 1) { lens[syms[0]] = 1; return lens; }
    // Binary heap of tree nodes, ordered by frequency, ties by creation order.
    const heap = [];
    let seq = 0;
    const push = (node) => {
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].f < heap[i].f || (heap[p].f === heap[i].f && heap[p].seq <= heap[i].seq)) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && (heap[l].f < heap[m].f || (heap[l].f === heap[m].f && heap[l].seq < heap[m].seq))) m = l;
          if (r < heap.length && (heap[r].f < heap[m].f || (heap[r].f === heap[m].f && heap[r].seq < heap[m].seq))) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
      return top;
    };
    for (const s of syms) push({ f: f[s], seq: seq++, sym: s, left: null, right: null });
    while (heap.length > 1) {
      const a = pop(), b = pop();
      push({ f: a.f + b.f, seq: seq++, sym: -1, left: a, right: b });
    }
    const walk = (node, depth) => {
      if (node.sym >= 0) { lens[node.sym] = depth; return; }
      walk(node.left, depth + 1);
      walk(node.right, depth + 1);
    };
    walk(heap[0], 0);
    // A single-symbol alphabet is the only degenerate case (handled above);
    // otherwise every length is at least 1. Guard anyway.
    for (const s of syms) if (lens[s] === 0) lens[s] = 1;
    return lens;
  };
  let lens = build(freq);
  if (Math.max(0, ...lens) <= limit) return lens;
  for (let k = 1; k <= 24; k++) {
    const flat = new Uint32Array(n);
    for (let s = 0; s < n; s++) if (freq[s] > 0) flat[s] = 1 + (freq[s] >> k);
    lens = build(flat);
    if (Math.max(0, ...lens) <= limit) return lens;
  }
  return lens; // unreachable: all-ones frequencies have depth <= ceil(log2 n) <= 9
}
// Canonical codes from lengths (MSB-first code values, as DEFLATE writes them reversed).
function codesFromLengths(lens) {
  const maxLen = Math.max(0, ...lens);
  const blCount = new Uint16Array(maxLen + 1);
  for (const l of lens) if (l > 0) blCount[l]++;
  const nextCode = new Uint16Array(maxLen + 2);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint16Array(lens.length);
  for (let s = 0; s < lens.length; s++) {
    if (lens[s] > 0) codes[s] = nextCode[lens[s]]++;
  }
  return { codes, maxLen };
}
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

// ---------- bit writer (LSB-first) ----------
class BitWriter {
  constructor(capacity) {
    this.out = new Uint8Array(capacity + 64);
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  writeBits(value, len) {
    this.bitBuf |= ((value & ((1 << len) - 1)) << this.bitCnt);
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(code, len) { this.writeBits(reverseBits(code, len), len); }
  align() {
    if (this.bitCnt > 0) {
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0; this.bitCnt = 0;
    }
  }
  // Bits written so far (bytes flushed plus the pending partial byte).
  bitsWritten() { return this.pos * 8 + this.bitCnt; }
  bytes() { return this.out.subarray(0, this.pos); }
}

// ---------- optimal parsing of one block ----------
// Shortest-path parse: cost[i] is the cheapest bit cost to reach position i; every
// position is inserted into the hash chains as the scan passes it, so matches only
// ever point backwards. `litLen`/`distLen` are the code-length tables the cost
// model uses (fixed or dynamic lengths).
const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_CHAIN = 64;
const MAX_MATCH = 258;
const MIN_MATCH = 3;
// Greedy longest-match parse: walk the data, take the longest match at each
// position, and emit one symbol per literal or match. It is far cheaper than
// the shortest-path parse (no cost arrays, no plateau relaxation), so it is
// used to estimate the symbol frequencies the dynamic Huffman tables are
// built from; the dynamic parse then re-parses under those tables. Its
// symbols are also the fixed-block candidate, emitted with the fixed tables.
function greedyParse(data, head, prev) {
  const syms = [];
  head.fill(-1);
  for (let i = 0; i < data.length;) {
    let best = 0, bestd = 0;
    if (i + 2 < data.length) {
      const h = (Math.imul((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2], 2654435761) >>> 17) & (HASH_SIZE - 1);
      let cur = head[h], tried = 0;
      const maxLen = Math.min(MAX_MATCH, data.length - i);
      while (cur !== -1 && tried < MAX_CHAIN) {
        const d = i - cur;
        if (d > 32768) break;
        if (best < maxLen && data[cur + best] === data[i + best]) {
          let len = best;
          while (len < maxLen && data[cur + len] === data[i + len]) len++;
          let ok = true;
          for (let k = 0; k < best; k++) if (data[cur + k] !== data[i + k]) { ok = false; break; }
          if (ok && len > best) { best = len; bestd = d; if (len === MAX_MATCH) break; }
        }
        cur = prev[cur]; tried++;
      }
      prev[i] = head[h]; head[h] = i;
    }
    if (best >= MIN_MATCH) {
      const lc = lenCodeOf(best);
      syms.push(257 + lc, best - LEN_BASE[lc], bestd);
      // Insert the skipped positions so later matches can start inside them.
      for (let j = i + 1; j < i + best && j + 2 < data.length; j++) {
        const h2 = (Math.imul((data[j] << 16) ^ (data[j + 1] << 8) ^ data[j + 2], 2654435761) >>> 17) & (HASH_SIZE - 1);
        prev[j] = head[h2]; head[h2] = j;
      }
      i += best;
    } else { syms.push(data[i], 0, 0); i++; }
  }
  return syms;
}
function parseBlock(data, litLen, distLen, head, prev) {
  const n = data.length;
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  // Predecessor on the cheapest path *to* each position: from where, how long, at what distance.
  const predPos = new Int32Array(n + 1);
  const predLen = new Uint16Array(n + 1);
  const predDist = new Uint16Array(n + 1);
  head.fill(-1);
  // Precompute per-length-symbol bit cost and per-distance-code bit cost.
  // A symbol with no code (length 0) is prohibitively expensive, never free:
  // the second parse may only use symbols the frequency table covers.
  const BIG = 1e9;
  const lenSymCost = new Float64Array(29);
  for (let c = 0; c < 29; c++) lenSymCost[c] = litLen[257 + c] === 0 ? BIG : litLen[257 + c] + LEN_EXTRA[c];
  const distSymCost = new Float64Array(30);
  for (let c = 0; c < 30; c++) distSymCost[c] = distLen[c] === 0 ? BIG : distLen[c] + DIST_EXTRA[c];
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (i + 2 < n) {
      const h = (Math.imul((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2], 2654435761) >>> 17) & (HASH_SIZE - 1);
      if (ci === Infinity) { prev[i] = head[h]; head[h] = i; continue; }
    } else if (ci === Infinity) continue;
    // Literal (only when the table gives this byte a code).
    if (litLen[data[i]] > 0) {
      const litCost = ci + litLen[data[i]];
      if (litCost < cost[i + 1]) { cost[i + 1] = litCost; predPos[i + 1] = i; predLen[i + 1] = 1; predDist[i + 1] = 0; }
    }
    // Matches.
    if (i + MIN_MATCH <= n) {
      const h = (Math.imul((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2], 2654435761) >>> 17) & (HASH_SIZE - 1);
      let cur = head[h];
      let tried = 0;
      let bestLen = 0;
      const maxLen = Math.min(MAX_MATCH, n - i);
      while (cur !== -1 && tried < MAX_CHAIN) {
        const dist = i - cur;
        if (dist > 32768) break;
        // A candidate can only beat the best length if its byte at bestLen
        // matches; otherwise skip the full comparison.
        if (bestLen < maxLen && data[cur + bestLen] === data[i + bestLen]) {
          let len = bestLen;
          while (len < maxLen && data[cur + len] === data[i + len]) len++;
          // The prefix below bestLen may mismatch; verify it before trusting len.
          if (len > bestLen) {
            let ok = true;
            for (let k = 0; k < bestLen; k++) if (data[cur + k] !== data[i + k]) { ok = false; break; }
            if (ok) {
              bestLen = len;
              const dc = distCodeOf(dist);
              // A match of length len at this distance also offers every
              // shorter length at the same distance. Within one length-code
              // plateau the bit cost is the same, so only the largest length
              // of each plateau can help the shortest path (a shorter exit at
              // the same cost is dominated); relax those plateau maxima.
              for (let bi = 0; bi < 29 && LEN_BASE[bi] <= len; bi++) {
                const nextBase = bi + 1 < 29 ? LEN_BASE[bi + 1] : MAX_MATCH + 1;
                const L = Math.min(len, nextBase - 1);
                if (L < MIN_MATCH) continue;
                const mc = ci + lenSymCost[bi] + distSymCost[dc];
                if (mc < cost[i + L]) { cost[i + L] = mc; predPos[i + L] = i; predLen[i + L] = L; predDist[i + L] = dist; }
              }
              if (len === MAX_MATCH) break;
            }
          }
        }
        cur = prev[cur];
        tried++;
      }
      prev[i] = head[h]; head[h] = i;
    }
  }
  // Backtrack from the end through the predecessors into symbols.
  const syms = [];
  let i = n;
  const rev = [];
  while (i > 0) {
    const from = predPos[i];
    const len = predLen[i];
    rev.push(from, len, predDist[i]);
    i = from;
  }
  for (let k = rev.length - 3; k >= 0; k -= 3) {
    const from = rev[k], len = rev[k + 1], dist = rev[k + 2];
    if (len <= 1) syms.push(data[from], 0, 0);
    else {
      const lc = lenCodeOf(len);
      syms.push(257 + lc, len - LEN_BASE[lc], dist);
    }
  }
  return syms;
}
// Emit one block's symbols with the given Huffman tables.
function emitBlock(bw, syms, isFinal, litCodes, litLen, distCodes, distLen, dynamic) {
  bw.writeBits(isFinal ? 1 : 0, 1); // BFINAL
  if (dynamic) {
    bw.writeBits(2, 2); // BTYPE = dynamic
    // Header: HLIT/HDIST/HCLEN + code-length code + RLE of lit+dist lengths.
    let hlit = 286;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    let hdist = 30;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    const all = new Uint8Array(hlit + hdist);
    all.set(litLen.subarray(0, hlit));
    all.set(distLen.subarray(0, hdist), hlit);
    // RLE-encode the lengths into (symbol, extra) pairs of the code-length alphabet.
    const clSyms = [];
    let j = 0;
    while (j < all.length) {
      const v = all[j];
      let run = 1;
      while (j + run < all.length && all[j + run] === v) run++;
      if (v === 0) {
        let r = run;
        while (r >= 11) { const take = Math.min(r, 138); clSyms.push(18, take - 11); r -= take; }
        if (r >= 3) { clSyms.push(17, r - 3); r = 0; }
        while (r > 0) { clSyms.push(0, 0); r--; }
      } else {
        clSyms.push(v, 0);
        let rep = run - 1;
        while (rep >= 3) { const take = Math.min(rep, 6); clSyms.push(16, take - 3); rep -= take; }
        while (rep > 0) { clSyms.push(v, 0); rep--; }
      }
      j += run;
    }
    const clFreq = new Uint32Array(19);
    for (let k = 0; k < clSyms.length; k += 2) clFreq[clSyms[k]]++;
    // The code-length code needs at least two symbols to be a complete code.
    let clUsed = 0;
    for (let s = 0; s < 19; s++) if (clFreq[s] > 0) clUsed++;
    while (clUsed < 2) {
      for (let s = 0; s < 19; s++) if (clFreq[s] === 0) { clFreq[s] = 1; clUsed++; break; }
    }
    const clLen = huffmanLengths(clFreq, 7);
    const { codes: clCodes } = codesFromLengths(clLen);
    const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    let hclen = 19;
    while (hclen > 4 && clLen[ORDER[hclen - 1]] === 0) hclen--;
    bw.writeBits(hlit - 257, 5);
    bw.writeBits(hdist - 1, 5);
    bw.writeBits(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) bw.writeBits(clLen[ORDER[k]], 3);
    for (let k = 0; k < clSyms.length; k += 2) {
      const s = clSyms[k], e = clSyms[k + 1];
      bw.writeCode(clCodes[s], clLen[s]);
      if (s === 16) bw.writeBits(e, 2);
      else if (s === 17) bw.writeBits(e, 3);
      else if (s === 18) bw.writeBits(e, 7);
    }
  } else {
    bw.writeBits(1, 2); // BTYPE = fixed
  }
  for (let k = 0; k < syms.length; k += 3) {
    const s = syms[k], e = syms[k + 1], dist = syms[k + 2];
    bw.writeCode(litCodes[s], litLen[s]);
    if (s >= 257 && s <= 285) {
      const lc = s - 257;
      if (LEN_EXTRA[lc] > 0) bw.writeBits(e, LEN_EXTRA[lc]);
      const dc = distCodeOf(dist);
      bw.writeCode(distCodes[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeCode(litCodes[256], litLen[256]); // end of block
}

// ---------- whole-stream deflate ----------
// Adler-32 of the raw data (zlib trailer).
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
const BLOCK = 1048576;
// Compress one block two ways (fixed Huffman from a fixed-cost parse, dynamic
// Huffman from a second parse under the dynamic costs) and write the smaller
// into the shared bit writer. Blocks are bit-packed back to back: only the
// stream's last block is aligned to a byte boundary, never a block in the middle.
function deflateBlock(data, isFinal, head, prev, bw, useGreedyFreq) {
  // The frequency source for the dynamic tables, and the fixed-block
  // candidate: a greedy parse (cheap) for palette data, where the shortest
  // path gains little, or a shortest-path parse under the fixed tables for
  // channel data, where it gains the most. The caller chooses by form.
  const fixedSyms = useGreedyFreq
    ? greedyParse(data, head, prev)
    : parseBlock(data, FIXED_LIT_LEN, FIXED_DIST_LEN, head, prev);
  const { codes: fLitCodes } = codesFromLengths(FIXED_LIT_LEN);
  const { codes: fDistCodes } = codesFromLengths(FIXED_DIST_LEN);
  const bwFixed = new BitWriter(data.length * 2 + 4096);
  emitBlock(bwFixed, fixedSyms, isFinal, fLitCodes, FIXED_LIT_LEN, fDistCodes, FIXED_DIST_LEN, false);
  const fixedBits = bwFixed.bitsWritten();
  // Frequencies from the first parse's symbols.
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let k = 0; k < fixedSyms.length; k += 3) {
    litFreq[fixedSyms[k]]++;
    if (fixedSyms[k] >= 257) distFreq[distCodeOf(fixedSyms[k + 2])]++;
  }
  litFreq[256]++; // end of block
  // A Huffman alphabet needs at least two symbols with a code, and a dynamic
  // block's distance code must be complete: pad dummies until both hold.
  let litUsed = 0, distUsed = 0;
  for (let s = 0; s < 288; s++) if (litFreq[s] > 0) litUsed++;
  for (let s = 0; s < 30; s++) if (distFreq[s] > 0) distUsed++;
  if (litUsed < 2) { for (let s = 0; s < 288; s++) if (litFreq[s] === 0) { litFreq[s] = 1; break; } }
  while (distUsed < 2) {
    for (let s = 0; s < 30; s++) if (distFreq[s] === 0) { distFreq[s] = 1; distUsed++; break; }
  }
  const dynLitLen = huffmanLengths(litFreq, 15);
  const dynDistLen = huffmanLengths(distFreq, 15);
  const dynSyms = parseBlock(data, dynLitLen, dynDistLen, head, prev);
  // Safety: the second parse must only use symbols the tables cover. If it
  // ever did not (a length code the first parse never used), keep the fixed block.
  let dynOk = true;
  for (let k = 0; k < dynSyms.length; k += 3) {
    if (dynLitLen[dynSyms[k]] === 0) { dynOk = false; break; }
    if (dynSyms[k] >= 257 && dynDistLen[distCodeOf(dynSyms[k + 2])] === 0) { dynOk = false; break; }
  }
  const { codes: dLitCodes } = codesFromLengths(dynLitLen);
  const { codes: dDistCodes } = codesFromLengths(dynDistLen);
  let dynBits = Infinity;
  let dynLitLenW = dynLitLen, dynDistLenW = dynDistLen, dLitCodesW = dLitCodes, dDistCodesW = dDistCodes;
  if (dynOk) {
    const bwDyn = new BitWriter(data.length * 2 + 4096);
    emitBlock(bwDyn, dynSyms, isFinal, dLitCodes, dynLitLen, dDistCodes, dynDistLen, true);
    dynBits = bwDyn.bitsWritten();
    // Re-code the same dynamic symbols with tables built from their own
    // frequencies: the first tables came from the first parse, which is not
    // the parse being coded, so its own tables are never worse in code
    // length (the header may cost a little more; the smaller emission wins).
    const lf2 = new Uint32Array(288), df2 = new Uint32Array(30);
    for (let k = 0; k < dynSyms.length; k += 3) {
      lf2[dynSyms[k]]++;
      if (dynSyms[k] >= 257) df2[distCodeOf(dynSyms[k + 2])]++;
    }
    lf2[256]++;
    let du2 = 0;
    for (let s = 0; s < 30; s++) if (df2[s] > 0) du2++;
    while (du2 < 2) { for (let s = 0; s < 30; s++) if (df2[s] === 0) { df2[s] = 1; du2++; break; } }
    const dl2 = huffmanLengths(lf2, 15), dd2 = huffmanLengths(df2, 15);
    let recodeOk = true;
    for (let k = 0; k < dynSyms.length; k += 3) {
      if (dl2[dynSyms[k]] === 0) { recodeOk = false; break; }
      if (dynSyms[k] >= 257 && dd2[distCodeOf(dynSyms[k + 2])] === 0) { recodeOk = false; break; }
    }
    if (recodeOk) {
      const { codes: dlc2 } = codesFromLengths(dl2);
      const { codes: ddc2 } = codesFromLengths(dd2);
      const bwDyn2 = new BitWriter(data.length * 2 + 4096);
      emitBlock(bwDyn2, dynSyms, isFinal, dlc2, dl2, ddc2, dd2, true);
      if (bwDyn2.bitsWritten() < dynBits) {
        dynBits = bwDyn2.bitsWritten();
        dynLitLenW = dl2; dynDistLenW = dd2; dLitCodesW = dlc2; dDistCodesW = ddc2;
      }
    }
  }
  // Re-emit the winner into the shared writer (emitting is cheap; parsing is not).
  if (dynBits < fixedBits) emitBlock(bw, dynSyms, isFinal, dLitCodesW, dynLitLenW, dDistCodesW, dynDistLenW, true);
  else emitBlock(bw, fixedSyms, isFinal, fLitCodes, FIXED_LIT_LEN, fDistCodes, FIXED_DIST_LEN, false);
}
// A zlib stream (header 0x78 0x9c, deflate blocks, Adler-32) of the raw data.
function deflateData(data, useGreedyFreq) {
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(data.length);
  const bw = new BitWriter(data.length * 2 + 4096);
  const nBlocks = Math.max(1, Math.ceil(data.length / BLOCK));
  for (let b = 0; b < nBlocks; b++) {
    const chunk = data.subarray(b * BLOCK, Math.min(data.length, (b + 1) * BLOCK));
    deflateBlock(chunk, b === nBlocks - 1, head, prev, bw, useGreedyFreq);
  }
  bw.align();
  const body = bw.bytes();
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(out.length - 4, adler32(data));
  return out;
}

// ---------- encode one image ----------
// Candidate filtered forms, screened by zlib level 6, then the winner is written
// with the optimal-parsing deflate (falling back to zlib level 9 when smaller).
function encodeImage(rgba) {
  const forms = formsOf(rgba);
  let best = null;
  for (const form of forms) {
    // Filter 0 (none) wins outright on palette indices, where Sub/Up create new
    // index values; the minimum-sum and fewest-pairs choices win on channel
    // data. All four variants come from one fused pass over the rows.
    const v = filteredVariants(form.samples, WIDTH, HEIGHT, form.bpp);
    const variants = [v.filter0, v.minsum];
    if (form.colourType !== 3) variants.push(v.paeth, v.pairs);
    const chunkBytes = (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    for (const raw of variants) {
      const z = deflateSync(raw, { level: 6, memLevel: 9 });
      const bytes = z.length + chunkBytes;
      if (best === null || bytes < best.bytes) best = { form, raw, bytes, chunkBytes };
    }
  }
  const { form, raw, chunkBytes } = best;
  // Palette rows are short (one byte per pixel) and the shortest-path parse
  // gains almost nothing over the greedy frequency estimate there, so they
  // take the cheap greedy path; channel rows take the two-parse path, where
  // the fixed-parse frequencies are worth the extra work.
  const mine = deflateData(raw, form.colourType === 3);
  const z9 = deflateSync(raw, { level: 9, memLevel: 9 });
  const idat = mine.length <= z9.length ? mine : z9;
  const chunks = [['IHDR', ihdrOf(WIDTH, HEIGHT, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- main ----------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const bytes = new Uint8Array(readFileSync(join(I, id, 'image.png')));
  const { rgba, width, height } = decodePng(bytes);
  if (width !== WIDTH || height !== HEIGHT) throw new Error(id + ': unexpected size ' + width + 'x' + height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encodeImage(rgba));
}
