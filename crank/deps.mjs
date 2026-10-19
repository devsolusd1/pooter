// Finds the Solana packages without installing anything new: this folder's own node_modules first
// (after `npm ci` here), then hunch/launch's, then MODULES_FROM (a folder holding a package.json whose
// node_modules has them), then the Infinite Monkey launch tool's, which already has the same pinned
// versions (@solana/web3.js 1.99.0, @solana/spl-token 0.4.15, the DBC SDK 1.5.13, bn.js 5.2.5).
// It only reads those folders.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hunch = resolve(here, "..");
const places = [
  join(here, "package.json"),
  join(hunch, "launch", "package.json"),
  ...(process.env.MODULES_FROM ? [join(resolve(process.env.MODULES_FROM), "package.json")] : []),
  join(hunch, "..", "infinite-monkey", "launch", "package.json"),
].filter((p) => existsSync(p));

// Only a copy inside that folder's own node_modules counts: Node's lookup also climbs to parent folders,
// and a stray node_modules there (C:\Users\John has one) would mix two versions of @solana/web3.js.
export function need(name) {
  for (const place of places) {
    const require = createRequire(place);
    const own = join(dirname(place), "node_modules");
    try {
      if (!require.resolve(name).startsWith(own)) continue;
      return require(name);
    } catch { /* not there: try the next place */ }
  }
  throw new Error(`${name} is not installed: run "npm ci" in hunch/crank (or hunch/launch), or point MODULES_FROM at a folder that has it`);
}

export const web3 = need("@solana/web3.js");
