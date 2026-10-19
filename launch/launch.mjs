// Creates $HUNCH on a Meteora bonding curve whose creator is the Hunch program's budget PDA. Adapted
// from the Infinite Monkey launch tool (infinite-monkey/launch/launch.mjs, left as it was): the same
// two steps, dry by default, nothing sent unless BOTH SEND=1 and STEP are given.
//
//   node launch.mjs                       # the plan: everything, which step is next, and a simulation of it
//   SEND=1 STEP=config node launch.mjs    # step 1: the curve's settings. Not public; nobody can trade it yet.
//   SEND=1 STEP=token node launch.mjs     # step 2: the token and its pool, with the pool's creator handed to
//                                         #         the budget PDA and the pool adopted by Hunch (adopt_curve)
//                                         #         in the SAME transaction, and, when
//                                         #         token.json's devBuySol is above 0, the developer's buy
//                                         #         in that transaction too, as the pool's first swap
//
// From Windows, each of these goes inside:  wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/launch && <command>'
//
// What is different from $MONKEY's tool:
// - The fee, the opening fee, the creator share, the LP split, the decimals and the immutable metadata
//   are compiled into the Hunch program: adopt_curve refuses a pool made from any other config. So
//   token.json must hold exactly those values, and every config (simulated in step 1, on chain in step 2)
//   is put through the program's own adoption checks here, byte for byte.
// - The config's fee claimer is the dev wallet (it gets the partner's 67% of the post-Meteora fee: 2.01%
//   of each trade); its leftover receiver is the budget PDA.
// - Step 2 is createPool, transferPoolCreator(new creator = the budget PDA) and Hunch's adopt_curve in one
//   transaction. The SDK's transferPoolCreator() helper reads the pool first and fails before the pool
//   exists, so the instruction comes from the program's own builder (and is checked against a hand-built
//   copy). Step 2 is refused unless its simulation reads the new pool back with creator == the budget PDA
//   and Hunch's state in the curve phase, holding this mint, the ticker and the config's migration price.
// - Why adopt_curve rides in step 2: the pool trades from the moment it exists, and adopt_curve refuses a
//   pool DBC has migrated. Sent separately, a curve bought out and migrated before it landed (65 to 113 SOL
//   of buys after the 5-second opening fee, then anyone's migration call) would leave the budget's fees,
//   surplus and LP position out of every instruction's reach until a program upgrade.
// - Step 2 also needs the Hunch program deployed and initialized with this token's address and with
//   token.json's symbol as its ticker (run ../scripts/init-hunch.mjs first). init-hunch.mjs STEP=adopt
//   remains only as a fallback (for a step 2 made by an older version of this tool).
// - The developer's buy (token.json devBuySol above 0) rides inside step 2: createPool, the creator
//   transfer to the budget PDA, the developer's WSOL wrapped and coin account made, then DBC swap2 (buy,
//   exact in) with the instructions sysvar and no referral. Only then is the config's "first swap with min
//   fee" set (the program accepts it since 2026-10-16, design/layout-final.md): DBC charges that one swap
//   3.75%, the schedule's end, because an earlier instruction of its own transaction created the pool, so
//   no outside trader can get it. Without a buy the flag stays off. Step 2 is refused unless its
//   simulation reads back the budget PDA as the creator and fee counters of exactly 3.75% of the buy.
//   There is no separate buy step any more: a buy after step 2 would pay the opening schedule.
//
// Settings: token.json (the token), program.json (the Hunch program's address per cluster). Where it
// runs comes from .env in this folder or the environment (the same names as $MONKEY's tool):
//   RPC_URL       the cluster to talk to. It is never shown, whatever goes wrong.
//   CLUSTER       mainnet-beta (default) or localnet (a local validator: then RPC_URL must be local)
//   KEYPAIR       the dev wallet's key file: pays, is the config's fee claimer, creates the pool (and hands
//                 the creator role to the budget PDA at once). Its path is never shown.
//   MINT_KEYPAIR  the key file of the token's address, made beforehand. Its path is never shown.
//   PAYER         an address to simulate with when there is no key file yet
//   SOL_USD       the SOL price to convert with; read from Jupiter when not given
//   PRIORITY      a price per compute unit, in micro-lamports (default 50000)
// SEND and STEP are only ever read from the command line, never from .env.
// Records (no secrets): pending.<cluster>.json after step 1, launched.<cluster>.json after step 2.

import { need } from "../crank/deps.mjs";
import {
  addresses, adoptionProblems, adoptCurveIx, configFacts, decodePool, decodeState, transferPoolCreatorIx, keepSecret, hide, isLocal,
  bs58 as base58, COMPILED, PHASE_NAME, liveFeeNumerator, OPENING_SECONDS, DBC, DBC_POOL_AUTHORITY, DBC_EVENT_AUTHORITY, TOKEN, SYSVAR_INSTRUCTIONS,
} from "../crank/hunch-program.mjs";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = need("@meteora-ag/dynamic-bonding-curve-sdk");
const {
  AccountLayout, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction,
  getAssociatedTokenAddressSync, NATIVE_MINT,
} = need("@solana/spl-token");
const { clusterApiUrl, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction } = need("@solana/web3.js");
const BN = need("bn.js");
const {
  ActivationType, BaseFeeMode, buildCurveWithMarketCap, CollectFeeMode, DammV2DynamicFeeMode, deriveDbcPoolAddress, deriveDbcTokenVaultAddress,
  DynamicBondingCurveClient, getPriceFromSqrtPrice, MigratedCollectFeeMode, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType,
} = sdk;

const DECIMALS = 6;
const MIN_OUT_UNDER_BPS = 50; // a dev buy fails if it would get more than 0.5% less than computed
const MAX_SOL_DRIFT = 0.1; // step 2 refuses if SOL has moved more than this since step 1
const PACKET = 1232; // the most bytes a transaction may have
const TOKEN_ACCOUNT_RENT = 2_039_280; // adopt_curve makes the budget's coin account in step 2; the dev wallet pays its rent
// The DBC config's migration_sqrt_price (u128 LE at 280), which adopt_curve pins in State at 1,200
export const CONFIG_MIGRATION_SQRT_PRICE_AT = 280;
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- pieces that touch nothing: exported so that they can be tested on their own ----

// The program's ticker rule (programs/hunch/src/layout.rs ticker_ok): initialize stores token.json's symbol
// as the coin's ticker, and the diary names the coin by it.
export const tickerOk = (t) => typeof t === "string" && /^[A-Z0-9]{1,10}$/.test(t);
// The ticker the Hunch State holds (offset 1,184, 16 bytes, zero-padded), or null for a State without one.
export const STATE_TICKER_AT = 1184;
export function storedTicker(d) {
  if (!d || d.length < STATE_TICKER_AT + 16) return null;
  const raw = Buffer.from(d.subarray(STATE_TICKER_AT, STATE_TICKER_AT + 16)), end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? 16 : end).toString("latin1");
}

// DBC's "first swap with min fee": on only when the developer buys in step 2 (the program accepts 0 or 1).
export const firstSwapFlag = (T) => typeof T?.devBuySol === "number" && T.devBuySol > 0;
// adopt_curve accepts the flag at 0 or 1 (design/layout-final.md, the last section). The copy of its checks
// in crank/hunch-program.mjs may still list the flag as a problem: that line is dropped when the byte is 0 or 1.
export const FIRST_SWAP_FLAG_AT = 365;
export const adoptable = (problems, config) =>
  problems.filter((p) => !(p === "no first-swap-with-min-fee" && config?.[FIRST_SWAP_FLAG_AT] <= 1));

// DBC's swap2 discriminator, and the fee DBC takes on a buy: on the input, rounded up (fee_on_amount).
export const SWAP2_DISC = createHash("sha256").update("global:swap2").digest().subarray(0, 8);
export const ENDING_FEE_NUMERATOR = 37_500_000n; // 3.75%, the end of the opening schedule
export const feeOnBuy = (lamports, numerator = ENDING_FEE_NUMERATOR) => (BigInt(lamports) * numerator + 999_999_999n) / 1_000_000_000n;
// The pool's fee counters (trading + protocol, in SOL): what every swap so far has paid in fees.
export const poolFeesPaid = (d) => d.readBigUInt64LE(336) + d.readBigUInt64LE(320);

