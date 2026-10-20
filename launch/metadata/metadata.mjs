// The coin's metadata file, kept in step with ../token.json, and checked before it is uploaded.
//
//   node metadata.mjs            copies name and symbol from ../token.json into metadata.json (and the
//                                image and website into the two fields that repeat them), then checks
//   node metadata.mjs --served   also fetches token.json's uri and the image it names, the way launch.mjs
//                                does before step 2, and compares them with the files here
//
// The name, symbol and uri go into the Metaplex metadata account when the pool is made (launch.mjs step 2
// passes token.json's values as they are) and can never change after: metadataCanChange is false. The
// file behind the uri is immutable too once it is an IPFS address, so nothing in it may be left unfilled.
// Exit code 0 when there is nothing to fix.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = join(HERE, "../token.json"), META = join(HERE, "metadata.json"), IMAGES = ["image.jpg", "image.png"].map((f) => join(HERE, f)).filter((f) => existsSync(f)); // the uploaded token image (image.jpg, as on Pinata) or the generated one
const SERVED = process.argv.includes("--served");

// Metaplex Token Metadata refuses longer values (NameTooLong, SymbolTooLong, UriTooLong); it counts bytes
const MAX = { name: 32, symbol: 10, uri: 200 };
// public gateways that no longer serve IPFS: a link on them would be dead from the first day
const RETIRED = ["ipfs.io", "dweb.link", "cloudflare-ipfs.com", "cf-ipfs.com"];
const CID = /\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(\/|$|\?)/;

const fix = [], ok = [];
const bytes = (s) => Buffer.byteLength(s, "utf8");
const T = JSON.parse(readFileSync(TOKEN, "utf8"));
const raw = readFileSync(META, "utf8");
let M;
try { M = JSON.parse(raw); }
catch (e) { console.log(`FIX  metadata.json is not valid JSON (${e.message}); a deleted line may have left a comma behind`); process.exit(1); }

// ---------- token.json: what goes on chain ----------
for (const k of ["name", "symbol"]) {
  if (typeof T[k] !== "string" || !T[k].trim()) fix.push(`token.json: ${k} is empty`);
  else if (bytes(T[k]) > MAX[k]) fix.push(`token.json: ${k} "${T[k]}" is ${bytes(T[k])} bytes; Metaplex takes at most ${MAX[k]}`);
  else ok.push(`token.json ${k} "${T[k]}": ${bytes(T[k])} of ${MAX[k]} bytes`);
}
if (T.uri == null) fix.push("token.json: uri is null; it gets the metadata.json link once that file is uploaded (README.md)");
else linkProblems("token.json uri", T.uri, MAX.uri, false); // on IPFS or served by the site (site/metadata.json, as chosen on 2026-10-20)

// ---------- metadata.json: name and symbol always follow token.json ----------
M.name = T.name;
M.symbol = T.symbol;
if (typeof M.image === "string" && M.properties?.files?.[0]) M.properties.files[0].uri = M.image;
if (typeof M.website === "string" && "external_url" in M) M.external_url = M.website;
const text = JSON.stringify(M, null, 2) + "\n";
if (text !== raw) { writeFileSync(META, text); ok.push("metadata.json rewritten: name and symbol from token.json, image and website copied to their repeats"); }

if (typeof M.description !== "string" || !M.description.trim()) fix.push("metadata.json: description is empty");
else if (/\bA\.?I\b/.test(M.description)) fix.push("metadata.json: the description says AI; say what it is instead");
linkProblems("metadata.json image", M.image);
for (const k of ["website", "twitter", "telegram"]) if (k in M) linkProblems(`metadata.json ${k}`, M[k], Infinity, false);
const left = text.match(/FILL_[A-Z_]+/g);
if (left) fix.push(`metadata.json still has placeholders: ${[...new Set(left)].join(", ")} (fill them, or delete the twitter / telegram lines)`);

function linkProblems(what, url, max = Infinity, ipfs = true) {
  if (typeof url === "string" && url.includes("FILL_")) return;        // counted once, below
  if (typeof url !== "string" || !/^https:\/\/[^/]+\.[^/]+/.test(url)) return fix.push(`${what}: "${url}" is not an https address`);
  const host = new URL(url).hostname;
  if (RETIRED.some((h) => host === h || host.endsWith("." + h))) return fix.push(`${what}: ${host} no longer serves IPFS; use gateway.pinata.cloud or the account's own gateway`);
  if (ipfs && !CID.test(url)) return fix.push(`${what}: "${url}" has no /ipfs/<CID> in it; use the gateway link Pinata gives for the file`);
  if (bytes(url) > max) return fix.push(`${what}: ${bytes(url)} bytes; Metaplex takes at most ${max}`);
  ok.push(`${what}: ${url}${max < Infinity ? ` (${bytes(url)} of ${max} bytes)` : ""}`);
}

// ---------- what the gateway serves ----------
if (SERVED && typeof T.uri === "string" && /^https:\/\//.test(T.uri)) {
  const got = await fetch(T.uri).then(async (r) => (r.ok ? r.json() : `HTTP ${r.status}`)).catch((e) => `${e.cause?.code ?? e.message}`);
  if (typeof got === "string") fix.push(`served: ${T.uri} did not give JSON (${got})`);
  else {
    if (got.name !== T.name || got.symbol !== T.symbol) fix.push(`served: the file at the uri says ${got.name} / ${got.symbol}, token.json says ${T.name} / ${T.symbol} (launch.mjs will refuse)`);
    else ok.push(`served: the uri gives name ${got.name} and symbol ${got.symbol}, as token.json`);
    if (JSON.stringify(got) !== JSON.stringify(M)) fix.push("served: the file at the uri is not this metadata.json (an older upload?)");
    else ok.push("served: the file at the uri is this metadata.json, field for field");
    const img = await fetch(got.image).then(async (r) => (r.ok ? { type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) } : `HTTP ${r.status}`)).catch((e) => `${e.cause?.code ?? e.message}`);
    if (typeof img === "string") fix.push(`served: the image ${got.image} did not load (${img})`);
    else {
      const sha = (b) => createHash("sha256").update(b).digest("hex");
      const same = IMAGES.some((f) => sha(img.body) === sha(readFileSync(f)));
      (same ? ok : fix).push(`served: the image loads (${img.type}, ${img.body.length} bytes) and ${same ? "is" : "is NOT"} this folder's image.jpg or image.png`);
    }
  }
} else if (SERVED) fix.push("served: token.json has no https uri to fetch yet");

for (const line of ok) console.log(`ok   ${line}`);
for (const line of fix) console.log(`FIX  ${line}`);
console.log(fix.length ? `\n${fix.length} to fix before the launch.` : "\nNothing to fix.");
process.exitCode = fix.length ? 1 : 0;
