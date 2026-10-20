// The developer's withdrawal: moves Pooter's budget to the developer's wallet, as plain SOL.
//
// The program's withdraw_budget (tag 12, since the upgrade of 2026-10-20) first claims the fee owed to the
// budget (the creator fee on the bonding curve; Hunch's position fee on the DAMM v2 pool after graduation),
// then moves the budget's WSOL to a WSOL account the signer owns. This script sends one transaction: that
// WSOL account created if missing, withdraw_budget, then the WSOL account closed into the wallet, so the SOL
// arrives as SOL. Only the program's upgrade authority can sign it. The hourly buy keeps running on the fees
// that arrive later. The developer says they use what they withdraw to buy POOTER and burn it by hand
// (burn.mjs burns it); every withdrawal is on chain, with a memo line and a lifetime total the site shows.
//
//   node withdraw-budget.mjs                      # dry: what the budget holds now, and a simulation
//   SEND=1 node withdraw-budget.mjs               # sends it; prints the amount and the signature
//   AMOUNT=1.5 SEND=1 node withdraw-budget.mjs    # only 1.5 SOL of it (default: ALL)
//
// From Windows:  wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && node withdraw-budget.mjs'
//
// Settings come from the environment or from hunch/launch/.env, read as init-hunch.mjs reads it
// (HUNCH_ENV_FILE names another file, for a local rehearsal). SEND only from the command line. Nothing
// prints the RPC address or a key path.
//   RPC_URL    never printed
//   CLUSTER    mainnet-beta (default) or localnet
//   KEYPAIR    the program's upgrade authority (the developer's wallet): signs, pays and receives
//   PRIORITY   micro-lamports per compute unit (default 50000)
//   AMOUNT     SOL to move (up to 9 decimals), or ALL (the default)
// If the wallet already has a WSOL account (its associated one) holding WSOL of its own, closing it at the end
// unwraps that WSOL too: all of it arrives in the wallet as SOL.

import { need } from "../crank/deps.mjs";
import {
  addresses, ataOf, claimCurveFeesIx, cuLimit, cuPrice, decodePool, decodeState, hide, isLocal, keepSecret, landedMeta, memoLines, simulate, wireSize,
  ATA, DAMM, DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY, DBC, DBC_EVENT_AUTHORITY, DBC_POOL_AUTHORITY, MEMO, PHASE, PHASE_NAME, SYSTEM, SYSVAR_INSTRUCTIONS, TOKEN, WSOL,
} from "../crank/hunch-program.mjs";
import { applyEnv, home, readEnv, sendOnce } from "../launch/launch.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { clusterApiUrl, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = need("@solana/web3.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = resolve(HERE, "..", "launch");
const sol = (l) => (Number(l) / 1e9).toFixed(6);
const WITHDRAW_BUDGET = 12;
// State offsets (design/layout-final.md): the claim totals and withdraw_budget's three fields
const AT = { claimed: 848, poolClaimed: 1136, withdrawn: 1216, withdrawals: 1224, lastWithdrawHour: 1228 };
const ERRORS = { 1: "CALLED_BY_CPI", 3: "NOT_TOP_LEVEL", 4: "WRONG_ACCOUNT", 6: "NOT_AUTHORITY (this wallet is not the program's upgrade authority)", 8: "WRONG_PHASE", 31: "NOTHING_TO_WITHDRAW (the budget is empty, even after the claim)", 32: "AMOUNT_TOO_HIGH (more than the budget holds)" };

const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });

/** withdraw_budget: tag, the programdata bump, the amount in lamports (0: everything); the accounts of
 *  design/layout-final.md, tag 12, for the phase State is in. */
