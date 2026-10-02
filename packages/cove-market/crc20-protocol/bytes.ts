/** Uint8Array-only Bitcoin primitives: no Node globals or runtime imports. */
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
export function unhex(value: string): Uint8Array {
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(value)) throw new Error("invalid hex");
  return Uint8Array.from(value.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
}
export const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export function le(value: bigint | number, size: number): Uint8Array {
  let n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(size * 8)) throw new Error("integer out of range");
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}
export function compact(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid length");
  return n < 253
    ? le(n, 1)
    : n <= 65535
      ? concat(le(253, 1), le(n, 2))
      : concat(le(254, 1), le(n, 4));
}
export const sized = (bytes: Uint8Array): Uint8Array => concat(compact(bytes.length), bytes);
const rotr = (n: number, k: number): number => (n >>> k) | (n << (32 - k));
const rol = (n: number, k: number): number => (n << k) | (n >>> (32 - k));
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function padded(input: Uint8Array, little: boolean): Uint8Array {
  const out = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  out.set(input);
  out[input.length] = 128;
  const bits = le(BigInt(input.length) * 8n, 8);
  out.set(little ? bits : bits.reverse(), out.length - 8);
  return out;
}
export function sha256(input: Uint8Array): Uint8Array {
  const data = padded(input, false),
    view = new DataView(data.buffer);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!,
        b = w[i - 2]!;
      w[i] =
        w[i - 16]! +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        w[i - 7]! +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, j] = Array.from(h) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (j + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      j = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, j].forEach((n, i) => {
      h[i] = h[i]! + n;
    });
  }
  const out = new Uint8Array(32),
    v = new DataView(out.buffer);
  h.forEach((n, i) => v.setUint32(i * 4, n));
  return out;
}
export const hash256 = (bytes: Uint8Array): Uint8Array => sha256(sha256(bytes));
const R = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2,
  14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3,
  7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];
const RP = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4,
  9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2,
  13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];
const S = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9,
  11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9,
  8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];
const SP = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7,
  6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6,
  14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];
const F = (j: number, x: number, y: number, z: number): number =>
  j < 16
    ? x ^ y ^ z
    : j < 32
      ? (x & y) | (~x & z)
      : j < 48
        ? (x | ~y) ^ z
        : j < 64
          ? (x & z) | (y & ~z)
          : x ^ (y | ~z);
export function hash160(input: Uint8Array): Uint8Array {
  const data = padded(sha256(input), true),
    v = new DataView(data.buffer);
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const k = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e],
    kp = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = Array.from({ length: 16 }, (_, i) => v.getUint32(offset + i * 4, true));
    let [a, b, c, d, e] = Array.from(h) as [number, number, number, number, number];
    let [ap, bp, cp, dp, ep] = [a, b, c, d, e];
    for (let j = 0; j < 80; j++) {
      const t =
        (rol((a + F(j, b, c, d) + w[R[j]!]! + k[Math.floor(j / 16)]!) >>> 0, S[j]!) + e) >>> 0;
      a = e;
      e = d;
      d = rol(c, 10);
      c = b;
      b = t;
      const tp =
        (rol((ap + F(79 - j, bp, cp, dp) + w[RP[j]!]! + kp[Math.floor(j / 16)]!) >>> 0, SP[j]!) +
          ep) >>>
        0;
      ap = ep;
      ep = dp;
      dp = rol(cp, 10);
      cp = bp;
      bp = tp;
    }
    const t = (h[1]! + c + dp) >>> 0;
    h[1] = h[2]! + d + ep;
    h[2] = h[3]! + e + ap;
    h[3] = h[4]! + a + bp;
    h[4] = h[0]! + b + cp;
    h[0] = t;
  }
  return concat(...Array.from(h, (n) => le(n, 4)));
}
