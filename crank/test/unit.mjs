// Checks of the pieces that touch nothing (no network): the crank's schedule, the opening fee, the
// launch tool's decisions and token.json, the State decoder.   node test/unit.mjs
import { due, barOf, isBoundaryBar, buyLater, buyDueAt, buyNext, buySlot, RETRY_REASONS } from "../crank.mjs";
import {
  decodeState, liveFeeNumerator, STATE_LEN, STATE_LEN_POOL, transferPoolCreatorIx, addresses, TRANSFER_POOL_CREATOR_DISC, decodePool, decodeDammPool, decodePosition,
  adoptPoolCandidates, dammPoolAddress, dammPositionOf, dammNftAccountOf, DAMM, DAMM_MIGRATION_CONFIGS, initializeIx, ERR, SKIP, claimCurveFeesIx,
} from "../hunch-program.mjs";
import { openingCostTable, sendDecision, tokenProblems } from "../../launch/launch.mjs";
import { need } from "../deps.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

// ---- the schedule ----
const cfg = { window: 30, tickFrom: 3, buyDelay: 20 };
const H = 1792170000; // a UTC hour boundary (1792170000 % 3600 === 0)
const fresh = () => ({ tick: new Set(), buy: new Set(), grow: new Set(), grad: new Set(), tickAt: {}, boundaryLandedAt: {} });
check(H % 3600 === 0 && isBoundaryBar(barOf(H)) && !isBoundaryBar(barOf(H + 600)), "bars: the first bar of an hour is its boundary");
let d = fresh();
check(due(H + 1, d, cfg).length === 0, "nothing due before the tick second");
check(due(H + 3, d, cfg).includes("tick"), "tick due at its second");
check(due(H + 28, d, cfg).includes("tick"), "tick still due late in the window (retry)");
check(!due(H + 29, d, cfg).includes("tick") && !due(H + 45, d, cfg).includes("tick"), "no tick after the window");
d.tick.add(barOf(H));
check(!due(H + 10, d, cfg).includes("tick") && due(H + 10, d, cfg).includes("grad"), "a settled bar: no second tick; the graduation check follows");
d.boundaryLandedAt[H / 3600] = H + 4;
check(!due(H + 20, d, cfg).includes("buy") && due(H + 24, d, cfg).includes("buy"), "buy due 20 s after the boundary tick landed");
d.buy.add(H / 3600);
check(!due(H + 100, d, cfg).includes("buy"), "one buy an hour");
// a boundary tick that made no open call (the baseline, a blind tick): look again in 5 s, for a minute
d = fresh();
d.boundaryLandedAt[H / 3600] = H + 4;
d.buyRetryAt = { [H / 3600]: H + 29 };
check(buyDueAt(d, H / 3600, cfg) === H + 29 && !due(H + 28, d, cfg).includes("buy") && due(H + 29, d, cfg).includes("buy"), "a buy that found no open call is due again 5 s later, not on every pass");
check(buyLater(H + 30, H + 4, cfg) === "later" && buyLater(H + 84, H + 4, cfg) === "later" && buyLater(H + 85, H + 4, cfg) === "skip", "and lets the hour go a minute after it was first due");
check(!due(H + 299, d, cfg).includes("grow") && due(H + 300, d, cfg).includes("grow"), "brain book check at minute 5 of each hour");
// claim_pool_fees: pool phase only, once an hour, from second 3030 (after the minute-50 bar's tick)
const pcfg = { ...cfg, pool: true };
d = fresh();
d.claim = new Set();
check(!due(H + 3029, d, pcfg).includes("claim") && !due(H + 3031, d, cfg).includes("claim"), "no claim before second 3030, nor on the curve");
check(!due(H + 3003, d, { ...pcfg, claimAt: 3000 }).includes("claim"), "no claim inside an unsettled tick window");
check(due(H + 3031, d, pcfg).includes("claim"), "claim due in the bar before the boundary");
d.claim.add(H / 3600);
check(!due(H + 3300, d, pcfg).includes("claim") && due(H + 3600 + 3031, d, pcfg).includes("claim"), "one claim an hour");

