// Hunch's program as seen from JavaScript: its addresses, its instructions (the account lists of
// programs/hunch/src/processor.rs, one for one), the few fields the tools read from its accounts and
// from Meteora DBC's, and the exact checks adopt_curve makes on a DBC config. Shared by the crank
// (crank.mjs), the launch tool (hunch/launch/launch.mjs) and hunch/scripts/init-hunch.mjs.
//
// If the program's instruction accounts or State layout change, this file changes with them. The
// tools never depend on State offsets for safety: every send is simulated first, and a State whose size
// is not STATE_LEN is reported and not decoded. The layout is hunch/design/layout-final.md (the build of
// 2026-10-16 evening, ~/hunch-target/final/hunch.so, sha256 face57dd...0f0f).

import { web3 } from "./deps.mjs";
import { format } from "node:util";

const { PublicKey, TransactionInstruction, SystemProgram, ComputeBudgetProgram, Transaction } = web3;

// ---------------------------------------------------------------- addresses
export const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const DBC_EVENT_AUTHORITY = new PublicKey("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
export const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
export const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
export const SYSTEM = SystemProgram.programId;

export const TAG = { INITIALIZE: 0, LOAD_BRAIN: 1, ADOPT_CURVE: 2, TICK: 3, BUY_AND_BURN_CURVE: 4, CLAIM_CURVE_FEES: 5, READ_CALL: 6, GROW_BRAIN_BOOK: 7 };
export const PHASE_NAME = ["setup", "curve", "graduating", "pool", "blind"];
export const PHASE = { SETUP: 0, CURVE: 1, GRADUATING: 2, POOL: 3, BLIND: 4 };

// programs/hunch/src/ids.rs, mod err
export const ERR = {
  1: "CALLED_BY_CPI", 2: "NOT_ALONE", 3: "NOT_TOP_LEVEL", 4: "WRONG_ACCOUNT", 6: "NOT_AUTHORITY", 7: "ALREADY_INITIALIZED",
  8: "WRONG_PHASE", 9: "POOL_MISMATCH", 10: "CONFIG_MISMATCH", 11: "OUTSIDE_WINDOW", 12: "ALREADY_TICKED", 13: "TOO_EARLY",
  14: "NO_BOUNDARY_THIS_HOUR", 15: "ALREADY_BOUGHT_THIS_HOUR", 16: "TOO_SOON", 17: "CURVE_COMPLETE", 18: "PRICE_MOVED_TOO_MUCH",
  19: "BAD_BRAIN", 20: "BOOK_HAS_ROOM", 21: "BLIND", 22: "MATH", 23: "NOT_EVENT_AUTHORITY",
};

// programs/hunch/src/rules.rs: the bar, the hour, the day, and the compiled DBC config values.
export const BAR = 600, HOUR = 3600, DAY = 86400;
export const OPENING_SECONDS = 5;
export const COMPILED = {
  cliffFeeNumerator: 500_000_000n, // 50% at the open ...
  numberOfPeriod: 5, periodFrequency: 1n, reductionFactor: 92_500_000n, // ... down 9.25 points a second ...
  endingFeeNumerator: 37_500_000n, // ... to 3.75%
  baseFeeModeLinear: 0, collectFeeModeQuote: 0, activationTimestamp: 1, migrationDammV2: 1, migrationFeeCustomizable: 6,
  migratedPoolFeeBps: 375, creatorTradingFeePct: 33, partnerLockedPct: 67, creatorLockedPct: 33, tokenUpdateImmutable: 1,
  tokenTypeSpl: 0, tokenDecimals: 6,
};
// State is 1,248 bytes in the final layout (design/layout-final.md); a State of any other size is not read.
export const STATE_LEN = 1248;
export const BOOK_GROW_BELOW = 30;
// The buy's rate limit (rules.rs BUY_GAP): a buy at least 30 minutes after the previous one.
export const BUY_GAP = 1800;
// Why a buy waited (rules.rs, mod skip): State's hs_reason, the wait event's reason.
export const SKIP_NAME = ["NONE", "BELOW_MIN", "GUARD", "STALE", "VOLUME_CAP", "DAY_CAP", "IMPACT_CAP"];
export const SKIP = { NONE: 0, BELOW_MIN: 1, GUARD: 2, STALE: 3, VOLUME_CAP: 4, DAY_CAP: 5, IMPACT_CAP: 6 };
// The ticker rule (layout.rs ticker_ok): 1 to 10 characters, A-Z and 0-9 only; anything else is BAD_TICKER.
export const tickerOk = (t) => typeof t === "string" && /^[A-Z0-9]{1,10}$/.test(t);

// ---------------------------------------------------------------- what is never printed
// The RPC address carries its key. Once known it is taken out of everything printed, by anyone.
let secrets = [];
export const hide = (text) => secrets.reduce((shown, secret) => shown.split(secret).join("<hidden>"), String(text));
export function keepSecret(address) {
  if (!address) return;
  const parts = [address];
  try {
    const url = new URL(address);
    parts.push(url.href, url.host + url.pathname + url.search, url.host, url.username, url.password, ...url.searchParams.values(), ...url.pathname.split("/"));
  } catch { /* not a URL: the text itself is still hidden */ }
  const worth = (p) => p && p.length >= 10 && !["mainnet-beta", "mainnet", "devnet", "testnet", "127.0.0.1:8899", "localhost:8899"].includes(p);
  secrets = [...new Set([...secrets, ...parts.filter(worth)])].sort((a, b) => b.length - a.length);
  for (const name of ["log", "info", "warn", "error"]) {
    if (console[name].hides) continue;
    const real = console[name].bind(console);
    console[name] = Object.assign((...args) => real(hide(format(...args))), { hides: true });
  }
}
export const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(url ?? "");

// ---------------------------------------------------------------- addresses of Hunch's accounts
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), program);
export const ataOf = (owner, mint) => pda([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];

export function addresses(programId) {
  const program = new PublicKey(programId);
  const [state, bState] = pda(["state"], program);
  const [model, bModel] = pda(["model"], program);
  const [tape, bTape] = pda(["tape"], program);
  const [signal, bSignal] = pda(["signal"], program);
  const [diary, bDiary] = pda(["diary"], program);
  const [book, bBook] = pda(["brains"], program);
  const [budget, bBudget] = pda(["budget"], program);
  const [eventAuthority, bEvent] = pda(["__event_authority"], program);
  const [programdata, bProgramdata] = pda([program.toBuffer()], LOADER_V3);
  return {
    program, state, model, tape, signal, diary, book, budget, eventAuthority, programdata,
    budgetWsol: ataOf(budget, WSOL),
    bumps: [bProgramdata, bState, bModel, bTape, bSignal, bDiary, bBook, bBudget, bEvent],
  };
}

// ---------------------------------------------------------------- instructions
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const signer = (pubkey, writable = true) => ({ pubkey, isSigner: true, isWritable: writable });

/** initialize(mint, seed, bumps, ticker): once, signed by the program's upgrade authority, who pays the
 *  rent. The data is exactly 47 + n bytes: the 46-byte head (tag, mint, seed, the nine bumps), then the
 *  ticker's length n and its n characters. A ticker the program would refuse with BAD_TICKER (not 1 to 10
 *  of A-Z and 0-9) is refused here, before anything is built; the program refuses the old 46-byte data. */
export function initializeIx(a, authority, mint, seed, ticker) {
  if (!tickerOk(ticker)) throw new Error(`initialize: the ticker ${JSON.stringify(ticker ?? null)} is not 1 to 10 characters of A-Z and 0-9`);
  const tail = Buffer.concat([Buffer.from([ticker.length]), Buffer.from(ticker, "latin1")]);
  const data = Buffer.alloc(1 + 32 + 4 + 9 + tail.length);
  data[0] = TAG.INITIALIZE;
  new PublicKey(mint).toBuffer().copy(data, 1);
  data.writeUInt32LE(seed >>> 0, 33);
  Buffer.from(a.bumps).copy(data, 37);
  tail.copy(data, 46);
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      signer(authority), r(a.programdata), w(a.state), w(a.model), w(a.tape), w(a.signal), w(a.diary), w(a.book),
      r(a.budget), w(a.budgetWsol), r(WSOL), r(SYSTEM), r(TOKEN), r(ATA), r(a.eventAuthority),
    ],
    data,
  });
}

