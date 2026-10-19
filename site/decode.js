// Hunch's public accounts, decoded in the browser from their raw bytes. Every offset mirrors
// programs/hunch/src/layout.rs (State, the open call, the diary, the brain book, the tape) and the
// repr(C) Model of programs/hunch-net/src/lib.rs, as hunch/design/layout-final.md lists them (the final
// program: State is 1,248 bytes, with the graduation fields and the ticker). If the program's layout
// changes, this file changes. Any other State size is refused, so an old layout shows the page's
// "could not be read" error instead of wrong numbers. Nothing here trusts a memo: the diary line is
// rebuilt from the diary account (core/chain.js), naming the coin by the ticker the program stores.

import { base58 } from "./solana.js";
import { diaryLine, luckBandBps, tickerOk, CALL, OUTCOME, PHASE, DF, SF, TF, SKIP } from "./core/chain.js";
import { sha256, toHex } from "./core/sha256.js";
import { N_WEIGHTS_V1 } from "./core/net.js";

export { CALL, OUTCOME, PHASE, DF, SF, TF, SKIP, diaryLine, luckBandBps };

const TAGS = {
  state: "HUNCHSTA", model: "HUNCHMDL", tape: "HUNCHTAP", signal: "HUNCHCAL", diary: "HUNCHDRY", book: "HUNCHBRN",
};

// ---------- sizes (layout.rs) ----------
export const STATE_LEN = 1248;                     // the final layout; nothing else is read
export const MODEL_OFFSET = 8;
export const MODEL_SIZE = 1280;                    // size_of::<Model>()
export const MODEL_LEN = MODEL_OFFSET + MODEL_SIZE;
export const TAPE_HEADER = 24, TAPE_ENTRIES = 144, TAPE_ENTRY = 48;
export const TAPE_LEN = TAPE_HEADER + TAPE_ENTRIES * TAPE_ENTRY;
export const SIGNAL_LEN = 160;
export const DIARY_HEADER = 24, DIARY_ENTRIES = 144, DIARY_ENTRY = 64;
export const DIARY_LEN = DIARY_HEADER + DIARY_ENTRIES * DIARY_ENTRY;
export const BOOK_HEADER = 32, BOOK_RECORD = 64;
export const POOL_LEN = 424;

// State: repr(C) field offsets (u8 fields packed after the tag, then 8-byte aligned blocks).
export const ST = {
  version: 8, phase: 9, chapter: 10, brainSource: 11, budgetBump: 12, eventBump: 13, lastOutcome: 14, blind: 15,
  mint: 16, pool: 48, config: 80, baseVault: 112, quoteVault: 144, budget: 176, budgetWsol: 208, budgetHunch: 240,
  model: 272, tape: 304, signal: 336, diary: 368, book: 400, eventAuthority: 432, brainHash: 464,
  seed: 496, launchHour: 500, launchTs: 504, activationPoint: 512, cliffFee: 520, reduction: 528,
  periodFrequency: 536, nPeriods: 544, migrationQuoteThreshold: 552,
  ticks: 560, lastTickTs: 568, lastTickBar: 576, startHour: 580, lastSp: 584, lastFeeTotal: 600, cum: 608,
  ownFee: 616, ownRatio: 624, ownLamports: 632, lastAttemptBar: 640, blindUntilHour: 644,
  lastBoundaryHour: 648, recentLen: 652, lastBoundaryTs: 656, lastBoundaryCum: 664, refVol: 672, refSecs: 680,
  hourVolPrev: 688, recentBits: 696, lastRecordDay: 700, n: 704, hits: 708, ruleHits: 712, busierHours: 716,
  quieterCalls: 720, quieterHits: 724, forfeits: 728, notScored: 732,
  lastBuyHour: 736, buyDay: 740, lastBuyTs: 744, dayBuys: 752, hsReason: 756, hsDetail: 757,
  daySpent: 760, dayCap: 768, hsHour: 776, hsBought: 784, hsBurned: 792, hsHeld: 800,
  spent: 808, boughtUnits: 816, burned: 824, donated: 832, buys: 840, skips: 844, claimed: 848, lastMissedBar: 856,
  // graduation: the DAMM v2 pool DBC's migration made, Hunch's position in it, the curve's record kept
  dammPool: 864, dammConfig: 896, tokenAVault: 928, tokenBVault: 960, position: 992, positionNft: 1024, positionMint: 1056,
  lastLiquidity: 1088, adoptFeeFp: 1104, lastFeeFp: 1112, adoptFeeNum: 1120, surplus: 1128, poolClaimed: 1136,
  adoptTs: 1144, adoptHour: 1152, poolWarmEnd: 1156, prevN: 1160, prevHits: 1164, prevRuleHits: 1168, prevForfeits: 1172,
  prevNotScored: 1176, lastStatus: 1180, distCur: 1181, distPrev: 1182, gradLine: 1183,
  // the coin's ticker as initialize stored it: ASCII A-Z and 0-9, 1 to 10 characters, zero-padded to 16
  ticker: 1184,
  // the DBC config's migration_sqrt_price, pinned by adopt_curve (the review fix of 2026-10-16)
  migrationSqrtPrice: 1200,
};
export const TICKER_BYTES = 16;