// ---- the hour's buy after a wait (the program refuses a second wait, 28, and lets a buy through) ----
const bcfg = { ...cfg, buyJitter: 45, buyRetry: 120, buyUntil: 3000 };
const h = H / 3600;
const st = (o) => ({ hsHour: h, lastBuyHour: h - 1, hsReason: SKIP.GUARD, lastBuyTs: H - 3600, ...o });
check(buyNext({ ts: H + 40, hour: h, result: "landed", state: st({ lastBuyHour: h, hsReason: SKIP.NONE }) }, bcfg) === "done", "a landed buy settles the hour");
check(buyNext({ ts: H + 40, hour: h, result: "landed", state: st() }, bcfg) === H + 160, "this crank's own wait on the guard: looked at again 120 s later");
check(buyNext({ ts: H + 40, hour: h, result: "nothing to do", code: 28, state: st() }, bcfg) === H + 160, "28 in simulation (anyone's wait on the guard stands, nothing sent): looked at again, not settled");
check(buyNext({ ts: H + 40, hour: h, result: "failed", code: 28, state: st({ hsReason: SKIP.STALE }) }, bcfg) === H + 160, "28 on chain after another cranker's wait on a stale tape: looked at again");
check(buyNext({ ts: H + 40, hour: h, result: "landed", state: st({ hsReason: SKIP.VOLUME_CAP }) }, bcfg) === "done" && buyNext({ ts: H + 40, hour: h, result: "nothing to do", code: 28, state: st({ hsReason: SKIP.DAY_CAP }) }, bcfg) === "done", "a wait on the volume or day cap settles the hour (it cannot pass within it)");
check([SKIP.BELOW_MIN, SKIP.GUARD, SKIP.STALE, SKIP.IMPACT_CAP].every((r) => RETRY_REASONS.has(r)) && !RETRY_REASONS.has(SKIP.VOLUME_CAP) && !RETRY_REASONS.has(SKIP.DAY_CAP), "the reasons looked at again: below the minimum, guard, stale, impact cap");
check([15, 17, 8, 27, 30].every((code) => buyNext({ ts: H + 40, hour: h, result: "nothing to do", code, state: st() }, bcfg) === "done"), "15, 17, 8, 27 and 30 settle the hour");
check(buyNext({ ts: H + 2950, hour: h, result: "nothing to do", code: 28, state: st() }, bcfg) === "done", "no look after second 3000 of the hour (a late buy would make the next hour's TOO_SOON)");
check(buyNext({ ts: H + 40, hour: h, result: "nothing to do", code: 16, state: st({ lastBuyTs: H - 600 }) }, bcfg) === H + 1201 && buyNext({ ts: H + 40, hour: h, result: "nothing to do", code: 16, state: st({ lastBuyTs: H + 1300 }) }, bcfg) === "done", "TOO_SOON: tried again once 30 minutes have passed since the last buy, if that is within the hour");
check(buyNext({ ts: H + 40, hour: h, result: "would send", state: st() }, bcfg) === "done", "a dry crank looks once an hour");
check(buyNext({ ts: H + 40, hour: h, result: "expired", code: null, state: st({ hsHour: h - 1 }) }, bcfg) === H + 160, "an expired send or a node error: looked at again later");
// the buy's random pause never runs into a tick window
check(buySlot(H + 600 - 61, bcfg) === H + 600 - 61 && buySlot(H + 600 - 60, bcfg) === H + 630 && buySlot(H + 25, bcfg) === H + 25, "buySlot: a try within BUY_JITTER + 15 s of the next bar moves after that bar's window");
d = fresh();
d.tick.add(barOf(H));
d.boundaryLandedAt[h] = H + 4;
d.buyRetryAt = { [h]: H + 560 };
check(buyDueAt(d, h, bcfg) === H + 630 && !due(H + 560, d, bcfg).includes("buy"), "a retry due 40 s before a bar waits for the end of that bar's tick window");
check(due(H + 630, d, bcfg).includes("buy"), "and is due there");
d.buyRetryAt[h] = H + 612;
check(!due(H + 612, d, bcfg).includes("buy") && (d.tick.add(barOf(H + 600)), due(H + 612, d, bcfg).includes("buy")), "a buy inside a tick window waits until that bar's tick is settled");

