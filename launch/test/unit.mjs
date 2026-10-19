// Checks of the launch pieces that touch nothing (no network, no key): the ticker rule and the 47 + n bytes
// of initialize's data, the stored ticker read back from a State, the first-swap flag in the config and in
// the adoption checks, the developer's buy (swap2 by hand against the SDK's own builder, the 3.75% fee,
// the instruction order).   node launch/test/unit.mjs

import { need } from "../../crank/deps.mjs";
import { addresses, adoptionProblems, DBC, initializeIx, SYSVAR_INSTRUCTIONS } from "../../crank/hunch-program.mjs";
import {
  adoptable, buildConfig, configDifferences, devBuyIxs, devBuySwapIx, feeOnBuy, firstSwapFlag, FIRST_SWAP_FLAG_AT, openingCostTable, poolFeesPaid,
  STATE_TICKER_AT, storedTicker, SWAP2_DISC, tickerOk, tokenProblems,
} from "../launch.mjs";
import { withTicker } from "../../scripts/init-hunch.mjs";
import { readFileSync } from "node:fs";

const sdk = need("@meteora-ag/dynamic-bonding-curve-sdk");
const { Connection, Keypair } = need("@solana/web3.js");
const { getAssociatedTokenAddressSync, NATIVE_MINT } = need("@solana/spl-token");
const BN = need("bn.js");

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
const T = JSON.parse(readFileSync(new URL("../token.json", import.meta.url), "utf8"));

// ---- the ticker ----
for (const t of ["HUNCH", "HOURHOG", "A", "ABCDEFGHIJ", "H2O"]) check(tickerOk(t), `ticker ${t} passes the program's rule`);
for (const t of ["", "ABCDEFGHIJK", "hunch", "Hunch", "HUN-CH", "HUN.CH", "HUN CH", "$HUNCH", "HÜNCH", null, 5]) check(!tickerOk(t), `ticker ${JSON.stringify(t)} is refused (as BAD_TICKER would)`);
check(tickerOk(T.symbol), `token.json's symbol ${T.symbol} is a ticker the program stores`);
check(tokenProblems({ ...T, symbol: "hunch" }).some((p) => /not a ticker/.test(p)), "token.json: a lowercase symbol is caught before anything is sent");
check(tokenProblems(T).length === 1 && /uri is not set/.test(tokenProblems(T)[0]), "token.json as it is: only the uri is missing");

// initialize: crank/hunch-program.mjs's 46-byte head (or its 47 + n bytes once it takes the ticker), checked
const A = addresses(Keypair.generate().publicKey);
const authority = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const ix = withTicker(initializeIx(A, authority, mint, 12346, "HUNCH"), "HUNCH");
check(ix.data.length === 47 + 5 && ix.data[46] === 5 && ix.data.subarray(47).toString() === "HUNCH", "initialize data: 47 + n bytes, the length at 46, the ticker at 47");
check(ix.data[0] === 0 && ix.data.subarray(1, 33).equals(mint.toBuffer()) && ix.data.readUInt32LE(33) === 12346 && ix.data.subarray(37, 46).equals(Buffer.from(A.bumps)), "initialize data: tag 0, the mint, seed 12346, the nine bumps");
check(ix.keys.length === 15 && ix.keys[0].pubkey.equals(authority) && ix.keys[0].isSigner, "initialize: 15 accounts, the authority signs");
let threw = null;
try { withTicker(initializeIx(A, authority, mint, 12346, "HUNCH"), "hunch"); } catch (e) { threw = e.message; }
check(/not 1 to 10/.test(threw ?? ""), "a bad ticker never reaches initialize's data");
const twice = withTicker(withTicker(initializeIx(A, authority, mint, 12346, "HUNCH"), "HUNCH"), "HUNCH");
check(twice.data.length === 52, "data already holding the ticker is kept as it is");
threw = null;
try { withTicker(withTicker(initializeIx(A, authority, mint, 12346, "HUNCH"), "HUNCH"), "HOURHOG"); } catch (e) { threw = e.message; }
check(/not the 46-byte head/.test(threw ?? ""), "data holding another ticker is refused, not patched");

// the ticker a State holds
const st = Buffer.alloc(1248);
st.write("HUNCHSTA", 0);
st.write("HOURHOG", STATE_TICKER_AT);
check(storedTicker(st) === "HOURHOG" && storedTicker(st.subarray(0, 920)) === null, "the stored ticker: up to the first zero at 1,184; none in a 920-byte State");

