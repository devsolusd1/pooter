// What happened on a local rehearsal's chain, read back from the chain itself (not from the cranks' own
// logs): every transaction that touched Hunch's State, by instruction, with its result, compute units
// and size; the landed ticks per bar (exactly one, none missing between the first and the last); the
// graduation (withdraw_surplus and adopt_pool landed once each); and the DAMM v2 position's fees: what
// the budget claimed against 33% of the LPs' fees. Local validator only.
//   node audit.mjs <local rpc> <program id> [<migration JSON line from migrate.mjs>]
import { web3 } from "../deps.mjs";
import { addresses, decodeDammPool, decodePool, decodePosition, decodeSignal, decodeState, isLocal, PHASE_NAME, BAR, HOUR } from "../hunch-program.mjs";
import { readFileSync, existsSync } from "node:fs";

const [rpc, programId, migrationFile] = process.argv.slice(2);
if (!isLocal(rpc)) throw new Error("local validator only");
const connection = new web3.Connection(rpc, "confirmed");
const A = addresses(programId);
const NAME = { 0: "initialize", 2: "adopt_curve", 3: "tick", 4: "buy_and_burn_curve", 5: "claim_curve_fees", 7: "grow_brain_book", 8: "withdraw_surplus", 9: "adopt_pool", 10: "buy_and_burn_pool", 11: "claim_pool_fees" };

// every signature that touched the State account, oldest first
let sigs = [], before;
for (;;) {
  const page = await connection.getSignaturesForAddress(A.state, { before, limit: 1000 }, "confirmed");
  sigs.push(...page);
  if (page.length < 1000) break;
  before = page.at(-1).signature;
}
sigs = sigs.reverse();
const rows = [];
for (const s of sigs) {
  const raw = await connection._rpcRequest("getTransaction", [s.signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  const t = raw.result;
  if (!t) continue;
  const bytes = Buffer.from(t.transaction[0], "base64");
  const tx = web3.VersionedTransaction.deserialize(bytes);
  const keys = tx.message.staticAccountKeys;
  const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex].equals(A.program));
  if (!ix) continue;
  const tag = ix.data[0];
  const preW = t.meta.preTokenBalances?.find((b) => keys[b.accountIndex].equals(A.budgetWsol));
  const postW = t.meta.postTokenBalances?.find((b) => keys[b.accountIndex].equals(A.budgetWsol));
  const wsolDelta = preW && postW ? BigInt(postW.uiTokenAmount.amount) - BigInt(preW.uiTokenAmount.amount) : null;
  rows.push({ sig: s.signature, slot: t.slot, time: t.blockTime, tag, name: NAME[tag] ?? `tag ${tag}`, ok: t.meta.err === null, err: t.meta.err, units: t.meta.computeUnitsConsumed, bytes: bytes.length, payer: keys[0].toBase58(), wsolDelta, logs: t.meta.logMessages ?? [] });
}

console.log(`transactions that touched Hunch's State: ${rows.length}`);
const by = {};
for (const r of rows) {
  const k = r.name;
  by[k] ??= { landed: 0, failed: 0, cu: [], bytes: [], errs: {} };
  if (r.ok) { by[k].landed++; by[k].cu.push(r.units); by[k].bytes.push(r.bytes); } else { by[k].failed++; const e = JSON.stringify(r.err); by[k].errs[e] = (by[k].errs[e] ?? 0) + 1; }
}
const span = (a) => (a.length ? (Math.min(...a) === Math.max(...a) ? `${a[0]}` : `${Math.min(...a)}-${Math.max(...a)}`) : "-");
for (const [k, v] of Object.entries(by)) {
  console.log(`  ${k.padEnd(20)} landed ${String(v.landed).padStart(4)}  failed on chain ${String(v.failed).padStart(3)}  CU ${span(v.cu).padEnd(13)} bytes ${span(v.bytes)}${v.failed ? `  failures: ${JSON.stringify(v.errs)}` : ""}`);
}