export function withdrawBudgetIx(a, st, authority, dest, lamports) {
  const data = Buffer.alloc(10);
  data[0] = WITHDRAW_BUDGET;
  data[1] = a.bumps[0];
  data.writeBigUInt64LE(BigInt(lamports), 2);
  const keys = [
    { pubkey: authority, isSigner: true, isWritable: true }, r(a.programdata), w(a.state), w(a.signal), r(a.budget), w(a.budgetWsol),
    w(ataOf(a.budget, st.mint)), r(st.mint), r(WSOL), w(dest), r(TOKEN), r(SYSVAR_INSTRUCTIONS), r(MEMO), r(a.eventAuthority), r(a.program),
  ];
  if (st.phase === PHASE.POOL) {
    const g = st.graduation;
    keys.push(r(g.dammPool), r(DAMM_POOL_AUTHORITY), w(g.tokenAVault), w(g.tokenBVault), w(g.position), r(g.positionNft), r(DAMM_EVENT_AUTHORITY), r(DAMM));
  } else {
    keys.push(w(st.pool), r(st.config), w(st.baseVault), w(st.quoteVault), r(DBC_POOL_AUTHORITY), r(DBC_EVENT_AUTHORITY), r(DBC));
  }
  return new TransactionInstruction({ programId: a.program, keys, data });
}
// the associated WSOL account, created if missing (idempotent), and closed into the wallet (unwrapped)
const createWsolIx = (owner, ata) =>
  new TransactionInstruction({ programId: ATA, keys: [{ pubkey: owner, isSigner: true, isWritable: true }, w(ata), r(owner), r(WSOL), r(SYSTEM), r(TOKEN)], data: Buffer.from([1]) });
