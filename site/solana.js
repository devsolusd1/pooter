// The few Solana address helpers the live site and its reader (api/state.js) need, with no
// dependencies: base58, program-derived addresses and associated token accounts. Plain ES module:
// the same file runs in the browser and in Node.

import { sha256 } from "./core/sha256.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}

export function fromBase58(text) {
  if (typeof text !== "string" || !text) throw new Error("not an address");
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error("not an address");
    n = n * 58n + BigInt(v);
  }
  const body = [];
  while (n > 0n) { body.unshift(Number(n & 255n)); n >>= 8n; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

// A 32-byte public key from base58, checked.
export function key(text) {
  const b = fromBase58(text);
  if (b.length !== 32) throw new Error("not an address");
  return b;
}
export const isAddress = (text) => { try { key(text); return true; } catch { return false; } };

// ed25519: is this 32-byte string a point on the curve? (What curve25519-dalek's decompress accepts:
// y with the sign bit cleared, and (y^2 - 1) / (d y^2 + 1) a square mod p.)
const P = (1n << 255n) - 19n;
const modp = (v) => ((v % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  b = modp(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
const D = modp(-121665n * pow(121666n, P - 2n));
export function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = modp(y);
  const y2 = (y * y) % P;
  const u = modp(y2 - 1n), v = modp(D * y2 + 1n);
  const w = (u * pow(v, P - 2n)) % P;
  if (w === 0n) return true;
  return pow(w, (P - 1n) / 2n) === 1n;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
const asBytes = (s) => (typeof s === "string" ? new TextEncoder().encode(s) : s);

// find_program_address: the first bump from 255 down whose hash is off the curve.
export function findPda(seeds, programId) {
  const program = typeof programId === "string" ? key(programId) : programId;
  const parts = seeds.map(asBytes);
  for (let bump = 255; bump >= 0; bump--) {
    const len = parts.reduce((a, p) => a + p.length, 0) + 1 + 32 + PDA_MARKER.length;
    const buf = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    buf[o++] = bump;
    buf.set(program, o); o += 32;
    buf.set(PDA_MARKER, o);
    const h = sha256(buf);
    if (!onCurve(h)) return { address: base58(h), bump };
  }
  throw new Error("no bump");
}

export const PROGRAMS = {
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  loaderV3: "BPFLoaderUpgradeab1e11111111111111111111111",
  dbc: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  wsol: "So11111111111111111111111111111111111111112",
};

export const ata = (owner, mint) => findPda([key(owner), key(PROGRAMS.token), key(mint)], PROGRAMS.ata).address;

// Every account the site reads, from three public facts: the program id, the mint and the pool.
// Hunch's own accounts are PDAs of the program (seeds in programs/hunch/src/ids.rs).
export function hunchAddresses({ programId, mint, pool }) {
  const p = (seed) => findPda([seed], programId).address;
  const budget = p("budget");
  return {
    program: programId,
    programData: findPda([key(programId)], PROGRAMS.loaderV3).address,
    state: p("state"),
    model: p("model"),
    tape: p("tape"),
    signal: p("signal"),
    diary: p("diary"),
    book: p("brains"),
    budget,
    budgetWsol: ata(budget, PROGRAMS.wsol),
    budgetHunch: ata(budget, mint),
    pool,
    mint,
  };
}