// The open call (layout.rs `sig`).
export const SIG = {
  version: 8, phase: 9, call: 10, chapter: 11, lean: 12, lastOutcome: 14, flags: 15, hours: 16, unixHour: 20,
  madeSlot: 24, n: 32, hits: 36, ruleHits: 40, busierHours: 44, quieterCalls: 48, quieterHits: 52, forfeits: 56,
  luckBand: 60, mult: 62, brain: 64, budget: 72, plannedSlice: 80, spent: 88, burned: 96, buys: 104, skips: 108,
  poolFeeBps: 112, poolStatus: 114, prevN: 116, prevHits: 120, prevRuleHits: 124, rule: 128, came: 129, notScored: 132,
};

// Model (hunch-net `Model`, repr(C)), offsets inside the model account (after its 8-byte tag).
export const MD = {
  weights: 8, version: 688, t: 696, ts: 704, s: 712, emaLv: 720, emaLvH: 728, started: 736, chapter: 740,
  rHist: 744, lamHist: 776, volHist: 832, lvhHist: 936, xHist: 972,
};
const RING = {           // buf length, element size, then head and len (u32) right after the buffer
  rHist: [6, 4], lamHist: [6, 8], volHist: [12, 8], lvhHist: [7, 4], xHist: [7, 44],
};

// Meteora DBC VirtualPool fields (layout.rs `pool`).
export const POOL = {
  config: 72, creator: 104, baseMint: 136, baseVault: 168, quoteVault: 200, baseReserve: 232, quoteReserve: 240,
  sqrtPrice: 280, activationPoint: 296, poolType: 304, isMigrated: 305, totalProtocolQuoteFee: 320,
  totalTradingQuoteFee: 336, creatorQuoteFee: 360,
};

// ---------- readers ----------
function reader(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u8: (o) => v.getUint8(o),
    u16: (o) => v.getUint16(o, true),
    u32: (o) => v.getUint32(o, true),
    i32: (o) => v.getInt32(o, true),
    u64: (o) => v.getBigUint64(o, true),
    i64: (o) => v.getBigInt64(o, true),
    u128: (o) => v.getBigUint64(o, true) | (v.getBigUint64(o + 8, true) << 64n),
    key: (o) => base58(bytes.subarray(o, o + 32)),
    hex: (o, n) => toHex(bytes.subarray(o, o + n)),
  };
}
const num = (b) => Number(b);        // u64 counters that stay far below 2^53 (lamports, hours, slots)
const tagOf = (bytes) => String.fromCharCode(...bytes.subarray(0, 8));

