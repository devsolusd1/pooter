// Sums up a local crank rehearsal: what each crank did (from its JSON log), and what the program's
// accounts say afterwards.   node summary.mjs <logs folder> <program id> <local rpc>
import { web3 } from "../deps.mjs";
import { addresses, decodeSignal, decodeState, isLocal, PHASE_NAME } from "../hunch-program.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, programId, rpc] = process.argv.slice(2);
if (!isLocal(rpc)) throw new Error("local validator only");
const runs = readdirSync(dir).filter((f) => /^crank.*\.jsonl$/.test(f)).sort();
const ticksByBar = new Map();
for (const f of runs) {
  const lines = readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tally = {};
  let cuTick = [], cuBuy = [], fees = 0;
  for (const r of lines) {
    const k = `${r.action}: ${r.result}`;
    tally[k] = (tally[k] ?? 0) + 1;
    if (r.action === "tick" && r.result === "landed") { cuTick.push(r.units); ticksByBar.set(r.bar, (ticksByBar.get(r.bar) ?? 0) + 1); }
    if (r.action === "buy" && r.result === "landed") cuBuy.push(r.units);
    if (r.fee) fees += r.fee;
  }
  console.log(`${f}:`);
  for (const [k, v] of Object.entries(tally).sort()) console.log(`   ${String(v).padStart(4)}  ${k}`);
  if (cuTick.length) console.log(`   tick CU min ${Math.min(...cuTick)} max ${Math.max(...cuTick)}; buy CU ${cuBuy.join(", ") || "-"}; fees paid by this crank ${fees} lamports`);
}
const twice = [...ticksByBar.values()].filter((n) => n > 1).length;
console.log(`bars with a landed tick: ${ticksByBar.size}; bars where two cranks both landed a tick: ${twice} (must be 0)`);

const connection = new web3.Connection(rpc, "confirmed");
const A = addresses(programId);
const st = decodeState((await connection.getAccountInfo(A.state)).data);
const sg = decodeSignal((await connection.getAccountInfo(A.signal)).data);
console.log(`program: phase ${PHASE_NAME[st.phase]}, ${st.ticks} ticks, last boundary hour ${st.lastBoundaryHour}, record ${st.hits}/${st.n} (forfeits ${st.forfeits}), buys ${st.buys}, waits ${st.skips}, spent ${(Number(st.spent) / 1e9).toFixed(6)} SOL, burned ${st.burned} units, claimed ${(Number(st.claimed) / 1e9).toFixed(6)} SOL`);
console.log(`open call: hour ${sg.unixHour}, call ${sg.call}, lean ${sg.lean}, flags ${sg.flags}, budget ${(Number(sg.budget) / 1e9).toFixed(6)} SOL, planned slice ${(Number(sg.plannedSlice) / 1e9).toFixed(6)} SOL`);
const memos = [];
for (const f of runs) for (const l of readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean)) {
  const r = JSON.parse(l);
  if (r.memo?.length) memos.push(...r.memo);
}
if (memos.length) console.log(`diary lines written:\n   ${memos.join("\n   ")}`);
const trader = join(dir, "trader.log");
if (existsSync(trader)) console.log(`crowd: ${readFileSync(trader, "utf8").trim().split("\n").pop()}`);
