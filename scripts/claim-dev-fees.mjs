// The developer's own trading fee: DBC's partner fee on Pooter's bonding curve, to the developer's wallet.
// The developer's wallet is the DBC config's fee claimer, so only it can claim this. The program's budget
// (Pooter's share, the creator fee) is a different counter and is not touched here: the hourly buy spends it,
// and withdraw-budget.mjs moves it to the developer, each in its own transaction. Only the partner part of
// lure-site/programs/examples/claim-fees.mjs is here (its creator part would be the budget's).
//
//   node claim-dev-fees.mjs           # dry: prints how much is claimable and simulates the claim
//   SEND=1 node claim-dev-fees.mjs    # claims it (SOL into the wallet; the temporary WSOL account is closed)
//
// From Windows:  wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && node claim-dev-fees.mjs'
//
// Built with the DBC SDK the launch tool uses (@meteora-ag/dynamic-bonding-curve-sdk 1.5.13,
// client.partner.claimPartnerTradingFee). After graduation the curve's fee stops growing (what is left on it
// can still be claimed here) and the developer's fee then comes from their locked DAMM v2 position (the
// partner's 67% of the migrated liquidity), which this script does not claim yet.
//
// Settings come from the environment or from hunch/launch/.env, read as init-hunch.mjs reads it
// (HUNCH_ENV_FILE names another file, for a local rehearsal). SEND only from the command line.
//   RPC_URL    never printed
//   CLUSTER    mainnet-beta (default) or localnet
//   KEYPAIR    the developer's wallet (the config's fee claimer); never printed
//   PRIORITY   micro-lamports per compute unit (default 50000)
//   POOL       optional: the DBC pool (default: launched.<cluster>.json's, else the program state's)

import { need } from "../crank/deps.mjs";
import { addresses, cuLimit, cuPrice, customCode, decodePool, decodeState, hide, isLocal, keepSecret, landedMeta, PHASE, PHASE_NAME, wireSize } from "../crank/hunch-program.mjs";
import { applyEnv, home, readEnv, sendOnce } from "../launch/launch.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { clusterApiUrl, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } = need("@solana/web3.js");
const { DynamicBondingCurveClient } = need("@meteora-ag/dynamic-bonding-curve-sdk");
const BN = need("bn.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = resolve(HERE, "..", "launch");
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);
// DBC VirtualPool (0.2.x): protocol fees 248/256, partner fees 264 (base) / 272 (quote), creator 352/360
const PARTNER_BASE_FEE = 264, PARTNER_QUOTE_FEE = 272, CREATOR_QUOTE_FEE = 360, PROTOCOL_QUOTE_FEE = 256;
const CONFIG_FEE_CLAIMER = 40;

