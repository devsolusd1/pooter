// Buys a local rehearsal's DBC curve out, so that it completes: throwaway buyers (airdropped on the local
// validator) buy in turns with DBC swap2 in partial-fill mode (the last buy stops at the migration
// threshold and keeps the rest), after the opening fee has fallen to the base fee. Local validator only.
//   RPC_URL=http://127.0.0.1:8920 LAUNCHED=<launched.localnet.json> node buyout.mjs <buyer key file> [...]
//   STEP_SOL   SOL per buy (default 6)
import { web3 } from "../deps.mjs";
import { ataOf, cuLimit, DBC, DBC_EVENT_AUTHORITY, DBC_POOL_AUTHORITY, decodeClock, decodePool, isLocal, sendSigned, SYSVAR_CLOCK, TOKEN, WSOL, OPENING_SECONDS } from "../hunch-program.mjs";
import { readFileSync } from "node:fs";

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } = web3;
const RPC_URL = process.env.RPC_URL;
if (!isLocal(RPC_URL)) throw new Error("buyout.mjs only talks to a local validator");
const connection = new Connection(RPC_URL, "confirmed");
const L = JSON.parse(readFileSync(process.env.LAUNCHED, "utf8"));
const pool = new PublicKey(L.pool), config = new PublicKey(L.config), mint = new PublicKey(L.mint);
const step = BigInt(Math.round(Number(process.env.STEP_SOL ?? 6) * LAMPORTS_PER_SOL));
const buyers = process.argv.slice(2).map((f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8")))));
if (!buyers.length) throw new Error("usage: node buyout.mjs <buyer key file> [...]");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const m = (pubkey, w = false, s = false) => ({ pubkey, isSigner: s, isWritable: w });
const createAta = (payer, owner, mintKey) => new TransactionInstruction({
  programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  keys: [m(payer, true, true), m(ataOf(owner, mintKey), true), m(owner), m(mintKey), m(SystemProgram.programId), m(TOKEN)],
  data: Buffer.from([1]),
});
const syncNative = (acc) => new TransactionInstruction({ programId: TOKEN, keys: [m(acc, true)], data: Buffer.from([17]) });
const cfgData = (await connection.getAccountInfo(config)).data;
const threshold = cfgData.readBigUInt64LE(264);

async function readPool() { return decodePool((await connection.getAccountInfo(pool, "confirmed")).data); }
let p = await readPool();
// wait for the opening fee to fall to the base fee (by the chain's clock)
for (;;) {
  const now = decodeClock((await connection.getAccountInfo(SYSVAR_CLOCK)).data).unixTimestamp;
  if (now >= p.activationPoint + OPENING_SECONDS + 1) break;
  await sleep(500);
}
// each buyer: SOL from a local airdrop, wrapped
for (const b of buyers) {
  await connection.confirmTransaction(await connection.requestAirdrop(b.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  const wsol = ataOf(b.publicKey, WSOL);
  const r = await sendSigned(connection, [createAta(b.publicKey, b.publicKey, WSOL), createAta(b.publicKey, b.publicKey, mint),
    SystemProgram.transfer({ fromPubkey: b.publicKey, toPubkey: wsol, lamports: 95 * LAMPORTS_PER_SOL }), syncNative(wsol)], [b]);
  if (r.outcome !== "landed") throw new Error(`wrapping SOL for a buyer: ${r.outcome} ${JSON.stringify(r.err)}`);
}
console.log(`${new Date().toISOString()} buyout: ${buyers.length} buyers ready; the curve holds ${(Number(p.quoteReserve) / 1e9).toFixed(4)} of ${(Number(threshold) / 1e9).toFixed(4)} SOL`);

function buyIx(b, amount) {
  const data = Buffer.alloc(25);
  Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]).copy(data, 0); // swap2
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(0n, 16);
  data[24] = 1; // partial fill: stops at the end of the curve
  return new TransactionInstruction({
    programId: DBC,
    keys: [m(DBC_POOL_AUTHORITY), m(config), m(pool, true), m(ataOf(b.publicKey, WSOL), true), m(ataOf(b.publicKey, mint), true), m(p.baseVault, true), m(p.quoteVault, true),
      m(mint), m(WSOL), m(b.publicKey, false, true), m(TOKEN), m(TOKEN), m(DBC), m(DBC_EVENT_AUTHORITY), m(DBC)],
    data,
  });
}
let i = 0, fails = 0;
while (p.quoteReserve < threshold && p.migrationProgress === 0) {
  const b = buyers[i++ % buyers.length];
  const r = await sendSigned(connection, [cuLimit(400000), buyIx(b, step)], [b]);
  if (r.outcome !== "landed") {
    fails++;
    console.log(`buy ${i}: ${r.outcome} ${JSON.stringify(r.err)}`);
    if (fails > 5) throw new Error("buyout: too many failed buys");
  }
  p = await readPool();
}
console.log(`${new Date().toISOString()} buyout: done after ${i} buys (${fails} failed); quote reserve ${(Number(p.quoteReserve) / 1e9).toFixed(6)} SOL, threshold ${(Number(threshold) / 1e9).toFixed(6)}, surplus over it ${p.quoteReserve - threshold} lamports, migration progress ${p.migrationProgress}`);
