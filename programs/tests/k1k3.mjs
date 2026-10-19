// Kill tests K1 and K3 for Hunch, against Meteora DBC's real mainnet bytecode on a local validator.
//
// Run through ../test.sh (it builds, starts solana-test-validator with the dumped DBC and Metaplex
// programs plus Hunch and the CPI probe, runs this file, and stops the validator). Every key here is
// a fresh throwaway made in memory; nothing is read from disk and nothing talks to devnet or mainnet.
//
// What it checks (each line of output starts with PASS, FAIL or INFO):
//   K3  createPool + transferPoolCreator(new creator = budget PDA) in ONE transaction, its size
//       against 1,232 bytes, and pool.creator read back as the budget PDA.
//   fee the creator fee counter on a buy inside the 5-second opening window and on trades after it
//       (expected 0.99% of the traded SOL after the window: 3.75% x 80% x 33%).
//   K1  buy_and_burn: sync_native + claim_creator_trading_fee2 + swap2 + burn + memo in one top-level
//       instruction signed by the budget PDA; compute units (< 250k) and transaction size.
//   K1  the guard: refused when any other non-ComputeBudget instruction shares the transaction, and
//       when called by CPI.

import { createRequire } from "node:module";

const MODULES = process.env.SDK_MODULES ?? "/mnt/c/Users/John/RafinhaProject/infinite-monkey/launch/package.json";
const require = createRequire(MODULES);
const sdk = require("@meteora-ag/dynamic-bonding-curve-sdk");
const {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const BN = require("bn.js");

const RPC = process.env.RPC_URL_LOCAL ?? "http://127.0.0.1:8899";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC)) throw new Error("this test only talks to a local validator");

const HUNCH = new PublicKey(process.env.HUNCH_PROGRAM ?? "ATxJHU3jCbm9fM6UKhZigZ2phpKKaa1UcbQXGsyYMwyT");
const PROBE = new PublicKey(process.env.PROBE_PROGRAM ?? "J5rMHTxcFaQ3q9yzsn5DDiQGjCGnqt1pgwQUzTXqj5Kd");
const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const WSOL = spl.NATIVE_MINT;
const PACKET = 1232;
const K1_CU = 250_000;

const ERR = { 1: "CALLED_BY_CPI", 2: "NOT_ALONE", 3: "NOT_TOP_LEVEL", 4: "WRONG_ACCOUNT", 5: "NOTHING_TO_SPEND" };

const connection = new Connection(RPC, "confirmed");
const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");

const results = [];
const check = (ok, label, detail = "") => {
  results.push({ ok, label });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const info = (text) => console.log(`INFO  ${text}`);
const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
const pct = (num, den) => (den === 0 ? "n/a" : `${((100 * Number(num)) / Number(den)).toFixed(4)}%`);

const [budget, budgetBump] = PublicKey.findProgramAddressSync([Buffer.from("budget")], HUNCH);
const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DBC);
const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DBC);
const budgetWsol = spl.getAssociatedTokenAddressSync(WSOL, budget, true);

// A transaction's wire size: the message, the signature count (one byte below 128) and 64 bytes per signature.
function wireSize(tx) {
  return tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures;
}

async function send(instructions, signers, { label = "tx" } = {}) {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const size = wireSize(tx);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await connection.confirmTransaction(sig, "confirmed");
  let got = null;
  for (let i = 0; i < 20 && !got; i++) {
    got = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!got) await new Promise((r) => setTimeout(r, 200));
  }
  const err = got?.meta?.err ?? conf.value.err ?? null;
  return { sig, size, err, cu: got?.meta?.computeUnitsConsumed ?? null, logs: got?.meta?.logMessages ?? [], blockTime: got?.blockTime ?? null, label };
}

function customCode(err) {
  const ie = err?.InstructionError;
  return ie && typeof ie[1] === "object" && "Custom" in ie[1] ? ie[1].Custom : null;
}

async function poolState(pool) {
  const p = await client.state.getPool(pool);
  if (!p) throw new Error("pool not found");
  return p.poolState; // SDK 1.5.13 (DBC 0.2.1) wraps the fields in poolState
}

const fees = (p) => ({
  creator: BigInt(p.creatorQuoteFee.toString()),
  partner: BigInt(p.partnerQuoteFee.toString()),
  protocol: BigInt(p.protocolQuoteFee.toString()),
});