/** adopt_curve(): anyone, once, after the pool exists; the payer pays the budget's HUNCH account. */
export function adoptCurveIx(a, payer, pool) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      signer(payer), w(a.state), w(a.signal), w(a.book), r(pool.pool), r(pool.config), r(pool.mint), r(a.budget),
      w(ataOf(a.budget, pool.mint)), r(SYSTEM), r(TOKEN), r(ATA),
    ],
    data: Buffer.from([TAG.ADOPT_CURVE]),
  });
}

/** tick(): anyone, top level and alone (ComputeBudget aside), once per bar inside the bar's window. */
export function tickIx(a, pool) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      w(a.state), w(a.model), w(a.tape), w(a.signal), w(a.diary), w(a.book), r(pool.pool), r(a.budgetWsol),
      r(SYSVAR_INSTRUCTIONS), r(MEMO), r(a.eventAuthority), r(a.program),
    ],
    data: Buffer.from([TAG.TICK]),
  });
}

/** buy_and_burn_curve(): anyone, top level and alone, once per UTC hour after that hour's boundary tick. */
export function buyAndBurnCurveIx(a, pool) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      w(a.state), w(a.signal), r(a.tape), r(a.budget), w(a.budgetWsol), w(ataOf(a.budget, pool.mint)), w(pool.mint), r(WSOL),
      w(pool.pool), r(pool.config), w(pool.baseVault), w(pool.quoteVault), r(DBC_POOL_AUTHORITY), r(DBC_EVENT_AUTHORITY),
      r(DBC), r(TOKEN), r(SYSVAR_INSTRUCTIONS), r(a.eventAuthority), r(a.program),
    ],
    data: Buffer.from([TAG.BUY_AND_BURN_CURVE]),
  });
}

