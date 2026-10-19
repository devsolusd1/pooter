// Makes throwaway key files for a local rehearsal (never for a real cluster): one file per name in the
// given folder, readable by its owner only. Prints each name with its PUBLIC key; never a secret.
//   node make-throwaway.mjs <folder> <name> [<name> ...]
import { web3 } from "../deps.mjs";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ...names] = process.argv.slice(2);
if (!dir || !names.length) { console.error("usage: node make-throwaway.mjs <folder> <name> [...]"); process.exit(1); }
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const name of names) {
  const file = join(dir, `${name}.json`);
  if (existsSync(file)) { console.error(`${name}.json already exists in that folder; not overwritten`); process.exit(1); }
  const kp = web3.Keypair.generate();
  writeFileSync(file, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`${name} ${kp.publicKey.toBase58()}`);
}