async function tokenAmount(account) {
  const a = await connection.getTokenAccountBalance(account).catch(() => null);
  return a ? BigInt(a.value.amount) : 0n;
}

function initIx(payer) {
  return new TransactionInstruction({
    programId: HUNCH,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: budget, isSigner: false, isWritable: false },
      { pubkey: budgetWsol, isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: spl.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: spl.ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, budgetBump]),
  });
}

function buyAndBurnKeys(env) {
  return [
    { pubkey: budget, isSigner: false, isWritable: false },
    { pubkey: budgetWsol, isSigner: false, isWritable: true },
    { pubkey: env.budgetHunch, isSigner: false, isWritable: true },
    { pubkey: env.mint, isSigner: false, isWritable: true },
    { pubkey: WSOL, isSigner: false, isWritable: false },
    { pubkey: env.pool, isSigner: false, isWritable: true },
    { pubkey: env.config, isSigner: false, isWritable: false },
    { pubkey: env.baseVault, isSigner: false, isWritable: true },
    { pubkey: env.quoteVault, isSigner: false, isWritable: true },
    { pubkey: poolAuthority, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: DBC, isSigner: false, isWritable: false },
    { pubkey: spl.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MEMO, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
  ];
}

function buyAndBurnData(slice, minOut) {
  const data = Buffer.alloc(18);
  data[0] = 1;
  data[1] = budgetBump;
  data.writeBigUInt64LE(BigInt(slice), 2);
  data.writeBigUInt64LE(BigInt(minOut), 10);
  return data;
}

const buyAndBurnIx = (env, slice, minOut) =>
  new TransactionInstruction({ programId: HUNCH, keys: buyAndBurnKeys(env), data: buyAndBurnData(slice, minOut) });

// The same call, made by the probe program through CPI.
const probeIx = (env, slice, minOut) =>
  new TransactionInstruction({
    programId: PROBE,
    keys: [{ pubkey: HUNCH, isSigner: false, isWritable: false }, ...buyAndBurnKeys(env)],
    data: buyAndBurnData(slice, minOut),
  });

async function traderSwap(env, trader, { buy, amount }) {
  const tx = await client.pool.swap2({
    owner: trader.publicKey,
    pool: env.pool,
    swapBaseForQuote: !buy,
    referralTokenAccount: null,
    swapMode: sdk.SwapMode.ExactIn,
    amountIn: new BN(amount.toString()),
    minimumAmountOut: new BN(0),
  });
  return tx.instructions;
}

async function nowOnChain() {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

async function main() {
  const version = await connection.getVersion();
  info(`local validator ${version["solana-core"]} at ${RPC}`);
  const dbcAccount = await connection.getAccountInfo(DBC);
  check(!!dbcAccount?.executable, "DBC program (dumped from mainnet) is loaded", DBC.toBase58());

  // Throwaway keys, in memory only.
  const dev = Keypair.generate(); // partner, fee claimer, pays and creates the pool
  const trader = Keypair.generate();
  const mintKp = Keypair.generate();
  const configKp = Keypair.generate();
  for (const who of [dev, trader]) {
    const s = await connection.requestAirdrop(who.publicKey, 500 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(s, "confirmed");
  }
  info(`budget PDA ${budget.toBase58()} (bump ${budgetBump}), its WSOL account ${budgetWsol.toBase58()}`);

  // ---- Hunch init: the budget's WSOL account ----
  const init = await send([initIx(dev.publicKey)], [dev]);
  const wsolInfo = await connection.getAccountInfo(budgetWsol);
  check(!init.err && !!wsolInfo, "init creates the budget's WSOL account", `cu ${init.cu}, err ${JSON.stringify(init.err)}`);

  // ---- DBC config with the user's numbers ----
  const curve = sdk.buildCurveWithMarketCap({
    token: {
      tokenType: sdk.TokenType.SPLToken,
      tokenBaseDecimal: sdk.TokenDecimal.SIX,
      tokenQuoteDecimal: sdk.TokenDecimal.NINE,
      tokenAuthorityOption: sdk.TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: sdk.BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 5000, endingFeeBps: 375, numberOfPeriod: 5, totalDuration: 5 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: sdk.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 33,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: sdk.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: sdk.MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: sdk.MigratedCollectFeeMode.QuoteToken, dynamicFee: sdk.DammV2DynamicFeeMode.Disabled, poolFeeBps: 375 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 67,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 33,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: sdk.ActivationType.Timestamp,
    // In SOL: a test curve from 40 SOL to 400 SOL of market cap.
    initialMarketCap: 40,
    migrationMarketCap: 400,
  });
  const configTx = await client.partner.createConfig({
    ...curve,
    config: configKp.publicKey,
    feeClaimer: dev.publicKey,
    leftoverReceiver: budget,
    payer: dev.publicKey,
    quoteMint: WSOL,
  });
  const cfgRes = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...configTx.instructions], [dev, configKp]);
  check(!cfgRes.err, "create_config accepted by DBC", `${cfgRes.size} bytes, cu ${cfgRes.cu}${cfgRes.err ? ` err ${JSON.stringify(cfgRes.err)}\n${cfgRes.logs.slice(-8).join("\n")}` : ""}`);
  if (cfgRes.err) return;
  const cfg = await client.state.getPoolConfig(configKp.publicKey);
  info(
    `config: creatorTradingFeePercentage ${cfg.creatorTradingFeePercentage}, collectFeeMode ${cfg.collectFeeMode}, ` +
      `cliffFeeNumerator ${cfg.poolFees.baseFee.cliffFeeNumerator} (${Number(cfg.poolFees.baseFee.cliffFeeNumerator) / 1e7}%), ` +
      `periods ${cfg.poolFees.baseFee.firstFactor}, period ${cfg.poolFees.baseFee.secondFactor}s, step ${cfg.poolFees.baseFee.thirdFactor}, ` +
      `migrationFeeOption ${cfg.migrationFeeOption}, migratedPoolFeeBps ${cfg.migratedPoolFeeBps}, ` +
      `LP partner/creator permanently locked ${cfg.partnerPermanentLockedLiquidityPercentage}/${cfg.creatorPermanentLockedLiquidityPercentage}, ` +
      `tokenUpdateAuthority ${cfg.tokenUpdateAuthority}, leftoverReceiver ${cfg.leftoverReceiver.toBase58()}, migrationQuoteThreshold ${sol(cfg.migrationQuoteThreshold)} SOL`,
  );

  // ---- K3: createPool + transferPoolCreator in ONE transaction ----
  const pool = sdk.deriveDbcPoolAddress(WSOL, mintKp.publicKey, configKp.publicKey);
  const createTx = await client.creator.createPool({
    name: "Hunch",
    symbol: "HUNCH",
    uri: "https://example.invalid/hunch.json",
    payer: dev.publicKey,
    poolCreator: dev.publicKey,
    config: configKp.publicKey,
    baseMint: mintKp.publicKey,
  });
  // The SDK's transferPoolCreator() fetches the pool first, so it cannot be built before the pool
  // exists. The same instruction is built here from the program's own builder, with the config known.
  let sdkTransferThrew = null;
  try {
    await client.creator.transferPoolCreator({ pool, creator: dev.publicKey, newCreator: budget });
  } catch (e) {
    sdkTransferThrew = String(e.message ?? e);
  }
  info(`SDK client.creator.transferPoolCreator before the pool exists: ${sdkTransferThrew ? `throws "${sdkTransferThrew}"` : "works"}`);
  const transferIx = await client.creator.program.methods
    .transferPoolCreator()
    .accountsPartial({ virtualPool: pool, config: configKp.publicKey, creator: dev.publicKey, newCreator: budget })
    .instruction();
  // The SDK adds a DAMM v1 migration-metadata remaining account (unused before migration); measured too.
  const transferIxSdkShape = new TransactionInstruction({
    programId: transferIx.programId,
    keys: [...transferIx.keys, { pubkey: sdk.deriveDammV1MigrationMetadataAddress(pool), isSigner: false, isWritable: false }],
    data: transferIx.data,
  });
  const budgetIxs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
  const sized = (ixs) => {
    const t = new Transaction().add(...ixs);
    t.feePayer = dev.publicKey;
    t.recentBlockhash = PublicKey.default.toBase58();
    return wireSize(t);
  };
  const bare = sized([...createTx.instructions, transferIx]);
  const withSdkExtra = sized([...createTx.instructions, transferIxSdkShape]);
  const withBudget = sized([...budgetIxs, ...createTx.instructions, transferIx]);
  info(`K3 sizes: create+transfer ${bare} B; with the SDK's extra remaining account ${withSdkExtra} B; with 2 ComputeBudget instructions ${withBudget} B (limit ${PACKET})`);
  const k3 = await send([...budgetIxs, ...createTx.instructions, transferIx], [dev, mintKp]);
  check(!k3.err, "K3 createPool + transferPoolCreator land in one transaction", `${k3.size} B of ${PACKET}, cu ${k3.cu}${k3.err ? ` err ${JSON.stringify(k3.err)}\n${k3.logs.slice(-10).join("\n")}` : ""}`);
  check(k3.size <= PACKET, "K3 transaction fits in 1,232 bytes", `${k3.size} B (legacy transaction, no lookup table); margin ${PACKET - k3.size} B`);
  if (k3.err) return;

  // ---- opening window: the first buy, as soon as the pool exists ----
  let p = await poolState(pool);
  check(p.creator.equals(budget), "K3 pool.creator reads back as the budget PDA", p.creator.toBase58());
  const env = {
    pool,
    mint: mintKp.publicKey,
    config: configKp.publicKey,
    baseVault: p.baseVault,
    quoteVault: p.quoteVault,
    budgetHunch: spl.getAssociatedTokenAddressSync(mintKp.publicKey, budget, true),
  };
  const activation = Number(p.activationPoint.toString());
  const mintInfo = await connection.getAccountInfo(mintKp.publicKey);
  const mintData = spl.MintLayout.decode(mintInfo.data);
  const md = await connection.getAccountInfo(sdk.deriveMintMetadata(mintKp.publicKey));
  // Metaplex Metadata: key, update authority, mint, name(4+32), symbol(4+10), uri(4+200), fee(2), creators option, primary sale, is_mutable.
  const isMutable = md && md.data[321] === 0 ? md.data[323] : null;
  check(mintData.mintAuthorityOption === 0 && isMutable === 0, "plain SPL token with no mint authority and immutable metadata",
    `mint authority ${mintData.mintAuthorityOption ? "set" : "none"}, metadata is_mutable ${isMutable}, metadata owner ${md?.owner.toBase58()}`);
  info(`pool ${pool.toBase58()}, mint ${mintKp.publicKey.toBase58()} (owner ${mintInfo.owner.toBase58()}), activation point ${activation} (unix seconds)`);

  const trades = [];
  async function trade(label, opts) {
    const before = fees(await poolState(pool));
    const quoteBefore = await tokenAmount(env.quoteVault);
    const res = await send(await traderSwap(env, trader, opts), [trader]);
    const after = fees(await poolState(pool));
    const quoteAfter = await tokenAmount(env.quoteVault);
    const d = { creator: after.creator - before.creator, partner: after.partner - before.partner, protocol: after.protocol - before.protocol };
    const totalFee = d.creator + d.partner + d.protocol;
    // SOL traded: on a buy, what went in (fee included); on a sell, the gross SOL taken out (fee included).
    // (In QuoteToken mode the fee stays in the quote vault, so on a sell the vault only drops by the net payout.)
    const traded = opts.buy ? BigInt(opts.amount) : quoteBefore - quoteAfter + totalFee;
    const t = { label, buy: opts.buy, secondsAfterOpen: res.blockTime - activation, traded, ...d, totalFee, err: res.err, cu: res.cu };
    trades.push(t);
    const gross = traded;
    info(
      `${label}: ${opts.buy ? "buy" : "sell"} at t=${t.secondsAfterOpen}s, SOL traded ${sol(traded)}, total fee ${sol(totalFee)} (${pct(totalFee, gross)}), ` +
        `creator ${sol(d.creator)} (${pct(d.creator, gross)}), partner ${sol(d.partner)} (${pct(d.partner, gross)}), protocol ${sol(d.protocol)} (${pct(d.protocol, gross)})` +
        `${res.err ? ` ERR ${JSON.stringify(res.err)}` : ""}`,
    );
    return t;
  }

  const opening = await trade("opening buy", { buy: true, amount: LAMPORTS_PER_SOL / 2 });
  check(!opening.err && opening.secondsAfterOpen < 5, "a buy inside the 5-second opening window lands", `t=${opening.secondsAfterOpen}s`);
  // Two more small buys while the opening fee falls (50% at t=0 down to 3.75% at t=5, one step a second).
  const decay = [];
  for (const at of [2, 4]) {
    while ((await nowOnChain()) < activation + at) await new Promise((r) => setTimeout(r, 200));
    decay.push(await trade(`opening buy at t>=${at}s`, { buy: true, amount: LAMPORTS_PER_SOL / 10 }));
  }
  const expectedBps = (t) => Math.max(375, 5000 - 925 * Math.min(t, 5));
  const decayOk = [opening, ...decay].every((t) => !t.err && Math.abs((10000 * Number(t.totalFee)) / Number(t.traded) - expectedBps(t.secondsAfterOpen)) < 1);
  check(decayOk, "the opening fee falls in a straight line, 925 bps a second", [opening, ...decay].map((t) => `t=${t.secondsAfterOpen}s ${pct(t.totalFee, t.traded)}`).join(", "));
  // Wait until the chain's clock is past the opening schedule.
  while ((await nowOnChain()) < activation + 6) await new Promise((r) => setTimeout(r, 400));
  const later = [];
  later.push(await trade("buy 1", { buy: true, amount: 2 * LAMPORTS_PER_SOL }));
  later.push(await trade("buy 2", { buy: true, amount: 5 * LAMPORTS_PER_SOL }));
  later.push(await trade("buy 3", { buy: true, amount: LAMPORTS_PER_SOL }));
  const traderHunch = await tokenAmount(spl.getAssociatedTokenAddressSync(mintKp.publicKey, trader.publicKey));
  later.push(await trade("sell 1", { buy: false, amount: traderHunch / 3n }));
  later.push(await trade("buy 4", { buy: true, amount: 3 * LAMPORTS_PER_SOL }));
  const sumTraded = later.reduce((s, t) => s + t.traded, 0n);
  const sumCreator = later.reduce((s, t) => s + t.creator, 0n);
  const sumFee = later.reduce((s, t) => s + t.totalFee, 0n);
  const creatorShare = Number(sumCreator) / Number(sumTraded);
  check(
    later.every((t) => !t.err) && Math.abs(creatorShare - 0.0099) < 0.00005,
    "after the opening window the creator fee counter grows by 0.99% of SOL traded",
    `${sol(sumCreator)} of ${sol(sumTraded)} SOL = ${(creatorShare * 100).toFixed(4)}% (total fee ${pct(sumFee, sumTraded)}, creator share of fee ${pct(sumCreator, sumFee)})`,
  );
  check(
    Math.abs(Number(opening.creator) / Number(opening.totalFee) - 0.264) < 0.001 && Number(opening.totalFee) / Number(opening.traded) > 0.0375,
    "inside the opening window the fee is higher and the creator still gets 26.4% of it",
    `fee ${pct(opening.totalFee, opening.traded)} of the trade at t=${opening.secondsAfterOpen}s, creator ${pct(opening.creator, opening.traded)} of the trade`,
  );

  // ---- K1: buy_and_burn ----
  // The budget's HUNCH account (anyone can create an associated token account for the PDA).
  const ataRes = await send([spl.createAssociatedTokenAccountIdempotentInstruction(dev.publicKey, env.budgetHunch, budget, env.mint)], [dev]);
  check(!ataRes.err, "the budget's HUNCH account is created");

  p = await poolState(pool);
  const claimable = BigInt(p.creatorQuoteFee.toString());
  const heldWsol = await tokenAmount(budgetWsol);
  const slice = claimable + heldWsol; // spend everything held after the claim
  const cfgNow = await client.state.getPoolConfig(env.config);
  const quote = client.pool.swapQuote2({
    virtualPool: { poolState: p },
    config: cfgNow,
    swapBaseForQuote: false,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: new BN(await nowOnChain()),
    slippageBps: 100,
    swapMode: sdk.SwapMode.ExactIn,
    amountIn: new BN(slice.toString()),
  });
  const expectedOut = BigInt(quote.outputAmount.toString());
  const minOut = (expectedOut * 99n) / 100n;
  info(`budget: creator fee counter ${sol(claimable)} SOL, WSOL held ${sol(heldWsol)}; slice ${sol(slice)} SOL, quoted ${expectedOut} HUNCH units, min_out ${minOut}`);

  // The guard first, while there is something to spend, so that the guard is the only reason to refuse.
  const cb = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })];
  const transfer1 = SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: trader.publicKey, lamports: 1 });
  const refusals = [
    ["a SOL transfer after it", [...cb, buyAndBurnIx(env, slice, minOut), transfer1], [dev], 2],
    ["a SOL transfer before it", [...cb, transfer1, buyAndBurnIx(env, slice, minOut)], [dev], 2],
    ["a trader's DBC buy before it (sandwich attempt)", [...cb, ...(await traderSwap(env, trader, { buy: true, amount: LAMPORTS_PER_SOL })), buyAndBurnIx(env, slice, minOut)], [trader], 2],
    ["two buy_and_burn instructions", [...cb, buyAndBurnIx(env, slice / 2n, 0), buyAndBurnIx(env, slice / 2n, 0)], [dev], 2],
    ["a call through another program (CPI)", [...cb, probeIx(env, slice, minOut)], [dev], 1],
  ];
  for (const [label, ixs, signers, want] of refusals) {
    const r = await send(ixs, signers);
    const code = customCode(r.err);
    check(code === want, `buy_and_burn refused with ${label}`, `error ${code !== null ? `Custom(${code}) ${ERR[code] ?? ""}` : JSON.stringify(r.err)}`);
  }
  const tooGreedy = await send([...cb, buyAndBurnIx(env, slice, expectedOut * 2n)], [dev]);
  const slippageLog = tooGreedy.logs.find((l) => /Error Code|Slippage|exceeded/i.test(l)) ?? JSON.stringify(tooGreedy.err);
  check(!!tooGreedy.err, "buy_and_burn reverts when DBC cannot meet min_out", slippageLog);

  const supplyBefore = BigInt((await connection.getTokenSupply(env.mint)).value.amount);
  const pBefore = await poolState(pool);
  const run = await send([...cb, buyAndBurnIx(env, slice, minOut)], [dev]);
  check(!run.err, "K1 buy_and_burn succeeds in one top-level instruction", run.err ? `err ${JSON.stringify(run.err)}\n${run.logs.join("\n")}` : "");
  if (run.err) return finish();
  const pAfter = await poolState(pool);
  const supplyAfter = BigInt((await connection.getTokenSupply(env.mint)).value.amount);
  const burned = supplyBefore - supplyAfter;
  const wsolAfter = await tokenAmount(budgetWsol);
  const hunchAfter = await tokenAmount(env.budgetHunch);
  // The counter is emptied by the claim, then refilled by Hunch's own buy (it pays the pool fee too).
  const ownFee = BigInt(pAfter.creatorQuoteFee.toString());
  const ownExpected = (Number(slice) * 0.0099);
  const claimLog = run.logs.some((l) => l.includes("Instruction: ClaimCreatorTradingFee2"));
  check(claimLog && BigInt(pBefore.creatorQuoteFee.toString()) === claimable && Math.abs(Number(ownFee) - ownExpected) < 1000,
    "it claimed the whole creator fee with claim_creator_trading_fee2",
    `claimed ${sol(claimable)} SOL; the counter now holds only ${sol(ownFee)} SOL, the 0.99% Hunch's own buy paid back to itself`);
  check(burned >= minOut && hunchAfter === 0n, "it bought and burned the whole HUNCH balance (supply went down)", `supply ${supplyBefore} -> ${supplyAfter} (-${burned} units = ${(Number(burned) / 1e6).toFixed(2)} HUNCH), budget HUNCH left ${hunchAfter}`);
  check(wsolAfter === 0n, "the slice spent everything held", `budget WSOL left ${wsolAfter}`);
  const memo = run.logs.find((l) => l.includes("Memo (len"));
  check(!!memo, "the memo landed", memo ?? "no memo line in logs");
  check(run.cu !== null && run.cu < K1_CU, `K1 compute units under ${K1_CU.toLocaleString()}`, `${run.cu} CU consumed by the whole transaction (2 ComputeBudget instructions + buy_and_burn)`);
  check(run.size <= PACKET, "buy_and_burn transaction size", `${run.size} B of ${PACKET} (legacy, 1 signer, 2 ComputeBudget instructions, 15 accounts)`);
  // Where the compute goes, from the log's "consumed" lines.
  const consumed = run.logs.filter((l) => / consumed \d+ of \d+ compute units/.test(l));
  info(`compute breakdown (inner program totals include their own CPIs):\n      ${consumed.join("\n      ")}`);
  info(`buy_and_burn signature ${run.sig}`);
  info(`instructions run inside it: ${run.logs.filter((l) => l.startsWith("Program log: Instruction:")).map((l) => l.slice(26)).join(" > ")}`);
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