/** claim_curve_fees(): anyone, any time after adoption: the creator fee into the budget's WSOL account. */
export function claimCurveFeesIx(a, pool) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      w(a.state), r(a.budget), w(a.budgetWsol), w(ataOf(a.budget, pool.mint)), r(pool.mint), r(WSOL), w(pool.pool), r(pool.config),
      w(pool.baseVault), w(pool.quoteVault), r(DBC_POOL_AUTHORITY), r(DBC_EVENT_AUTHORITY), r(DBC), r(TOKEN),
    ],
    data: Buffer.from([TAG.CLAIM_CURVE_FEES]),
  });
}

/** grow_brain_book(): anyone (the payer pays the rent of 92 more daily records) when fewer than 30 remain. */
export function growBrainBookIx(a, payer) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [signer(payer), r(a.state), w(a.book), r(SYSTEM)],
    data: Buffer.from([TAG.GROW_BRAIN_BOOK]),
  });
}

/** read_call(): the 160-byte open call as return data. */
export function readCallIx(a) {
  return new TransactionInstruction({ programId: a.program, keys: [r(a.signal), r(SYSVAR_INSTRUCTIONS)], data: Buffer.from([TAG.READ_CALL]) });
}

// ---------------------------------------------------------------- the graduation path
// The account lists of withdraw_surplus (8), adopt_pool (9), buy_and_burn_pool (10) and
// claim_pool_fees (11), as programs/hunch/src/processor.rs has them (the build of 2026-10-16, run end to
// end on a local validator with DBC 0.2.2 and DAMM v2's mainnet bytecode by test/graduation-e2e.sh).
export const DAMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const DAMM_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
Object.assign(TAG, { WITHDRAW_SURPLUS: 8, ADOPT_POOL: 9, BUY_AND_BURN_POOL: 10, CLAIM_POOL_FEES: 11 });
Object.assign(ERR, { 24: "NOT_MIGRATED", 25: "OUTSIDE_POOL", 26: "NOT_OUR_POSITION", 27: "POOL_PAUSED" });
// the build of 2026-10-16 evening: a second wait in an hour is refused; initialize checks the ticker; the
// pool buy is refused while Meteora's fee is above the fee at adoption
Object.assign(ERR, { 28: "ALREADY_WAITED_THIS_HOUR", 29: "BAD_TICKER", 30: "FEE_RAISED" });
/** The DAMM v2 configs DBC's migration uses, by migration fee option (the DBC SDK 1.5.13's
 *  DAMM_V2_MIGRATION_FEE_ADDRESS: FixedBps25, 30, 100, 200, 400, 600, Customizable). Hunch's config is
 *  Customizable, so its pool is made from the last one. */
export const DAMM_MIGRATION_CONFIGS = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd", "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k", "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq", "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD", "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u",
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
].map((k) => new PublicKey(k));
/** DAMM v2's addresses: a pool made from a config, ["pool", config, max(a, b), min(a, b)]; a position
 *  and its NFT account, from the NFT's mint. */
export function dammPoolAddress(config, mintA, mintB) {
  const [hi, lo] = Buffer.compare(new PublicKey(mintA).toBuffer(), new PublicKey(mintB).toBuffer()) > 0 ? [mintA, mintB] : [mintB, mintA];
  return pda(["pool", new PublicKey(config).toBuffer(), new PublicKey(hi).toBuffer(), new PublicKey(lo).toBuffer()], DAMM)[0];
}
export const dammPositionOf = (nftMint) => pda(["position", new PublicKey(nftMint).toBuffer()], DAMM)[0];
export const dammNftAccountOf = (nftMint) => pda(["position_nft_account", new PublicKey(nftMint).toBuffer()], DAMM)[0];

/** withdraw_surplus(): anyone, once, after the curve completes: DBC's surplus into the budget's WSOL. */
export function withdrawSurplusIx(a, st) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [w(a.state), r(a.budget), w(a.budgetWsol), r(WSOL), w(st.pool), r(st.config), w(st.quoteVault), r(DBC_POOL_AUTHORITY), r(DBC_EVENT_AUTHORITY), r(DBC), r(TOKEN)],
    data: Buffer.from([TAG.WITHDRAW_SURPLUS]),
  });
}

/** adopt_pool(): anyone, once, after DBC migrated the curve into DAMM v2. */
export function adoptPoolIx(a, st, c) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [w(a.state), w(a.signal), r(st.pool), r(c.dammPool), r(c.dammConfig), r(c.position), r(c.nftAccount), r(a.budget)],
    data: Buffer.from([TAG.ADOPT_POOL]),
  });
}

