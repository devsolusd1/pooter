// Used by rehearse-withdraw.sh only: prepares one cloned mainnet account for solana-test-validator.
//
//   node rehearse-patch-account.mjs <cloned.json> <out.json> <fee claimer address or ->
//
// 1. Rent. Mainnet charges 5,080 lamports per byte (with the 128-byte overhead) since its rent change;
//    solana-test-validator still uses 6,960. An account cloned from mainnet is therefore below the local
//    rent-exempt minimum, and a transaction that leaves it there fails with InsufficientFundsForRent (the
//    budget's WSOL account after it is spent, for example). Every account is topped up to the local minimum.
//    A wrapped-SOL token account keeps its token amount: its stored rent reserve (is_native) is raised by the
//    same lamports, so lamports - reserve, the amount sync_native counts, does not change.
// 2. The DBC config only: its fee_claimer (offset 40) is set to the given throwaway key, so the developer's
//    partner-fee claim can be rehearsed without the developer's key.
// Prints one line saying what it changed.

import { readFileSync, writeFileSync } from "node:fs";

const [src, dst, claimer] = process.argv.slice(2);
const LOCAL_PER_BYTE = 6_960n; // solana-test-validator: 3,480 lamports per byte-year x 2 years
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const POOL_CONFIG_DISC = Buffer.from([26, 108, 14, 123, 116, 230, 129, 43]);
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const decode58 = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const k = Buffer.alloc(32); for (let i = 31; i >= 0; i--) { k[i] = Number(n & 255n); n >>= 8n; } return k; };

const j = JSON.parse(readFileSync(src, "utf8"));
const d = Buffer.from(j.account.data[0], "base64");
const notes = [];
let lamports = BigInt(j.account.lamports);
const need = (BigInt(d.length) + 128n) * LOCAL_PER_BYTE;
const native = j.account.owner === TOKEN && d.length === 165 && d.readUInt32LE(109) === 1;
if (native) {
  // what stays once the SOL is spent is the stored reserve: it must meet the local minimum too
  const reserve = d.readBigUInt64LE(113);
  if (reserve < need) {
    const add = need - reserve;
    d.writeBigUInt64LE(need, 113);
    lamports += add;
    notes.push(`wrapped SOL: rent reserve ${reserve} -> ${need}, lamports +${add} (its amount unchanged)`);
  }
} else if (lamports < need) {
  notes.push(`lamports +${need - lamports} to the local rent minimum`);
  lamports = need;
}
if (claimer && claimer !== "-" && j.account.owner === DBC && d.subarray(0, 8).equals(POOL_CONFIG_DISC)) {
  decode58(claimer).copy(d, 40);
  notes.push(`DBC config fee_claimer set to the throwaway ${claimer}`);
}
j.account.lamports = Number(lamports);
j.account.data[0] = d.toString("base64");
writeFileSync(dst, JSON.stringify(j));
console.log(`${j.pubkey}: ${notes.length ? notes.join("; ") : "as cloned"}`);
