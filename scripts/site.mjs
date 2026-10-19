// Serves hunch/site as it is: no build step. It also answers /api/state by calling the very same
// handler Vercel runs (api/state.js).
// Usage: node hunch/scripts/site.mjs [--port 4600]
//          [--local [--rpc http://127.0.0.1:8899] (--accounts <file.json> | --program <id> --mint <m> --pool <p>) [--developer <w>]]
//
//   no option   the site as deployed: rehearsal while site/config.js is null; /api/state answers from
//               the environment (RPC_URL), as on Vercel.
//   --local     live mode against a node of your choosing, by default a local validator on 8899. The
//               page is handed a config.js with the program, mint and pool in it (the file on disk is
//               not touched), and /api/state reads that node. --accounts takes the addresses from the
//               fixture's accounts.json (see ~/hunch-target/site-live). Nothing is ever sent to a chain,
//               no key or .env file is read, and the node's address is never printed.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import stateHandler, { createStateHandler } from "../api/state.js";
import { CONFIG, isLive } from "../site/config.js";
import { isAddress } from "../site/solana.js";

const root = resolve(fileURLToPath(new URL("../site", import.meta.url)));
const has = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith("--") ? process.argv[at + 1] : fallback;
};
const port = Number(arg("port", 4600));

let api = stateHandler, configText = null;
let mode = isLive() ? `live per site/config.js, /api/state reading ${process.env.RPC_URL?.trim() ? "the node of RPC_URL" : "no node (RPC_URL is not set)"}` : "rehearsal (site/config.js has no program, mint and pool)";
if (has("local")) {
  let local = { programId: arg("program", null), mint: arg("mint", null), pool: arg("pool", null), developer: arg("developer", null) };
  const file = arg("accounts", null);
  if (file) {
    const j = JSON.parse(await readFile(file, "utf8"));
    local = { ...local, programId: local.programId ?? j.programId, mint: local.mint ?? j.mint, pool: local.pool ?? j.pool };
  }
  for (const k of ["programId", "mint", "pool"]) if (!isAddress(local[k] ?? "")) { console.error(`--local needs a ${k} (--program, --mint, --pool or --accounts)`); process.exit(1); }
  if (local.developer && !isAddress(local.developer)) { console.error("--developer is not an address"); process.exit(1); }
  const config = { ...CONFIG, ...Object.fromEntries(Object.entries(local).filter(([, v]) => v)) };
  api = createStateHandler({ rpcUrl: arg("rpc", "http://127.0.0.1:8899"), config });
  // the page's config.js with the addresses in it; the rest of the file is as on disk
  let text = await readFile(join(root, "config.js"), "utf8");
  for (const [k, v] of Object.entries(local)) {
    if (!v) continue;
    const re = new RegExp(`^(\\s*${k}:\\s*)null,`, "m");
    if (!re.test(text)) { console.error(`site/config.js has no "${k}: null," line to fill`); process.exit(1); }
    text = text.replace(re, `$1${JSON.stringify(v)},`);
  }
  configText = text;
  mode = `live, program ${config.programId}, read from ${has("rpc") ? "the node given with --rpc" : "a local validator on 8899"}`;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.replace(/\/$/, "") === "/api/state") { await api(req, res); return; }
    if (configText && path === "/config.js") {
      res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" }).end(configText);
      return;
    }
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end("no"); return; }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!path.endsWith("/")) { res.writeHead(302, { location: path + "/" }).end(); return; }
      file = join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("error");
  }
}).listen(port, () => console.log(`hunch site on http://localhost:${port} (${mode})`));