/** buy_and_burn_pool(): the hourly buy on the adopted DAMM v2 pool (addresses from State). */
export function buyAndBurnPoolIx(a, st) {
  const g = st.graduation;
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      w(a.state), w(a.signal), r(a.tape), r(a.budget), w(a.budgetWsol), w(ataOf(a.budget, st.mint)), w(st.mint), r(WSOL),
      w(g.dammPool), r(DAMM_POOL_AUTHORITY), w(g.tokenAVault), w(g.tokenBVault), w(g.position), r(g.positionNft),
      r(DAMM_EVENT_AUTHORITY), r(DAMM), r(TOKEN), r(SYSVAR_INSTRUCTIONS), r(a.eventAuthority), r(a.program),
    ],
    data: Buffer.from([TAG.BUY_AND_BURN_POOL]),
  });
}

/** claim_pool_fees(): anyone, any time in the pool phase: the adopted position's fees into the budget's
 *  WSOL account (buy_and_burn_pool claims too; this keeps the budget the boundary tick reads current). */
export function claimPoolFeesIx(a, st) {
  const g = st.graduation;
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      w(a.state), r(a.budget), w(a.budgetWsol), w(ataOf(a.budget, st.mint)), r(st.mint), r(WSOL), r(g.dammPool), r(DAMM_POOL_AUTHORITY),
      w(g.tokenAVault), w(g.tokenBVault), w(g.position), r(g.positionNft), r(DAMM_EVENT_AUTHORITY), r(DAMM), r(TOKEN),
    ],
    data: Buffer.from([TAG.CLAIM_POOL_FEES]),
  });
}

/** The pool tick() reads: DBC's curve until adoption of the DAMM v2 pool, then that pool. */
export const tickPoolOf = (st) => (st.phase === PHASE.POOL && st.graduation ? { pool: st.graduation.dammPool } : { pool: st.pool });

/** Every (pool, config, position, NFT account) adopt_pool could be given for this token, found without
 *  getProgramAccounts: the position NFTs (Token-2022) the budget PDA holds, the DAMM v2 position each
 *  NFT's mint derives, the pool that position is in, and the DBC migration config that pool's address
 *  derives from (with HUNCH and WSOL). The program makes every check again; the crank simulates first.
 *  Only when no known config matches (Meteora added one) does it ask for DAMM v2's configs whose pool
 *  creator is DBC's pool authority, which needs an RPC that serves getProgramAccounts. */
export async function adoptPoolCandidates(connection, a, st) {
  const nfts = (await connection.getTokenAccountsByOwner(a.budget, { programId: TOKEN_2022 })).value
    .map((n) => ({ account: n.pubkey, mint: new PublicKey(n.account.data.subarray(0, 32)), amount: n.account.data.readBigUInt64LE(64) }))
    .filter((n) => n.amount === 1n);
  if (!nfts.length) return [];
  const positions = nfts.map((n) => dammPositionOf(n.mint));
  const infos = await connection.getMultipleAccountsInfo(positions);
  const out = [];
  let configs = DAMM_MIGRATION_CONFIGS;
  let askedForConfigs = false;
  for (const [i, info] of infos.entries()) {
    if (!info || !info.owner.equals(DAMM) || info.data.length !== 408) continue;
    const pos = decodePosition(info.data);
    let config = configs.find((c) => dammPoolAddress(c, st.mint, WSOL).equals(pos.pool));
    if (!config && !askedForConfigs) {
      askedForConfigs = true;
      const more = await connection.getProgramAccounts(DAMM, {
        filters: [{ dataSize: 328 }, { memcmp: { offset: 40, bytes: DBC_POOL_AUTHORITY.toBase58() } }],
        dataSlice: { offset: 0, length: 0 },
      });
      configs = [...configs, ...more.map((m) => m.pubkey)];
      config = configs.find((c) => dammPoolAddress(c, st.mint, WSOL).equals(pos.pool));
    }
    if (!config) continue;
    out.push({ dammPool: pos.pool, dammConfig: config, position: positions[i], nftAccount: nfts[i].account, locked: pos.permanentLocked });
  }
  // the largest locked share first (the creator's 33%; an outsider's position in the same pool is smaller)
  return out.sort((x, y) => (y.locked > x.locked ? 1 : y.locked < x.locked ? -1 : 0));
}

/** Meteora DBC transfer_pool_creator, built by hand (the SDK helper reads the pool first, so it cannot
 *  be built before the pool exists). Accounts and discriminator as the SDK 1.5.13 IDL has them
 *  (sha256("global:transfer_pool_creator")[..8]): virtual_pool (w), config, creator (signer),
 *  new_creator, event_authority, program. The launch tool checks it equals the SDK's own builder. */
