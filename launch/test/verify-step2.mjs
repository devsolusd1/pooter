// Reads back, from a LOCAL validator, what launch.mjs step 2 and init-hunch.mjs left on chain, and checks
// it: the config's "first swap with min fee" (1 with a developer buy, 0 without), the budget PDA as the
// pool's creator, the pool's fee counters (exactly 3.75% of the buy, rounded up, or nothing), the
// developer's coin (and no WSOL account left open), Hunch adopted (curve phase) with the ticker token.json
// names, and the launch record.
//   RPC_URL=http://127.0.0.1:8960 node verify-step2.mjs <records folder> <token.json> <program.json>
import { need } from "../../crank/deps.mjs";
import { addresses, decodePool, decodeState, isLocal, PHASE_NAME } from "../../crank/hunch-program.mjs";
import { feeOnBuy, FIRST_SWAP_FLAG_AT, poolFeesPaid, storedTicker } from "../launch.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { Connection, LAMPORTS_PER_SOL, PublicKey } = need("@solana/web3.js");
const { getAssociatedTokenAddressSync, NATIVE_MINT } = need("@solana/spl-token");
const RPC = process.env.RPC_URL;
if (!isLocal(RPC)) throw new Error("local validator only");
const [records, tokenFile, programFile] = process.argv.slice(2);
const T = JSON.parse(readFileSync(tokenFile, "utf8"));
const L = JSON.parse(readFileSync(join(records, "launched.localnet.json"), "utf8"));
const A = addresses(JSON.parse(readFileSync(programFile, "utf8")).localnet);
const connection = new Connection(RPC, "confirmed");
const buy = BigInt(Math.round((T.devBuySol ?? 0) * LAMPORTS_PER_SOL));
const owner = new PublicKey(L.owner), mint = new PublicKey(L.mint);

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
const [cfg, poolInfo, stInfo, coin, wsol] = await connection.getMultipleAccountsInfo([
  new PublicKey(L.config), new PublicKey(L.pool), A.state, getAssociatedTokenAddressSync(mint, owner), getAssociatedTokenAddressSync(NATIVE_MINT, owner),
]);
check(cfg?.data[FIRST_SWAP_FLAG_AT] === (buy > 0n ? 1 : 0), `the config's first-swap-with-min-fee is ${cfg?.data[FIRST_SWAP_FLAG_AT]} (${buy > 0n ? "a developer buy: 1" : "no buy: 0"})`);
const p = decodePool(poolInfo?.data);
check(!!p && p.creator.equals(A.budget), `the pool's creator is the budget PDA ${A.budget}`);
const paid = poolInfo ? poolFeesPaid(poolInfo.data) : -1n;
const want = buy > 0n ? feeOnBuy(buy) : 0n;
check(paid === want, `the pool's fee counters: ${paid} lamports, ${buy > 0n ? `3.75% of the ${Number(buy) / 1e9} SOL buy is ${want} (the opening fee at that second was 50%: ${buy / 2n})` : "no swap"}`);
const units = coin ? coin.data.readBigUInt64LE(64) : 0n;
check(buy > 0n ? units > 0n : units === 0n, `the developer holds ${units} units of the coin`);
if (buy > 0n) check(!wsol, "the developer's WSOL account was closed in the same transaction");
if (buy > 0n) check(L.devBuy?.inStep2 === true && Number(L.devBuy?.feeLamports) === Number(want), `the launch record: ${JSON.stringify(L.devBuy)}`);
const st = decodeState(stInfo?.data);
check(st?.phase === 1 && st.mint.equals(mint) && st.pool.equals(new PublicKey(L.pool)), `Hunch adopted the pool: phase ${PHASE_NAME[st?.phase] ?? "?"}`);
check(stInfo?.data.length === 1248, `Hunch's State is ${stInfo?.data.length} bytes (the final layout)`);
check(storedTicker(stInfo?.data) === T.symbol && L.ticker === T.symbol, `the stored ticker is ${storedTicker(stInfo?.data)}, token.json's symbol ${T.symbol}`);
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