export function fromBase64(text) {
  if (typeof atob === "function") {
    const s = atob(text), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

function expectTag(bytes, name, minLen) {
  if (!bytes || bytes.length < minLen) throw new Error(`${name}: ${bytes ? bytes.length : 0} bytes, expected ${minLen}`);
  if (tagOf(bytes) !== TAGS[name]) throw new Error(`${name}: tag ${JSON.stringify(tagOf(bytes))}, expected ${TAGS[name]}`);
}

// The ticker: the bytes before the first zero, which must pass the program's own rule (tickerOk).
export function decodeTicker(b, at = ST.ticker) {
  const raw = b.subarray(at, at + TICKER_BYTES), end = raw.indexOf(0);
  const text = String.fromCharCode(...raw.subarray(0, end < 0 ? TICKER_BYTES : end));
  if (!tickerOk(text)) throw new Error(`state: the ticker bytes are not 1 to 10 of A-Z and 0-9`);
  return text;
}

export function decodeState(b) {
  expectTag(b, "state", STATE_LEN);
  if (b.length !== STATE_LEN) throw new Error(`state: ${b.length} bytes, expected ${STATE_LEN} (this page reads the final program's layout only)`);
  const r = reader(b), o = ST;
  return {
    ticker: decodeTicker(b),
    version: r.u8(o.version), phase: r.u8(o.phase), chapter: r.u8(o.chapter), brainSource: r.u8(o.brainSource),
    lastOutcome: r.u8(o.lastOutcome), blind: r.u8(o.blind),
    mint: r.key(o.mint), pool: r.key(o.pool), config: r.key(o.config), budget: r.key(o.budget),
    budgetWsol: r.key(o.budgetWsol), budgetHunch: r.key(o.budgetHunch), model: r.key(o.model), tape: r.key(o.tape),
    signal: r.key(o.signal), diary: r.key(o.diary), book: r.key(o.book), brainHash: r.hex(o.brainHash, 32),
    seed: r.u32(o.seed), launchHour: r.u32(o.launchHour), launchTs: num(r.i64(o.launchTs)),
    activationPoint: num(r.u64(o.activationPoint)), migrationQuoteThreshold: r.u64(o.migrationQuoteThreshold),
    ticks: num(r.u64(o.ticks)), lastTickTs: num(r.i64(o.lastTickTs)), lastTickBar: r.u32(o.lastTickBar),
    startHour: r.u32(o.startHour), cum: r.u64(o.cum), lastAttemptBar: r.u32(o.lastAttemptBar),
    lastBoundaryHour: r.u32(o.lastBoundaryHour), hourVolPrev: r.u64(o.hourVolPrev), lastRecordDay: r.u32(o.lastRecordDay),
    n: r.u32(o.n), hits: r.u32(o.hits), ruleHits: r.u32(o.ruleHits), busierHours: r.u32(o.busierHours),
    quieterCalls: r.u32(o.quieterCalls), quieterHits: r.u32(o.quieterHits), forfeits: r.u32(o.forfeits), notScored: r.u32(o.notScored),
    lastBuyHour: r.u32(o.lastBuyHour), lastBuyTs: num(r.i64(o.lastBuyTs)), dayBuys: r.u32(o.dayBuys),
    hsReason: r.u8(o.hsReason), hsDetail: r.u8(o.hsDetail), daySpent: r.u64(o.daySpent), dayCap: r.u64(o.dayCap),
    hsHour: r.u32(o.hsHour), hsBought: r.u64(o.hsBought), hsBurned: r.u64(o.hsBurned), hsHeld: r.u64(o.hsHeld),
    spent: r.u64(o.spent), boughtUnits: r.u64(o.boughtUnits), burned: r.u64(o.burned), donated: r.u64(o.donated),
    buys: r.u32(o.buys), skips: r.u32(o.skips), claimed: r.u64(o.claimed), lastMissedBar: r.u32(o.lastMissedBar),
    blindUntilHour: r.u32(o.blindUntilHour), buyDay: r.u32(o.buyDay),
    // graduation (all zero until adopt_pool)
    dammPool: r.key(o.dammPool), dammConfig: r.key(o.dammConfig), tokenAVault: r.key(o.tokenAVault), tokenBVault: r.key(o.tokenBVault),
    position: r.key(o.position), positionNft: r.key(o.positionNft), positionMint: r.key(o.positionMint),
    lastLiquidity: r.u128(o.lastLiquidity), adoptFeeNum: r.u64(o.adoptFeeNum), surplus: r.u64(o.surplus), poolClaimed: r.u64(o.poolClaimed),
    adoptTs: num(r.i64(o.adoptTs)), adoptHour: r.u32(o.adoptHour), poolWarmEnd: r.u32(o.poolWarmEnd),
    prevN: r.u32(o.prevN), prevHits: r.u32(o.prevHits), prevRuleHits: r.u32(o.prevRuleHits), prevForfeits: r.u32(o.prevForfeits),
    prevNotScored: r.u32(o.prevNotScored), lastStatus: r.u8(o.lastStatus), distCur: r.u8(o.distCur), distPrev: r.u8(o.distPrev),
    gradLine: r.u8(o.gradLine), migrationSqrtPrice: r.u128(o.migrationSqrtPrice),
  };
}

export function decodeSignal(b) {
  expectTag(b, "signal", SIGNAL_LEN);
  const r = reader(b), o = SIG;
  return {
    version: r.u8(o.version), phase: r.u8(o.phase), call: r.u8(o.call), chapter: r.u8(o.chapter), lean: r.u16(o.lean),
    lastOutcome: r.u8(o.lastOutcome), flags: r.u8(o.flags), hours: r.u32(o.hours), unixHour: r.u32(o.unixHour),
    madeSlot: num(r.u64(o.madeSlot)), n: r.u32(o.n), hits: r.u32(o.hits), ruleHits: r.u32(o.ruleHits),
    busierHours: r.u32(o.busierHours), quieterCalls: r.u32(o.quieterCalls), quieterHits: r.u32(o.quieterHits),
    forfeits: r.u32(o.forfeits), luckBand: r.u16(o.luckBand), mult: r.u8(o.mult), brain: r.hex(o.brain, 8),
    budget: r.u64(o.budget), plannedSlice: r.u64(o.plannedSlice), spent: r.u64(o.spent), burned: r.u64(o.burned),
    buys: r.u32(o.buys), skips: r.u32(o.skips), poolFeeBps: r.u16(o.poolFeeBps), poolStatus: r.u8(o.poolStatus),
    prevN: r.u32(o.prevN), prevHits: r.u32(o.prevHits), prevRuleHits: r.u32(o.prevRuleHits),
    rule: r.u8(o.rule), came: r.u8(o.came), notScored: r.u32(o.notScored),
  };
}

// One diary entry (layout.rs `Entry`), in the shape core/chain.js diaryLine() reads.
export function decodeEntry(b, at = 0) {
  const r = reader(b.subarray(at, at + DIARY_ENTRY));
  const brain4 = b.slice(at + 56, at + 60);
  return {
    hour: r.u32(0), unixHour: r.u32(4), slot: num(r.u64(8)), call: r.u8(16), outcome: r.u8(17), lean: r.u16(18),
    n: r.u32(20), hits: r.u32(24), ruleHits: r.u32(28), nextLean: r.u16(32), nextCall: r.u8(34), phase: r.u8(35),
    chapter: r.u8(36), detail: r.u8(37), flags: r.u16(38), bought: r.u64(40), burned: r.u64(48),
    brain4, brain8: toHex(brain4), held: r.u32(60),
  };
}

// A ring of `cap` entries after a header (tag, head u32 = next write, count u32, ...): oldest first.
function ring(b, header, size, cap, decode) {
  const r = reader(b), head = r.u32(8) % cap, count = Math.min(r.u32(12), cap), out = [];
  for (let k = 0; k < count; k++) {
    const i = (head - count + k + cap) % cap;
    out.push(decode(b, header + i * size));
  }
  return out;
}

// `ticker`: the one the program stores (State.ticker), so each line reads as the program's memo did.
export function decodeDiary(b, ticker = "HUNCH") {
  expectTag(b, "diary", DIARY_LEN);
  const entries = ring(b, DIARY_HEADER, DIARY_ENTRY, DIARY_ENTRIES, decodeEntry);
  for (const e of entries) e.line = diaryLine(e, ticker);
  return { total: num(reader(b).u64(16)), entries };
}

export function decodeTapeEntry(b, at) {
  const r = reader(b.subarray(at, at + TAPE_ENTRY));
  return {
    bar: r.u32(0), sec: r.u8(4), utcHour: r.u8(5), flags: r.u16(6), sqrtPrice: r.u128(8), cum: r.u64(24),
    ret: r.i32(32), feeBps: r.u16(36), status: r.u8(38), own: r.u64(40),
  };
}
export function decodeTape(b) {
  expectTag(b, "tape", TAPE_LEN);
  return { entries: ring(b, TAPE_HEADER, TAPE_ENTRY, TAPE_ENTRIES, decodeTapeEntry) };
}

// The brain book: one record per UTC day since launch (only days with a landed tick are written).
export function decodeBook(b) {
  expectTag(b, "book", BOOK_HEADER);
  const r = reader(b), launchDay = r.u32(8), capacity = r.u32(12), written = r.u32(16), records = [];
  for (let i = 0; i < capacity && BOOK_HEADER + (i + 1) * BOOK_RECORD <= b.length; i++) {
    const at = BOOK_HEADER + i * BOOK_RECORD, q = reader(b.subarray(at, at + BOOK_RECORD));
    const unixTime = num(q.i64(16));
    if (!unixTime) continue;                 // a day nobody ticked
    records.push({
      day: q.u16(0), chapter: q.u8(2), phase: q.u8(3), hour: q.u32(4), slot: num(q.u64(8)), unixTime,
      n: q.u32(24), hits: q.u32(28), hash: toHex(b.subarray(at + 32, at + 64)),
    });
  }
  return { launchDay, capacity, written, records };
}

function ringOf(r, at, [cap, size], read) {
  const head = r.u32(at + cap * size), len = r.u32(at + cap * size + 4), out = [];
  for (let k = 0; k < Math.min(len, cap); k++) out.push(read(at + ((head + k) % cap) * size));
  return out;
}

// The network and its feature tape, in place.
export function decodeModel(b) {
  expectTag(b, "model", MODEL_LEN);
  const r = reader(b), o = MD;
  const weights = new Int32Array(N_WEIGHTS_V1);
  for (let k = 0; k < N_WEIGHTS_V1; k++) weights[k] = r.i32(o.weights + 4 * k);
  const slots = ringOf(r, o.xHist, RING.xHist, (at) => {
    if (!r.u32(at)) return null;
    return Array.from({ length: 10 }, (_, i) => r.i32(at + 4 + 4 * i));
  });
  const vols = ringOf(r, o.volHist, RING.volHist, (at) => r.u64(at));
  return {
    weights,
    weightBytes: b.slice(o.weights, o.weights + N_WEIGHTS_V1 * 4),
    hash: toHex(sha256(b.subarray(o.weights, o.weights + N_WEIGHTS_V1 * 4))),
    version: num(r.u64(o.version)), t: num(r.i64(o.t)), ts: num(r.i64(o.ts)), chapter: r.u32(o.chapter),
    x: slots.length ? slots[slots.length - 1] : null,     // this bar's inputs (null: none yet)
    // the sample the last step learned from: inputs 6 bars back, and the 6 bars before and after it
    sample: slots.length === 7 && vols.length === 12 ? {
      x: slots[0],
      lastVol: vols.slice(0, 6).reduce((a, v) => a + v, 0n),
      nextVol: vols.slice(6).reduce((a, v) => a + v, 0n),
      bars: vols,
    } : null,
  };
}

export function decodePool(b) {
  if (!b || b.length !== POOL_LEN) throw new Error(`pool: ${b ? b.length : 0} bytes, expected ${POOL_LEN}`);
  const r = reader(b), o = POOL;
  return {
    config: r.key(o.config), creator: r.key(o.creator), baseMint: r.key(o.baseMint),
    baseReserve: r.u64(o.baseReserve), quoteReserve: r.u64(o.quoteReserve), sqrtPrice: r.u128(o.sqrtPrice),
    activationPoint: num(r.u64(o.activationPoint)), isMigrated: r.u8(o.isMigrated),
    creatorQuoteFee: r.u64(o.creatorQuoteFee),
  };
}

// SPL Token account amount (offset 64) and mint supply (36) and decimals (44).
export const tokenAmount = (b) => (b && b.length >= 72 ? reader(b).u64(64) : null);
export const mintOf = (b) => (b && b.length >= 82 ? { supply: reader(b).u64(36), decimals: reader(b).u8(44) } : null);

// Upgradeable loader: the program account names its ProgramData, which names the upgrade authority.
export function decodeProgramData(b) {
  if (!b || b.length < 45 || reader(b).u32(0) !== 3) return null;
  const r = reader(b);
  return { slot: num(r.u64(4)), authority: r.u8(12) === 1 ? r.key(13) : null };
}

// ---------- the whole snapshot the reader returns (api/state.js) ----------
// `resp`: { slot, at, addresses, accounts: { name: { owner, lamports, data (base64) } | null }, programData }
export function decodeSnapshot(resp) {
  const A = resp.accounts ?? {}, bytes = (k) => (A[k]?.data ? fromBase64(A[k].data) : null);
  const errors = [];
  const safe = (name, f) => { try { return f(); } catch (e) { errors.push(e.message.startsWith(`${name}:`) ? e.message : `${name}: ${e.message}`); return null; } };
  const owned = (k) => A[k] && A[k].owner === resp.addresses.program;
  for (const k of ["state", "signal", "diary", "model", "book", "tape"]) {
    if (!A[k]) errors.push(`${k}: no account`);
    else if (!owned(k)) errors.push(`${k}: not owned by the program`);
  }
  const state = owned("state") ? safe("state", () => decodeState(bytes("state"))) : null;
  const s = {
    slot: resp.slot, at: resp.at, addresses: resp.addresses,
    state,
    signal: owned("signal") ? safe("signal", () => decodeSignal(bytes("signal"))) : null,
    // the diary's lines name the coin as the program does; without a readable state, nothing is shown
    diary: state && owned("diary") ? safe("diary", () => decodeDiary(bytes("diary"), state.ticker)) : null,
    model: owned("model") ? safe("model", () => decodeModel(bytes("model"))) : null,
    book: owned("book") ? safe("book", () => decodeBook(bytes("book"))) : null,
    tape: owned("tape") ? safe("tape", () => decodeTape(bytes("tape"))) : null,
    pool: A.pool ? safe("pool", () => decodePool(bytes("pool"))) : null,
    held: A.budgetWsol ? tokenAmount(bytes("budgetWsol")) : null,
    hunchHeld: A.budgetHunch ? tokenAmount(bytes("budgetHunch")) : null,
    mint: A.mint ? mintOf(bytes("mint")) : null,
    programData: resp.programData?.data ? decodeProgramData(fromBase64(resp.programData.data)) : null,
    errors,
  };
  // the state names its own accounts: they must be the ones read
  if (s.state) {
    for (const k of ["signal", "diary", "model", "book", "tape", "pool", "mint"]) {
      if (s.state[k] !== resp.addresses[k] && !(k === "pool" && s.state.phase === PHASE.SETUP)) errors.push(`${k}: the state names ${s.state[k]}`);
    }
  }
  return s;
}

// ---------- words shared by the live views ----------
export const sideWord = (c) => (c === CALL.BUSIER ? "busier" : c === CALL.QUIETER ? "quieter" : null);
// "56/44": the lean toward the called side first (as core/chain.js writes it)
export function leanPair(call, lean) {
  const busier = Math.floor((lean + 50) / 100);
  return call === CALL.BUSIER ? `${busier}/${100 - busier}` : `${100 - busier}/${busier}`;
}
export const leansText = (call, lean) => (sideWord(call) ? `leans ${sideWord(call)} ${leanPair(call, lean)}` : "no call");
// The coin flip's 95% band as percentages: 50 +- 9800/sqrt(n) basis points.
export function flipBand(n) {
  if (!n) return null;
  const half = luckBandBps(n) / 100;
  return { lo: 50 - half, hi: 50 + half, half };
}
export const PHASE_WORD = ["set up", "curve", "graduating", "pool", "blind"];
