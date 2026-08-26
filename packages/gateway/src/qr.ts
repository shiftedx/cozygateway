/** Dependency-free QR encoder for the pairing finale.
 *
 *  Scope is deliberately narrow: byte mode, error-correction level M, versions 1 through 10
 *  (up to 213 payload bytes). That covers every `{"gatewayUrl":...,"setupCode":...}` pairing
 *  payload this gateway mints, including long https hostnames, without pulling a dependency
 *  into the one artifact the simple install track ships as a single verified file. A payload
 *  that does not fit throws `QrCapacityError`; the caller falls back to plain text, because
 *  the printed URL and code are the guarantee and the QR is sugar on top.
 *
 *  Implements ISO/IEC 18004: finder/timing/alignment function patterns, interleaved
 *  Reed-Solomon blocks over GF(256), all eight data masks scored by the four penalty rules,
 *  BCH-protected format information, and version information for versions 7+.
 */

export class QrCapacityError extends Error {
  constructor(byteLength: number) {
    super(`payload of ${byteLength} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte QR capacity`);
    this.name = "QrCapacityError";
  }
}

export interface QrCode {
  /** QR version, 1-10. */
  version: number;
  /** Modules per side: 17 + 4 * version. */
  size: number;
  /** Row-major modules; `true` is a dark module. */
  modules: boolean[][];
}

/** Byte-mode data capacity at EC level M, indexed by version (index 0 unused). */
const DATA_CAPACITY = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

export const MAX_PAYLOAD_BYTES = 213;

/** EC-level-M Reed-Solomon block structure per version: [blockCount, totalCodewords,
 *  dataCodewords] groups, indexed by version (index 0 unused). */
const RS_BLOCKS: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [],
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [
    [2, 60, 38],
    [2, 61, 39],
  ],
  [
    [3, 58, 36],
    [2, 59, 37],
  ],
  [
    [4, 69, 43],
    [1, 70, 44],
  ],
];

/** Alignment pattern center coordinates, indexed by version (index 0 unused). */
const ALIGNMENT_CENTERS: ReadonlyArray<ReadonlyArray<number>> = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// --- GF(256) arithmetic (polynomial 0x11d), shared by Reed-Solomon encoding ---

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Monic Reed-Solomon generator polynomial of the given degree, highest power first. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    // Multiply the highest-power-first polynomial by (x + a^i).
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon error-correction codewords for one block. */
function rsEncode(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = rsGenerator(ecLength);
  const buffer = new Uint8Array(data.length + ecLength);
  buffer.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buffer[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) buffer[i + j] = buffer[i + j]! ^ gfMul(gen[j]!, factor);
  }
  return buffer.slice(data.length);
}

// --- BCH codes for format and version information ---

function bitLength(x: number): number {
  let length = 0;
  while (x !== 0) {
    length += 1;
    x >>>= 1;
  }
  return length;
}

/** 15-bit format information: EC level M (00) + mask, BCH(15,5) protected, masked per spec. */
function formatBits(mask: number): number {
  const data = mask; // EC level M contributes 00 as the two high bits.
  let remainder = data << 10;
  while (bitLength(remainder) >= 11) remainder ^= 0x537 << (bitLength(remainder) - 11);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** 18-bit version information for versions 7+, BCH(18,6) protected. */
function versionBits(version: number): number {
  let remainder = version << 12;
  while (bitLength(remainder) >= 13) remainder ^= 0x1f25 << (bitLength(remainder) - 13);
  return (version << 12) | remainder;
}

// --- Bit assembly ---

class BitBuffer {
  bytes: number[] = [];
  bitLength = 0;

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      const byteIndex = this.bitLength >>> 3;
      if (byteIndex === this.bytes.length) this.bytes.push(0);
      if (((value >>> i) & 1) === 1) this.bytes[byteIndex] = this.bytes[byteIndex]! | (0x80 >>> (this.bitLength & 7));
      this.bitLength += 1;
    }
  }
}