export const TRANSFER_POOL_CREATOR_DISC = Buffer.from([20, 7, 169, 33, 58, 147, 166, 33]);
export function transferPoolCreatorIx({ pool, config, creator, newCreator }) {
  return new TransactionInstruction({
    programId: DBC,
    keys: [w(pool), r(config), signer(creator, false), r(newCreator), r(DBC_EVENT_AUTHORITY), r(DBC)],
    data: TRANSFER_POOL_CREATOR_DISC,
  });
}

// ---------------------------------------------------------------- reading accounts
const u32 = (d, o) => d.readUInt32LE(o);
const u64 = (d, o) => d.readBigUInt64LE(o);
const i64 = (d, o) => d.readBigInt64LE(o);
const key = (d, o) => new PublicKey(d.subarray(o, o + 32));

export function decodeClock(d) {
  return { slot: Number(u64(d, 0)), epoch: Number(u64(d, 16)), unixTimestamp: Number(i64(d, 32)) };
}

/** The State fields the tools show, at the offsets of design/layout-final.md (programs/hunch/src/layout.rs
 *  State, 1,248 bytes): the stage-2 fields (0 to 863), the graduation fields (864 to 1,183), the ticker
 *  (1,184) and the migration sqrt price adopt_curve pins (1,200). A State of any other size (the
 *  920-byte stage-2 layout, say) is not decoded: null. */
export const STATE_LEN_POOL = STATE_LEN; // the name the graduation tools used for the 1,248-byte layout
export function decodeState(d) {
  if (!d || d.length !== STATE_LEN || d.subarray(0, 8).toString() !== "HUNCHSTA") return null;
  const pool = {
    dammPool: key(d, 864), dammConfig: key(d, 896), tokenAVault: key(d, 928), tokenBVault: key(d, 960),
    position: key(d, 992), positionNft: key(d, 1024), positionMint: key(d, 1056), adoptFeeNum: u64(d, 1120), adoptTs: Number(i64(d, 1144)),
    adoptHour: u32(d, 1152), poolWarmEnd: u32(d, 1156), prevN: u32(d, 1160), prevHits: u32(d, 1164),
  };
  // the ticker (16 bytes at 1,184, zero-padded)
  const tick = d.subarray(1184, 1200);
  const tickerEnd = tick.indexOf(0) < 0 ? tick.length : tick.indexOf(0);
  return {
    length: d.length, graduation: pool, ticker: tickerEnd ? tick.subarray(0, tickerEnd).toString("latin1") : null,
    // the DBC config's migration sqrt price, pinned by adopt_curve (0 before it); adopt_pool's bar uses it
    migrationSqrtPrice: u128(d, 1200),
    // what creator_withdraw_surplus and the position's fee claims paid into the budget
    surplus: u64(d, 1128), poolClaimed: u64(d, 1136),
    version: d[8], phase: d[9], chapter: d[10], brainSource: d[11],
    mint: key(d, 16), pool: key(d, 48), config: key(d, 80), baseVault: key(d, 112), quoteVault: key(d, 144),
    budget: key(d, 176), budgetWsol: key(d, 208), budgetHunch: key(d, 240), book: key(d, 400),
    seed: u32(d, 496), launchHour: u32(d, 500), launchTs: Number(i64(d, 504)), activationPoint: Number(u64(d, 512)),
    migrationQuoteThreshold: u64(d, 552),
    ticks: Number(u64(d, 560)), lastTickTs: Number(i64(d, 568)), lastTickBar: u32(d, 576),
    lastAttemptBar: u32(d, 640), lastBoundaryHour: u32(d, 648),
    n: u32(d, 704), hits: u32(d, 708), ruleHits: u32(d, 712), forfeits: u32(d, 728),
    lastBuyHour: u32(d, 736), lastBuyTs: Number(i64(d, 744)), hsReason: d[756], hsDetail: d[757], hsHour: u32(d, 776),
    spent: u64(d, 808), burned: u64(d, 824), buys: u32(d, 840), skips: u32(d, 844), claimed: u64(d, 848),
  };
}

/** The open call (160 bytes at the published offsets). */
export function decodeSignal(d) {
  if (!d || d.length < 160 || d.subarray(0, 8).toString() !== "HUNCHCAL") return null;
  return {
    phase: d[9], call: d[10], chapter: d[11], lean: d.readUInt16LE(12), flags: d[15], unixHour: u32(d, 20),
    n: u32(d, 32), hits: u32(d, 36), ruleHits: u32(d, 40), forfeits: u32(d, 56), budget: u64(d, 72), plannedSlice: u64(d, 80),
    spent: u64(d, 88), burned: u64(d, 96), buys: u32(d, 104), skips: u32(d, 108),
  };
}

/** The brain book's header: launch day, capacity (records), length. */
export function decodeBook(d) {
  if (!d || d.length < 32 || d.subarray(0, 8).toString() !== "HUNCHBRN") return null;
  return { launchDay: u32(d, 8), capacity: u32(d, 12), length: d.length };
}