async function main() {
  const envFile = process.env.HUNCH_ENV_FILE ? home(process.env.HUNCH_ENV_FILE) : join(LAUNCH, ".env");
  const notes = existsSync(envFile) ? applyEnv(readEnv(readFileSync(envFile)), process.env) : [];
  const CLUSTER = process.env.CLUSTER ?? "mainnet-beta";
  const local = CLUSTER === "localnet";
  const RPC_URL = process.env.RPC_URL || (local ? "http://127.0.0.1:8899" : clusterApiUrl(CLUSTER));
  if (process.env.RPC_URL) keepSecret(process.env.RPC_URL);
  const SEND = process.env.SEND === "1";
  if (local !== isLocal(RPC_URL)) { console.log(`REFUSED: CLUSTER is ${CLUSTER} but RPC_URL is ${local ? "not a local validator" : "a local validator"}. Nothing was sent.`); return 1; }
  const priority = Number(process.env.PRIORITY ?? 50000) >= 0 ? Number(process.env.PRIORITY ?? 50000) : 50000;
  for (const n of notes) console.log(`note      ${n}`);
  const keyPath = process.env.KEYPAIR;
  if (!keyPath || !existsSync(home(keyPath))) { console.log("REFUSED: KEYPAIR is not set, or no key file is there (the config's fee claimer). Nothing was sent."); return 1; }
  let wallet;
  try { wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(home(keyPath), "utf8")))); } catch { console.log("REFUSED: KEYPAIR does not hold a key file I can read. Nothing was sent."); return 1; }
  const connection = new Connection(RPC_URL, "confirmed");

  // the pool: POOL, else launched.<cluster>.json's, else the program's state
  const RECORDS = local && process.env.HUNCH_RECORDS ? home(process.env.HUNCH_RECORDS) : LAUNCH;
  let pool = process.env.POOL ? new PublicKey(process.env.POOL) : null;
  const launchedFile = join(RECORDS, `launched.${CLUSTER}.json`);
  if (!pool && existsSync(launchedFile)) pool = new PublicKey(JSON.parse(readFileSync(launchedFile, "utf8")).pool);
  let st = null;
  const PROGRAM_FILE = local && process.env.HUNCH_PROGRAM_FILE ? home(process.env.HUNCH_PROGRAM_FILE) : join(LAUNCH, "program.json");
  const P = existsSync(PROGRAM_FILE) ? JSON.parse(readFileSync(PROGRAM_FILE, "utf8")) : {};
  if (typeof P[CLUSTER] === "string") st = decodeState((await connection.getAccountInfo(addresses(P[CLUSTER]).state))?.data);
  if (!pool && st) pool = st.pool;
  if (!pool) { console.log("REFUSED: no pool: set POOL, or keep launched.<cluster>.json. Nothing was sent."); return 1; }

  const poolInfo = await connection.getAccountInfo(pool);
  const p = decodePool(poolInfo?.data);
  if (!p) { console.log(`REFUSED: ${pool} is not a DBC pool. Nothing was sent.`); return 1; }
  const cfg = (await connection.getAccountInfo(p.config))?.data;
  const claimer = new PublicKey(cfg.subarray(CONFIG_FEE_CLAIMER, CONFIG_FEE_CLAIMER + 32));
  const d = poolInfo.data;
  const partnerQuote = d.readBigUInt64LE(PARTNER_QUOTE_FEE), partnerBase = d.readBigUInt64LE(PARTNER_BASE_FEE);
  const bal0 = await connection.getBalance(wallet.publicKey);
  console.log(`cluster   ${CLUSTER}`);
  console.log(`pool      ${pool} (DBC${p.isMigrated ? ", migrated" : ""}), config ${p.config}`);
  console.log(`claimer   ${claimer} (the config's fee claimer)`);
  console.log(`wallet    ${wallet.publicKey}${wallet.publicKey.equals(claimer) ? " (the fee claimer)" : ""}, ${sol(bal0)} SOL`);
  console.log(`claimable ${sol(partnerQuote)} SOL of partner trading fee${partnerBase > 0n ? `, and ${partnerBase} base units` : ""}`);
  console.log(`not yours (not touched): ${sol(d.readBigUInt64LE(CREATOR_QUOTE_FEE))} SOL of creator fee (Pooter's budget), ${sol(d.readBigUInt64LE(PROTOCOL_QUOTE_FEE))} SOL of protocol fee (Meteora)`);
  if (p.isMigrated || (st && st.phase >= PHASE.GRADUATING)) {
    console.log(`after graduation (Pooter's phase: ${st ? PHASE_NAME[st.phase] : "?"}): the curve earns no more fees. Your fee from the new pool comes from your locked DAMM v2 position (the partner's 67% of the migrated liquidity), claimed from DAMM v2 with that position's NFT; this script does not do that yet.`);
  }
  if (!wallet.publicKey.equals(claimer)) { console.log("REFUSED: this wallet is not the config's fee claimer; DBC would refuse it. Nothing was sent."); return 1; }
  if (partnerQuote === 0n && partnerBase === 0n) { console.log("Nothing to claim. Nothing was sent."); return 0; }

  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const built = await client.partner.claimPartnerTradingFee({
    // everything owed when it runs (as claim-fees.mjs asks): a fee that grows between this read and the send is claimed too
    feeClaimer: wallet.publicKey, payer: wallet.publicKey, pool, maxBaseAmount: new BN("18446744073709551615"), maxQuoteAmount: new BN("18446744073709551615"),
  });
  const tx = new Transaction().add(cuLimit(200_000), cuPrice(priority), ...built.instructions);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = (await connection.simulateTransaction(tx, undefined, [wallet.publicKey, pool])).value;
  if (sim.err) {
    console.log(`The simulation fails: ${JSON.stringify(sim.err)}${customCode(sim.err) !== null ? ` (DBC error ${customCode(sim.err)})` : ""}`);
    for (const l of (sim.logs ?? []).slice(-6)) console.log(`   ${l}`);
    console.log("Nothing was sent.");
    return 1;
  }
  const after = Buffer.from(sim.accounts[1].data[0], "base64");
  const gain = BigInt(sim.accounts[0].lamports) - BigInt(bal0);
  // the SDK also creates the wallet's own coin account if it has none (its rent is the wallet's, back if it is closed)
  const coinAta = PublicKey.findProgramAddressSync([wallet.publicKey.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(d.subarray(136, 168)).toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
  const hasCoinAta = !!(await connection.getAccountInfo(coinAta));
  console.log(`\n== the claim (simulated): ${built.instructions.length} instructions, ${wireSize(tx)} bytes, ${sim.unitsConsumed ?? "?"} CU`);
  console.log(`wallet    the claim pays ${sol(partnerQuote)} SOL into it; the simulated balance change is +${sol(gain)} SOL (less the network fee${hasCoinAta ? "" : " and the rent of the coin account the SDK creates for this wallet, which has none yet"}); partner fee left on the pool ${sol(after.readBigUInt64LE(PARTNER_QUOTE_FEE))} SOL`);
  console.log(`untouched creator fee ${sol(after.readBigUInt64LE(CREATOR_QUOTE_FEE))} SOL, protocol fee ${sol(after.readBigUInt64LE(PROTOCOL_QUOTE_FEE))} SOL`);
  if (!SEND) { console.log("\nNothing was sent. To claim:  SEND=1 node claim-dev-fees.mjs"); return 0; }

  console.log("\n== sending the claim");
  const send = new Transaction().add(cuLimit(200_000), cuPrice(priority), ...built.instructions);
  send.feePayer = wallet.publicKey;
  const result = await sendOnce(connection, send, [wallet]);
  if (result.outcome !== "landed") { console.log(`It did not land: ${result.outcome}${result.detail ? `, ${hide(result.detail)}` : ""}.`); return 1; }
  const meta = await landedMeta(connection, result.signature);
  const bal1 = await connection.getBalance(wallet.publicKey);
  const left = (await connection.getAccountInfo(pool)).data.readBigUInt64LE(PARTNER_QUOTE_FEE);
  console.log(`landed    ${result.signature}${meta.units ? `, ${meta.units} CU` : ""}`);
  console.log(`wallet    ${sol(bal0)} -> ${sol(bal1)} SOL (+${sol(BigInt(bal1) - BigInt(bal0))}); partner fee left on the pool ${sol(left)} SOL`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`\nSTOPPED: ${hide(error?.message ?? error)}\nNothing more was done.`); process.exit(1); });
}
