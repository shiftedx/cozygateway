import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_PAYLOAD_BYTES, QrCapacityError, encodeQr, renderQrHalfBlocks } from "../src/qr.ts";

/** This file verifies the encoder with an independently written decoder: it rebuilds the
 *  function-module map from the spec, reads and BCH-checks both format information copies,
 *  unmasks, de-zigzags, de-interleaves, verifies every Reed-Solomon block's syndromes are
 *  zero, and parses the byte-mode segment back to text. Constants are deliberately duplicated
 *  from the spec rather than imported from the encoder. */

// --- Spec tables (duplicated on purpose) ---

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

// --- GF(256) for syndrome checks ---

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Evaluates a highest-power-first polynomial at `x`. */
function polyEval(poly: number[], x: number): number {
  let result = 0;
  for (const coefficient of poly) result = gfMul(result, x) ^ coefficient;
  return result;
}

function bitLength(x: number): number {
  let length = 0;
  while (x !== 0) {
    length += 1;
    x >>>= 1;
  }
  return length;
}

function expectedFormatValue(data5: number): number {
  let remainder = data5 << 10;
  while (bitLength(remainder) >= 11) remainder ^= 0x537 << (bitLength(remainder) - 11);
  return ((data5 << 10) | remainder) ^ 0x5412;
}

function expectedVersionValue(version: number): number {
  let remainder = version << 12;
  while (bitLength(remainder) >= 13) remainder ^= 0x1f25 << (bitLength(remainder) - 13);
  return (version << 12) | remainder;
}

// --- The decoder ---

function functionMap(version: number): boolean[][] {
  const size = 17 + 4 * version;
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const markZone = (top: number, left: number, height: number, width: number): void => {
    for (let r = top; r < top + height; r++) {
      for (let c = left; c < left + width; c++) {
        if (r >= 0 && r < size && c >= 0 && c < size) map[r]![c] = true;
      }
    }
  };
  markZone(0, 0, 8, 8);
  markZone(0, size - 8, 8, 8);
  markZone(size - 8, 0, 8, 8);
  for (let i = 8; i <= size - 9; i++) {
    map[6]![i] = true;
    map[i]![6] = true;
  }
  const centers = ALIGNMENT_CENTERS[version]!;
  for (const row of centers) {
    for (const col of centers) {
      const nearTopLeft = row <= 8 && col <= 8;
      const nearTopRight = row <= 8 && col >= size - 9;
      const nearBottomLeft = row >= size - 9 && col <= 8;
      if (nearTopLeft || nearTopRight || nearBottomLeft) continue;
      markZone(row - 2, col - 2, 5, 5);
    }
  }
  for (let i = 0; i <= 8; i++) {
    map[8]![i] = true;
    map[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    map[8]![size - 1 - i] = true;
    map[size - 8 + i]![8] = true;
  }
  if (version >= 7) {
    markZone(0, size - 11, 6, 3);
    markZone(size - 11, 0, 3, 6);
  }
  return map;
}

function readFormat(modules: boolean[][], size: number): { mask: number } {
  let copy1 = 0;
  let copy2 = 0;
  for (let i = 0; i < 15; i++) {
    const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    if (modules[row]![8]) copy1 |= 1 << i;
    const col = i < 8 ? size - 1 - i : i === 8 ? 7 : 14 - i;
    if (modules[8]![col]) copy2 |= 1 << i;
  }
  expect(copy2).toBe(copy1);
  const data5 = (copy1 ^ 0x5412) >> 10;
  expect(expectedFormatValue(data5)).toBe(copy1);
  expect(data5 >> 3).toBe(0b00); // EC level M
  return { mask: data5 & 7 };
}

function readCodewords(modules: boolean[][], version: number, mask: number): number[] {
  const size = 17 + 4 * version;
  const isFunction = functionMap(version);
  const maskFn = MASKS[mask]!;
  const bits: number[] = [];
  let row = size - 1;
  let direction = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (const c of [col, col - 1]) {
        if (!isFunction[row]![c]) {
          const dark = modules[row]![c] !== maskFn(row, c);
          bits.push(dark ? 1 : 0);
        }
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
  const codewords: number[] = [];
  const total = RS_BLOCKS[version]!.reduce((sum, [count, totalCw]) => sum + count * totalCw, 0);
  for (let i = 0; i < total; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j]!;
    codewords.push(byte);
  }
  return codewords;
}

function deinterleaveAndCheck(codewords: number[], version: number): number[] {
  const shapes: Array<{ dataLength: number; ecLength: number }> = [];
  for (const [count, total, dataLength] of RS_BLOCKS[version]!) {
    for (let i = 0; i < count; i++) shapes.push({ dataLength, ecLength: total - dataLength });
  }
  const dataBlocks: number[][] = shapes.map(() => []);
  const ecBlocks: number[][] = shapes.map(() => []);
  let index = 0;
  const maxData = Math.max(...shapes.map((s) => s.dataLength));
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < shapes.length; b++) {
      if (i < shapes[b]!.dataLength) dataBlocks[b]!.push(codewords[index++]!);
    }
  }
  for (let i = 0; i < shapes[0]!.ecLength; i++) {
    for (let b = 0; b < shapes.length; b++) ecBlocks[b]!.push(codewords[index++]!);
  }
  expect(index).toBe(codewords.length);
  for (let b = 0; b < shapes.length; b++) {
    const poly = [...dataBlocks[b]!, ...ecBlocks[b]!];
    for (let i = 0; i < shapes[b]!.ecLength; i++) {
      expect(polyEval(poly, EXP[i]!)).toBe(0);
    }
  }
  return dataBlocks.flat();
}