// ticks per bar, by the slot's time; and the phase each tick read (the pool account it named)
const ticks = rows.filter((r) => r.name === "tick" && r.ok);
const perBar = new Map();
for (const r of ticks) perBar.set(Math.floor(r.time / BAR), (perBar.get(Math.floor(r.time / BAR)) ?? 0) + 1);
const bars = [...perBar.keys()].sort((a, b) => a - b);
const missing = [];
for (let b = bars[0]; b <= bars.at(-1); b++) if (!perBar.has(b)) missing.push(b);
const twice = bars.filter((b) => perBar.get(b) > 1);
if (!ticks.length) console.log("ticks: none landed");
else console.log(`ticks: ${ticks.length} landed over bars ${bars[0]}..${bars.at(-1)} (${new Date(bars[0] * BAR * 1000).toISOString().slice(11, 16)}-${new Date(bars.at(-1) * BAR * 1000).toISOString().slice(11, 16)} UTC); bars with two landed ticks: ${twice.length} (must be 0); bars with none between: ${missing.length ? missing.map((b) => new Date(b * BAR * 1000).toISOString().slice(11, 16)).join(", ") : "none"}`);
const boundaryTicks = ticks.filter((r) => (Math.floor(r.time / BAR) * BAR) % HOUR === 0);
for (const r of boundaryTicks) {
  const memo = r.logs.filter((l) => l.includes("Memo (len")).map((l) => l.slice(l.indexOf(": \"") + 3).replace(/"$/, ""));
  console.log(`  boundary tick ${new Date(r.time * 1000).toISOString().slice(11, 19)} UTC: ${r.units} CU, ${r.bytes} B; diary: ${memo.join(" | ") || "-"}`);
}
const payers = new Map();
for (const r of rows.filter((x) => x.ok)) payers.set(r.payer, (payers.get(r.payer) ?? 0) + 1);
console.log(`landed transactions by payer: ${[...payers.entries()].map(([k, v]) => `${k.slice(0, 6)}… ${v}`).join(", ")}`);

// the graduation
const st = decodeState((await connection.getAccountInfo(A.state)).data);
const sg = decodeSignal((await connection.getAccountInfo(A.signal)).data);
const dbc = decodePool((await connection.getAccountInfo(st.pool)).data);
const once = (k) => (by[k]?.landed ?? 0);
console.log(`graduation: withdraw_surplus landed ${once("withdraw_surplus")} time(s), adopt_pool landed ${once("adopt_pool")} time(s) (each must be 1); DBC pool migrated ${dbc.isMigrated}, progress ${dbc.migrationProgress}, creator surplus withdrawn ${dbc.creatorWithdrewSurplus}`);
for (const k of ["withdraw_surplus", "adopt_pool"]) {
  const r = rows.find((x) => x.name === k && x.ok);
  if (r) console.log(`  ${k}: ${new Date(r.time * 1000).toISOString().slice(11, 19)} UTC, ${r.units} CU, ${r.bytes} B, budget WSOL ${r.wsolDelta === null ? "unchanged" : `+${r.wsolDelta}`} lamports, paid by ${r.payer.slice(0, 6)}…`);
}
console.log(`state: phase ${PHASE_NAME[st.phase]}, ${st.ticks} ticks, surplus ${st.surplus} lamports, claimed from the pool ${st.poolClaimed} lamports, buys ${st.buys}, waits ${st.skips}, last attempt hour ${st.hsHour} reason ${st.hsReason}; record on the pool ${st.hits}/${st.n}, the curve's ${st.graduation?.prevHits}/${st.graduation?.prevN}; adopted in hour ${st.graduation?.adoptHour}, pool warm-up until hour ${st.graduation?.poolWarmEnd}`);
console.log(`open call: hour ${sg.unixHour}, call ${sg.call}, lean ${sg.lean}, flags ${sg.flags}, budget ${(Number(sg.budget) / 1e9).toFixed(6)} SOL`);

// the position's fees: the budget's share of what the LPs earned on DAMM v2
if (st.phase === 3 && st.graduation) {
  const g = st.graduation;
  const pool = decodeDammPool((await connection.getAccountInfo(g.dammPool)).data);
  const pos = decodePosition((await connection.getAccountInfo(g.position)).data);
  const liq = pos.unlocked + pos.vested + pos.permanentLocked;
  const unclaimed = pos.feeBPending + (((pool.feeBPerLiquidity - pos.feeBCheckpoint) * liq) >> 128n);
  const lpFees = pool.totalLpBFee; // since the pool was made by the migration
  const share = Number(liq * 1_000_000n / pool.liquidity) / 1e4;
  const claims = rows.filter((r) => r.ok && r.name === "claim_pool_fees");
  const claimSum = claims.reduce((a, r) => a + (r.wsolDelta ?? 0n), 0n);
  console.log(`DAMM v2 pool ${g.dammPool}: LPs earned ${lpFees} lamports in SOL fees (protocol ${pool.totalProtocolBFee}); Hunch's position holds ${share}% of the liquidity (${liq} of ${pool.liquidity}, locked for good ${pos.permanentLocked})`);
  console.log(`  claimed by the position (DAMM's own count) ${pos.totalClaimedB}, unclaimed now ${unclaimed}; together ${pos.totalClaimedB + unclaimed} = ${(Number(pos.totalClaimedB + unclaimed) / Number(lpFees) * 100).toFixed(4)}% of the LPs' fees (the share is ${share}%; DAMM rounds each trade's fee per unit of liquidity down)`);
  console.log(`  claim_pool_fees landed ${claims.length} time(s), moving ${claimSum} lamports into the budget's WSOL (State counts ${st.poolClaimed}); buy_and_burn_pool claims the rest at each buy`);
  for (const r of claims) console.log(`    claim ${new Date(r.time * 1000).toISOString().slice(11, 19)} UTC: +${r.wsolDelta} lamports, ${r.units} CU, ${r.bytes} B`);
  if (migrationFile && existsSync(migrationFile)) {
    const mig = JSON.parse(readFileSync(migrationFile, "utf8").trim().split("\n").filter((l) => l.startsWith("{")).at(-1));
    const other = [mig.first, mig.second].find((x) => x.position !== g.position.toBase58());
    const theirs = decodePosition((await connection.getAccountInfo(new web3.PublicKey(other.position))).data);
    const tl = theirs.unlocked + theirs.vested + theirs.permanentLocked;
    const tu = theirs.feeBPending + (((pool.feeBPerLiquidity - theirs.feeBCheckpoint) * tl) >> 128n);
    console.log(`  the other position (the partner's, the dev wallet's as fee claimer): ${(Number(tl * 1_000_000n / pool.liquidity) / 1e4)}% of the liquidity, unclaimed ${tu}; both positions together ${pos.totalClaimedB + unclaimed + theirs.totalClaimedB + tu} of ${lpFees} (the rest is rounding dust left in the pool)`);
    console.log(`  migration: ${mig.result}, ${mig.units} CU, ${mig.bytes} B, paid by the throwaway keeper ${mig.keeper.slice(0, 6)}… (no Meteora key signed)`);
  }
}
