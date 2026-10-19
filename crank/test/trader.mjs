// A pretend crowd for a local rehearsal only: round trips (buy, then sell all of it) on the Hunch DBC
// pool through swap2, at random sizes and pauses, so that the pool has volume and Hunch's budget fills.
// Once DBC reports the pool migrated, the round trips move to the DAMM v2 pool the migration made
// (DAMM v2 swap2), so the pool phase has volume too. Refuses any RPC that is not a local validator.
//   TRADE_SCALE   multiplies the round trips' sizes (default 1)
//   RPC_URL=http://127.0.0.1:18899 TRADER_KEYPAIR=<throwaway> LAUNCHED=<launched.localnet.json> node trader.mjs --for <s>
import { web3 } from "../deps.mjs";
import { ataOf, cuLimit, DAMM, DAMM_EVENT_AUTHORITY, DAMM_MIGRATION_CONFIGS, DAMM_POOL_AUTHORITY, dammPoolAddress, DBC, DBC_EVENT_AUTHORITY, DBC_POOL_AUTHORITY, decodeDammPool, decodePool, isLocal, sendSigned, TOKEN, WSOL } from "../hunch-program.mjs";
import { readFileSync } from "node:fs";

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } = web3;
const RPC_URL = process.env.RPC_URL;
if (!isLocal(RPC_URL)) throw new Error("the trader only talks to a local validator");
const seconds = Number(process.argv[process.argv.indexOf("--for") + 1] || 3600);
const trader = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.TRADER_KEYPAIR, "utf8"))));
const L = JSON.parse(readFileSync(process.env.LAUNCHED, "utf8"));
const connection = new Connection(RPC_URL, "confirmed");
const pool = new PublicKey(L.pool), config = new PublicKey(L.config), mint = new PublicKey(L.mint);
const p = decodePool((await connection.getAccountInfo(pool)).data);
const wsol = ataOf(trader.publicKey, WSOL), hunch = ataOf(trader.publicKey, mint);
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const createAta = (owner, m) => new TransactionInstruction({
  programId: ATA,
  keys: [
    { pubkey: trader.publicKey, isSigner: true, isWritable: true }, { pubkey: ataOf(owner, m), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: m, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1]),
});
const syncNative = (acc) => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: acc, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
// the DAMM v2 pool once DBC has migrated (made from the config of the DBC config's migration fee option)
let damm = null;
async function findDamm() {
  if (damm) return damm;
  const now = decodePool((await connection.getAccountInfo(pool)).data);
  if (now.isMigrated !== 1) return null;
  const option = (await connection.getAccountInfo(config)).data[243];
  const key = dammPoolAddress(DAMM_MIGRATION_CONFIGS[option], mint, WSOL);
  const d = decodeDammPool((await connection.getAccountInfo(key))?.data);
  if (!d) return null;
  damm = { pool: key, ...d };
  console.log(`${new Date().toISOString()} trader: DBC migrated; trading on the DAMM v2 pool ${key} from now on`);
  return damm;
}
function swap2Damm(buy, amount) {
  const data = Buffer.alloc(25);
  Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]).copy(data, 0);
  data.writeBigUInt64LE(BigInt(amount), 8);
  data.writeBigUInt64LE(0n, 16);
  data[24] = 0;
  const [input, output] = buy ? [wsol, hunch] : [hunch, wsol];
  const m = (pubkey, w = false, s = false) => ({ pubkey, isSigner: s, isWritable: w });
  return new TransactionInstruction({
    programId: DAMM,
    keys: [m(DAMM_POOL_AUTHORITY), m(damm.pool, true), m(input, true), m(output, true), m(damm.tokenAVault, true), m(damm.tokenBVault, true), m(damm.tokenAMint), m(damm.tokenBMint),
      m(trader.publicKey, false, true), m(TOKEN), m(TOKEN), m(DAMM), m(DAMM_EVENT_AUTHORITY), m(DAMM)],
    data,
  });
}
function swap2(buy, amount) {
  if (damm) return swap2Damm(buy, amount);
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]).copy(data, 0);
  data.writeBigUInt64LE(BigInt(amount), 8);
  data.writeBigUInt64LE(0n, 16);
  data[24] = 0;
  const [input, output] = buy ? [wsol, hunch] : [hunch, wsol];
  const m = (pubkey, w = false, s = false) => ({ pubkey, isSigner: s, isWritable: w });
  return new TransactionInstruction({
    programId: DBC,
    keys: [m(DBC_POOL_AUTHORITY), m(config), m(pool, true), m(input, true), m(output, true), m(p.baseVault, true), m(p.quoteVault, true), m(mint), m(WSOL),
      m(trader.publicKey, false, true), m(TOKEN), m(TOKEN), m(DBC), m(DBC_EVENT_AUTHORITY), m(DBC)],
    data,
  });
}
const balance = async (acc) => BigInt((await connection.getTokenAccountBalance(acc).catch(() => ({ value: { amount: "0" } }))).value.amount);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sig = await connection.requestAirdrop(trader.publicKey, 500 * LAMPORTS_PER_SOL);
await connection.confirmTransaction(sig, "confirmed");
await sendSigned(connection, [createAta(trader.publicKey, WSOL), createAta(trader.publicKey, mint),
  SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: wsol, lamports: 400 * LAMPORTS_PER_SOL }), syncNative(wsol)], [trader]);
console.log(`${new Date().toISOString()} trader ready with 400 wrapped SOL`);

const start = Date.now();
const scale = Number(process.env.TRADE_SCALE ?? 1);
let trips = 0, volume = 0n, fails = 0;
process.on("SIGTERM", () => { console.log(`${new Date().toISOString()} trader stopped: ${trips} round trips, about ${(Number(volume) / 1e9).toFixed(1)} SOL traded, ${fails} failed`); process.exit(0); });
while (Date.now() - start < seconds * 1000) {
  // busier and quieter stretches: the pause and the size drift slowly
  const phase = Math.sin((Date.now() - start) / 600000);
  const lamports = BigInt(Math.round((0.3 + Math.random() * 1.2) * (1.2 + phase) * scale * LAMPORTS_PER_SOL));
  await findDamm().catch(() => null);
  const before = await balance(hunch);
  const b = await sendSigned(connection, [cuLimit(300000), swap2(true, lamports)], [trader]);
  if (b.outcome !== "landed") { fails++; await sleep(2000); continue; }
  const got = (await balance(hunch)) - before;
  const s = await sendSigned(connection, [cuLimit(300000), swap2(false, got)], [trader]);
  if (s.outcome !== "landed") fails++;
  trips++;
  volume += 2n * lamports;
  if (trips % 20 === 0) console.log(`${new Date().toISOString()} trader: ${trips} round trips, about ${(Number(volume) / 1e9).toFixed(1)} SOL traded, ${fails} failed`);
  await sleep(Math.round((4 + Math.random() * 20) * (1.6 - phase) * 1000));
}
console.log(`${new Date().toISOString()} trader done: ${trips} round trips, about ${(Number(volume) / 1e9).toFixed(1)} SOL traded, ${fails} failed`);