/** A Meteora DBC VirtualPool (424 bytes, unchanged in 0.2.2). */
export function decodePool(d) {
  if (!d || d.length !== 424) return null;
  return {
    config: key(d, 72), creator: key(d, 104), baseMint: key(d, 136), baseVault: key(d, 168), quoteVault: key(d, 200),
    baseReserve: u64(d, 232), quoteReserve: u64(d, 240), sqrtPrice: d.readBigUInt64LE(280) | (d.readBigUInt64LE(288) << 64n),
    activationPoint: Number(u64(d, 296)), poolType: d[304], isMigrated: d[305], migrationProgress: d[308],
    // DBC's own record that creator_withdraw_surplus ran (the same flag DBC checks to refuse a second)
    creatorWithdrewSurplus: d[310], creatorQuoteFee: u64(d, 360),
  };
}

const u128 = (d, o) => u64(d, o) | (u64(d, o + 8) << 64n);
const u256 = (d, o) => u128(d, o) | (u128(d, o + 16) << 128n);

/** A Meteora DAMM v2 Pool (1,112 bytes; the offsets of programs/hunch/src/layout.rs `damm`, and
 *  fee_b_per_liquidity from cp-amm's Pool). */
export function decodeDammPool(d) {
  if (!d || d.length !== 1112) return null;
  return {
    // the base fee's cliff numerator (1e9 = 100%) and whether a dynamic fee is on: what FEE_RAISED compares
    cliffFeeNumerator: u64(d, 8), dynamicFee: d[56],
    tokenAMint: key(d, 168), tokenBMint: key(d, 200), tokenAVault: key(d, 232), tokenBVault: key(d, 264), liquidity: u128(d, 360),
    sqrtPrice: u128(d, 456), status: d[481], collectFeeMode: d[484], feeBPerLiquidity: u256(d, 520), permanentLock: u128(d, 552),
    totalLpBFee: u128(d, 584), totalProtocolBFee: u64(d, 608), creator: key(d, 648),
  };
}

/** A Meteora DAMM v2 Position (408 bytes). */
export function decodePosition(d) {
  if (!d || d.length !== 408) return null;
  return {
    pool: key(d, 8), nftMint: key(d, 40), feeBCheckpoint: u256(d, 104), feeBPending: u64(d, 144),
    unlocked: u128(d, 152), vested: u128(d, 168), permanentLocked: u128(d, 184), totalClaimedB: u64(d, 208),
  };
}

// The same offsets as programs/hunch/src/layout.rs `config`.
const C = {
  QUOTE_MINT: 8, FEE_CLAIMER: 40, LEFTOVER_RECEIVER: 72, CLIFF_FEE_NUMERATOR: 104, SECOND_FACTOR: 112, THIRD_FACTOR: 120,
  FIRST_FACTOR: 128, BASE_FEE_MODE: 130, DYNAMIC_FEE_INITIALIZED: 136, PARTNER_VESTING_INITIALIZED: 184,
  CREATOR_VESTING_INITIALIZED: 200, COLLECT_FEE_MODE: 232, MIGRATION_OPTION: 233, ACTIVATION_TYPE: 234, TOKEN_DECIMAL: 235,
  VERSION: 236, TOKEN_TYPE: 237, QUOTE_TOKEN_FLAG: 238, PARTNER_LOCKED_PCT: 239, PARTNER_LIQUIDITY_PCT: 240, CREATOR_LOCKED_PCT: 241,
  CREATOR_LIQUIDITY_PCT: 242, MIGRATION_FEE_OPTION: 243, CREATOR_TRADING_FEE_PCT: 245, TOKEN_UPDATE_AUTHORITY: 246,
  MIGRATION_FEE_PCT: 247, CREATOR_MIGRATION_FEE_PCT: 248, MIGRATION_QUOTE_THRESHOLD: 264, VESTING_AMOUNT_PER_PERIOD: 296,
  VESTING_CLIFF_UNLOCK: 328, MIGRATED_COLLECT_FEE_MODE: 360, MIGRATED_DYNAMIC_FEE: 361, MIGRATED_POOL_FEE_BPS: 362,
  MIGRATED_POOL_BASE_FEE_MODE: 364, ENABLE_FIRST_SWAP_WITH_MIN_FEE: 365, MIGRATED_COMPOUNDING_FEE_BPS: 366, POOL_CREATION_FEE: 368,
  // DBC 0.2.2 source: transfer_fee_basis_points u16, withheld authority u8, migrated authority option u8, transfer_fee_flag u8
  TRANSFER_FEE_BPS: 216, TRANSFER_FEE_FLAG: 220,
};
export const POOL_CONFIG_DISC = Buffer.from([26, 108, 14, 123, 116, 230, 129, 43]);

