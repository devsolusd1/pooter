// Burns POOTER held by the developer's wallet (bought by hand with what withdraw-budget.mjs moved), so the
// coin's supply on chain goes down. One SPL Token burn_checked from the wallet's own POOTER account (its
// associated token account), signed by the wallet. Dry by default.
//
//   AMOUNT=1000000 node burn.mjs          # dry: what the wallet holds, the supply now and after, a simulation
//   AMOUNT=ALL SEND=1 node burn.mjs       # burns everything that account holds
//   AMOUNT=250000.5 SEND=1 node burn.mjs  # whole tokens, up to the coin's 6 decimals
//
// From Windows:  wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && AMOUNT=ALL node burn.mjs'
//
// It prints the supply before and after and the signature, ready to post. Settings come from the
// environment or from hunch/launch/.env, read as init-hunch.mjs reads it (HUNCH_ENV_FILE names another file,
// for a local rehearsal); SEND only from the command line. Nothing prints the RPC address or a key path.
//   RPC_URL    never printed
//   CLUSTER    mainnet-beta (default) or localnet
//   KEYPAIR    the wallet that holds the POOTER (the developer's); signs and pays
//   AMOUNT     whole tokens to burn, or ALL (required)
//   MINT       optional: the coin (default: launched.<cluster>.json's mint, else the program state's)
//   PRIORITY   micro-lamports per compute unit (default 50000)
// POOTER held in another token account of the wallet (not its associated one) is not touched.

import { need } from "../crank/deps.mjs";
import { addresses, ataOf, cuLimit, cuPrice, decodeState, hide, isLocal, keepSecret, landedMeta, simulate, wireSize, TOKEN } from "../crank/hunch-program.mjs";
import { applyEnv, home, readEnv, sendOnce } from "../launch/launch.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { clusterApiUrl, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = need("@solana/web3.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = resolve(HERE, "..", "launch");
const sol = (l) => (Number(l) / 1e9).toFixed(6);