function parseByteMode(data: number[], version: number): Uint8Array {
  let bitIndex = 0;
  const read = (length: number): number => {
    let value = 0;
    for (let i = 0; i < length; i++) {
      value = (value << 1) | ((data[bitIndex >> 3]! >> (7 - (bitIndex & 7))) & 1);
      bitIndex += 1;
    }
    return value;
  };
  expect(read(4)).toBe(0b0100);
  const count = read(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = read(8);
  return bytes;
}

function decode(text: string): { decoded: string; version: number } {
  const qr = encodeQr(text);
  expect(qr.size).toBe(17 + 4 * qr.version);
  if (qr.version >= 7) {
    // Version information, both copies, BCH-checked.
    let copy1 = 0;
    let copy2 = 0;
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + qr.size - 11;
      if (qr.modules[a]![b]) copy1 |= 1 << i;
      if (qr.modules[b]![a]) copy2 |= 1 << i;
    }
    expect(copy2).toBe(copy1);
    expect(copy1).toBe(expectedVersionValue(qr.version));
  }
  const { mask } = readFormat(qr.modules, qr.size);
  const codewords = readCodewords(qr.modules, qr.version, mask);
  const data = deinterleaveAndCheck(codewords, qr.version);
  const decoded = new TextDecoder().decode(parseByteMode(data, qr.version));
  return { decoded, version: qr.version };
}

// --- Tests ---

describe("qr encoder", () => {
  it("round-trips the contract's pairing payload shape through an independent decoder", () => {
    const payload = JSON.stringify({ gatewayUrl: "https://gateway.example.com", setupCode: "ABCD-EFGH" });
    expect(decode(payload).decoded).toBe(payload);
  });

  it("matches the contract example's key order byte for byte", () => {
    // contract/v1.md section 4 pins the QR payload as {"gatewayUrl":...,"setupCode":...}.
    const contract = readFileSync(join(import.meta.dirname, "../../../contract/v1.md"), "utf8");
    expect(contract).toContain('{ "gatewayUrl": "https://...", "setupCode": "string" }');
    const payload = JSON.stringify({ gatewayUrl: "https://...", setupCode: "string" });
    expect(payload).toBe('{"gatewayUrl":"https://...","setupCode":"string"}');
    expect(decode(payload).decoded).toBe(payload);
  });

  it("round-trips a realistic LAN payload", () => {
    const payload = JSON.stringify({ gatewayUrl: "http://192.168.1.23:8787", setupCode: "K7PQ-2M9X" });
    const { decoded, version } = decode(payload);
    expect(decoded).toBe(payload);
    expect(version).toBeLessThanOrEqual(5);
  });

  it("round-trips at every version, including the 16-bit character count at version 10", () => {
    const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    for (let version = 1; version <= 10; version++) {
      const exact = "a".repeat(capacities[version - 1]!);
      const result = decode(exact);
      expect(result.decoded).toBe(exact);
      expect(result.version).toBe(version);
    }
  });

  it("round-trips multi-byte UTF-8", () => {
    const payload = '{"gatewayUrl":"https://gemütlich.example","setupCode":"COZY-CHAT"}';
    expect(decode(payload).decoded).toBe(payload);
  });

  it("refuses payloads beyond capacity with a typed error", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(213);
    expect(() => encodeQr("a".repeat(214))).toThrow(QrCapacityError);
  });

  it("renders half blocks with a four-module quiet zone", () => {
    const qr = encodeQr("cozy");
    const rendered = renderQrHalfBlocks(qr, { color: false });
    const lines = rendered.split("\n");
    expect(lines).toHaveLength(Math.ceil((qr.size + 8) / 2));
    for (const line of lines) expect(line).toHaveLength(qr.size + 8);
    // The quiet zone is light: full blocks along the top rows and side columns.
    expect(lines[0]).toBe("█".repeat(qr.size + 8));
    expect(lines[1]).toBe("█".repeat(qr.size + 8));
    for (const line of lines) {
      expect(line.slice(0, 4)).toBe("████");
      expect(line.slice(-4)).toBe("████");
    }
  });

  it("wraps colored output in an explicit white-on-black SGR per line", () => {
    const rendered = renderQrHalfBlocks(encodeQr("cozy"), { color: true });
    for (const line of rendered.split("\n")) {
      expect(line.startsWith("[0;40;97m")).toBe(true);
      expect(line.endsWith("[0m")).toBe(true);
    }
  });
});