// ---- the opening fee ----
const pcts = [0, 1, 2, 3, 4, 5, 6, 60].map((t) => Number(liveFeeNumerator(t)) / 1e7);
check(JSON.stringify(pcts) === JSON.stringify([50, 40.75, 31.5, 22.25, 13, 3.75, 3.75, 3.75]), `opening fee by second: ${pcts.join(", ")}%`);
const t5 = openingCostTable(1_000_000_000n).at(-1);
check(t5.fee === 37_500_000n && t5.meteora === 7_500_000n && t5.budget === 9_900_000n && t5.dev === 20_100_000n, "after the opening, 1 SOL pays 0.0375: Meteora 0.0075, budget 0.0099, dev 0.0201");
const t0 = openingCostTable(1_000_000_000n)[0];
check(t0.budget === 132_000_000n, "at t=0 the budget gets 13.2% of the trade (the stage-1 measurement)");

// ---- the launch tool's decisions ----
const T = JSON.parse(readFileSync(new URL("../../launch/token.json", import.meta.url), "utf8"));
const probs = tokenProblems(T);
check(probs.length === 1 && /uri is not set/.test(probs[0]), `token.json: only the uri is missing (${probs.length} problem(s))`);
check(tokenProblems({ ...T, uri: "https://x.example/m.json", creatorSharePct: 34 }).some((p) => /creatorSharePct/.test(p)), "token.json: a creator share the program would refuse is caught");
check(tokenProblems({ ...T, uri: "http://127.0.0.1:1/m.json" }).length === 1 && tokenProblems({ ...T, uri: "http://127.0.0.1:1/m.json" }, { local: true }).length === 0, "a local uri only on a local rehearsal");
check(sendDecision({ send: false, step: "", next: "config", notReady: false }).go === false, "no SEND: nothing sent");
check(sendDecision({ send: true, step: "", next: "config", notReady: false }).code === 1, "SEND without STEP: refused");
check(sendDecision({ send: true, step: "token", next: "config", notReady: false }).code === 1, "the wrong STEP: refused");
check(sendDecision({ send: true, step: "config", next: "config", notReady: true }).code === 1, "a not-ready list: refused");
check(sendDecision({ send: true, step: "config", next: "config", notReady: false }).go === true, "SEND=1 and the right STEP with nothing missing: sent");

// ---- transfer_pool_creator by hand, against the SDK's own builder ----
check(createHash("sha256").update("global:transfer_pool_creator").digest().subarray(0, 8).equals(TRANSFER_POOL_CREATOR_DISC), "transfer_pool_creator discriminator");
const sdk = need("@meteora-ag/dynamic-bonding-curve-sdk");
const { Connection, Keypair, PublicKey } = need("@solana/web3.js");
const client = sdk.DynamicBondingCurveClient.create(new Connection("http://127.0.0.1:9"), "confirmed");
const [pool, config, creator] = [0, 1, 2].map(() => Keypair.generate().publicKey);
const A = addresses(Keypair.generate().publicKey);
const fromSdk = await client.creator.program.methods.transferPoolCreator().accountsPartial({ virtualPool: pool, config, creator, newCreator: A.budget }).instruction();
const byHand = transferPoolCreatorIx({ pool, config, creator, newCreator: A.budget });
check(fromSdk.data.equals(byHand.data) && fromSdk.keys.every((k, i) => k.pubkey.equals(byHand.keys[i].pubkey) && k.isSigner === byHand.keys[i].isSigner && k.isWritable === byHand.keys[i].isWritable), "transfer_pool_creator: the hand-built instruction equals the SDK's");