/** Every check adopt_curve makes on the config (programs/hunch/src/processor.rs check_config), with a
 *  line for each that fails. An empty list: the program would adopt a pool made from this config. */
export function adoptionProblems(c, budget) {
  const k = COMPILED;
  const b = (o) => c[o];
  const h = (o) => c.readUInt16LE(o);
  const q = (o) => c.readBigUInt64LE(o);
  const same = (o, pk) => c.subarray(o, o + 32).equals(new PublicKey(pk).toBuffer());
  if (!c || c.length !== 1048) return [`the config is ${c?.length ?? 0} bytes, not 1,048`];
  const checks = [
    ["the account is a DBC PoolConfig", c.subarray(0, 8).equals(POOL_CONFIG_DISC)],
    ["priced in wrapped SOL", same(C.QUOTE_MINT, WSOL)],
    ["leftover tokens go to the budget PDA", same(C.LEFTOVER_RECEIVER, budget)],
    ["opening fee 50%", q(C.CLIFF_FEE_NUMERATOR) === k.cliffFeeNumerator],
    ["one-second fee steps", q(C.SECOND_FACTOR) === k.periodFrequency],
    ["each step 9.25 points", q(C.THIRD_FACTOR) === k.reductionFactor],
    ["five steps (to 3.75%)", h(C.FIRST_FACTOR) === k.numberOfPeriod],
    ["linear fee schedule", b(C.BASE_FEE_MODE) === k.baseFeeModeLinear],
    ["no dynamic fee", b(C.DYNAMIC_FEE_INITIALIZED) === 0],
    ["no partner liquidity vesting", b(C.PARTNER_VESTING_INITIALIZED) === 0],
    ["no creator liquidity vesting", b(C.CREATOR_VESTING_INITIALIZED) === 0],
    ["fees taken in SOL", b(C.COLLECT_FEE_MODE) === k.collectFeeModeQuote],
    ["graduates to DAMM v2", b(C.MIGRATION_OPTION) === k.migrationDammV2],
    ["keeps time by the clock", b(C.ACTIVATION_TYPE) === k.activationTimestamp],
    ["6 decimals", b(C.TOKEN_DECIMAL) === k.tokenDecimals],
    ["plain SPL token", b(C.TOKEN_TYPE) === k.tokenTypeSpl],
    ["quote is plain SPL", b(C.QUOTE_TOKEN_FLAG) === 0],
    ["partner LP 67% locked for good", b(C.PARTNER_LOCKED_PCT) === k.partnerLockedPct],
    ["no free partner LP", b(C.PARTNER_LIQUIDITY_PCT) === 0],
    ["creator LP 33% locked for good", b(C.CREATOR_LOCKED_PCT) === k.creatorLockedPct],
    ["no free creator LP", b(C.CREATOR_LIQUIDITY_PCT) === 0],
    ["Customizable migration fee option", b(C.MIGRATION_FEE_OPTION) === k.migrationFeeCustomizable],
    ["creator share 33", b(C.CREATOR_TRADING_FEE_PCT) === k.creatorTradingFeePct],
    ["immutable metadata", b(C.TOKEN_UPDATE_AUTHORITY) === k.tokenUpdateImmutable],
    ["no migration fee", b(C.MIGRATION_FEE_PCT) === 0],
    ["no creator migration fee", b(C.CREATOR_MIGRATION_FEE_PCT) === 0],
    ["no locked vesting (per period)", q(C.VESTING_AMOUNT_PER_PERIOD) === 0n],
    ["no locked vesting (cliff)", q(C.VESTING_CLIFF_UNLOCK) === 0n],
    ["pool fee after graduation in SOL", b(C.MIGRATED_COLLECT_FEE_MODE) === 0],
    ["no dynamic fee after graduation", b(C.MIGRATED_DYNAMIC_FEE) === 0],
    ["375 bps after graduation", h(C.MIGRATED_POOL_FEE_BPS) === k.migratedPoolFeeBps],
    ["flat fee after graduation", b(C.MIGRATED_POOL_BASE_FEE_MODE) === 0],
    // the build of 2026-10-16 evening accepts the flag on as well (the developer's optional first buy in
    // step 2); the line keeps its old name, which launch.mjs's adoptable() matches
    ["no first-swap-with-min-fee", b(C.ENABLE_FIRST_SWAP_WITH_MIN_FEE) <= 1],
    ["no compounding fee", h(C.MIGRATED_COMPOUNDING_FEE_BPS) === 0],
    ["no pool creation fee", q(C.POOL_CREATION_FEE) === 0n],
  ];
  return checks.filter(([, ok]) => !ok).map(([what]) => what);
}

/** Facts about a config the program does not check but the launch states (DBC 0.2.2 fields). */
export function configFacts(c) {
  return {
    version: c[C.VERSION], transferFeeBps: c.readUInt16LE(C.TRANSFER_FEE_BPS), transferFeeFlag: c[C.TRANSFER_FEE_FLAG],
    feeClaimer: key(c, C.FEE_CLAIMER), migrationQuoteThreshold: c.readBigUInt64LE(C.MIGRATION_QUOTE_THRESHOLD),
  };
}