/** Base units as tokens with `decimals`, grouped: 1,234,567.5 */
export function fmtUnits(units, decimals) {
  const u = BigInt(units), d = 10n ** BigInt(decimals);
  const whole = (u / d).toLocaleString("en-US");
  const frac = (u % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
/** "1000000", "250000.5" or "ALL" as base units (null for ALL). */
export function parseTokens(text, decimals) {
  const t = String(text ?? "").trim().replace(/[,_]/g, "");
  if (/^all$/i.test(t)) return null;
  const m = t.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));
  if (!m) throw new Error(`AMOUNT must be whole tokens (up to ${decimals} decimals) or ALL, not "${text ?? ""}"`);
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error("AMOUNT is 0");
  return units;
}

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
  const priority = Number.isFinite(Number(process.env.PRIORITY)) && Number(process.env.PRIORITY) >= 0 ? Number(process.env.PRIORITY) : 50000;
  for (const n of notes) console.log(`note      ${n}`);
  if (!process.env.AMOUNT) { console.log("REFUSED: say how much with AMOUNT (whole tokens) or AMOUNT=ALL. Nothing was sent."); return 1; }
  const keyPath = process.env.KEYPAIR;
  if (!keyPath || !existsSync(home(keyPath))) { console.log("REFUSED: KEYPAIR is not set, or no key file is there (the wallet holding the POOTER). Nothing was sent."); return 1; }
  let wallet;
  try { wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(home(keyPath), "utf8")))); } catch { console.log("REFUSED: KEYPAIR does not hold a key file I can read. Nothing was sent."); return 1; }
  const connection = new Connection(RPC_URL, "confirmed");

  // the coin: MINT, else launched.<cluster>.json's, else the program state's
  const RECORDS = local && process.env.HUNCH_RECORDS ? home(process.env.HUNCH_RECORDS) : LAUNCH;
  let mint = process.env.MINT ? new PublicKey(process.env.MINT) : null;
  const launchedFile = join(RECORDS, `launched.${CLUSTER}.json`);
  if (!mint && existsSync(launchedFile)) mint = new PublicKey(JSON.parse(readFileSync(launchedFile, "utf8")).mint);
  let ticker = "POOTER";
  const PROGRAM_FILE = local && process.env.HUNCH_PROGRAM_FILE ? home(process.env.HUNCH_PROGRAM_FILE) : join(LAUNCH, "program.json");
  const P = existsSync(PROGRAM_FILE) ? JSON.parse(readFileSync(PROGRAM_FILE, "utf8")) : {};
  if (typeof P[CLUSTER] === "string") {
    const st = decodeState((await connection.getAccountInfo(addresses(P[CLUSTER]).state, "confirmed"))?.data);
    if (st?.ticker) ticker = st.ticker;
    if (!mint && st) mint = st.mint;
  }
  if (!mint) { console.log("REFUSED: no coin: set MINT, or keep launched.<cluster>.json. Nothing was sent."); return 1; }
  const account = ataOf(wallet.publicKey, mint);
  const [mintInfo, accInfo] = await connection.getMultipleAccountsInfo([mint, account], "confirmed");
  if (!mintInfo || !mintInfo.owner.equals(TOKEN) || mintInfo.data.length < 82) { console.log(`REFUSED: ${mint} is not an SPL Token mint. Nothing was sent.`); return 1; }
  const decimals = mintInfo.data[44];
  const supply0 = mintInfo.data.readBigUInt64LE(36);
  const held = accInfo && accInfo.data.length >= 72 ? accInfo.data.readBigUInt64LE(64) : 0n;
  console.log(`cluster   ${CLUSTER}`);
  console.log(`coin      ${ticker} ${mint}, ${decimals} decimals; supply now ${fmtUnits(supply0, decimals)}`);
  console.log(`wallet    ${wallet.publicKey}, ${sol(await connection.getBalance(wallet.publicKey, "confirmed"))} SOL; it holds ${fmtUnits(held, decimals)} ${ticker} in ${account}`);
  let units;
  try { units = parseTokens(process.env.AMOUNT, decimals) ?? held; } catch (e) { console.log(`REFUSED: ${e.message}. Nothing was sent.`); return 1; }
  if (held === 0n) { console.log(`Nothing to burn: the wallet's ${ticker} account holds none. Nothing was sent.`); return 1; }
  if (units > held) { console.log(`REFUSED: AMOUNT is ${fmtUnits(units, decimals)} ${ticker}, more than the ${fmtUnits(held, decimals)} the wallet holds. Nothing was sent.`); return 1; }

  // SPL Token burn_checked (15): the wallet's account, the mint, the wallet as owner; amount and decimals
  const data = Buffer.alloc(10);
  data[0] = 15;
  data.writeBigUInt64LE(units, 1);
  data[9] = decimals;
  const burn = new TransactionInstruction({
    programId: TOKEN,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
    data,
  });
  const ixs = [cuLimit(20_000), cuPrice(priority), burn];
  const sim = await simulate(connection, ixs, wallet.publicKey, [mint]);
  console.log(`\n== the burn (simulated): ${fmtUnits(units, decimals)} ${ticker}, ${wireSize(sim.tx)} bytes, ${sim.units} CU`);
  if (sim.err) {
    console.log(`The simulation fails: ${JSON.stringify(sim.err)}`);
    for (const l of sim.logs.slice(-6)) console.log(`   ${l}`);
    console.log("Nothing was sent.");
    return 1;
  }
  const supplySim = Buffer.from(sim.accounts[0].data[0], "base64").readBigUInt64LE(36);
  console.log(`supply    ${fmtUnits(supply0, decimals)} -> ${fmtUnits(supplySim, decimals)} ${ticker} in the simulation`);
  if (!SEND) { console.log(`\nNothing was sent. To burn:  AMOUNT=${process.env.AMOUNT} SEND=1 node burn.mjs`); return 0; }

  console.log("\n== sending the burn");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const result = await sendOnce(connection, tx, [wallet]);
  if (result.outcome !== "landed") { console.log(`It did not land: ${result.outcome}${result.detail ? `, ${hide(result.detail)}` : ""}.`); return 1; }
  const meta = await landedMeta(connection, result.signature);
  const supply1 = (await connection.getAccountInfo(mint, "confirmed")).data.readBigUInt64LE(36);
  console.log(`landed    ${result.signature}${meta.units ? `, ${meta.units} CU` : ""}`);
  console.log(`\nBurned ${fmtUnits(units, decimals)} ${ticker}. Supply before: ${fmtUnits(supply0, decimals)}. Supply after: ${fmtUnits(supply1, decimals)}.`);
  console.log(`Signature: ${result.signature}${local ? "" : `\nhttps://solscan.io/tx/${result.signature}`}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`\nSTOPPED: ${hide(error?.message ?? error)}\nNothing more was done.`); process.exit(1); });
}