// ---- State ----
const buf = Buffer.alloc(STATE_LEN_POOL);
buf.write("HUNCHSTA", 0);
buf[9] = 3;
A.budget.toBuffer().copy(buf, 176);
buf.writeUInt32LE(7, 840);
const s2 = decodeState(buf);
check(STATE_LEN === 1248 && STATE_LEN_POOL === 1248 && s2 && s2.phase === 3 && s2.budget.equals(A.budget) && s2.graduation && s2.buys === 7, "State (1,248 bytes, the final layout) decodes");
check(decodeState(buf.subarray(0, 920)) === null && decodeState(Buffer.concat([buf, Buffer.alloc(8)])) === null, "a State of any other size (the 920-byte stage-2 layout, say) is not read");
check(s2.ticker === null, "State: no ticker before initialize writes one");
Buffer.from("HUNCH").copy(buf, 1184);
check(decodeState(buf).ticker === "HUNCH", "State: the ticker (16 bytes at 1,184, zero-padded)");
buf.writeBigUInt64LE(5n, 1200); buf.writeBigUInt64LE(1n, 1208);
buf.writeBigUInt64LE(37_500_000n, 1120);
buf[756] = 2; buf[757] = 9;
const s3 = decodeState(buf);
check(s3.migrationSqrtPrice === (1n << 64n) + 5n && s3.graduation.adoptFeeNum === 37_500_000n && s3.hsReason === 2 && s3.hsDetail === 9, "State: migration_sqrt_price (u128 at 1,200), adopt_fee_num (1,120), hs_reason and hs_detail (756, 757)");
const initT = initializeIx(A, Keypair.generate().publicKey, Keypair.generate().publicKey, 12346, "HUNCH");
check(initT.data.length === 52 && initT.data[46] === 5 && initT.data.subarray(47).toString() === "HUNCH" && initT.keys.length === 15,
  "initialize: 47 + n bytes, the 46-byte head, then the ticker's length and characters");
const refused = ["", "hunch", "ABCDEFGHIJK", "HUN-CH", undefined, null].filter((t) => { try { initializeIx(A, A.budget, A.budget, 12346, t); return false; } catch { return true; } });
check(refused.length === 6, "initialize: a ticker the program would refuse (BAD_TICKER), or none, is refused before anything is built");
check(ERR[28] === "ALREADY_WAITED_THIS_HOUR" && ERR[29] === "BAD_TICKER" && ERR[30] === "FEE_RAISED", "the error names of the final build (28, 29, 30)");
buf.writeBigUInt64LE(123n, 1128);
buf.writeBigUInt64LE(456n, 1136);
check(decodeState(buf).surplus === 123n && decodeState(buf).poolClaimed === 456n, "State: surplus and pool claims");
const cc = claimCurveFeesIx(A, { pool: A.state, config: A.model, mint: A.tape, baseVault: A.diary, quoteVault: A.book });
check(cc.data.length === 1 && cc.data[0] === 5 && cc.keys.length === 14 && cc.keys[2].pubkey.equals(A.budgetWsol) && cc.keys[2].isWritable && cc.keys[6].pubkey.equals(A.state) && cc.keys[6].isWritable, "claim_curve_fees: tag 5, the 14 accounts of layout-final.md (budget WSOL and the DBC pool writable)");