/** Byte-mode data codewords for the version: mode + count + payload + terminator + padding. */
function dataCodewords(payload: Uint8Array, version: number): Uint8Array {
  const capacityBytes = RS_BLOCKS[version]!.reduce((sum, [count, , data]) => sum + count * data, 0);
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4);
  buffer.put(payload.length, version <= 9 ? 8 : 16);
  for (const byte of payload) buffer.put(byte, 8);
  const capacityBits = capacityBytes * 8;
  buffer.put(0, Math.min(4, capacityBits - buffer.bitLength));
  if (buffer.bitLength % 8 !== 0) buffer.put(0, 8 - (buffer.bitLength % 8));
  const padBytes = [0xec, 0x11];
  for (let i = 0; buffer.bitLength < capacityBits; i++) buffer.put(padBytes[i % 2]!, 8);
  return Uint8Array.from(buffer.bytes);
}

/** Split into RS blocks, append EC codewords, and interleave both per the spec. */
function interleavedCodewords(data: Uint8Array, version: number): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, total, dataLength] of RS_BLOCKS[version]!) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + dataLength);
      offset += dataLength;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, total - dataLength));
    }
  }
  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  const ecLength = ecBlocks[0]!.length;
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return Uint8Array.from(out);
}

// --- Matrix construction ---

interface Matrix {
  size: number;
  dark: boolean[][];
  isFunction: boolean[][];
}

function newMatrix(size: number): Matrix {
  return {
    size,
    dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(m: Matrix, row: number, col: number, dark: boolean): void {
  m.dark[row]![col] = dark;
  m.isFunction[row]![col] = true;
}

/** Finder pattern plus its light separator, anchored at the pattern's top-left module. */
function placeFinder(m: Matrix, top: number, left: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const row = top + r;
      const col = left + c;
      if (row < 0 || row >= m.size || col < 0 || col >= m.size) continue;
      const inOuterRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      setFunction(m, row, col, inOuterRing || inCore);
    }
  }
}

function placeAlignment(m: Matrix, centerRow: number, centerCol: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      setFunction(m, centerRow + r, centerCol + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
    }
  }
}

function placeFunctionPatterns(m: Matrix, version: number): void {
  placeFinder(m, 0, 0);
  placeFinder(m, 0, m.size - 7);
  placeFinder(m, m.size - 7, 0);
  for (let i = 8; i <= m.size - 9; i++) {
    setFunction(m, 6, i, i % 2 === 0);
    setFunction(m, i, 6, i % 2 === 0);
  }
  const centers = ALIGNMENT_CENTERS[version]!;
  for (const row of centers) {
    for (const col of centers) {
      // Skip the three corners occupied by finder patterns.
      const nearTopLeft = row <= 8 && col <= 8;
      const nearTopRight = row <= 8 && col >= m.size - 9;
      const nearBottomLeft = row >= m.size - 9 && col <= 8;
      if (nearTopLeft || nearTopRight || nearBottomLeft) continue;
      placeAlignment(m, row, col);
    }
  }
  // Reserve the format information areas (values are written once the mask is chosen).
  for (let i = 0; i < 9; i++) {
    if (!m.isFunction[8]![i]) setFunction(m, 8, i, false);
    if (!m.isFunction[i]![8]) setFunction(m, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFunction(m, 8, m.size - 1 - i, false);
    setFunction(m, m.size - 8 + i, 8, false);
  }
  setFunction(m, m.size - 8, 8, true); // the always-dark module
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + m.size - 8 - 3;
      setFunction(m, a, b, dark);
      setFunction(m, b, a, dark);
    }
  }
}

/** Standard zigzag placement: column pairs right to left, alternating direction, skipping the
 *  vertical timing column; overflow modules (the spec's remainder bits) stay light. */
function placeData(m: Matrix, codewords: Uint8Array): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let row = m.size - 1;
  let direction = -1;
  for (let col = m.size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (const c of [col, col - 1]) {
        if (!m.isFunction[row]![c]) {
          let dark = false;
          if (bitIndex < totalBits) {
            dark = ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) === 1;
          }
          m.dark[row]![c] = dark;
          bitIndex += 1;
        }
      }
      row += direction;
      if (row < 0 || row >= m.size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

const MASKS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, mask: number): void {
  const fn = MASKS[mask]!;
  for (let r = 0; r < m.size; r++) {
    const darkRow = m.dark[r]!;
    const functionRow = m.isFunction[r]!;
    for (let c = 0; c < m.size; c++) {
      if (!functionRow[c] && fn(r, c)) darkRow[c] = !darkRow[c];
    }
  }
}