const closeIx = (account, owner) =>
  new TransactionInstruction({ programId: TOKEN, keys: [w(account), w(owner), { pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from([9]) });

/** "1.5" SOL, or "ALL", as lamports (0n for ALL). */
export function parseAmount(text) {
  const t = String(text ?? "ALL").trim();
  if (/^all$/i.test(t)) return 0n;
  const m = t.match(/^(\d+)(?:\.(\d{1,9}))?$/);
  if (!m) throw new Error(`AMOUNT must be a number of SOL (up to 9 decimals) or ALL, not "${t}"`);
  const lamports = BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
  if (lamports === 0n) throw new Error("AMOUNT is 0; leave it out (or ALL) for everything");
  return lamports;
}

const u64 = (d, o) => d.readBigUInt64LE(o);
const fields = (d) => ({ claimed: u64(d, AT.claimed), poolClaimed: u64(d, AT.poolClaimed), withdrawn: u64(d, AT.withdrawn), withdrawals: d.readUInt32LE(AT.withdrawals), lastWithdrawHour: d.readUInt32LE(AT.lastWithdrawHour) });

async function main() {
  const envFile = process.env.HUNCH_ENV_FILE ? home(process.env.HUNCH_ENV_FILE) : join(LAUNCH, ".env");
  const notes = existsSync(envFile) ? applyEnv(readEnv(readFileSync(envFile)), process.env) : [];
  const CLUSTER = process.env.CLUSTER ?? "mainnet-beta";
  const local = CLUSTER === "localnet";
  const RPC_URL = process.env.RPC_URL || (local ? "http://127.0.0.1:8899" : clusterApiUrl(CLUSTER));
  if (process.env.RPC_URL) keepSecret(process.env.RPC_URL);
  const SEND = process.env.SEND === "1";
  if (local !== isLocal(RPC_URL)) { console.log(`REFUSED: CLUSTER is ${CLUSTER} but RPC_URL is ${local ? "not a local validator" : "a local validator"}. Nothing was sent.`); return 1; }
  if (process.env.SEND && !SEND) notes.push(`SEND is "${process.env.SEND}": only SEND=1 sends, so this is a dry run`);
  const priority = Number.isFinite(Number(process.env.PRIORITY)) && Number(process.env.PRIORITY) >= 0 ? Number(process.env.PRIORITY ?? 50000) : 50000;
  let ask;
  try { ask = parseAmount(process.env.AMOUNT); } catch (e) { console.log(`REFUSED: ${e.message}. Nothing was sent.`); return 1; }
  for (const n of notes) console.log(`note      ${n}`);
  const keyPath = process.env.KEYPAIR;
  if (!keyPath || !existsSync(home(keyPath))) { console.log("REFUSED: KEYPAIR is not set, or no key file is there (the program's upgrade authority). Nothing was sent."); return 1; }
  let wallet;
  try { wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(home(keyPath), "utf8")))); } catch { console.log("REFUSED: KEYPAIR does not hold a key file I can read. Nothing was sent."); return 1; }
  const connection = new Connection(RPC_URL, "confirmed");

  const PROGRAM_FILE = local && process.env.HUNCH_PROGRAM_FILE ? home(process.env.HUNCH_PROGRAM_FILE) : join(LAUNCH, "program.json");
  const P = existsSync(PROGRAM_FILE) ? JSON.parse(readFileSync(PROGRAM_FILE, "utf8")) : {};
  if (typeof P[CLUSTER] !== "string") { console.log(`REFUSED: program.json has no program address for ${CLUSTER}. Nothing was sent.`); return 1; }
  const a = addresses(P[CLUSTER]);
  const [stInfo, pdInfo, wsolInfo] = await connection.getMultipleAccountsInfo([a.state, a.programdata, a.budgetWsol], "confirmed");
  const st = decodeState(stInfo?.data);
  if (!st) { console.log(`REFUSED: no Hunch state of the final layout at ${a.state}. Nothing was sent.`); return 1; }
  const f0 = fields(stInfo.data);
  const authority = pdInfo && pdInfo.data.length >= 45 && pdInfo.data[12] === 1 ? new PublicKey(pdInfo.data.subarray(13, 45)) : null;
  const balance0 = await connection.getBalance(wallet.publicKey, "confirmed");
  console.log(`cluster   ${CLUSTER}`);
  console.log(`program   ${a.program}, upgrade authority ${authority ?? "none"}`);
  console.log(`wallet    ${wallet.publicKey}${authority && wallet.publicKey.equals(authority) ? " (the upgrade authority)" : ""}, ${sol(balance0)} SOL`);
  console.log(`state     phase ${PHASE_NAME[st.phase] ?? st.phase}; the program bought and burned: ${sol(st.spent)} SOL spent in ${st.buys} buys`);
  console.log(`          withdrawn by the developer so far: ${sol(f0.withdrawn)} SOL in ${f0.withdrawals} withdrawal${f0.withdrawals === 1 ? "" : "s"}`);

  // ---- what the budget holds ----
  const wd = wsolInfo?.data;
  const reserve = wd && wd.length === 165 && wd.readUInt32LE(109) === 1 ? wd.readBigUInt64LE(113) : 0n;
  const inWsol = wsolInfo ? BigInt(wsolInfo.lamports) - reserve : 0n;
  const ixs = [cuLimit(200_000), cuPrice(priority)];
  let waiting = "", oldCurve = 0n;
  const poolInfo = await connection.getAccountInfo(st.pool, "confirmed");
  const dbcPool = decodePool(poolInfo?.data);
  if (st.phase === PHASE.CURVE || st.phase === PHASE.GRADUATING) {
    waiting = `${sol(dbcPool?.creatorQuoteFee ?? 0n)} SOL of creator fee waiting on the DBC pool (claimed in the same instruction)`;
  } else if (st.phase === PHASE.POOL) {
    oldCurve = dbcPool?.creatorQuoteFee ?? 0n;
    waiting = `the position's fee waiting on the DAMM v2 pool (claimed in the same instruction; the simulation shows how much)`;
    if (oldCurve > 0n) waiting += `, and ${sol(oldCurve)} SOL still on the old curve (claim_curve_fees runs first in the same transaction)`;
  } else {
    console.log(`REFUSED: the program is in phase ${PHASE_NAME[st.phase] ?? st.phase}; withdraw_budget runs on the curve, while graduating and on the pool. Nothing was sent.`);
    return 1;
  }
  console.log(`budget    ${sol(inWsol)} SOL in its WSOL account, plus ${waiting}`);
  if (!authority || !wallet.publicKey.equals(authority)) { console.log("REFUSED: this wallet is not the program's upgrade authority; the program would refuse it (NOT_AUTHORITY). Nothing was sent."); return 1; }

  const dest = ataOf(wallet.publicKey, WSOL);
  const own = await connection.getAccountInfo(dest, "confirmed");
  if (own && own.data.length === 165 && own.data.readBigUInt64LE(64) > 0n) console.log(`note      your WSOL account already holds ${sol(own.data.readBigUInt64LE(64))} WSOL of its own; closing it unwraps that too`);
  ixs.push(createWsolIx(wallet.publicKey, dest));
  if (st.phase === PHASE.POOL && oldCurve > 0n) ixs.push(claimCurveFeesIx(a, { mint: st.mint, pool: st.pool, config: st.config, baseVault: st.baseVault, quoteVault: st.quoteVault }));
  ixs.push(withdrawBudgetIx(a, st, wallet.publicKey, dest, ask), closeIx(dest, wallet.publicKey));

  // ---- the simulation ----
  const sim = await simulate(connection, ixs, wallet.publicKey, [a.state, wallet.publicKey]);
  console.log(`\n== the withdrawal (simulated): ${ixs.length} instructions, ${wireSize(sim.tx)} bytes, ${sim.units} CU, asking for ${ask === 0n ? "everything" : `${sol(ask)} SOL`}`);
  if (sim.err) {
    console.log(`The simulation fails: ${JSON.stringify(sim.err)}${sim.code !== null ? ` (${ERRORS[sim.code] ?? `error ${sim.code}`})` : ""}`);
    for (const l of sim.logs.slice(-6)) console.log(`   ${l}`);
    console.log("Nothing was sent.");
    return 1;
  }
  const f1 = fields(Buffer.from(sim.accounts[0].data[0], "base64"));
  const amount = f1.withdrawn - f0.withdrawn;
  const claimed = f1.claimed - f0.claimed + (f1.poolClaimed - f0.poolClaimed);
  console.log(`amount    ${sol(amount)} SOL to your wallet (of which ${sol(claimed)} SOL claimed in this transaction)`);
  console.log(`wallet    ${sol(balance0)} -> ${sol(sim.accounts[1].lamports)} SOL in the simulation (the network fee comes off)`);
  for (const m of memoLines(sim.logs)) console.log(`memo      ${m}`);
  if (!SEND) { console.log(`\nNothing was sent. To withdraw:  ${ask === 0n ? "" : `AMOUNT=${process.env.AMOUNT} `}SEND=1 node withdraw-budget.mjs`); return 0; }

  console.log("\n== sending the withdrawal");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const result = await sendOnce(connection, tx, [wallet]);
  if (result.outcome !== "landed") { console.log(`It did not land: ${result.outcome}${result.detail ? `, ${hide(result.detail)}` : ""}.`); return 1; }
  const meta = await landedMeta(connection, result.signature);
  const after = fields((await connection.getAccountInfo(a.state, "confirmed")).data);
  const balance1 = await connection.getBalance(wallet.publicKey, "confirmed");
  console.log(`landed    ${result.signature}${meta.units ? `, ${meta.units} CU` : ""}`);
  console.log(`amount    ${sol(after.withdrawn - f0.withdrawn)} SOL withdrawn; wallet ${sol(balance0)} -> ${sol(balance1)} SOL`);
  for (const m of memoLines(meta.logs)) console.log(`memo      ${m}`);
  console.log(`in all    ${sol(after.withdrawn)} SOL withdrawn by the developer, in ${after.withdrawals} withdrawal${after.withdrawals === 1 ? "" : "s"}`);
  if (!local) console.log(`see it    https://solscan.io/tx/${result.signature}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`\nSTOPPED: ${hide(error?.message ?? error)}\nNothing more was done.`); process.exit(1); });
}