/** The base fee (parts in 1e9) at `secondsSinceActivation`: 50% falling 9.25 points a second to 3.75%. */
export function liveFeeNumerator(secondsSinceActivation) {
  const k = COMPILED;
  const steps = Math.max(0, Math.min(k.numberOfPeriod, Math.floor(secondsSinceActivation / Number(k.periodFrequency))));
  return k.cliffFeeNumerator - k.reductionFactor * BigInt(steps);
}

// ---------------------------------------------------------------- simulate and send
export function customCode(err) {
  const ie = err?.InstructionError;
  return ie && typeof ie[1] === "object" && ie[1] && "Custom" in ie[1] ? ie[1].Custom : null;
}
export const errText = (err) => {
  const code = customCode(err);
  if (code !== null && ERR[code]) return `${ERR[code]} (${code})`;
  return typeof err === "string" ? err : JSON.stringify(err);
};

export const cuLimit = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });
export const cuPrice = (microLamports) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

/** Simulates instructions with `payer` as fee payer (no signature checked; the node's blockhash). */
export async function simulate(connection, ixs, payer, watch = []) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const res = await connection.simulateTransaction(tx, undefined, watch.length ? watch : undefined);
  const v = res.value;
  return { err: v.err, logs: v.logs ?? [], units: v.unitsConsumed ?? 0, accounts: v.accounts ?? null, code: customCode(v.err), tx };
}

export const wireSize = (tx) => tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures;

/** Signs and sends once, rebroadcasting the same bytes until it lands, fails on chain, or its blockhash
 *  runs out. A resend of the same signed bytes can never land twice. */
export async function sendSigned(connection, ixs, signers, { pause = 1500, rebroadcast = 3000 } = {}) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const wire = tx.serialize();
  const signature = bs58(tx.signature);
  const send = () => connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 }).catch(() => null);
  await send();
  let last = Date.now();
  for (;;) {
    const st = (await connection.getSignatureStatuses([signature]).catch(() => null))?.value?.[0];
    if (st && ["confirmed", "finalized"].includes(st.confirmationStatus)) {
      return { signature, outcome: st.err ? "failed" : "landed", err: st.err ?? null, bytes: wire.length };
    }
    const height = await connection.getBlockHeight("confirmed").catch(() => 0);
    if (height > lastValidBlockHeight) {
      const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null))?.value?.[0];
      if (again && !again.err) return { signature, outcome: "landed", err: null, bytes: wire.length };
      if (again?.err) return { signature, outcome: "failed", err: again.err, bytes: wire.length };
      return { signature, outcome: "expired", err: null, bytes: wire.length };
    }
    if (Date.now() - last > rebroadcast) { await send(); last = Date.now(); }
    await new Promise((res) => setTimeout(res, pause));
  }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let text = "";
  for (; n > 0n; n /= 58n) text = ALPHABET[Number(n % 58n)] + text;
  for (const b of bytes) { if (b !== 0) break; text = `1${text}`; }
  return text;
}

/** Compute units and log lines of a landed transaction (for the crank's log). */
export async function landedMeta(connection, signature) {
  for (let i = 0; i < 10; i++) {
    const t = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (t) return { units: t.meta?.computeUnitsConsumed ?? null, fee: t.meta?.fee ?? null, logs: t.meta?.logMessages ?? [] };
    await new Promise((res) => setTimeout(res, 400));
  }
  return { units: null, fee: null, logs: [] };
}

/** The memo lines in a transaction's logs (the diary line of a boundary tick). */
export function memoLines(logs) {
  const out = [];
  for (const [i, line] of logs.entries()) {
    const at = line.indexOf("Memo (len ");
    if (at < 0) continue;
    const rest = line.slice(at);
    const q = rest.indexOf(': "');
    if (q >= 0) out.push(rest.slice(q + 3).replace(/"$/, ""));
    else if (logs[i + 1]) out.push(logs[i + 1].replace(/^Program log: /, ""));
  }
  return out;
}

/** A key file's keypair, read from a path given in the environment. The path and the key are never printed. */
export function readKeypairFrom(envName, { required = true } = {}) {
  const path = process.env[envName];
  if (!path) {
    if (required) throw new Error(`${envName} is not set (the path of a key file)`);
    return null;
  }
  return import("node:fs").then(({ readFileSync, existsSync }) => {
    const full = path.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "");
    if (!existsSync(full)) {
      if (required) throw new Error(`${envName} points at no file`);
      return null;
    }
    try {
      return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(full, "utf8"))));
    } catch {
      throw new Error(`${envName} does not hold a key file I can read (a list of 64 numbers)`);
    }
  });
}