function placeFormat(m: Matrix, mask: number): void {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // First copy, wrapped around the top-left finder (skipping the timing row at 6).
    const row = i < 6 ? i : i < 8 ? i + 1 : m.size - 15 + i;
    setFunction(m, row, 8, dark);
    // Second copy, under the top-right and beside the bottom-left finders (skipping the
    // timing column at 6).
    const col = i < 8 ? m.size - 1 - i : i === 8 ? 7 : 14 - i;
    setFunction(m, 8, col, dark);
  }
  setFunction(m, m.size - 8, 8, true);
}

// --- Mask evaluation (the four penalty rules) ---

function runPenalty(line: boolean[]): number {
  let penalty = 0;
  let runColor = line[0];
  let runLength = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === runColor) {
      runLength += 1;
      continue;
    }
    if (runLength >= 5) penalty += 3 + (runLength - 5);
    if (i < line.length) {
      runColor = line[i];
      runLength = 1;
    }
  }
  return penalty;
}

const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LIKE_REVERSED = [...FINDER_LIKE].reverse();

function finderLikePenalty(line: boolean[]): number {
  let penalty = 0;
  for (let i = 0; i + FINDER_LIKE.length <= line.length; i++) {
    if (FINDER_LIKE.every((v, j) => line[i + j] === v)) penalty += 40;
    if (FINDER_LIKE_REVERSED.every((v, j) => line[i + j] === v)) penalty += 40;
  }
  return penalty;
}

function penaltyScore(m: Matrix): number {
  let score = 0;
  for (let r = 0; r < m.size; r++) {
    const row = m.dark[r]!;
    const col = m.dark.map((line) => line[r]!);
    score += runPenalty(row) + runPenalty(col) + finderLikePenalty(row) + finderLikePenalty(col);
  }
  for (let r = 0; r + 1 < m.size; r++) {
    const top = m.dark[r]!;
    const bottom = m.dark[r + 1]!;
    for (let c = 0; c + 1 < m.size; c++) {
      const v = top[c];
      if (top[c + 1] === v && bottom[c] === v && bottom[c + 1] === v) score += 3;
    }
  }
  let darkCount = 0;
  for (const row of m.dark) for (const module of row) if (module) darkCount += 1;
  const percent = (darkCount * 100) / (m.size * m.size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// --- Public API ---

/** Encodes UTF-8 text as a QR symbol (byte mode, EC level M, smallest fitting version). */
export function encodeQr(text: string): QrCode {
  const payload = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v < DATA_CAPACITY.length; v++) {
    if (payload.length <= DATA_CAPACITY[v]!) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new QrCapacityError(payload.length);

  const codewords = interleavedCodewords(dataCodewords(payload, version), version);
  const size = 17 + 4 * version;

  let best: Matrix | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const m = newMatrix(size);
    placeFunctionPatterns(m, version);
    placeData(m, codewords);
    applyMask(m, mask);
    placeFormat(m, mask);
    const score = penaltyScore(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (best === undefined) throw new Error("unreachable: no mask evaluated");
  return { version, size, modules: best.dark };
}

/** Renders a QR symbol for a terminal using half-block characters, two modules per text row,
 *  with the spec's four-module quiet zone on every side.
 *
 *  `color: true` wraps each line in an explicit white-on-black SGR so the symbol keeps correct
 *  polarity on light-themed terminals; `false` emits bare characters (light modules as filled
 *  blocks), which phone scanners read fine on the dark terminals the install runs in and keeps
 *  logs free of escape codes. */
export function renderQrHalfBlocks(qr: QrCode, options: { color: boolean }): string {
  const quiet = 4;
  const dim = qr.size + 2 * quiet;
  const isLight = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || r >= qr.size || c < 0 || c >= qr.size) return true;
    return !qr.modules[r]![c];
  };
  const lines: string[] = [];
  for (let row = 0; row < dim; row += 2) {
    let line = "";
    for (let col = 0; col < dim; col++) {
      const top = isLight(row, col);
      const bottom = row + 1 < dim ? isLight(row + 1, col) : true;
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(options.color ? `[0;40;97m${line}[0m` : line);
  }
  return lines.join("\n");
}