// ---- the first-swap-with-min-fee flag ----
check(firstSwapFlag({ devBuySol: 0.5 }) && !firstSwapFlag({ devBuySol: 0 }) && !firstSwapFlag({}), "the flag is on only when devBuySol is above 0");
const solUsd = 180;
const withBuy = buildConfig({ ...T, devBuySol: 0.5 }, solUsd), noBuy = buildConfig(T, solUsd);
check(withBuy.enableFirstSwapWithMinFee === true && noBuy.enableFirstSwapWithMinFee === false, "buildConfig sets the flag from devBuySol");
const owner = Keypair.generate().publicKey;
const asChain = (c, flag) => ({ ...c, quoteMint: NATIVE_MINT, feeClaimer: owner, leftoverReceiver: A.budget, poolFees: c.poolFees, enableFirstSwapWithMinFee: flag, curve: c.curve, preMigrationTokenSupply: c.tokenSupply?.preMigrationTokenSupply });
const rowOf = (d) => d.filter((x) => /first-trade fee rule/.test(x));
check(rowOf(configDifferences(asChain(withBuy, 1), withBuy, owner, A.budget)).length === 0, "configDifferences: flag 1 expected with a dev buy");
check(rowOf(configDifferences(asChain(withBuy, 0), withBuy, owner, A.budget)).length === 1, "configDifferences: flag 0 with a dev buy is a difference");
check(rowOf(configDifferences(asChain(noBuy, 1), noBuy, owner, A.budget)).length === 1, "configDifferences: flag 1 without a dev buy is a difference");
// adopt_curve accepts 0 or 1: a config differing only in that byte passes the (filtered) adoption checks
const cfg = Buffer.alloc(1048);
cfg[FIRST_SWAP_FLAG_AT] = 1;
const raw = adoptionProblems(cfg, A.budget);
check(!adoptable(raw, cfg).includes("no first-swap-with-min-fee"), "adoptable: the flag at 1 is not a problem");
cfg[FIRST_SWAP_FLAG_AT] = 2;
check(adoptable(adoptionProblems(cfg, A.budget), cfg).includes("no first-swap-with-min-fee"), "adoptable: the flag at 2 still is (error 10)");

// ---- the developer's buy ----
const config = Keypair.generate().publicKey, base = Keypair.generate().publicKey;
const pool = sdk.deriveDbcPoolAddress(NATIVE_MINT, base, config);
const lamports = new BN(500_000_000), minOut = new BN(123_456_789);
const swap = devBuySwapIx({ pool, config, mint: base, owner, lamports, minOut });
check(swap.programId.equals(DBC) && swap.keys.length === 16 && swap.keys[15].pubkey.equals(SYSVAR_INSTRUCTIONS), "swap2: 15 named accounts, then the instructions sysvar");
check(swap.keys[12].pubkey.equals(DBC) && swap.data.subarray(0, 8).equals(SWAP2_DISC) && swap.data.length === 25 && swap.data[24] === 0, "swap2: no referral (DBC's id in its slot), exact in");
check(swap.data.readBigUInt64LE(8) === 500_000_000n && swap.data.readBigUInt64LE(16) === 123_456_789n, "swap2: amount in and minimum out");
// against the SDK's own builder (the same program, its IDL)
const client = sdk.DynamicBondingCurveClient.create(new Connection("http://127.0.0.1:1"), "confirmed");
const fromSdk = await client.pool.getProgram().methods.swap2({ amount0: lamports, amount1: minOut, swapMode: 0 }).accountsPartial({
  baseMint: base, quoteMint: NATIVE_MINT, pool, baseVault: sdk.deriveDbcTokenVaultAddress(pool, base), quoteVault: sdk.deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
  config, poolAuthority: sdk.deriveDbcPoolAuthority(), referralTokenAccount: null, inputTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, owner),
  outputTokenAccount: getAssociatedTokenAddressSync(base, owner), payer: owner, tokenBaseProgram: swap.keys[10].pubkey, tokenQuoteProgram: swap.keys[11].pubkey,
}).remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false }]).instruction();
const same = fromSdk.data.equals(swap.data) && fromSdk.keys.length === swap.keys.length
  && fromSdk.keys.every((k, i) => k.pubkey.equals(swap.keys[i].pubkey) && k.isSigner === swap.keys[i].isSigner && k.isWritable === swap.keys[i].isWritable);
check(same, "swap2 by hand is byte for byte the SDK's builder (accounts, signer and writable flags, data)");
const ixs = devBuyIxs({ pool, config, mint: base, owner, lamports, minOut });
check(ixs.length === 6 && ixs[4].data.equals(swap.data) && ixs[2].data[0] === 17 && ixs[5].data[0] === 9, "the buy's instructions: WSOL account, SOL in, sync_native, coin account, swap2, close WSOL");
check(devBuyIxs({ pool, config, mint: base, owner, lamports, minOut, close: false }).length === 5, "without closing the WSOL account: five");
const prewrapped = devBuyIxs({ pool, config, mint: base, owner, lamports, minOut, close: false, wrap: false });
check(prewrapped.length === 2 && prewrapped[1].data.equals(swap.data) && prewrapped[0].keys[1].pubkey.equals(getAssociatedTokenAddressSync(base, owner)), "with the buy's SOL wrapped beforehand: only the coin account and swap2");
// DBC's fee on a buy: on the input, rounded up; 3.75% of 1 SOL is the first_swap.rs test's 37,500,000
check(feeOnBuy(1_000_000_000n) === 37_500_000n && feeOnBuy(500_000_001n) === 18_750_001n, "the min fee on a buy: 37,500,000 of 1 SOL, rounded up");
check(openingCostTable(1_000_000_000n)[0].fee === 500_000_000n, "the same buy at the pool's first second, without the flag: 50%");
const pd = Buffer.alloc(424);
pd.writeBigUInt64LE(30_000_000n, 336); pd.writeBigUInt64LE(7_500_000n, 320);
check(poolFeesPaid(pd) === 37_500_000n, "the pool's fee counters: trading + protocol");

// (step 2's size with the buy needs a node: DBC's SDK reads the quote mint before it builds createPool.
// launch.mjs measures it and refuses above 1,232 bytes; test/step2-devbuy-local.sh runs it on a local validator.)

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