// DBC swap2 for the developer's buy inside the pool-creating transaction, by hand: the 15 named accounts
// (no referral: DBC's own id in that slot), then the instructions sysvar, which DBC reads to see that an
// earlier instruction of this transaction created the pool. A buy spends `lamports` of the developer's
// WSOL (exact in) and asks at least `minOut` units back.
export function devBuySwapIx({ pool, config, mint, owner, lamports, minOut }) {
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  SWAP2_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(lamports.toString()), 8);
  data.writeBigUInt64LE(BigInt(minOut.toString()), 16);
  data[24] = 0; // ExactIn
  const k = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: DBC,
    keys: [
      k(DBC_POOL_AUTHORITY), k(config), k(pool, true),
      k(getAssociatedTokenAddressSync(NATIVE_MINT, owner), true), k(getAssociatedTokenAddressSync(mint, owner), true),
      k(deriveDbcTokenVaultAddress(pool, mint), true), k(deriveDbcTokenVaultAddress(pool, NATIVE_MINT), true),
      k(mint), k(NATIVE_MINT), k(owner, false, true), k(TOKEN), k(TOKEN), k(DBC), k(DBC_EVENT_AUTHORITY), k(DBC),
      k(SYSVAR_INSTRUCTIONS),
    ],
    data,
  });
}

// What the developer's buy adds to step 2, after createPool and the creator transfer: the WSOL account,
// the SOL into it and sync_native, the coin account, the swap, and the WSOL account closed again (its rent
// and any SOL left come back to the wallet). `close` false leaves the WSOL account open (fewer bytes);
// `wrap` false leaves out the WSOL account and the SOL into it, for a wallet whose WSOL account already
// holds the buy (spl-token wrap beforehand), which takes about 40 bytes off.
export function devBuyIxs({ pool, config, mint, owner, lamports, minOut, close = true, wrap = true }) {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  return [
    ...(wrap ? [
      createAssociatedTokenAccountIdempotentInstruction(owner, wsol, owner, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: BigInt(lamports.toString()) }),
      createSyncNativeInstruction(wsol),
    ] : []),
    createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(mint, owner), owner, mint),
    devBuySwapIx({ pool, config, mint, owner, lamports, minOut }),
    ...(close ? [createCloseAccountInstruction(wsol, owner, owner)] : []),
  ];
}

// Reads a .env the way people on Windows really save one (as $MONKEY's tool does).
export function readEnv(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString("utf16le");
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2))).swap16().toString("utf16le");
  else if (bytes.length > 1 && bytes[0] !== 0 && bytes[1] === 0) text = bytes.toString("utf16le");
  else text = bytes.toString("utf8");
  const edges = /^[\s\uFEFF\u200B]+|[\s\uFEFF\u200B]+$/g;
  const found = {};
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(edges, "");
    const equals = line.indexOf("=");
    if (line.startsWith("#") || equals < 1) continue;
    const name = line.slice(0, equals).replace(/^export\s+/i, "").replace(edges, "").toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    let value = line.slice(equals + 1).replace(edges, "");
    const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/) ?? value.match(/^[\u201C\u201D](.*)[\u201C\u201D]$/) ?? value.match(/^[\u2018\u2019](.*)[\u2018\u2019]$/);
    value = quoted ? quoted[1] : value.replace(/\s+#.*$/, "");
    if (value) found[name] = value;
  }
  return found;
}

export function applyEnv(found, env) {
  const notes = [];
  for (const [name, value] of Object.entries(found)) {
    if (name === "SEND" || name === "STEP") notes.push(`${name} in .env is ignored: sending is only ever asked for on the command line`);
    else if (env[name] === undefined) env[name] = value;
  }
  return notes;
}

// "~" is the home folder; a Windows path (C:\Users\...) is found where WSL keeps that drive.
export function home(path, platform = process.platform) {
  const drive = platform !== "win32" && path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  return path.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "");
}

// token.json against what the Hunch program has compiled in. Gives a line for each difference.
export function tokenProblems(T, { local = false } = {}) {
  const out = [];
  const want = [
    ["curveFeeBps", 375], ["poolFeeBps", COMPILED.migratedPoolFeeBps], ["openingFeeBps", 5000], ["openingFeeSeconds", OPENING_SECONDS],
    ["creatorSharePct", COMPILED.creatorTradingFeePct], ["partnerLockedLpPct", COMPILED.partnerLockedPct], ["creatorLockedLpPct", COMPILED.creatorLockedPct],
    ["decimals", COMPILED.tokenDecimals], ["metadataCanChange", false],
  ];
  for (const [field, value] of want) if (T[field] !== value) out.push(`token.json: ${field} is ${JSON.stringify(T[field])}, but the Hunch program only adopts ${JSON.stringify(value)}`);
  if (!T.name || !T.symbol) out.push("token.json has no name or symbol");
  else if (!tickerOk(T.symbol)) out.push(`token.json: symbol ${JSON.stringify(T.symbol)} is not a ticker the Hunch program stores (1 to 10 characters, A-Z and 0-9 only): its diary names the coin by it`);
  if (!(Number.isInteger(T.supply) && T.supply > 0)) out.push("token.json: supply is not a whole number of tokens");
  if (!(T.startUsd > 0 && T.graduationUsd > T.startUsd)) out.push("token.json: startUsd and graduationUsd do not make a curve");
  // a local rehearsal may serve its metadata from this machine; a real cluster needs https
  const uriOk = typeof T.uri === "string" && (/^https:\/\//.test(T.uri) || (local && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(T.uri)));
  if (!uriOk) out.push("token.json: uri is not set (an https address of the served metadata file)");
  if (!(typeof T.devBuySol === "number" && Number.isFinite(T.devBuySol) && T.devBuySol >= 0)) out.push("token.json: devBuySol is not an amount of SOL (0 for no buy)");
  return out;
}

// The curve's settings, as DBC takes them, from token.json and one SOL price. Everything but the two
// market caps and the supply is the program's compiled value.
export function buildConfig(T, solUsd) {
  return buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: T.supply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 5000, endingFeeBps: 375, numberOfPeriod: OPENING_SECONDS, totalDuration: OPENING_SECONDS },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: COMPILED.creatorTradingFeePct,
      poolCreationFee: 0,
      // on only for the developer's buy inside step 2 (its one swap pays 3.75%, not the opening fee)
      enableFirstSwapWithMinFee: firstSwapFlag(T),
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: COMPILED.migratedPoolFeeBps },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: COMPILED.partnerLockedPct,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: COMPILED.creatorLockedPct,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: T.startUsd / solUsd,
    migrationMarketCap: T.graduationUsd / solUsd,
  });
}

// A config as the SDK decodes it against the settings built here, field by field (as $MONKEY's tool),
// with the fee claimer the dev wallet and the leftover receiver the budget PDA.
export function configDifferences(chain, want, owner, budget) {
  const segments = chain.curve.filter((point) => !point.sqrtPrice.isZero() || !point.liquidity.isZero());
  const pairs = [
    ["the coin the curve is priced in", chain.quoteMint, NATIVE_MINT],
    ["the wallet that claims the partner's fees", chain.feeClaimer, owner],
    ["the receiver of leftover tokens (the budget PDA)", chain.leftoverReceiver, budget],
    ["the opening fee (parts in 1,000,000,000)", chain.poolFees.baseFee.cliffFeeNumerator, want.poolFees.baseFee.cliffFeeNumerator],
    ["the opening fee's number of steps", chain.poolFees.baseFee.firstFactor, want.poolFees.baseFee.firstFactor],
    ["the opening fee's step length", chain.poolFees.baseFee.secondFactor, want.poolFees.baseFee.secondFactor],
    ["the opening fee's step size", chain.poolFees.baseFee.thirdFactor, want.poolFees.baseFee.thirdFactor],
    ["the shape of the fee", chain.poolFees.baseFee.baseFeeMode, want.poolFees.baseFee.baseFeeMode],
    ["the side the fee is taken from", chain.collectFeeMode, want.collectFeeMode],
    ["the first-trade fee rule (1 = the developer's buy in step 2 pays 3.75%)", chain.enableFirstSwapWithMinFee === undefined ? undefined : Number(chain.enableFirstSwapWithMinFee), want.enableFirstSwapWithMinFee ? 1 : 0],
    ["the fee for creating a pool", chain.poolCreationFee, want.poolCreationFee],
    ["the creator's share of the fee", chain.creatorTradingFeePercentage, want.creatorTradingFeePercentage],
    ["the right over the metadata (1 = nobody)", chain.tokenUpdateAuthority, want.tokenUpdateAuthority],
    ["the token program", chain.tokenType, want.tokenType],
    ["the token's decimals", chain.tokenDecimal, want.tokenDecimal],
    ["the supply", chain.preMigrationTokenSupply, want.tokenSupply?.preMigrationTokenSupply],
    ["how the pool keeps time", chain.activationType, want.activationType],
    ["the starting price", chain.sqrtStartPrice, want.sqrtStartPrice],
    ["the SOL at which it graduates (lamports)", chain.migrationQuoteThreshold, want.migrationQuoteThreshold],
    ["the number of segments of the curve", segments.length, want.curve.length],
    ...want.curve.flatMap((point, i) => [
      [`the curve's segment ${i + 1} (price)`, segments[i]?.sqrtPrice, point.sqrtPrice],
      [`the curve's segment ${i + 1} (depth)`, segments[i]?.liquidity, point.liquidity],
    ]),
    ["where it graduates to", chain.migrationOption, want.migrationOption],
    ["the kind of fee after graduation", chain.migrationFeeOption, want.migrationFeeOption],
    ["the fee in the pool after graduation (bps)", chain.migratedPoolFeeBps, want.migratedPoolFee.poolFeeBps],
    ["the fee claimer's liquidity, locked for good", chain.partnerPermanentLockedLiquidityPercentage, want.partnerPermanentLockedLiquidityPercentage],
    ["the creator's liquidity, locked for good", chain.creatorPermanentLockedLiquidityPercentage, want.creatorPermanentLockedLiquidityPercentage],
  ];
  return pairs
    .filter(([, has, makes]) => has === undefined || makes === undefined || String(has) !== String(makes))
    .map(([what, has, makes]) => `${what}: the config has ${has}, token.json makes ${makes}`);
}

