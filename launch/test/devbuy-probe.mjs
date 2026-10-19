// The developer's buy inside the pool-creating transaction, on a LOCAL validator with DBC's mainnet bytecode,
// built exactly as launch.mjs step 2 builds it (createPool from the SDK, the creator transfer to a budget PDA,
// devBuyIxs: WSOL wrapped, the coin account, swap2 with the instructions sysvar, WSOL closed). Three
// creation transactions, each with a fresh config and token:
//   transfer-before-buy, flag on   (launch.mjs's order)   the buy must pay 3.75% and the budget PDA be creator
//   buy-before-transfer, flag on                           the same
//   transfer-before-buy, flag off                          the buy pays the 50% opening fee
// Prints one JSON line each: size, compute units, fee paid against 3.75% and 50%, the creator, whether the
// Hunch program's adoption checks pass on the config. Throwaway keys in memory; local only.
//   RPC_URL=http://127.0.0.1:8960 node devbuy-probe.mjs [buy SOL, default 0.5]
import { need } from "../../crank/deps.mjs";
import { addresses, adoptionProblems, cuLimit, cuPrice, decodePool, isLocal, transferPoolCreatorIx, wireSize } from "../../crank/hunch-program.mjs";
import { adoptable, buildConfig, devBuyIxs, feeOnBuy, poolFeesPaid } from "../launch.mjs";
import { readFileSync } from "node:fs";

const sdk = need("@meteora-ag/dynamic-bonding-curve-sdk");
const { Connection, Keypair, LAMPORTS_PER_SOL, Transaction } = need("@solana/web3.js");
const { NATIVE_MINT, getAssociatedTokenAddressSync } = need("@solana/spl-token");
const BN = need("bn.js");

const RPC = process.env.RPC_URL;
if (!isLocal(RPC)) throw new Error("local validator only");
const buySol = Number(process.argv[2] ?? 0.5);
const connection = new Connection(RPC, "confirmed");
const client = sdk.DynamicBondingCurveClient.create(connection, "confirmed");
const A = addresses(Keypair.generate().publicKey); // a stand-in program: only its budget PDA matters here
const T = JSON.parse(readFileSync(new URL("../token.json", import.meta.url), "utf8"));

async function send(ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const size = wireSize(tx);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await connection.confirmTransaction(sig, "confirmed");
  const got = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { size, err: res.value.err, logs: got?.meta?.logMessages ?? [], cu: got?.meta?.computeUnitsConsumed };
}

async function attempt(order, minFee) {
  const dev = Keypair.generate(), mint = Keypair.generate(), configKp = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(dev.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  const curve = buildConfig({ ...T, devBuySol: minFee ? buySol : 0 }, 180);
  const cfgTx = await client.partner.createConfig({ ...curve, config: configKp.publicKey, feeClaimer: dev.publicKey, leftoverReceiver: A.budget, payer: dev.publicKey, quoteMint: NATIVE_MINT });
  const c = await send([cuLimit(400000), ...cfgTx.instructions], [dev, configKp]);
  if (c.err) throw new Error(`config: ${JSON.stringify(c.err)}`);
  const cfgBytes = (await connection.getAccountInfo(configKp.publicKey)).data;
  const pool = sdk.deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configKp.publicKey);
  const lamports = new BN(Math.round(buySol * LAMPORTS_PER_SOL));
  const create = await client.creator.createPool({ name: T.name, symbol: T.symbol, uri: "https://www.example.com/hunch/metadata.json", payer: dev.publicKey, poolCreator: dev.publicKey, config: configKp.publicKey, baseMint: mint.publicKey });
  const transfer = transferPoolCreatorIx({ pool, config: configKp.publicKey, creator: dev.publicKey, newCreator: A.budget });
  const buy = devBuyIxs({ pool, config: configKp.publicKey, mint: mint.publicKey, owner: dev.publicKey, lamports, minOut: new BN(1) });
  const body = order === "transfer-before-buy" ? [...create.instructions, transfer, ...buy] : [...create.instructions, ...buy, transfer];
  const r = await send([cuLimit(400000), cuPrice(50000), ...body], [dev, mint]);
  const pd = r.err ? null : (await connection.getAccountInfo(pool)).data;
  const paid = pd ? poolFeesPaid(pd) : null;
  const units = r.err ? 0n : BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint.publicKey, dev.publicKey))).value.amount);
  const buyLamports = BigInt(lamports.toString());
  return {
    order, minFee, bytes: r.size, instructions: body.length + 2, err: r.err, cu: r.cu,
    creatorIsBudget: pd ? decodePool(pd).creator.equals(A.budget) : null, tokensGot: units.toString(),
    feePaid: paid?.toString() ?? null, is375: paid === feeOnBuy(buyLamports), is50: paid === feeOnBuy(buyLamports, 500_000_000n),
    adoptable: adoptable(adoptionProblems(cfgBytes, A.budget), cfgBytes), tail: r.err ? r.logs.slice(-4) : [],
  };
}

let wrong = 0;
for (const [order, minFee] of [["transfer-before-buy", true], ["buy-before-transfer", true], ["transfer-before-buy", false]]) {
  const r = await attempt(order, minFee);
  const ok = !r.err && r.creatorIsBudget && r.bytes <= 1232 && (minFee ? r.is375 : r.is50) && r.adoptable.length === 0;
  if (!ok) wrong++;
  console.log(`${ok ? "PASS" : "FAIL"} ${JSON.stringify(r)}`);
}
console.log(wrong ? `${wrong} FAILED` : "devbuy-probe: as expected");
process.exit(wrong ? 1 : 0);
