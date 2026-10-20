// Used by rehearse-withdraw.sh only: on the LOCAL validator, the developer's wallet buys POOTER on the DBC
// curve with SOL, standing in for the buy the developer makes by hand (with any wallet app) before burn.mjs.
// Refuses any cluster but a local validator.
//
//   CLUSTER=localnet RPC_URL=http://127.0.0.1:8970 KEYPAIR=<throwaway> LAMPORTS=<n> node rehearse-buy.mjs
//   (HUNCH_PROGRAM_FILE names the rehearsal's program.json)

import { need } from "../crank/deps.mjs";
import { addresses, ataOf, cuLimit, decodeState, isLocal } from "../crank/hunch-program.mjs";
import { devBuyIxs, home, sendOnce } from "../launch/launch.mjs";
import { readFileSync } from "node:fs";

const { Connection, Keypair, Transaction } = need("@solana/web3.js");
const RPC_URL = process.env.RPC_URL ?? "";
if (process.env.CLUSTER !== "localnet" || !isLocal(RPC_URL)) {
  console.log("REFUSED: rehearse-buy.mjs runs on a local validator only (CLUSTER=localnet and a local RPC_URL). Nothing was sent.");
  process.exit(1);
}
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(home(process.env.KEYPAIR), "utf8"))));
const program = JSON.parse(readFileSync(home(process.env.HUNCH_PROGRAM_FILE), "utf8")).localnet;
const connection = new Connection(RPC_URL, "confirmed");
const st = decodeState((await connection.getAccountInfo(addresses(program).state))?.data);
const lamports = BigInt(process.env.LAMPORTS ?? "1000000000");
const tx = new Transaction().add(cuLimit(300_000), ...devBuyIxs({ pool: st.pool, config: st.config, mint: st.mint, owner: wallet.publicKey, lamports, minOut: 1n }));
tx.feePayer = wallet.publicKey;
const result = await sendOnce(connection, tx, [wallet]);
const acc = await connection.getAccountInfo(ataOf(wallet.publicKey, st.mint));
console.log(`rehearsal buy of ${Number(lamports) / 1e9} SOL on the curve: ${result.outcome}; the wallet now holds ${acc ? Number(acc.data.readBigUInt64LE(64)) / 1e6 : 0} ${st.ticker ?? "POOTER"}`);
process.exitCode = result.outcome === "landed" ? 0 : 1;
