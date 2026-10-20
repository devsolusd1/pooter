// Clones the LIVE accounts of the Pooter program (code name hunch) from mainnet, read-only, through
// Solana's public RPC node (never the user's private RPC, never a key): the program's own accounts
// (state, model, tape, open call, diary, brain book), the budget's WSOL and coin accounts, the DBC pool,
// its config, its two vaults and the mint (and, after graduation, the DAMM v2 pool, its vaults, Hunch's
// position and its NFT account), DBC's pool authority, and the Clock sysvar of that moment.
//
//   node hunch/programs/tests/clone-live.mjs [out dir] [program id]
//
// The out dir defaults to $HUNCH_TARGET/live-clone (~/hunch-target/live-clone). Each account is written as
// <role>.json in the format `solana account --output json-compact` uses (solana-test-validator --account
// reads it too), and index.json maps each role to its address, with the slot and the chain time.
// The LiteSVM test programs/hunch-tests/tests/upgrade_live.rs loads them (LIVE_ACCOUNTS=<out dir>).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.mainnet-beta.solana.com"; // public, read-only; nothing is sent
const home = process.env.HOME ?? ".";
const OUT = resolve(process.argv[2] ?? join(process.env.HUNCH_TARGET ?? join(home, "hunch-target"), "live-clone"));
const PROGRAM = process.argv[3] ?? JSON.parse(readFileSync(join(HERE, "..", "..", "launch", "program.json"), "utf8"))["mainnet-beta"];

// ---- base58 and PDAs, with no dependency ----
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
function b58decode(text) {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
// ed25519 on-curve test (RFC 8032 point decoding), for find_program_address
const P = (1n << 255n) - 19n, D = (-121665n * inv(121666n)) % P;
function pow(b, e) { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function inv(x) { return pow((x % P + P) % P, P - 2n); }
function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
  const x2 = (u * inv(v)) % P;
  if (x2 === 0n) return true;
  let x = pow(x2, (P + 3n) / 8n);
  if ((x * x - x2) % P !== 0n) x = (x * pow(2n, (P - 1n) / 4n)) % P;
  return (x * x - x2) % P === 0n || ((x * x - x2) % P + P) % P === 0n;
}
function pda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])).update(b58decode(program)).update(Buffer.from("ProgramDerivedAddress"));
    const out = h.digest();
    if (!onCurve(out)) return b58encode(out);
  }
  throw new Error("no PDA");
}

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const roles = {
  state: pda([Buffer.from("state")], PROGRAM), model: pda([Buffer.from("model")], PROGRAM), tape: pda([Buffer.from("tape")], PROGRAM),
  signal: pda([Buffer.from("signal")], PROGRAM), diary: pda([Buffer.from("diary")], PROGRAM), book: pda([Buffer.from("brains")], PROGRAM),
  budget: pda([Buffer.from("budget")], PROGRAM), event_authority: pda([Buffer.from("__event_authority")], PROGRAM),
  programdata: pda([b58decode(PROGRAM)], "BPFLoaderUpgradeab1e11111111111111111111111"),
  dbc_pool_authority: "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", clock: "SysvarC1ock11111111111111111111111111111111",
};
// the state first, for the addresses it pins
const first = await rpc("getMultipleAccounts", [[roles.state], { encoding: "base64", commitment: "confirmed" }]);
const st = Buffer.from(first.value[0].data[0], "base64");
if (st.length !== 1248 || st.subarray(0, 8).toString() !== "HUNCHSTA") throw new Error(`the state at ${roles.state} is not the 1,248-byte layout`);
const key = (o) => b58encode(st.subarray(o, o + 32));
Object.assign(roles, { mint: key(16), pool: key(48), config: key(80), base_vault: key(112), quote_vault: key(144), budget_wsol: key(208), budget_hunch: key(240) });
if (st[9] === 3) Object.assign(roles, { damm_pool: key(864), token_a_vault: key(928), token_b_vault: key(960), position: key(992), position_nft: key(1024) });

const names = Object.keys(roles);
const got = await rpc("getMultipleAccounts", [names.map((n) => roles[n]), { encoding: "base64", commitment: "confirmed" }]);
mkdirSync(OUT, { recursive: true });
const index = { program: PROGRAM, rpc: "public mainnet-beta node", slot: got.context.slot, cloned_at: new Date().toISOString(), accounts: {} };
for (const [i, name] of names.entries()) {
  const a = got.value[i];
  index.accounts[name] = a ? roles[name] : null;
  if (!a) continue;
  const data = a.data[0];
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({
    pubkey: roles[name],
    account: { lamports: a.lamports, data: [data, "base64"], owner: a.owner, executable: a.executable, rentEpoch: 0, space: Buffer.from(data, "base64").length },
  }));
}
const clock = Buffer.from(got.value[names.indexOf("clock")].data[0], "base64");
index.unix_timestamp = Number(clock.readBigInt64LE(32));
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
const missing = names.filter((n) => !index.accounts[n]);
console.log(`cloned ${names.length - missing.length} accounts of ${PROGRAM} at slot ${index.slot} (chain time ${new Date(index.unix_timestamp * 1000).toISOString()}) into ${OUT}`);
console.log(`phase ${st[9]}, ticks ${st.readBigUInt64LE(560)}, buys ${st.readUInt32LE(840)}, spent ${(Number(st.readBigUInt64LE(808)) / 1e9).toFixed(6)} SOL; reserve bytes 1,216..1,247 ${st.subarray(1216, 1248).every((b) => b === 0) ? "all zero" : "NOT ZERO"}`);
if (missing.length) console.log(`no account at: ${missing.join(", ")} (a PDA with no lamports is normal for budget and event_authority)`);
