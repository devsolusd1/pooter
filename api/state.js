// GET /api/state: Hunch's public accounts as raw bytes, read from a Solana node, so the browser never
// talks to the node and the node's address (RPC_URL, which may carry a key) never reaches it.
// The browser decodes the bytes itself (site/decode.js). One answer serves everyone for about
// 10 seconds: kept in this instance's memory, and cached by Vercel's edge (s-maxage).
//
// Reads, in two requests: getMultipleAccounts over the program's accounts (state, open call, diary,
// model, brain book, tape), the pool, the budget's WSOL and HUNCH accounts and the mint; and the
// first 45 bytes of the program's ProgramData (who can update the program). Nothing is ever sent.

import { CONFIG, isLive } from "../site/config.js";
import { hunchAddresses } from "../site/solana.js";

const CACHE_MS = 10_000;
const TIMEOUT_MS = 6_000;
const NAMES = ["state", "signal", "diary", "model", "book", "tape", "pool", "budgetWsol", "budgetHunch", "mint"];

async function rpc(rpcUrl, method, params, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`the node answered ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`the node refused ${method}: ${j.error.message ?? j.error.code}`);
    return j.result;
  } catch (err) {
    // never the URL: it may carry the node's key
    const msg = err.name === "AbortError" ? "the node did not answer in time"
      : err.name === "TypeError" ? "the node could not be reached"
      : String(err.message ?? err).replace(/https?:\/\/\S+/g, "<node>");
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// One read of everything, as the browser receives it.
export async function readState({ rpcUrl, config = CONFIG, fetchImpl = fetch } = {}) {
  const addresses = hunchAddresses(config);
  const [many, pd] = await Promise.all([
    rpc(rpcUrl, "getMultipleAccounts", [NAMES.map((k) => addresses[k]), { encoding: "base64", commitment: "confirmed" }], fetchImpl),
    rpc(rpcUrl, "getAccountInfo", [addresses.programData, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 45 } }], fetchImpl),
  ]);
  const accounts = {};
  NAMES.forEach((k, i) => {
    const a = many.value[i];
    accounts[k] = a ? { owner: a.owner, lamports: a.lamports, data: a.data[0] } : null;
  });
  return {
    live: true,
    slot: many.context.slot,
    at: Math.floor(Date.now() / 1000),
    addresses,
    accounts,
    programData: pd?.value ? { owner: pd.value.owner, data: pd.value.data[0] } : null,
  };
}

// The handler Vercel runs, and scripts/site.mjs in its local mode (with its own node and config).
export function createStateHandler({ rpcUrl, config = CONFIG, fetchImpl = fetch } = {}) {
  let last = null, pending = null;
  return async function handler(req, res) {
    const send = (status, body, cache) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", cache);
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" && req.method !== "HEAD") { send(405, { error: "GET only" }, "no-store"); return; }
    if (!isLive(config)) { send(200, { live: false, reason: "not launched: the config has no program, mint and pool yet" }, "public, s-maxage=60"); return; }
    if (!rpcUrl) { send(503, { live: false, error: "the reader has no node (RPC_URL is not set)" }, "no-store"); return; }
    try {
      if (!last || Date.now() - last.t > CACHE_MS) {
        pending ??= readState({ rpcUrl, config, fetchImpl }).finally(() => { pending = null; });
        last = { t: Date.now(), body: await pending };
      }
      send(200, last.body, "public, s-maxage=10, stale-while-revalidate=20");
    } catch (err) {
      console.error("state: the read failed:", err.message);
      if (last) { send(200, { ...last.body, stale: true }, "no-store"); return; }
      send(503, { live: true, error: err.message }, "no-store");
    }
  };
}

let own;
export default async function handler(req, res) {
  own ??= createStateHandler({ rpcUrl: process.env.RPC_URL?.trim() || null });
  return own(req, res);
}
