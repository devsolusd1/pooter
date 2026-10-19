// Does what Meteora's migration keeper does once a DBC curve completes, on a local validator only:
// DBC's migration_damm_v2, built by the DBC SDK 1.5.13 (MigrationService.migrateToDammV2), sent and paid
// by a throwaway key that has no role in the pool (the instruction asks for no Meteora key: only a payer
// and the two fresh position NFT mints sign). The DAMM v2 config is the one DBC's migration uses for the
// config's migration fee option (Customizable for Hunch).
//   RPC_URL=http://127.0.0.1:8920 LAUNCHED=<launched.localnet.json> KEEPER_KEYPAIR=<throwaway> node migrate.mjs
// Prints one JSON line: the DAMM v2 pool, both positions (the first is the larger LP share, the partner's),
// the compute units and the transaction size.
import { need } from "../deps.mjs";
import { DAMM_MIGRATION_CONFIGS, dammPoolAddress, decodePool, isLocal, WSOL } from "../hunch-program.mjs";
import { readFileSync } from "node:fs";

const sdk = need("@meteora-ag/dynamic-bonding-curve-sdk");
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = need("@solana/web3.js");
const RPC_URL = process.env.RPC_URL;
if (!isLocal(RPC_URL)) throw new Error("migrate.mjs only talks to a local validator");
const connection = new Connection(RPC_URL, "confirmed");
const L = JSON.parse(readFileSync(process.env.LAUNCHED, "utf8"));
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEEPER_KEYPAIR, "utf8"))));
const pool = new PublicKey(L.pool), config = new PublicKey(L.config), mint = new PublicKey(L.mint);

const p = decodePool((await connection.getAccountInfo(pool)).data);
if (p.migrationProgress < 1) throw new Error(`the curve is not complete (migration progress ${p.migrationProgress})`);
const option = (await connection.getAccountInfo(config)).data[243]; // migration_fee_option
const dammConfig = DAMM_MIGRATION_CONFIGS[option];
if (!dammConfig) throw new Error(`no DAMM v2 config known for migration fee option ${option}`);
if ((await connection.getBalance(keeper.publicKey)) < LAMPORTS_PER_SOL) {
  await connection.confirmTransaction(await connection.requestAirdrop(keeper.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
}
const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");
const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({ payer: keeper.publicKey, pool, dammConfig });
transaction.feePayer = keeper.publicKey;
transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
transaction.sign(keeper, firstPositionNftKeypair, secondPositionNftKeypair);
const wire = transaction.serialize();
const signature = await connection.sendRawTransaction(wire, { skipPreflight: false });
const conf = await connection.confirmTransaction(signature, "confirmed");
const t = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
const after = decodePool((await connection.getAccountInfo(pool)).data);
const dammPool = dammPoolAddress(dammConfig, mint, WSOL);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"))[0];
const posOf = (kp) => ({ nftMint: kp.publicKey.toBase58(), position: pda([Buffer.from("position"), kp.publicKey.toBuffer()]).toBase58(), nftAccount: pda([Buffer.from("position_nft_account"), kp.publicKey.toBuffer()]).toBase58() });
console.log(JSON.stringify({
  result: conf.value.err ? "failed" : "landed", err: conf.value.err, signature, keeper: keeper.publicKey.toBase58(), dammConfig: dammConfig.toBase58(), dammPool: dammPool.toBase58(),
  first: posOf(firstPositionNftKeypair), second: posOf(secondPositionNftKeypair), units: t?.meta?.computeUnitsConsumed ?? null, bytes: wire.length,
  dbcAfter: { isMigrated: after.isMigrated, migrationProgress: after.migrationProgress, quoteReserve: String(after.quoteReserve) },
}));