// Whether to send, decided in one place: only with SEND=1, AND the STEP that is next, AND nothing left
// on the "not ready" list.
export function sendDecision({ send, step, next, notReady, pendingFile }) {
  const command = `SEND=1 STEP=${next} node launch.mjs`;
  if (!send) return { go: false, code: 0, say: `Nothing was sent. ${notReady ? "Once the list above is empty, the" : "The"} next step is the ${next}:\n   ${command}` };
  if (step !== next) {
    const why = step ? `STEP=${step} was asked, but the next step is the ${next}` : `SEND=1 alone sends nothing: it takes STEP as well. The next step is the ${next}`;
    const again = step === "config" ? `\n(The config already exists. To make it again, delete ${pendingFile} first.)` : "";
    return { go: false, code: 1, say: `REFUSED: ${why}:\n   ${command}${again}\nNothing was sent.` };
  }
  if (notReady) return { go: false, code: 1, say: "REFUSED: not sending while the list above stands. Nothing was sent." };
  return { go: true, code: 0, say: "" };
}

// What each second of the opening costs a buy of `lamports`, and where the fee goes (DBC: Meteora keeps
// 20% of every fee; of the rest the creator, here the budget PDA, takes 33% and the partner, the dev
// wallet, 67%). Gives rows for t = 0..5 seconds after the pool opens.
export function openingCostTable(lamports) {
  const rows = [];
  for (let t = 0; t <= OPENING_SECONDS; t++) {
    const num = liveFeeNumerator(t);
    const fee = (BigInt(lamports) * num) / 1_000_000_000n;
    const meteora = fee / 5n;
    const budget = ((fee - meteora) * 33n) / 100n;
    const dev = fee - meteora - budget;
    rows.push({ t, pct: Number(num) / 1e7, fee, meteora, budget, dev, lost: meteora + budget });
  }
  return rows;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (status) => !!status && ["confirmed", "finalized"].includes(status.confirmationStatus);

// Signs a transaction and sends it ONCE, then finds out what became of it ($MONKEY's sendOnce, unchanged):
// landed | failed | refused | expired | unknown.
export async function sendOnce(connection, tx, signers, { exists = async () => false, beforeSend, log = console.log, patience = 180000, pause = 2000 } = {}) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(...signers);
  const wire = tx.serialize();
  const signature = base58(tx.signature);
  await beforeSend?.(signature, lastValidBlockHeight);
  log(`   signature ${signature}`);
  let refusal = null;
  try {
    await connection.sendRawTransaction(wire, { preflightCommitment: "confirmed" });
  } catch (error) {
    if (error instanceof SendTransactionError) refusal = error;
    else log(`   the node gave no clear answer when it was sent (${hide(error?.message ?? error)}); looking it up before saying anything`);
  }
  const look = () => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).then((answer) => answer.value[0], () => undefined);
  const there = () => Promise.resolve().then(exists).then(Boolean, () => false);
  const verdict = async (status) => {
    if (!settled(status)) return null;
    return status.err ? { signature, outcome: "failed", detail: JSON.stringify(status.err) } : { signature, outcome: "landed" };
  };
  if (refusal) {
    await sleep(pause);
    const seen = (await verdict(await look())) ?? ((await there()) ? { signature, outcome: "landed" } : null);
    const logs = Array.isArray(refusal.logs) ? refusal.logs.slice(-6).join("\n") : "";
    return seen ?? { signature, outcome: "refused", detail: hide(`${refusal.transactionError?.message ?? refusal.message}${logs ? `\n${logs}` : ""}`) };
  }
  const started = Date.now();
  let told = false;
  for (;;) {
    const seen = await verdict(await look());
    if (seen) return seen;
    const height = await connection.getBlockHeight("confirmed").catch(() => undefined);
    if (height !== undefined && height > lastValidBlockHeight) {
      await sleep(pause);
      const last = await look();
      const final = await verdict(last);
      if (final) return final;
      if (await there()) return { signature, outcome: "landed" };
      if (last === null) return { signature, outcome: "expired" };
    }
    if (Date.now() - started > patience) return { signature, outcome: (await there()) ? "landed" : "unknown" };
    if (!told) log("   waiting for it to land: this can take a minute or two. Leave the window open.");
    told = true;
    await sleep(pause);
  }
}

// ---- the launch itself ----

