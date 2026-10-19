// Builds, offline, the Meteora DBC instructions the LiteSVM tests send: create_config with the user's
// numbers (3.75% fee, 50% opening falling to 3.75% over 5 seconds, creator share 33, QuoteToken, DAMM v2
// migration Customizable 375 bps, LP 67/33 permanently locked, leftover to the budget PDA, immutable
// metadata), the pool (initialize_virtual_pool_with_spl_token) and transfer_pool_creator to the budget.
//
// It talks to no network: the SDK's one RPC read (the quote mint's owner) is answered locally.
// Usage: node dbc-ixs.mjs <payer> <config> <mint> <budget> <variant>    (public keys only, base58)
// Variants: good | fee50 (creator share 50) | leftover (leftover to the payer) | schedule (ends at 300 bps)
//           | lp5050 | segments (16 segments of uneven liquidity) | small (a curve that completes at ~3 SOL)
//           | replay (a curve from 400 to 200,000 SOL of market cap, so the rehearsal pool's prices sit on it)
//           | grad (the small curve with 20M HUNCH of leftover for the budget: the graduation tests)
//           | minfee (good, with enable_first_swap_with_min_fee: the developer's buy in the pool-creating transaction)
// Prints JSON: { pool, baseVault, quoteVault, metadata, ixs: { config: [ix], pool: [ix], transfer: ix } }

import { createRequire } from "node:module";

const require = createRequire(process.env.SDK_MODULES ?? "/mnt/c/Users/John/RafinhaProject/infinite-monkey/launch/package.json");
const sdk = require("@meteora-ag/dynamic-bonding-curve-sdk");
const { Connection, PublicKey } = require("@solana/web3.js");
const spl = require("@solana/spl-token");

const [payerS, configS, mintS, budgetS, variant = "good"] = process.argv.slice(2);
const payer = new PublicKey(payerS), config = new PublicKey(configS), mint = new PublicKey(mintS), budget = new PublicKey(budgetS);
const WSOL = spl.NATIVE_MINT;

const connection = new Connection("http://127.0.0.1:9"); // never contacted
connection.getAccountInfo = async () => ({ owner: spl.TOKEN_PROGRAM_ID, data: Buffer.alloc(82), lamports: 1, executable: false });
const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");

const v = variant;
const base = {
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
      feeSchedulerParam: { startingFeeBps: 5000, endingFeeBps: v === "schedule" ? 300 : 375, numberOfPeriod: 5, totalDuration: 5 },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: sdk.CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: v === "fee50" ? 50 : 33,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: v === "minfee",
  },
  migration: {
    migrationOption: sdk.MigrationOption.MET_DAMM_V2,
    migrationFeeOption: sdk.MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: sdk.MigratedCollectFeeMode.QuoteToken, dynamicFee: sdk.DammV2DynamicFeeMode.Disabled, poolFeeBps: 375 },
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: v === "lp5050" ? 50 : 67,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: v === "lp5050" ? 50 : 33,
    creatorLiquidityPercentage: 0,
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: sdk.ActivationType.Timestamp,
};

let curve;
if (v === "segments") {
  // 16 segments whose liquidity alternates 1:4, so a buy can cross from thick to thin liquidity
  curve = sdk.buildCurveWithLiquidityWeights({
    ...base, token: { ...base.token, leftover: 50_000_000 }, initialMarketCap: 40, migrationMarketCap: 400,
    liquidityWeights: Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.5 : 2)),
  });
} else if (v === "replay") {
  curve = sdk.buildCurveWithMarketCap({ ...base, initialMarketCap: 400, migrationMarketCap: 200_000 });
} else if (v === "small") {
  curve = sdk.buildCurveWithMarketCap({ ...base, initialMarketCap: 10, migrationMarketCap: 25 });
} else if (v === "grad") {
  curve = sdk.buildCurveWithMarketCap({ ...base, token: { ...base.token, leftover: 20_000_000 }, initialMarketCap: 10, migrationMarketCap: 25 });
} else {
  curve = sdk.buildCurveWithMarketCap({ ...base, initialMarketCap: 40, migrationMarketCap: 400 });
}

const toJson = (ix) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString("base64"),
});

const configTx = await client.partner.createConfig({
  ...curve, config, feeClaimer: payer, leftoverReceiver: v === "leftover" ? payer : budget, payer, quoteMint: WSOL,
});
const pool = sdk.deriveDbcPoolAddress(WSOL, mint, config);
const poolTx = await client.creator.buildCreatePoolTx(
  { name: "Hunch", symbol: "HUNCH", uri: "https://example.invalid/hunch.json", payer, poolCreator: payer, config, baseMint: mint },
  0, WSOL,
);
const transferIx = await client.creator.program.methods
  .transferPoolCreator()
  .accountsPartial({ virtualPool: pool, config, creator: payer, newCreator: budget })
  .instruction();

console.log(JSON.stringify({
  pool: pool.toBase58(),
  baseVault: sdk.deriveDbcTokenVaultAddress(pool, mint).toBase58(),
  quoteVault: sdk.deriveDbcTokenVaultAddress(pool, WSOL).toBase58(),
  metadata: sdk.deriveMintMetadata(mint).toBase58(),
  ixs: { config: configTx.instructions.map(toJson), pool: poolTx.instructions.map(toJson), transfer: toJson(transferIx) },
}));
