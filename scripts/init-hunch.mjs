// Starts the Hunch program on a cluster, in two steps, dry by default (nothing is sent without BOTH
// SEND=1 and STEP):
//
//   node init-hunch.mjs                          # the plan: what is on chain, what is next, a simulation of it
//   SEND=1 STEP=initialize node init-hunch.mjs   # BEFORE the token: creates Hunch's accounts (state, model,
//                                                #   tape, open call, diary, brain book, the budget's WSOL account)
//                                                #   for the token address in MINT_KEYPAIR, and stores the coin's
//                                                #   ticker (token.json's symbol). Upgrade authority only.
//   SEND=1 STEP=adopt node init-hunch.mjs        # A FALLBACK: launch step 2 sends adopt_curve in the pool-creating
//                                                #   transaction, so this finds Hunch running. Only if step 2 left
//                                                #   Hunch in phase setup: Hunch checks the pool and its config
//                                                #   against its compiled values, pins them, and starts the curve phase
//
// From Windows:  wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && <command>'
//
// Settings are the launch tool's: hunch/launch/.env (or the environment), hunch/launch/program.json
// (the program's address per cluster), hunch/launch/token.json (its symbol is the ticker initialize stores,
// for good: the diary names the coin by it), hunch/launch/launched.<cluster>.json (the pool, written by step 2).
// The ticker must pass the program's own rule (1 to 10 characters, A-Z and 0-9 only): anything else is
// refused here, before a simulation, rather than failing on chain with BAD_TICKER.
//   RPC_URL             never shown
//   CLUSTER             mainnet-beta (default) or localnet
//   KEYPAIR             pays; for STEP=initialize it must be the program's upgrade authority (the deployer)
//   AUTHORITY_KEYPAIR   optional: the upgrade authority, when it is not KEYPAIR
//   MINT_KEYPAIR        the token's key file (only its public key is used): the SAME file launch.mjs creates the
//                       token with. initialize happens once, for good: Hunch cannot be initialized again for
//                       another address. MINT=<address> is accepted on a local rehearsal only.
//   PRIORITY            micro-lamports per compute unit (default 50000)
// No key path and no key is ever printed.

import { need } from "../crank/deps.mjs";
import {
  addresses, adoptCurveIx, adoptionProblems, cuLimit, cuPrice, decodePool, decodeState, errText, hide, initializeIx, isLocal, keepSecret, PHASE_NAME,
} from "../crank/hunch-program.mjs";
import { adoptable, applyEnv, home, readEnv, sendOnce, storedTicker, tickerOk } from "../launch/launch.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { clusterApiUrl, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } = need("@solana/web3.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = resolve(HERE, "..", "launch");
const SEED = 12346; // hunch-net SEED (programs/hunch-net/src/lib.rs, site/core/net.js)
const PACKET = 1232;
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);

// The ticker rule (tickerOk), the ticker State holds (storedTicker) and the adoption checks with the
// first-swap flag at 0 or 1 accepted (adoptable) come from the launch tool, which applies the same ones.

// initialize's data is 47 + n bytes: tag, mint, seed, the nine bumps (46 bytes), then n and the ticker.
// crank/hunch-program.mjs builds all of them (and refuses a bad ticker); the result is checked here byte
// for byte against the layout before anything is simulated (a bare 46-byte head is completed).
export function withTicker(ix, ticker) {
  if (!tickerOk(ticker)) throw new Error(`the ticker ${JSON.stringify(ticker)} is not 1 to 10 of A-Z and 0-9`);
  const head = Buffer.from(ix.data.subarray(0, 46));
  const want = Buffer.concat([head, Buffer.from([ticker.length]), Buffer.from(ticker, "latin1")]);
  if (head[0] !== 0 || !(ix.data.length === 46 || Buffer.from(ix.data).equals(want))) {
    throw new Error(`crank/hunch-program.mjs built initialize data of ${ix.data.length} bytes, not the 46-byte head or the ${want.length} bytes with this ticker`);
  }
  ix.data = want;
  return ix;
}

// The DBC config's migration_sqrt_price (u128 LE at 280) and the copy adopt_curve pins in State (at 1,200,
// the review fix of 2026-10-16): adopt_pool measures Hunch's position against the liquidity DBC builds from it.
const CONFIG_MIGRATION_SQRT_PRICE_AT = 280, STATE_MIGRATION_SQRT_PRICE_AT = 1200;
const u128At = (d, o) => (d && d.length >= o + 16 ? Buffer.from(d).readBigUInt64LE(o) | (Buffer.from(d).readBigUInt64LE(o + 8) << 64n) : null);
const migrationSqrtPriceOf = (d) => (d && d.length === 1248 ? u128At(d, STATE_MIGRATION_SQRT_PRICE_AT) : null);