const sol = (lamports) => Number(lamports.toString()) / LAMPORTS_PER_SOL;
const count = (n, digits = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
const pct = (bps) => `${bps / 100}%`;
const tokens = (units) => Number(units.toString()) / 10 ** DECIMALS;

async function main() {
  // ---- settings: .env first, the environment wins; SEND and STEP only from the command line ----
  const notes = existsSync(join(HERE, ".env")) ? applyEnv(readEnv(readFileSync(join(HERE, ".env"))), process.env) : [];
  const CLUSTER = process.env.CLUSTER ?? "mainnet-beta";
  const local = CLUSTER === "localnet";
  const RPC_URL = process.env.RPC_URL || (local ? "http://127.0.0.1:8899" : clusterApiUrl(CLUSTER));
  if (process.env.RPC_URL) keepSecret(process.env.RPC_URL);
  const SEND = process.env.SEND === "1";
  const STEP = (process.env.STEP ?? "").trim().toLowerCase();
  if (STEP === "buy") {
    console.log("REFUSED: there is no STEP=buy any more. The developer's buy (token.json devBuySol) is part of step 2, the pool's first swap in the transaction that creates it, where DBC charges it 3.75%; a buy after step 2 would pay the opening schedule. Nothing was sent.");
    return 1;
  }
  if (STEP && !["config", "token"].includes(STEP)) {
    console.log(`REFUSED: STEP must be config or token, not "${STEP}". Nothing was sent.`);
    return 1;
  }
  if (local !== isLocal(RPC_URL)) {
    console.log(`REFUSED: CLUSTER is ${CLUSTER} but RPC_URL is ${local ? "not a local validator" : "a local validator"}. Nothing was sent.`);
    return 1;
  }
  if (process.env.SEND && !SEND) notes.push(`SEND is "${process.env.SEND}": only SEND=1 sends, so this is a dry run`);
  // A local rehearsal may read its settings and write its records elsewhere; a real cluster never does.
  const where = (envName, name) => (local && process.env[envName] ? home(process.env[envName]) : join(HERE, name));
  const TOKEN_FILE = where("HUNCH_TOKEN_FILE", "token.json");
  const PROGRAM_FILE = where("HUNCH_PROGRAM_FILE", "program.json");
  const RECORDS = local && process.env.HUNCH_RECORDS ? home(process.env.HUNCH_RECORDS) : HERE;
  const PENDING = `pending.${CLUSTER}.json`, LAUNCHED = `launched.${CLUSTER}.json`;
  const say = (how) => `${how} node launch.mjs`.trim();

  const T = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  const symbol = T.symbol ?? "?";
  const buySol = T.devBuySol ?? 0;
  const P = JSON.parse(readFileSync(PROGRAM_FILE, "utf8"));
  const programId = typeof P[CLUSTER] === "string" ? new PublicKey(P[CLUSTER]) : null;
  const A = programId ? addresses(programId) : null;

  // ---- what still has to be decided or put right before anything can be sent ----
  const missing = [...tokenProblems(T, { local })];
  if (!A) missing.push(`program.json has no Hunch program address for ${CLUSTER}: the budget PDA, the pool's creator, comes from it`);
  const buyLamports = new BN(typeof buySol === "number" && buySol > 0 ? Math.round(buySol * LAMPORTS_PER_SOL) : 0);

  const readKey = (envName) => {
    const path = process.env[envName];
    if (!path || !existsSync(home(path))) return null;
    try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(home(path), "utf8")))); } catch { throw new Error(`${envName} does not hold a key file I can read`); }
  };
  const wallet = readKey("KEYPAIR");
  const owner = wallet ? wallet.publicKey : process.env.PAYER ? new PublicKey(process.env.PAYER) : null;
  const mint = readKey("MINT_KEYPAIR");
  if (!mint) missing.push("MINT_KEYPAIR is not set, or no key file is there: the token's address must be made beforehand");
  if (!wallet) missing.push("KEYPAIR is not set, or no key file is there (the dev wallet)");
  if (!process.env.RPC_URL && !local) missing.push("RPC_URL is not set: the public node is used, which is slow and often refuses");
  const tell = () => { if (missing.length) console.log(`\nNOT READY TO SEND:\n${missing.map((m) => `  - ${m}`).join("\n")}`); };

  const recordPath = (name) => join(RECORDS, name);
  const readRecord = (name) => {
    if (!existsSync(recordPath(name))) return null;
    try { return JSON.parse(readFileSync(recordPath(name), "utf8")); } catch { return { unreadable: true }; }
  };
  const writeRecord = (name, record) => writeFileSync(recordPath(name), `${JSON.stringify(record, null, 2)}\n`);
  const removeRecord = (name) => { if (existsSync(recordPath(name))) unlinkSync(recordPath(name)); };

  const connection = new Connection(RPC_URL, "confirmed");
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const program = client.pool.getProgram();
  const priority = Number(process.env.PRIORITY ?? 50000) >= 0 ? Number(process.env.PRIORITY ?? 50000) : 50000;

  for (const note of notes) console.log(`note      ${note}`);
  console.log(`cluster   ${CLUSTER}`);
  console.log(`dev       ${owner ? `${owner}  (${sol(await connection.getBalance(owner))} SOL)` : "not known yet"}  pays, claims the partner's 67% of the fee, creates the pool`);
  console.log(`token     ${T.name ?? "NO NAME YET"} ($${symbol}), ${count(T.supply, 0)} supply, ${DECIMALS} decimals, plain SPL token, nothing can be minted later`);
  console.log(`address   ${mint ? mint.publicKey : "not reserved yet"}`);
  console.log(`metadata  ${T.uri ?? "NOT SET (token.json uri is null)"}; name, symbol and picture can never be changed`);

  // ---- the Hunch program on this cluster ----
  let deployed = false, upgradeAuthority = null, st = null, stTicker = null;
  if (A) {
    const [progInfo, pdInfo, stInfo] = await connection.getMultipleAccountsInfo([A.program, A.programdata, A.state]);
    deployed = !!progInfo?.executable;
    upgradeAuthority = pdInfo && pdInfo.data.length >= 45 && pdInfo.data[12] === 1 ? new PublicKey(pdInfo.data.subarray(13, 45)) : null;
    st = decodeState(stInfo?.data);
    stTicker = storedTicker(stInfo?.data);
    console.log(`hunch     program ${A.program}${deployed ? "" : "  NOT DEPLOYED on this cluster"}`);
    if (deployed) console.log(`          upgrade authority ${upgradeAuthority ?? "none (frozen)"}`);
    console.log(`          budget PDA ${A.budget}: the pool's creator (0.99% of each trade) and the leftover receiver`);
    console.log(`          state ${st ? `initialized, phase ${PHASE_NAME[st.phase] ?? st.phase}, token ${st.mint}, ticker ${stTicker ?? "NONE (an older layout)"}` : stInfo ? "PRESENT BUT NOT READABLE (layout changed?)" : "not initialized yet"}`);
    if (!deployed) missing.push(`the Hunch program is not deployed at ${A.program} on ${CLUSTER} (scripts/deploy-program.sh)`);
  }

  const mintKey = mint ?? Keypair.generate();

  // Puts the compute limit and the tip in front, simulates exactly as it would be sent, reads back `watch`.
  async function prepare(tx, watch, signerCount) {
    const body = tx.instructions.slice();
    const front = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...(priority > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority })] : [])];
    const ROOM = 1400000;
    tx.feePayer = owner;
    tx.instructions = [...front(ROOM), ...body];
    const first = await connection.simulateTransaction(tx, undefined, [owner]);
    if (first.value.err) return { err: first.value.err, logs: first.value.logs ?? [] };
    const limit = Math.min(ROOM, Math.ceil(((first.value.unitsConsumed ?? 0) * 1.3 + 10000) / 1000) * 1000);
    tx.instructions = [...front(limit), ...body];
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const signatures = signerCount ?? tx.compileMessage().header.numRequiredSignatures;
    const bytes = tx.serializeMessage().length + 1 + 64 * signatures;
    if (bytes > PACKET) return { err: `the transaction is ${bytes} bytes, more than the ${PACKET} a transaction may have`, logs: [] };
    const before = await connection.getBalance(owner);
    const sim = await connection.simulateTransaction(tx, undefined, [owner, ...watch]);
    if (sim.value.err) return { err: sim.value.err, logs: sim.value.logs ?? [] };
    const networkFee = (units) => 5000 * signatures + Math.ceil(units * priority / 1e6);
    const fee = networkFee(limit);
    const feeTakenOff = networkFee(ROOM) === fee || sim.value.accounts[0].lamports - first.value.accounts[0].lamports === networkFee(ROOM) - fee;
    const spent = before - sim.value.accounts[0].lamports + (feeTakenOff ? 0 : fee);
    return { units: sim.value.unitsConsumed ?? 0, limit, bytes, fee, before, spent, accounts: sim.value.accounts.slice(1) };
  }
  function refusedInSimulation(ready) {
    console.log(`\nREFUSED in simulation: ${typeof ready.err === "string" ? ready.err : JSON.stringify(ready.err)}${ready.logs.length ? `\n${ready.logs.slice(-8).join("\n")}` : ""}`);
    if (ready.err === "AccountNotFound") console.log(`The dev wallet has no SOL on ${CLUSTER}.`);
    if (ready.logs.some((line) => /insufficient lamports|insufficient funds/i.test(line))) console.log("The dev wallet does not hold enough SOL for this step.");
    tell();
    console.log("Nothing was sent.");
    return 1;
  }
  function maySend(next) {
    tell();
    const decision = sendDecision({ send: SEND, step: STEP, next, notReady: missing.length > 0, pendingFile: PENDING });
    if (decision.say) console.log(`\n${decision.say}`);
    return decision;
  }
  // The transfer of the creator role, from the program's own builder, held against the hand-built copy.
  async function transferIx(poolKey, configKey) {
    const fromSdk = await client.creator.program.methods.transferPoolCreator()
      .accountsPartial({ virtualPool: poolKey, config: configKey, creator: owner, newCreator: A.budget }).instruction();
    const byHand = transferPoolCreatorIx({ pool: poolKey, config: configKey, creator: owner, newCreator: A.budget });
    const same = fromSdk.data.equals(byHand.data) && fromSdk.keys.length === byHand.keys.length
      && fromSdk.keys.every((k, i) => k.pubkey.equals(byHand.keys[i].pubkey) && k.isSigner === byHand.keys[i].isSigner && k.isWritable === byHand.keys[i].isWritable);
    if (!same) missing.push("the SDK's transferPoolCreator instruction differs from the hand-built one: check the DBC version before sending");
    return fromSdk;
  }
  function poolCheck(bytes, poolKey, configKey) {
    const p = decodePool(bytes);
    if (!p) return ["the pool could not be read back from the simulation"];
    const out = [];
    if (!p.creator.equals(A.budget)) out.push(`the pool's creator reads ${p.creator}, not the budget PDA ${A.budget}`);
    if (!p.baseMint.equals(mintKey.publicKey)) out.push(`the pool's token reads ${p.baseMint}`);
    if (!p.config.equals(configKey)) out.push(`the pool's config reads ${p.config}`);
    if (p.isMigrated !== 0 || p.poolType !== 0) out.push("the pool is not a fresh SPL-token curve");
    return out;
  }

  // ---- already launched ----
  const launched = readRecord(LAUNCHED);
  let pending = readRecord(PENDING);
  if (launched && !launched.unreadable) return afterLaunch({ launched });

  const isSent = (note) => typeof note?.signature === "string" && note.lastValidBlockHeight > 0;
  const pendingReads = pending && typeof pending.config === "string" && pending.solUsd > 0
    && (pending.landed !== false || isSent(pending)) && (pending.tokenSent === undefined || isSent(pending.tokenSent));
  if (pending && !pendingReads) {
    console.log(`REFUSED: ${PENDING} is there but cannot be read. If step 1 was never sent, delete the file and run this again. Nothing was sent.`);
    return 1;
  }
  if (pending && A && pending.programId !== A.program.toBase58()) {
    console.log(`REFUSED: ${PENDING} was made for the Hunch program ${pending.programId}, but program.json now names ${A.program}. Its config sends leftovers to the other program's budget. Delete ${PENDING} and run step 1 again. Nothing was sent.`);
    return 1;
  }

  async function solPrice() {
    if (process.env.SOL_USD) {
      if (!(Number(process.env.SOL_USD) > 0)) throw new Error("SOL_USD is not a price.");
      return Number(process.env.SOL_USD);
    }
    const id = NATIVE_MINT.toBase58();
    const answer = await fetch(`https://lite-api.jup.ag/price/v3?ids=${id}`).then((r) => r.json()).catch(() => null);
    const price = answer?.[id]?.usdPrice;
    if (!(price > 0)) throw new Error("Could not read the SOL price from Jupiter. Pass it as SOL_USD.");
    return price;
  }
  const now = await solPrice();

  // ---- has step 1 been done? ----
  const look = (signature) => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).then((answer) => answer.value[0]);
  let onChain = null, onChainBytes = null;
  if (pending) {
    const address = new PublicKey(pending.config);
    onChain = await client.state.getPoolConfig(address);
    onChainBytes = onChain ? (await connection.getAccountInfo(address))?.data ?? null : null;
    if (onChain && pending.landed === false) {
      pending = { ...pending, landed: true };
      delete pending.lastValidBlockHeight;
      writeRecord(PENDING, pending);
    } else if (!onChain && pending.landed === false) {
      const height = await connection.getBlockHeight("confirmed");
      const status = await look(pending.signature);
      const refused = settled(status) && !!status.err;
      const gone = status === null && height > pending.lastValidBlockHeight && !(await client.state.getPoolConfig(address));
      if (!refused && !gone) {
        console.log(`\nStep 1 was sent and is not settled yet (${pending.signature}).\nWait a minute and run the plan again: ${say("")}\nNothing was sent now.`);
        return SEND ? 1 : 0;
      }
      removeRecord(PENDING);
      console.log(`\nThe config sent earlier (${pending.signature}) ${refused ? "was refused on chain" : "never got into a block, and no longer can"}.\nNo config was made, and ${PENDING} is removed. Run the plan again: ${say("")}\nNothing was sent now.`);
      return SEND ? 1 : 0;
    } else if (!onChain) {
      console.log(`\nREFUSED: ${PENDING} names the config ${pending.config}, but this node does not show it on ${CLUSTER}. Nothing was sent.`);
      return 1;
    }
  }
  const stage = onChain ? "token" : "config";

  const basis = pending ? pending.solUsd : now;
  const config = buildConfig(T, basis);
  const cap = (sqrtPrice) => Number(getPriceFromSqrtPrice(sqrtPrice, DECIMALS, 9).mul(T.supply).toString());
  const curve = onChain
    ? { start: cap(onChain.sqrtStartPrice), grad: cap(onChain.migrationSqrtPrice), threshold: onChain.migrationQuoteThreshold }
    : { start: T.startUsd / basis, grad: T.graduationUsd / basis, threshold: config.migrationQuoteThreshold };
  if (!onChain) {
    console.log(`SOL       $${count(now)}`);
    console.log(`curve     starts at $${count(T.startUsd, 0)} of market cap (${count(curve.start)} SOL), graduates at $${count(T.graduationUsd, 0)} (${count(curve.grad)} SOL)  [the user's choice, as on $MONKEY]`);
  } else {
    console.log(`SOL       $${count(now)} now; it was $${count(basis)} when the config was made`);
    console.log(`curve     as the config on chain has it: starts at ${count(curve.start)} SOL of market cap, graduates at ${count(curve.grad)} SOL`);
    console.log(`          in dollars: $${count(curve.start * basis, 0)} and $${count(curve.grad * basis, 0)} when it was made, $${count(curve.start * now, 0)} and $${count(curve.grad * now, 0)} at the price now`);
  }
  console.log(`          it graduates once ${count(sol(curve.threshold))} SOL sits in the curve (about $${count(sol(curve.threshold) * now, 0)})`);
  console.log(`fee       3.75% per trade on the curve and in the DAMM v2 pool after graduation, in SOL:`);
  console.log(`          Meteora 0.75%, Hunch's budget 0.99% (creator share 33), the dev wallet 2.01% (partner share 67)`);
  console.log(`          it opens at 50% and comes down 9.25 points a second to 3.75% over the first 5 seconds, for every buyer and seller`);
  console.log(`LP        after graduation: 67% the dev wallet's, 33% the budget PDA's, both locked for good`);

  // The site has to be serving the metadata before the token exists: terminals read it at once.
  if (typeof T.uri === "string" && /^https?:\/\//.test(T.uri)) {
    const metadata = await fetch(T.uri).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const ok = !!metadata && metadata.name === T.name && metadata.symbol === T.symbol && !!(await fetch(metadata.image, { method: "HEAD" }).catch(() => null))?.ok;
    if (!ok) missing.push(`${T.uri} is not being served yet with this name and symbol, or its picture is missing`);
  }

  showDevBuyPlan();

  if (!owner) {
    tell();
    console.log("\nThis is the plan only. Give PAYER=<the dev wallet's address> to simulate it, or set KEYPAIR.");
    return 0;
  }

  const configAddress = pending ? new PublicKey(pending.config) : null;
  const pool = configAddress ? deriveDbcPoolAddress(NATIVE_MINT, mintKey.publicKey, configAddress) : null;

  // ---- step 2 needs the program initialized for this very token ----
  const initializedForThisMint = !!st && st.mint.equals(mintKey.publicKey);
  if (A && deployed && !st) missing.push(`the Hunch program is not initialized yet: run ../scripts/init-hunch.mjs (STEP=initialize) with this token's address first`);
  if (st && !initializedForThisMint) missing.push(`the Hunch program was initialized for the token ${st.mint}, not ${mintKey.publicKey}: point MINT_KEYPAIR at the key file used for initialize (its address is ${st.mint}). Hunch cannot be initialized again; only a program upgrade or a new program address gets out of this`);
  if (st && st.phase !== 0) missing.push(`the Hunch program is in phase ${PHASE_NAME[st.phase] ?? st.phase}, not setup: it has adopted a pool already`);
  // the diary names the coin by the ticker initialize stored: it must be this token's symbol
  if (st && stTicker !== T.symbol) missing.push(`the Hunch program was initialized with the ticker ${stTicker ?? "(none: an older layout)"}, but token.json's symbol is ${JSON.stringify(T.symbol)}: its diary would name another coin`);

  async function recordLaunch(signature, devBuy = null) {
    const record = {
      cluster: CLUSTER, mint: mintKey.publicKey.toBase58(), pool: pool.toBase58(), config: pending.config, owner: owner.toBase58(),
      programId: A.program.toBase58(), budget: A.budget.toBase58(), ticker: stTicker,
      ...(signature ? { signature } : {}), ...(pending.signature ? { configSignature: pending.signature } : {}),
      solUsdAtConfig: pending.solUsd, startUsd: T.startUsd, graduationUsd: T.graduationUsd, curveFeeBps: 375, poolFeeBps: 375,
      openingFeeBps: 5000, openingFeeSeconds: OPENING_SECONDS, creatorSharePct: 33,
      ...(devBuy ? { devBuy } : {}),
    };
    writeRecord(LAUNCHED, record);
    removeRecord(PENDING);
    return record;
  }
  // what the developer's buy in step 2 got, read from the chain after it landed (null: no buy asked)
  async function devBuyRecord(fee = null) {
    if (buyLamports.isZero()) return null;
    const ata = getAssociatedTokenAddressSync(mintKey.publicKey, owner);
    const tokens = await connection.getTokenAccountBalance(ata).then((a) => a.value.uiAmountString, () => null);
    return { sol: sol(buyLamports), tokens, inStep2: true, ...(fee !== null ? { feeLamports: fee.toString() } : {}) };
  }

  if (await connection.getAccountInfo(mintKey.publicKey)) {
    const made = pool ? decodePool((await connection.getAccountInfo(pool))?.data) : null;
    if (made) {
      const record = await recordLaunch(pending.tokenSent?.signature ?? null, await devBuyRecord());
      console.log(`\n$${symbol} is already live on ${CLUSTER}: step 2 landed. Written to ${LAUNCHED}.`);
      console.log(`   contract address  ${record.mint}\n   pool              ${record.pool}\n   pool creator      ${made.creator}${made.creator.equals(A.budget) ? " (the budget PDA)" : "  NOT THE BUDGET PDA"}`);
      if (SEND) console.log("REFUSED: there is nothing left to send.");
      return SEND ? 1 : 0;
    }
    console.log(`\nREFUSED: the address ${mintKey.publicKey} is already in use on ${CLUSTER}${pool ? ", and not by a pool under this config" : ""}. Nothing was sent.`);
    return 1;
  }
  if (pending?.tokenSent) {
    const sent = pending.tokenSent;
    const height = await connection.getBlockHeight("confirmed");
    const status = await look(sent.signature);
    const refused = settled(status) && !!status.err;
    const gone = status === null && height > sent.lastValidBlockHeight && !(await connection.getAccountInfo(mintKey.publicKey));
    if (!refused && !gone) {
      console.log(`\nStep 2 was sent and is not settled yet (${sent.signature}).\nWait a minute and run the plan again: ${say("")}\nNothing was sent now.`);
      return SEND ? 1 : 0;
    }
    pending = { ...pending };
    delete pending.tokenSent;
    writeRecord(PENDING, pending);
    console.log(`note      the token sent earlier (${sent.signature}) ${refused ? "was refused on chain" : "never got into a block, and no longer can"}: no token was made`);
  }

  console.log(`steps     0. deploy and initialize Hunch (../scripts)                         ${st ? "done" : "<- FIRST"}`);
  console.log(`          1. config   the curve's settings. Not public: nobody can trade it.  ${stage === "config" ? "<- NEXT" : `done: ${pending.config}`}`);
  console.log(`          2. token    the token and its pool, creator handed to the budget PDA and the pool adopted by Hunch in the same transaction${buyLamports.gtn(0) ? ", and the developer's buy" : ""}.   ${stage === "token" ? "<- NEXT" : "after step 1"}`);
  console.log(`          then        start the crank (../crank); ../scripts/init-hunch.mjs STEP=adopt only if step 2 left Hunch in phase setup`);

  // ---- step 1: the config ----
  if (stage === "config") {
    if (!A) { tell(); console.log("\nNothing was sent."); return SEND ? 1 : 0; }
    const configKey = Keypair.generate();
    const accounts = { config: configKey.publicKey, feeClaimer: owner, leftoverReceiver: A.budget, payer: owner, quoteMint: NATIVE_MINT };
    const tx = await client.partner.createConfig({ ...config, ...accounts });
    const ready = await prepare(tx, [configKey.publicKey]);
    if (ready.err) return refusedInSimulation(ready);
    const bytes = Buffer.from(ready.accounts[0].data[0], "base64");
    const written = program.coder.accounts.decode("poolConfig", bytes);
    const wrong = configDifferences(written, config, owner, A.budget);
    if (wrong.length) missing.push(`in simulation DBC did not store what token.json asks:\n${wrong.map((w) => `      ${w}`).join("\n")}`);
    const problems = adoptable(adoptionProblems(bytes, A.budget), bytes);
    if (problems.length) missing.push(`the Hunch program would NOT adopt a pool made from this config: ${problems.join("; ")}`);
    if (bytes[FIRST_SWAP_FLAG_AT] !== (firstSwapFlag(T) ? 1 : 0)) missing.push(`in simulation the config holds "first swap with min fee" at ${bytes[FIRST_SWAP_FLAG_AT]}, not ${firstSwapFlag(T) ? 1 : 0}`);
    const facts = configFacts(bytes);
    const rent = ready.accounts[0].lamports, cost1 = ready.spent;
    console.log(`\nStep 1 simulates cleanly on ${CLUSTER}: ${ready.bytes} bytes of ${PACKET}, ${count(ready.units, 0)} compute units (limit set to ${count(ready.limit, 0)}).`);
    console.log(`   it costs ${count(sol(cost1), 6)} SOL: ${count(sol(rent), 6)} kept in the config's account as rent, ${count(sol(ready.fee), 6)} network fee`);
    if (!wrong.length) console.log("   what DBC would store was read back from the simulation: it is what token.json asks");
    if (!problems.length) console.log("   the Hunch program's adoption checks (all 35) pass on those bytes");
    console.log(`   DBC config version ${facts.version}, base transfer fee ${facts.transferFeeBps} bps (flag ${facts.transferFeeFlag}), "first swap with min fee" ${bytes[FIRST_SWAP_FLAG_AT]}${firstSwapFlag(T) ? " (for the developer's buy in step 2)" : ""}`);

    // Rehearsal of step 2: config + pool + transfer in one simulated transaction (never sent like that);
    // name, symbol and uri cut to one letter so that it fits. The developer's buy is not in it (it would not
    // fit): its SOL is added to what the wallet needs, and step 2 simulates it for real once the config exists.
    const buyNeed = (buyLamports.gtn(0) ? Number(buyLamports.toString()) + 2_100_000 : 0) + TOKEN_ACCOUNT_RENT;
    let need = cost1 + 30000000 + buyNeed;
    try {
      const poolKey = deriveDbcPoolAddress(NATIVE_MINT, mintKey.publicKey, configKey.publicKey);
      const poolTx = await client.creator.buildCreatePoolTx(
        { name: "x", symbol: "x", uri: "x", payer: owner, poolCreator: owner, config: configKey.publicKey, baseMint: mintKey.publicKey }, 0, NATIVE_MINT);
      const rehearsal = new Transaction().add(...tx.instructions.slice(priority > 0 ? 2 : 1), ...poolTx.instructions, await transferIx(poolKey, configKey.publicKey));
      rehearsal.feePayer = owner;
      rehearsal.recentBlockhash = tx.recentBlockhash;
      const size = rehearsal.serializeMessage().length + 1 + 64 * rehearsal.compileMessage().header.numRequiredSignatures;
      if (size > PACKET) throw new Error(`the two steps together are ${size} bytes, too many for one transaction`);
      const r = (await connection.simulateTransaction(rehearsal, undefined, [owner, poolKey])).value;
      if (r.err) {
        missing.push(`the rehearsal of step 2 was refused in simulation: ${JSON.stringify(r.err)}\n${(r.logs ?? []).slice(-6).map((l) => `      ${l}`).join("\n")}`);
      } else {
        const bad = poolCheck(Buffer.from(r.accounts[1].data[0], "base64"), poolKey, configKey.publicKey);
        if (bad.length) missing.push(`in the rehearsal of step 2: ${bad.join("; ")}`);
        need = ready.before - r.accounts[0].lamports + 20000 + ready.fee + buyNeed;
        console.log(`\nRehearsal of step 2 (steps 1 and 2 in one simulated transaction, ${size} bytes, never sent like that): runs cleanly, ${count(r.unitsConsumed ?? 0, 0)} compute units.`);
        if (!bad.length) console.log(`   the pool reads back with its creator = the budget PDA ${A.budget}`);
        console.log(`   the two steps together take about ${count(sol(need), 4)} SOL from the dev wallet (rent of the config, pool, vaults, mint and metadata, Metaplex's fee, network fees, the budget's coin account adopt_curve makes${buyLamports.gtn(0) ? ", the developer's buy and its coin account" : ""})`);
      }
    } catch (error) {
      console.log(`\nStep 2 could not be rehearsed now (${hide(error.message)}). It is simulated for real once the config exists.`);
    }
    console.log(`   the dev wallet holds ${count(sol(ready.before), 4)} SOL`);
    if (ready.before < need) missing.push(`the dev wallet holds ${sol(ready.before)} SOL; the two steps take about ${count(sol(need), 4)}`);

    const decision = maySend("config");
    if (!decision.go) return decision.code;
    const record = { cluster: CLUSTER, config: configKey.publicKey.toBase58(), owner: owner.toBase58(), programId: A.program.toBase58(), budget: A.budget.toBase58(), solUsd: basis, settings: settingsOf(T) };
    console.log(`\nSending step 1, the config ${record.config} ...`);
    const result = await sendOnce(connection, tx, [wallet, configKey], {
      exists: () => client.state.getPoolConfig(configKey.publicKey),
      beforeSend: (signature, lastValidBlockHeight) => writeRecord(PENDING, { ...record, signature, landed: false, lastValidBlockHeight }),
    });
    if (result.outcome === "landed") {
      writeRecord(PENDING, { ...record, signature: result.signature, landed: true });
      console.log(`\nStep 1 is done: the config is on chain. It is not public and nothing can be traded yet.\n   config  ${record.config}\n   Written to ${PENDING}.`);
      console.log(`Next, the plan for step 2:\n   ${say("")}\nand then the token itself:\n   ${say("SEND=1 STEP=token")}`);
      return 0;
    }
    if (result.outcome === "unknown") {
      console.log(`\nNOT KNOWN YET whether step 1 landed. Do NOT send it again now.\nWait a minute and run the plan:\n   ${say("")}`);
      return 1;
    }
    removeRecord(PENDING);
    console.log(`\nStep 1 did NOT happen: ${outcomeInWords(result)}\nNo config was made. Run the plan again before trying again:\n   ${say("")}`);
    return 1;
  }

  // ---- step 2: the token and its pool, creator handed to the budget PDA in the same transaction, and the
  //      developer's buy (when token.json asks for one) as the pool's first swap ----
  const wrong = configDifferences(onChain, config, owner, A.budget);
  if (wrong.length) missing.push(`the config on chain (${pending.config}) is not the one token.json makes today:\n${wrong.map((w) => `      ${w}`).join("\n")}\n    Put token.json back as it was, or delete ${PENDING} and run step 1 again`);
  const problems = onChainBytes ? adoptable(adoptionProblems(onChainBytes, A.budget), onChainBytes) : ["the config could not be read"];
  if (problems.length) missing.push(`the Hunch program would NOT adopt a pool made from the config on chain: ${problems.join("; ")}`);
  // the flag, byte for byte: on exactly when the developer buys in step 2
  const buying = buyLamports.gtn(0);
  if (onChainBytes && onChainBytes[FIRST_SWAP_FLAG_AT] !== (buying ? 1 : 0)) {
    missing.push(`the config on chain has "first swap with min fee" at ${onChainBytes[FIRST_SWAP_FLAG_AT]}, but token.json's devBuySol ${buying ? "asks for a buy in step 2, which needs 1" : "is 0, which needs 0"}.\n    Put devBuySol back as it was, or delete ${PENDING} and run step 1 again`);
  }
  const drift = now / basis - 1;
  if (Math.abs(drift) > MAX_SOL_DRIFT) missing.push(`SOL has moved ${(drift * 100).toFixed(1)}% since the config was made: the token would start at $${count(curve.start * now, 0)} of market cap, not $${count(T.startUsd, 0)}.\n    Delete ${PENDING} and run step 1 again`);

  // The developer's buy is quoted as DBC prices the pool's first swap (the min fee, at the curve's start),
  // and the simulation must agree. Nobody can trade the pool before it, so the 0.5% margin is for rounding.
  const devCoin = getAssociatedTokenAddressSync(mintKey.publicKey, owner);
  const quote = buying ? client.pool.getQuoteFromInputAmount({ config: onChain, swapBaseForQuote: false, amountIn: buyLamports, eligibleForFirstSwapWithMinFee: true }) : null;
  const minOut = buying ? quote.outputAmount.muln(10000 - MIN_OUT_UNDER_BPS).divn(10000) : new BN(0);
  // Hunch adopts the pool in the same transaction (adopt_curve, last): only when it is initialized for this
  // mint and still in setup; otherwise the list above already holds why step 2 cannot be sent.
  const adopting = initializedForThisMint && st.phase === 0;
  const step2 = async ({ close = true, wrap = true } = {}) => {
    const t = await client.creator.createPool({ name: T.name, symbol: T.symbol, uri: T.uri ?? "", payer: owner, poolCreator: owner, config: configAddress, baseMint: mintKey.publicKey });
    t.add(await transferIx(pool, configAddress));
    if (buying) t.add(...devBuyIxs({ pool, config: configAddress, mint: mintKey.publicKey, owner, lamports: buyLamports, minOut, close, wrap }));
    if (adopting) t.add(adoptCurveIx(A, owner, { pool, config: configAddress, mint: mintKey.publicKey }));
    return t;
  };
  // a developer's WSOL account that already holds the buy (spl-token wrap beforehand) needs no wrapping here
  const devWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const wrapped = buying ? BigInt(await connection.getTokenAccountBalance(devWsol).then((a) => a.value.amount, () => "0")) : 0n;
  // its size as sent (with the compute-budget instructions in front); Infinity when it cannot be serialized
  const wireOf = (t) => {
    try {
      const w = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ...(priority > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })] : []), ...t.instructions);
      w.feePayer = owner;
      w.recentBlockhash = PublicKey.default.toBase58();
      return w.serializeMessage().length + 1 + 64 * w.compileMessage().header.numRequiredSignatures;
    } catch { return Infinity; }
  };
  let tx = await step2(), closesWsol = buying, wraps = buying;
  if (buying && wireOf(tx) > PACKET) { tx = await step2({ close: false }); closesWsol = false; }
  if (buying && wireOf(tx) > PACKET && wrapped >= BigInt(buyLamports.toString())) { tx = await step2({ close: false, wrap: false }); wraps = false; }
  if (wireOf(tx) > PACKET) {
    const size = wireOf(tx);
    const without = buying ? wireOf(await step2({ close: false, wrap: false })) : Infinity;
    // spl-token wrap moves that many SOL into the new WSOL account, its rent included: wrap the buy plus the rent
    const rent = buying ? await connection.getMinimumBalanceForRentExemption(165) : 0;
    const toWrap = (Number(buyLamports.toString()) + rent) / LAMPORTS_PER_SOL;
    const hint = buying && without <= PACKET
      ? `Wrap the buy's SOL into the dev wallet's WSOL account first (it takes ${size - without} bytes off): the buy plus the account's rent (${sol(rent)} SOL), from a wallet that has no WSOL account yet, for example:\n   spl-token wrap ${toWrap.toFixed(9)} <the KEYPAIR file> --fee-payer <the KEYPAIR file> -u m\nthen run the plan again (it shows the WSOL account holding ${wrapped} of the ${buyLamports} lamports needed now). Or set devBuySol to 0, or shorten the name or uri.`
      : `Shorten the name or uri${buying ? ", or set devBuySol to 0" : ""}.`;
    console.log(`\nREFUSED: step 2 (createPool, the creator transfer${buying ? ", the developer's buy" : ""}${adopting ? ", adopt_curve" : ""}) is ${Number.isFinite(size) ? size : "more than"} bytes, more than the ${PACKET} a transaction may have. ${hint}\nNothing was sent.`);
    return 1;
  }
  const watchState = adopting ? [A.state] : [];
  const ready = await prepare(tx, buying ? [pool, devCoin, ...watchState] : [pool, ...watchState]);
  if (ready.err) return refusedInSimulation(ready);
  const poolBytes = Buffer.from(ready.accounts[0].data[0], "base64");
  const bad = poolCheck(poolBytes, pool, configAddress);
  // Hunch's state after the simulated step 2: adopted (curve phase), this mint, this ticker, the config's
  // migration sqrt price pinned (adopt_pool measures the position against it after graduation)
  let adoptedState = null;
  if (adopting) {
    const stBytes = ready.accounts.at(-1)?.data ? Buffer.from(ready.accounts.at(-1).data[0], "base64") : null;
    adoptedState = decodeState(stBytes);
    const pinned = adoptedState?.migrationSqrtPrice ?? null;
    const want = onChainBytes ? onChainBytes.readBigUInt64LE(CONFIG_MIGRATION_SQRT_PRICE_AT) | (onChainBytes.readBigUInt64LE(CONFIG_MIGRATION_SQRT_PRICE_AT + 8) << 64n) : null;
    if (!adoptedState || adoptedState.phase !== 1) bad.push(`Hunch's state reads phase ${PHASE_NAME[adoptedState?.phase] ?? "?"} after the simulated step 2, not curve: adopt_curve did not adopt the pool`);
    else {
      if (!adoptedState.pool.equals(pool)) bad.push(`Hunch's state adopted the pool ${adoptedState.pool}, not ${pool}`);
      if (!adoptedState.mint.equals(mintKey.publicKey)) bad.push(`Hunch's state holds the mint ${adoptedState.mint}`);
      if (adoptedState.ticker !== T.symbol) bad.push(`Hunch's state holds the ticker ${adoptedState.ticker}, not ${T.symbol}`);
      if (!pinned || pinned !== want) bad.push(`adopt_curve pinned the migration sqrt price ${pinned}, not the config's ${want}`);
    }
  }
  let got = new BN(0), feePaid = 0n;
  if (buying) {
    feePaid = poolFeesPaid(poolBytes);
    const want = feeOnBuy(buyLamports.toString());
    if (feePaid !== want) bad.push(`the pool's fee counters read ${feePaid} lamports after the developer's buy, not ${want} (3.75% of ${sol(buyLamports)} SOL): the buy would not get DBC's first-swap fee`);
    got = ready.accounts[1] ? new BN(AccountLayout.decode(Buffer.from(ready.accounts[1].data[0], "base64")).amount.toString()) : new BN(0);
    if (got.lt(minOut)) bad.push(`the developer's coin account reads ${got} units after the buy, under the minimum ${minOut}`);
  }
  const buyWhat = !buying ? "" : ` + the developer's buy${wraps ? "" : " (from the WSOL the wallet already holds)"}${closesWsol || !wraps ? "" : " (its WSOL account left open: closing it would not fit)"}`;
  const what = `createPool + transferPoolCreator${buyWhat}${adopting ? " + adopt_curve" : ""}`;
  console.log(`\nStep 2 simulates cleanly on ${CLUSTER}: one transaction (${what}), ${ready.bytes} bytes of ${PACKET}, ${count(ready.units, 0)} compute units (limit set to ${count(ready.limit, 0)}).`);
  if (bad.length) {
    console.log(`\nREFUSED: in simulation ${bad.join("; ")}. Nothing was sent.`);
    return 1;
  }
  console.log(`   the pool reads back from the simulation with its creator = the budget PDA ${A.budget}`);
  if (adoptedState) console.log(`   Hunch adopts it in the same transaction: its state reads back in phase curve, token ${adoptedState.mint}, ticker ${adoptedState.ticker}, the config's migration sqrt price pinned`);
  if (buying) {
    const row = openingCostTable(buyLamports.toString()).at(-1);
    console.log(`   the developer's buy: ${sol(buyLamports)} SOL in, ${count(tokens(got), 6)} ${symbol} out (${(tokens(got) / T.supply * 100).toFixed(4)}% of the supply; quoted ${count(tokens(quote.outputAmount), 6)}, minimum ${count(tokens(minOut), 6)})`);
    console.log(`   it paid ${sol(feePaid)} SOL of fee, exactly 3.75% (the opening fee at that second is 50%): Meteora ${sol(row.meteora)}, the budget ${sol(row.budget)}, back to the dev wallet ${sol(row.dev)}`);
  }
  const buyFromWallet = buying && wraps ? Number(buyLamports.toString()) : 0; // pre-wrapped: the buy's SOL is already in the WSOL account
  console.log(`   it takes ${count(sol(ready.spent), 6)} SOL from the dev wallet: ${buying ? (wraps ? `${sol(buyLamports)} for the buy, ` : `(the buy's ${sol(buyLamports)} SOL from its WSOL account), `) : ""}${count(sol(ready.spent - ready.fee - buyFromWallet), 6)} rent for the new accounts and Metaplex's fee, ${count(sol(ready.fee), 6)} network fee`);
  console.log(`   it holds ${count(sol(ready.before), 4)} SOL and would be left with ${count(sol(ready.before - ready.spent), 4)}`);

  const decision = maySend("token");
  if (!decision.go) return decision.code;
  console.log(`\nSending step 2: $${symbol} at ${mintKey.publicKey}${buying ? `, with the developer's ${sol(buyLamports)} SOL buy` : ""} ...`);
  const result = await sendOnce(connection, tx, [wallet, mintKey], {
    exists: () => connection.getAccountInfo(mintKey.publicKey),
    beforeSend: (signature, lastValidBlockHeight) => writeRecord(PENDING, { ...pending, tokenSent: { signature, lastValidBlockHeight } }),
  });
  if (result.outcome === "landed") {
    const landedPool = (await connection.getAccountInfo(pool))?.data;
    const made = decodePool(landedPool);
    console.log(`\n$${symbol} is live.\n   contract address  ${mintKey.publicKey}\n   pool              ${pool}\n   pool creator      ${made?.creator ?? "?"}${made?.creator.equals(A.budget) ? " (the budget PDA)" : "  NOT THE BUDGET PDA: stop and look"}\n   ${result.signature}`);
    try {
      const devBuy = await devBuyRecord(buying && landedPool ? poolFeesPaid(landedPool) : null);
      if (devBuy) console.log(`   the dev wallet bought ${devBuy.tokens} ${symbol} with ${devBuy.sol} SOL, paying ${devBuy.feeLamports} lamports of fee`);
      await recordLaunch(result.signature, devBuy);
      console.log(`   Written to ${LAUNCHED}.`);
    } catch (error) {
      console.log(`   It landed; only the record could not be written (${hide(error.message)}). Run the plan and it is written then.`);
    }
    const after = decodeState((await connection.getAccountInfo(A.state))?.data);
    if (after?.phase >= 1 && after.pool.equals(pool)) {
      console.log(`   Hunch adopted the pool in the same transaction: phase ${PHASE_NAME[after.phase]}, ticker ${after.ticker}.`);
      console.log(`\nNext: start the crank (hunch/crank). Ticks are refused until 5 s after the pool opened; the first tick is only a baseline.`);
    } else {
      console.log(`\nWARNING: Hunch's state reads phase ${PHASE_NAME[after?.phase] ?? "?"}, not curve. Adopt the pool now, then start the crank:\n   (cd ../scripts && SEND=1 STEP=adopt node init-hunch.mjs)`);
    }
    return 0;
  }
  if (result.outcome === "unknown") {
    console.log(`\nNOT KNOWN YET whether step 2 landed. Do NOT send it again now.\nWait a minute and run the plan, which looks on chain for the token:\n   ${say("")}`);
    return 1;
  }
  writeRecord(PENDING, pending);
  console.log(`\nStep 2 did NOT happen: ${outcomeInWords(result)}\nNo token was made. Run the plan again before trying again:\n   ${say("")}`);
  return 1;

  // ---- the dev buy: inside step 2, the pool's first swap ----
  function showDevBuyPlan() {
    if (buyLamports.isZero()) {
      console.log("dev buy   none (token.json devBuySol is 0): the token is created with nobody buying, and the config's");
      console.log("          \"first swap with min fee\" stays off");
      return;
    }
    const table = openingCostTable(buyLamports.toString()), at = table.at(-1), open = table[0];
    console.log(`dev buy   ${sol(buyLamports)} SOL, inside step 2: the pool's first swap, in the transaction that creates the pool,`);
    console.log("          after the creator role goes to the budget PDA. The config sets DBC's \"first swap with min fee\"");
    console.log("          (only because devBuySol is above 0), so that one swap pays 3.75%, not the 50% opening fee; DBC");
    console.log("          gives it only to a swap whose own transaction created the pool, so no outside trader can get it.");
    console.log(`          it pays ${sol(at.fee).toFixed(6)} SOL of fee: Meteora ${sol(at.meteora).toFixed(6)}, the budget ${sol(at.budget).toFixed(6)}, back to the dev wallet ${sol(at.dev).toFixed(6)}`);
    console.log(`          (a buy of the same size at the pool's first second would pay ${sol(open.fee).toFixed(4)} SOL)`);
  }

  // ---- after step 2 ----
  async function afterLaunch({ launched }) {
    console.log(`\n$${symbol} is launched on ${CLUSTER}, says ${LAUNCHED}:`);
    console.log(`   contract address  ${launched.mint}\n   pool              ${launched.pool}\n   config            ${launched.config}\n   budget PDA        ${launched.budget}`);
    const poolKey = new PublicKey(launched.pool);
    const p = decodePool((await connection.getAccountInfo(poolKey))?.data);
    if (p) console.log(`   pool creator      ${p.creator}${A && p.creator.equals(A.budget) ? " (the budget PDA)" : ""}, ${count(sol(p.quoteReserve), 4)} SOL in the curve`);
    if (st) console.log(`   Hunch             phase ${PHASE_NAME[st.phase] ?? st.phase}, ticker ${stTicker ?? "?"}${st.phase === 0 ? ": NOT ADOPTED YET, run (cd ../scripts && SEND=1 STEP=adopt node init-hunch.mjs)" : `, ${st.ticks} ticks`}`);
    if (launched.devBuy) console.log(`   the dev wallet bought ${launched.devBuy.tokens} ${symbol} with ${launched.devBuy.sol} SOL${launched.devBuy.inStep2 ? " in step 2" : ""}`);
    else if (buyLamports.gtn(0)) console.log(`   token.json asks for a ${sol(buyLamports)} SOL dev buy, but step 2 was made without one. A buy now is an ordinary trade at the pool's fee; this tool does not send it.`);
    if (SEND) console.log("REFUSED: there is nothing left to send.");
    return SEND ? 1 : 0;
  }
}

const settingsOf = (T) => Object.fromEntries(["startUsd", "graduationUsd", "curveFeeBps", "poolFeeBps", "openingFeeBps", "openingFeeSeconds", "creatorSharePct", "supply"].map((key) => [key, T[key] ?? null]));
const outcomeInWords = (result) => ({
  failed: `it reached the chain and the program refused it (${result.detail}). Only the network fee was paid.`,
  refused: `the node refused to pass it on, so it was never sent. What the node said:\n${result.detail}`,
  expired: "it never got into a block, and it no longer can. If the network is busy, a higher PRIORITY (for example PRIORITY=200000) helps it in.",
}[result.outcome]);

if (!new URL(import.meta.url).search && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stopped = (error) => {
    console.error(`\nSTOPPED: ${hide(error?.message ?? error)}\nNothing more was done. If a step had just been sent, do not send it again: run the plan (no SEND) to see what became of it.`);
    process.exit(1);
  };
  process.on("uncaughtException", stopped);
  process.on("unhandledRejection", (error) => console.error(`note      something went wrong in the background: ${hide(error?.message ?? error)}`));
  main().then((code) => { process.exitCode = code; }, stopped);
}