// ---- DBC and DAMM v2 accounts ----
const vp = Buffer.alloc(424);
vp[305] = 1; vp[308] = 3; vp[310] = 1;
const dp = decodePool(vp);
check(dp.isMigrated === 1 && dp.migrationProgress === 3 && dp.creatorWithdrewSurplus === 1, "DBC pool: migrated, progress, creator surplus flag (offset 310)");
const dpool = Buffer.alloc(1112);
dpool.writeBigUInt64LE(5n, 360); dpool.writeBigUInt64LE(1n, 368); // liquidity 2^64 + 5
dpool.writeBigUInt64LE(7n, 584);
dpool.writeBigUInt64LE(9n, 520 + 16); // fee_b_per_liquidity = 9 * 2^128
const dd = decodeDammPool(dpool);
check(dd.liquidity === (1n << 64n) + 5n && dd.totalLpBFee === 7n && dd.feeBPerLiquidity === 9n << 128n, "DAMM v2 pool: liquidity, LP fees, fee per liquidity (u128, u256)");
const dpos = Buffer.alloc(408);
dpos.writeBigUInt64LE(11n, 184); dpos.writeBigUInt64LE(3n, 144); dpos.writeBigUInt64LE(4n, 208);
const pp = decodePosition(dpos);
check(pp.permanentLocked === 11n && pp.feeBPending === 3n && pp.totalClaimedB === 4n && decodePosition(Buffer.alloc(407)) === null, "DAMM v2 position: locked liquidity, pending fee, claimed");

// ---- finding the DAMM v2 pool to adopt, without getProgramAccounts ----
const mintK = Keypair.generate().publicKey, nftMint = Keypair.generate().publicKey, wsolMint = new PublicKey("So11111111111111111111111111111111111111112");
const migrated = dammPoolAddress(DAMM_MIGRATION_CONFIGS[6], mintK, wsolMint);
check(migrated.equals(dammPoolAddress(DAMM_MIGRATION_CONFIGS[6], wsolMint, mintK)), "DAMM v2 pool address: the mints in either order");
const fakeConnection = (poolOfPosition, extraConfigs = []) => {
  const calls = { gpa: 0 };
  const nftData = Buffer.alloc(165);
  nftMint.toBuffer().copy(nftData, 0);
  A.budget.toBuffer().copy(nftData, 32);
  nftData.writeBigUInt64LE(1n, 64);
  const posData = Buffer.alloc(408);
  poolOfPosition.toBuffer().copy(posData, 8);
  nftMint.toBuffer().copy(posData, 40);
  posData.writeBigUInt64LE(1000n, 184);
  return {
    calls,
    getTokenAccountsByOwner: async () => ({ value: [{ pubkey: dammNftAccountOf(nftMint), account: { data: nftData } }] }),
    getMultipleAccountsInfo: async (keys) => keys.map((k) => (k.equals(dammPositionOf(nftMint)) ? { owner: DAMM, data: posData } : null)),
    getProgramAccounts: async () => { calls.gpa++; return extraConfigs.map((pubkey) => ({ pubkey })); },
  };
};
let fc = fakeConnection(migrated);
let cands = await adoptPoolCandidates(fc, A, { mint: mintK });
check(cands.length === 1 && cands[0].dammPool.equals(migrated) && cands[0].dammConfig.equals(DAMM_MIGRATION_CONFIGS[6]) && cands[0].position.equals(dammPositionOf(nftMint)) && cands[0].nftAccount.equals(dammNftAccountOf(nftMint)) && fc.calls.gpa === 0,
  "adopt_pool's accounts from the budget's position NFT, with no getProgramAccounts");
const newConfig = Keypair.generate().publicKey;
fc = fakeConnection(dammPoolAddress(newConfig, mintK, wsolMint), [newConfig]);
cands = await adoptPoolCandidates(fc, A, { mint: mintK });
check(cands.length === 1 && cands[0].dammConfig.equals(newConfig) && fc.calls.gpa === 1, "a config Meteora adds later is found by asking DAMM v2 for its configs, once");
fc = fakeConnection(Keypair.generate().publicKey);
cands = await adoptPoolCandidates(fc, A, { mint: mintK });
check(cands.length === 0, "a position in some other pool is no candidate");

console.log(failed ? `${failed} FAILED` : "all pass");
process.exitCode = failed ? 1 : 0;