async function main() {
  const notes = existsSync(join(LAUNCH, ".env")) ? applyEnv(readEnv(readFileSync(join(LAUNCH, ".env"))), process.env) : [];
  const CLUSTER = process.env.CLUSTER ?? "mainnet-beta";
  const local = CLUSTER === "localnet";
  const RPC_URL = process.env.RPC_URL || (local ? "http://127.0.0.1:8899" : clusterApiUrl(CLUSTER));
  if (process.env.RPC_URL) keepSecret(process.env.RPC_URL);
  const SEND = process.env.SEND === "1";
  const STEP = (process.env.STEP ?? "").trim().toLowerCase();
  if (STEP && !["initialize", "adopt"].includes(STEP)) { console.log(`REFUSED: STEP must be initialize or adopt, not "${STEP}". Nothing was sent.`); return 1; }
  if (local !== isLocal(RPC_URL)) { console.log(`REFUSED: CLUSTER is ${CLUSTER} but RPC_URL is ${local ? "not a local validator" : "a local validator"}. Nothing was sent.`); return 1; }
  const PROGRAM_FILE = local && process.env.HUNCH_PROGRAM_FILE ? home(process.env.HUNCH_PROGRAM_FILE) : join(LAUNCH, "program.json");
  const TOKEN_FILE = local && process.env.HUNCH_TOKEN_FILE ? home(process.env.HUNCH_TOKEN_FILE) : join(LAUNCH, "token.json");
  const RECORDS = local && process.env.HUNCH_RECORDS ? home(process.env.HUNCH_RECORDS) : LAUNCH;
  const priority = Number(process.env.PRIORITY ?? 50000) >= 0 ? Number(process.env.PRIORITY ?? 50000) : 50000;
  for (const n of notes) console.log(`note      ${n}`);

  const readKey = (envName) => {
    const path = process.env[envName];
    if (!path || !existsSync(home(path))) return null;
    try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(home(path), "utf8")))); } catch { throw new Error(`${envName} does not hold a key file I can read`); }
  };
  const wallet = readKey("KEYPAIR");
  const authority = readKey("AUTHORITY_KEYPAIR") ?? wallet;
  // on a real cluster only the key file: a typed address can name a token nobody can create (a lost or
  // other key file), and initialize for it could never be undone
  if (!local && process.env.MINT && !readKey("MINT_KEYPAIR")) {
    console.log("REFUSED: MINT=<address> is only for a local rehearsal. On a real cluster set MINT_KEYPAIR to the token's key file, the one launch.mjs will create the token with: initialize binds Hunch to that address for good. Nothing was sent.");
    return 1;
  }
  const mintKey = readKey("MINT_KEYPAIR")?.publicKey ?? (local && process.env.MINT ? new PublicKey(process.env.MINT) : null);
  const missing = [];
  const T = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  const ticker = typeof T.symbol === "string" ? T.symbol : "";
  const tickerGood = tickerOk(ticker);
  if (!tickerGood) missing.push(`token.json's symbol ${JSON.stringify(T.symbol ?? null)} is not a ticker the program stores (1 to 10 characters, A-Z and 0-9 only, upper case): initialize would fail with BAD_TICKER`);
  if (!wallet) missing.push("KEYPAIR is not set, or no key file is there");
  if (!mintKey) missing.push(`MINT_KEYPAIR is not set, or no key file is there${local ? " (or MINT=<address> on a local rehearsal)" : ""}: initialize needs the token's address`);

  const P = JSON.parse(readFileSync(PROGRAM_FILE, "utf8"));
  if (typeof P[CLUSTER] !== "string") { console.log(`REFUSED: program.json has no Hunch program address for ${CLUSTER}. Nothing was sent.`); return 1; }
  const A = addresses(P[CLUSTER]);
  const connection = new Connection(RPC_URL, "confirmed");
  const [progInfo, pdInfo, stInfo] = await connection.getMultipleAccountsInfo([A.program, A.programdata, A.state]);
  const deployed = !!progInfo?.executable;
  const upgradeAuthority = pdInfo && pdInfo.data.length >= 45 && pdInfo.data[12] === 1 ? new PublicKey(pdInfo.data.subarray(13, 45)) : null;
  const st = decodeState(stInfo?.data);
  console.log(`cluster   ${CLUSTER}`);
  console.log(`program   ${A.program}${deployed ? `, upgrade authority ${upgradeAuthority ?? "none"}` : "  NOT DEPLOYED"}`);
  console.log(`budget    ${A.budget} (its WSOL account ${A.budgetWsol})`);
  const onChainTicker = storedTicker(stInfo?.data);
  console.log(`state     ${st ? `phase ${PHASE_NAME[st.phase]}, token ${st.mint}, ticker ${onChainTicker ?? "NONE (an older layout)"}, ${st.ticks} ticks${st.phase >= 1 ? `, pool ${st.pool}` : ""}` : stInfo ? "PRESENT BUT NOT READABLE" : "not initialized"}`);
  console.log(`ticker    ${tickerGood ? ticker : `${JSON.stringify(T.symbol ?? null)}  NOT A TICKER THE PROGRAM STORES`} (token.json's symbol; initialize stores it for good and the diary names the coin by it)`);
  if (st && onChainTicker !== ticker) missing.push(`Hunch was initialized with the ticker ${onChainTicker ?? "(none)"}, but token.json's symbol is ${JSON.stringify(ticker)}: the diary would name another coin`);
  if (wallet) console.log(`payer     ${wallet.publicKey} (${sol(await connection.getBalance(wallet.publicKey))} SOL)`);
  if (!deployed) missing.push("the program is not deployed on this cluster (scripts/deploy-program.sh)");

  const next = !st ? "initialize" : st.phase === 0 ? "adopt" : null;
  if (!next) {
    console.log(`\nHunch is running (phase ${PHASE_NAME[st.phase]}). Nothing left to start${SEND ? ": REFUSED, nothing was sent" : ""}.`);
    return SEND ? 1 : 0;
  }

  let ixs, signers, label, configBytes = null;
  if (next === "initialize") {
    if (authority && upgradeAuthority && !authority.publicKey.equals(upgradeAuthority)) missing.push("the signer is not the program's upgrade authority (initialize would fail with NOT_AUTHORITY)");
    if (!authority || !mintKey || !tickerGood) { report(); return SEND ? 1 : 0; }
    const ix = withTicker(initializeIx(A, authority.publicKey, mintKey, SEED, ticker), ticker);
    ixs = [ix];
    signers = authority.publicKey.equals(wallet.publicKey) ? [wallet] : [wallet, authority];
    label = `initialize for the token ${mintKey} (seed ${SEED}, ticker ${ticker}, ${ix.data.length} bytes of data)`;
  } else {
    const launchedPath = join(RECORDS, `launched.${CLUSTER}.json`);
    if (!existsSync(launchedPath)) { missing.push(`launched.${CLUSTER}.json is not there yet: launch step 2 writes it`); report(); return SEND ? 1 : 0; }
    const L = JSON.parse(readFileSync(launchedPath, "utf8"));
    const pool = new PublicKey(L.pool), config = new PublicKey(L.config), mint = new PublicKey(L.mint);
    const [poolInfo, cfgInfo] = await connection.getMultipleAccountsInfo([pool, config]);
    configBytes = cfgInfo?.data ?? null;
    const p = decodePool(poolInfo?.data);
    if (!p) missing.push(`the pool ${pool} is not on chain`);
    else if (!p.creator.equals(A.budget)) missing.push(`the pool's creator is ${p.creator}, not the budget PDA: adopt_curve would refuse it`);
    if (!st.mint.equals(mint)) missing.push(`Hunch was initialized for ${st.mint}, but the launched token is ${mint}`);
    const problems = cfgInfo ? adoptable(adoptionProblems(cfgInfo.data, A.budget), cfgInfo.data) : ["the config is not on chain"];
    if (problems.length) missing.push(`the config fails the program's checks: ${problems.join("; ")}`);
    if (!wallet) { report(); return SEND ? 1 : 0; }
    ixs = [adoptCurveIx(A, wallet.publicKey, { pool, config, mint })];
    signers = [wallet];
    label = `adopt_curve on the pool ${pool}`;
  }

  // simulate with room, then set the limit from the units used
  const front = (units) => [cuLimit(units), ...(priority > 0 ? [cuPrice(priority)] : [])];
  const build = (units) => { const tx = new Transaction().add(...front(units), ...ixs); tx.feePayer = wallet.publicKey; return tx; };
  let tx = build(400000);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const watch = next === "initialize" ? [A.state, A.model, A.tape, A.signal, A.diary, A.book, A.budgetWsol] : [A.state];
  const before = await connection.getBalance(wallet.publicKey);
  const sim = (await connection.simulateTransaction(tx, undefined, [wallet.publicKey, ...watch])).value;
  if (sim.err) {
    console.log(`\nREFUSED in simulation: ${label}: ${errText(sim.err)}\n${(sim.logs ?? []).slice(-8).join("\n")}`);
    report();
    console.log("Nothing was sent.");
    return 1;
  }
  const units = sim.unitsConsumed ?? 0;
  const limit = Math.min(400000, Math.ceil((units * 1.3 + 10000) / 1000) * 1000);
  tx = build(limit);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const bytes = tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures;
  const fee = 5000 * tx.compileMessage().header.numRequiredSignatures + Math.ceil(limit * priority / 1e6);
  const rent = (sim.accounts ?? []).slice(1).reduce((s, a) => s + (a?.lamports ?? 0), 0);
  console.log(`\n${label}: simulates cleanly, ${units} compute units (limit ${limit}), ${bytes} of ${PACKET} bytes.`);
  if (next === "initialize") {
    console.log(`   rent of the seven accounts: ${sol(rent)} SOL, paid by the upgrade authority; network fee ${sol(fee)} SOL`);
    const simTicker = storedTicker(sim.accounts?.[1]?.data ? Buffer.from(sim.accounts[1].data[0], "base64") : null);
    console.log(`   the state reads back from the simulation with the ticker ${simTicker ?? "(none)"}`);
    if (simTicker !== ticker) missing.push(`in simulation the state holds the ticker ${simTicker ?? "(none)"}, not ${ticker}`);
  } else {
    const afterBytes = Buffer.from(sim.accounts[1].data[0], "base64");
    const after = decodeState(afterBytes);
    console.log(`   after it: phase ${PHASE_NAME[after?.phase] ?? "?"}, pool ${after?.pool}; it costs ${sol(before - sim.accounts[0].lamports)} SOL (the budget's HUNCH account rent and the fee)`);
    // adopt_curve pins the config's migration sqrt price, which adopt_pool measures Hunch's position against
    const pinned = migrationSqrtPriceOf(afterBytes), want = configBytes ? u128At(configBytes, CONFIG_MIGRATION_SQRT_PRICE_AT) : null;
    console.log(`   it pins the migration sqrt price ${pinned ?? "(none: an older layout)"}${want !== null ? ` (the config's: ${want})` : ""}`);
    if (!pinned || pinned !== want) missing.push(`in simulation adopt_curve pinned the migration sqrt price ${pinned ?? "(none)"}, not the config's ${want}: adopt_pool would refuse Hunch's position after graduation`);
  }
  if (bytes > PACKET) missing.push(`the transaction is ${bytes} bytes`);
  report();
  const command = `SEND=1 STEP=${next} node init-hunch.mjs`;
  if (!SEND) { console.log(`\nNothing was sent. The next step is ${next}:\n   ${command}`); return 0; }
  if (STEP !== next) { console.log(`\nREFUSED: ${STEP ? `STEP=${STEP} was asked, but the next step is ${next}` : "SEND=1 alone sends nothing"}:\n   ${command}\nNothing was sent.`); return 1; }
  if (missing.length) { console.log("\nREFUSED: not sending while the list above stands. Nothing was sent."); return 1; }
  console.log(`\nSending: ${label} ...`);
  const result = await sendOnce(connection, tx, signers, { exists: async () => { const s = decodeState((await connection.getAccountInfo(A.state))?.data); return next === "initialize" ? !!s : s?.phase >= 1; } });
  if (result.outcome === "landed") {
    const info = await connection.getAccountInfo(A.state);
    const s = decodeState(info?.data);
    console.log(`\nDone: ${label}. Hunch is in phase ${PHASE_NAME[s?.phase] ?? "?"}.`);
    const back = storedTicker(info?.data);
    if (back !== ticker) { console.log(`\nWARNING: the state holds the ticker ${back ?? "(none)"}, not token.json's ${ticker}. Stop and look before the launch.`); return 1; }
    console.log(`   the state holds the ticker ${back}, as token.json's symbol.`);
    if (next === "initialize") console.log("Next: the launch tool, step 1 (config) then step 2 (token), which adopts the pool in the same transaction. Keep the MINT_KEYPAIR file: it is the only address Hunch will adopt.");
    else {
      const pinned = migrationSqrtPriceOf(info?.data), want = u128At(configBytes, CONFIG_MIGRATION_SQRT_PRICE_AT);
      if (!pinned || pinned !== want) { console.log(`\nWARNING: the state pinned the migration sqrt price ${pinned ?? "(none)"}, not the config's ${want}. Stop and look: adopt_pool would refuse the position after graduation.`); return 1; }
      console.log(`   the state pinned the migration sqrt price ${pinned}, as the config holds it.`);
      console.log("Next: start the crank (hunch/crank). Ticks are refused until 5 s after the pool opened; the first tick is only a baseline.");
    }
    return 0;
  }
  console.log(`\nIt did NOT land (${result.outcome}${result.detail ? `: ${hide(result.detail)}` : ""}). Run the plan (no SEND) before trying again.`);
  return 1;

  function report() {
    if (missing.length) console.log(`\nNOT READY TO SEND:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
  }
}

// Run only as a command: launch/test imports the pieces above (the ticker rule, the data, the config filter).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`\nSTOPPED: ${hide(error?.message ?? error)}\nNothing more was done.`); process.exit(1); });
}
