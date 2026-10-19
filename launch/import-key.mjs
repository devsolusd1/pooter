// Key files for launch day, as $MONKEY's import-key.mjs makes them. It prints the wallet's ADDRESS and
// nothing else: never the key.
//
//   node import-key.mjs <file with the exported key> <key file to write> [address it must be]
//        turns a wallet's exported private key (the base58 text Phantom and Solflare show, or the list of
//        64 numbers the Solana tools use) into a key file. Delete the first file once this has run.
//   node import-key.mjs --new <key file to write>
//        makes a fresh key file (the crank's fee payer, or the program's address if no vanity one is
//        wanted). The token's and the program's addresses can also come from `solana-keygen grind`.
//
// The files Hunch's tools read (paths given in hunch/launch/.env, never printed by them):
//   KEYPAIR          the dev wallet: deploys (the program's upgrade authority), initializes, pays the
//                    launch, claims the partner's 2.01% of each trade
//   MINT_KEYPAIR     the token's address
//   PROGRAM_KEYPAIR  the program's address
//   CRANK_KEYPAIR    the crank's fee payer (keep only a little SOL in it: about 0.002 SOL a day)

import { need } from "../crank/deps.mjs";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const { Keypair } = need("@solana/web3.js");
const home = (path) => path.replace(/^~(?=$|[\\/])/, homedir());
const args = process.argv.slice(2);

function write(to, keypair) {
  if (existsSync(to)) {
    console.error("A file is already there; nothing was written (it is never overwritten).");
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  writeFileSync(to, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  chmodSync(to, 0o600);
}

if (args[0] === "--new") {
  if (!args[1]) { console.error("Usage: node import-key.mjs --new <key file to write>"); process.exit(1); }
  const keypair = Keypair.generate();
  write(home(args[1]), keypair);
  console.log(`Key file written for ${keypair.publicKey.toBase58()}.`);
  process.exit(0);
}

const [from, to, expected] = args.map((a, i) => (i < 2 ? home(a) : a));
if (!from || !to) {
  console.error("Usage: node import-key.mjs <exported key file> <key file to write> [expected address]\n       node import-key.mjs --new <key file to write>");
  process.exit(1);
}
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(text) {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error("not base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
let keypair;
try {
  const text = readFileSync(from, "utf8").trim();
  const secret = text.startsWith("[") ? Uint8Array.from(JSON.parse(text)) : base58(text);
  keypair = secret.length === 32 ? Keypair.fromSeed(secret) : Keypair.fromSecretKey(secret);
} catch {
  // Say nothing about the content: an error message could quote part of the key.
  console.error("That file does not hold a private key I can read (base58 text, or a list of 64 numbers).");
  process.exit(1);
}
const address = keypair.publicKey.toBase58();
if (expected && expected !== address) {
  console.error(`That key is for ${address}, not ${expected}. Nothing was written.`);
  process.exit(1);
}
write(to, keypair);
console.log(`Key file written for ${address}. Now delete the exported key file.`);
