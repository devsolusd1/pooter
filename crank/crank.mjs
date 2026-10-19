// The Hunch crank: keeps the program ticking by the chain's own clock. Anyone may run it; a second copy
// on another host is safe: one tick lands per bar, at most one wait and one buy per hour (the program
// refuses a second of either), one withdraw_surplus and one adopt_pool in all. A copy set to act later in the bar (TICK_FROM=14) sees the first one's transactions
// when it simulates and sends nothing; two copies set to the same second both send their ticks, and the
// later one fails on chain (it costs its network fee, about 0.000006 SOL, and changes nothing).
//
//   node crank.mjs            DRY (the default): prints the plan and its cost, then watches: reads the
//                             clock and the accounts and simulates what is due, never sends
//   SEND=1 node crank.mjs     sends: a tick early in each 10-minute bar, buy_and_burn after each hour's
//                             boundary tick, grow_brain_book when the brain book runs short
//                             (SEND is read from the environment only, never from .env)
//   --dry                     never sends, even with SEND=1
//   node crank.mjs --local    against a local validator only (RPC_URL must be 127.0.0.1/localhost): polls
//                             faster and tops up the crank key by airdrop; for testing
//   --for <seconds>           stop after that many seconds (tests); --until <unix time>: stop once the chain's
//                             clock reaches it (tests); --once: do what is due now and stop
//
// Environment (or hunch/crank/.env; nothing secret is ever printed: not the RPC address, not a key path):
//   RPC_URL          the node (required unless --local)
//   CRANK_KEYPAIR    the key file that pays the network fees (about 0.0001 SOL a tick with the default tip)
//   PAYER            --dry only: an address to simulate with when there is no key file
//   PROGRAM_ID       the Hunch program; otherwise hunch/launch/program.json for CLUSTER (default mainnet-beta)
//   PRIORITY         micro-lamports per compute unit (default 20000)
//   TICK_WINDOW      seconds of each bar a tick is accepted in (default 30, the program's window)
//   TICK_FROM, TICK_JITTER   the tick is tried at a random second in [TICK_FROM, TICK_FROM + TICK_JITTER]
//                    of each bar (defaults 2 and 8). On a backup host, set TICK_FROM=14 so that it only
//                    acts when the first host did not.
//   BUY_DELAY        seconds after the hour's boundary tick before the buy is tried (default 20), plus a
//   BUY_JITTER       random 0 to BUY_JITTER seconds (default 45), after which State is read again at the
//                    newest bank, so that two crankers rarely both try the hour's buy (the program refuses a
//                    second wait in an hour with ALREADY_WAITED_THIS_HOUR, 28, so a collision costs one
//                    network fee). The pause never runs into a bar's tick window: a try that would is moved
//                    to just after the next bar's window.
//   BUY_RETRY        after the hour waited (anyone's wait) for a reason that can pass within the hour (the
//                    guard, a stale tape, the impact cap, too little budget), the buy is simulated again
//                    every BUY_RETRY seconds (default 120): a call that would wait again fails in simulation
//                    with 28 and nothing is sent; one that can buy is sent and buys. A wait at a bad moment,
//                    natural or forced by someone pumping the price, so cancels nothing. Waits on the volume
//                    or day cap settle the hour (they cannot change within it).
//   BUY_UNTIL        the second of the hour after which the buy is no longer tried (default 3000), so that a
//                    late buy does not make the next hour's buy TOO_SOON (30 minutes between buys); a
//                    TOO_SOON refusal is tried again once the 30 minutes have passed
//   CLAIM_AT         in the pool phase, the second of each hour from which claim_pool_fees is tried, once
//                    an hour (default 3030, in the bar before the boundary, so that the boundary tick's
//                    budget counts the position's fees)
//   CLAIM_MIN        lamports the claim must move to be worth sending (default 1000000 = 0.001 SOL)
//   GRAD_JITTER      withdraw_surplus, adopt_pool and claim_pool_fees wait a random 0 to GRAD_JITTER
//                    seconds (default 8) before they simulate, so that two crankers do not both send them
//   CRANK_LOG        a file to append one JSON line per action to
//
// Started before the launch, it waits: for Hunch's accounts (init-hunch.mjs STEP=initialize), then for
// the adoption of the curve (launch.mjs step 2 adopts it in the pool-creating transaction; init-hunch.mjs
// STEP=adopt is the fallback). The graduation path, run end to end on a local validator with
// Meteora DBC 0.2.2's and DAMM v2's mainnet bytecode (test/graduation-e2e.sh): once DBC reports the
// curve complete, withdraw_surplus (once: DBC records it) and claim_curve_fees for the creator fee DBC
// still holds (no hourly curve buy claims it any more); once DBC reports the pool migrated,
// adopt_pool (the DAMM v2 pool and the budget's position, found from the position NFT the budget holds);
// from then on the ticks read the DAMM v2 pool, claim_pool_fees runs once an hour before the boundary,
// and the hourly buy is buy_and_burn_pool. A crank that was down during the graduation does all of this
// when it starts. Every send is simulated first, against State read fresh for each action.

import { web3 } from "./deps.mjs";
import {
  addresses, adoptPoolCandidates, adoptPoolIx, buyAndBurnCurveIx, buyAndBurnPoolIx, claimCurveFeesIx, claimPoolFeesIx, tickPoolOf, withdrawSurplusIx, cuLimit, cuPrice, customCode, decodeBook, decodeClock, decodeDammPool, decodePool, decodeSignal, decodeState, errText,
  ERR, growBrainBookIx, hide, isLocal, keepSecret, landedMeta, memoLines, PHASE, PHASE_NAME, sendSigned, simulate, SYSVAR_CLOCK, tickIx,
  BAR, HOUR, DAY, BOOK_GROW_BELOW, BUY_GAP, SKIP, SKIP_NAME,
} from "./hunch-program.mjs";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = web3;
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- the schedule, as pure functions (tested on their own) ----
export const barOf = (ts) => Math.floor(ts / BAR);
export const isBoundaryBar = (bar) => (bar * BAR) % HOUR === 0;
/** The buy waits a random 0 to BUY_JITTER seconds before it looks, and the loop does nothing else
 *  meanwhile: a time from which that pause (plus 15 s to send) could run into the next bar's tick window
 *  moves to the end of that window. */
export function buySlot(t, cfg) {
  const bar = barOf(t);
  return t - bar * BAR + (cfg.buyJitter ?? 0) + 15 >= BAR ? (bar + 1) * BAR + cfg.window : t;
}
/** When the hour's buy is due: BUY_DELAY after its boundary tick landed, or later when an attempt asked
 *  to look again (buyRetryAt), never where its pause could run into a tick window (buySlot). */
export const buyDueAt = (done, hour, cfg) => buySlot(Math.max(done.boundaryLandedAt[hour] + cfg.buyDelay, done.buyRetryAt?.[hour] ?? 0), cfg);
/** What is due at chain time `ts`, given what this crank already settled. */
export function due(ts, done, cfg) {
  const bar = barOf(ts);
  const sec = ts - bar * BAR;
  const hour = Math.floor(ts / HOUR);
  const out = [];
  const tickAt = done.tickAt?.[bar] ?? cfg.tickFrom;
  const barSettled = done.tick.has(bar) || sec >= cfg.window - 1;
  if (!done.tick.has(bar) && sec >= tickAt && sec < cfg.window - 1) out.push("tick");
  // the buy only once this bar's tick is settled, and not where its pause could reach the next bar's
  if (done.boundaryLandedAt?.[hour] !== undefined && !done.buy.has(hour) && ts >= buyDueAt(done, hour, cfg) && barSettled && buySlot(ts, cfg) === ts) out.push("buy");
  if (!done.grow.has(hour) && ts - hour * HOUR >= 300) out.push("grow");
  if (done.grad && !done.grad.has(bar) && barSettled) out.push("grad");
  // pool phase: one claim an hour, after the tick of the bar it falls in (never in a tick's window)
  if (cfg.pool && done.claim && !done.claim.has(hour) && ts - hour * HOUR >= (cfg.claimAt ?? 3030) && barSettled) out.push("claim");
  return out;
}

/** A buy that found no open call for its hour: look again a few seconds later ("later") until a minute
 *  after it was first due, then let the hour go ("skip"). Before this, the crank looked again on every
 *  pass of its loop (four times a second on a local validator, once a second otherwise) for 15 minutes. */
export function buyLater(ts, boundaryLandedAt, cfg) {
  const firstDue = (boundaryLandedAt ?? ts) + cfg.buyDelay;
  return ts - firstDue > 60 ? "skip" : "later";
}

/** Wait reasons that can pass within the hour: the guard (the price more than 5% over the tape's median),
 *  a stale tape (the next tick refreshes it), the impact cap (the price moves) and too little budget (fees
 *  keep coming in). The volume cap (a quarter of the previous hour's volume) and the day cap cannot. */
export const RETRY_REASONS = new Set([SKIP.BELOW_MIN, SKIP.GUARD, SKIP.STALE, SKIP.IMPACT_CAP]);
/** Codes that settle the hour's buy: ALREADY_BOUGHT_THIS_HOUR, CURVE_COMPLETE, WRONG_PHASE, POOL_PAUSED
 *  and FEE_RAISED (only Meteora's operators lift a pause or a raised fee; the budget keeps). */
export const BUY_SETTLED = new Set([15, 17, 8, 27, 30]);

/** After an attempt at the hour's buy: "done" (settled for this hour) or the chain time to try again.
 *  `result` and `code` are act()'s; `state` is State read after the attempt (null when unknown). A wait the
 *  program refused again (28) sent nothing; it is looked at again later while the hour's wait could still
 *  pass, never after BUY_UNTIL. TOO_SOON (16) is tried again once 30 minutes have passed since the last buy. */
export function buyNext({ ts, hour, result, code, state }, cfg) {
  const until = hour * HOUR + (cfg.buyUntil ?? 3000);
  const again = (t) => (t <= until ? t : "done");
  const waitedThisHour = !!state && state.hsHour === hour && state.lastBuyHour !== hour && state.hsReason !== SKIP.NONE;
  if (result === "would send") return "done"; // a dry crank never sends, so never looks twice
  if (result === "landed") return waitedThisHour && RETRY_REASONS.has(state.hsReason) ? again(ts + cfg.buyRetry) : "done";
  if (BUY_SETTLED.has(code)) return "done";
  if (code === 16) return again(Math.max(ts + 5, (state?.lastBuyTs ?? ts) + BUY_GAP + 1));
  if (code === 28 && waitedThisHour && !RETRY_REASONS.has(state.hsReason)) return "done";
  // 28 (the hour waited, and this call would wait again), a node error, an expired send, a swap that
  // moved the price too much: nothing changed; look again later in the hour
  return again(ts + cfg.buyRetry);
}

function parseArgs(argv) {
  const a = { dry: false, local: false, once: false, for: null, until: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry") a.dry = true;
    else if (argv[i] === "--local") a.local = true;
    else if (argv[i] === "--once") a.once = true;
    else if (argv[i] === "--for") a.for = Number(argv[++i]);
    else if (argv[i] === "--until") a.until = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

function readDotEnv() {
  const p = join(HERE, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[1] !== "SEND" && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.SEND !== "1") args.dry = true; // sending needs SEND=1 in the environment itself
  readDotEnv();
  const RPC_URL = process.env.RPC_URL || (args.local ? "http://127.0.0.1:8899" : null);
  if (!RPC_URL) throw new Error("RPC_URL is not set");
  keepSecret(RPC_URL);
  if (args.local && !isLocal(RPC_URL)) throw new Error("--local only talks to a local validator (127.0.0.1 or localhost)");
  const CLUSTER = args.local ? "localnet" : process.env.CLUSTER ?? "mainnet-beta";
  let programId = process.env.PROGRAM_ID;
  if (!programId) {
    const file = join(resolve(HERE, "..", "launch"), "program.json");
    programId = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[CLUSTER] : null;
  }
  if (!programId) throw new Error(`no Hunch program address: set PROGRAM_ID (or hunch/launch/program.json for ${CLUSTER})`);
  const A = addresses(programId);
  const cfg = {
    priority: Number(process.env.PRIORITY ?? 20000),
    window: Number(process.env.TICK_WINDOW ?? 30),
    tickFrom: Number(process.env.TICK_FROM ?? 2),
    jitter: Number(process.env.TICK_JITTER ?? 8),
    buyDelay: Number(process.env.BUY_DELAY ?? 20),
    claimAt: Number(process.env.CLAIM_AT ?? 3030),
    claimMin: BigInt(process.env.CLAIM_MIN ?? 1_000_000),
    gradJitter: Number(process.env.GRAD_JITTER ?? 8),
    buyJitter: Number(process.env.BUY_JITTER ?? 45),
    buyRetry: Number(process.env.BUY_RETRY ?? 120),
    buyUntil: Number(process.env.BUY_UNTIL ?? 3000),
    pollMs: args.local ? 250 : 1000,
  };
  if (!(cfg.claimAt >= 0 && cfg.claimAt < HOUR)) throw new Error("CLAIM_AT is a second of the hour (0-3599)");
  if (!(cfg.buyRetry >= 30)) throw new Error("BUY_RETRY is at least 30 seconds");
  if (!(cfg.buyUntil > 0 && cfg.buyUntil < HOUR)) throw new Error("BUY_UNTIL is a second of the hour (1-3599)");
  if (!(cfg.buyJitter >= 0 && cfg.buyJitter + 15 + cfg.window < BAR)) throw new Error("BUY_JITTER leaves no room in a bar");
  if (cfg.tickFrom + cfg.jitter > cfg.window - 6) throw new Error("TICK_FROM + TICK_JITTER leaves no room inside TICK_WINDOW");

  // the key that pays; read from a path in the environment, never printed
  let crank = null;
  const keyPath = process.env.CRANK_KEYPAIR;
  if (keyPath) {
    const full = keyPath.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "");
    if (!existsSync(full)) throw new Error("CRANK_KEYPAIR points at no file");
    try { crank = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(full, "utf8")))); } catch { throw new Error("CRANK_KEYPAIR does not hold a key file I can read"); }
  }
  const payer = crank?.publicKey ?? (process.env.PAYER ? new PublicKey(process.env.PAYER) : null);
  if (!payer) throw new Error(args.dry ? "set CRANK_KEYPAIR or PAYER (an address with some SOL, to simulate with)" : "CRANK_KEYPAIR is not set");
  if (!args.dry && !crank) throw new Error("sending needs CRANK_KEYPAIR");

  const connection = new Connection(RPC_URL, { commitment: "confirmed" });
  const fresh = new Connection(RPC_URL, { commitment: "processed" }); // the newest clock and bank, for timing and simulation
  const logFile = process.env.CRANK_LOG;
  const say = (record) => {
    const line = `${new Date().toISOString()} chain ${record.chain ?? "-"} ${record.action.padEnd(5)} ${record.result}${record.detail ? `  ${record.detail}` : ""}`;
    console.log(line);
    if (logFile) appendFileSync(logFile, `${hide(JSON.stringify({ at: new Date().toISOString(), ...record }))}\n`);
  };

  // ---- the chain's clock, and how fast it runs against this machine's (1 on a real cluster) ----
  let lastClock = null, rate = 1, samples = [];
  async function clock() {
    const info = await fresh.getAccountInfo(SYSVAR_CLOCK);
    const c = decodeClock(info.data);
    const wall = Date.now();
    samples.push([wall, c.unixTimestamp]);
    samples = samples.filter(([w]) => wall - w < 120000);
    if (samples.length > 3 && wall - samples[0][0] > 10000) rate = Math.max(0.5, Math.min(1000, (c.unixTimestamp - samples[0][1]) / ((wall - samples[0][0]) / 1000)));
    lastClock = c;
    return c;
  }

  // ---- the program and its pool. Every action re-reads State first (another cranker may have moved the
  // phase, e.g. adopted the DAMM v2 pool, since the last read); the loop itself reads it at most every 60 s.
  // Before initialize there is no State: null, and the crank waits.
  let st = null, poolKeys = null, stAt = 0;
  async function loadState(force = false) {
    if (!force && st && Date.now() - stAt < 60000) return st;
    const info = await connection.getAccountInfo(A.state);
    if (!info) {
      st = null;
      stAt = Date.now();
      return null;
    }
    const s = decodeState(info.data);
    if (!s) throw new Error("the state account does not read as Hunch's (layout changed? update hunch-program.mjs)");
    st = s;
    stAt = Date.now();
    if (s.phase >= PHASE.CURVE) poolKeys = { pool: s.pool, config: s.config, mint: s.mint, baseVault: s.baseVault, quoteVault: s.quoteVault };
    return s;
  }

  const done = { tick: new Set(), buy: new Set(), grow: new Set(), grad: new Set(), claim: new Set(), tickAt: {}, boundaryLandedAt: {}, claimBase: {}, buyRetryAt: {}, tries: {}, surplusTries: 0, adoptNote: -1 };
  const pickTickSecond = (bar) => {
    if (done.tickAt[bar] === undefined) done.tickAt[bar] = cfg.tickFrom + Math.floor(Math.random() * (cfg.jitter + 1));
    return done.tickAt[bar];
  };

  // Simulates, and (unless --dry) sends what simulates cleanly. Gives { result, code }.
  async function act(action, ixs, cuMax, chainTs) {
    const sim = await simulate(fresh, [cuLimit(cuMax), ...ixs], payer).catch((e) => ({ err: hide(e.message), logs: [], units: 0, code: null }));
    if (sim.err) return { result: "nothing to do", code: sim.code, detail: errText(sim.err) };
    const limit = Math.min(cuMax, Math.ceil(sim.units * 1.25 + 5000));
    const front = [cuLimit(limit), ...(cfg.priority > 0 ? [cuPrice(cfg.priority)] : [])];
    if (args.dry) return { result: "would send", code: null, detail: `simulates cleanly, ${sim.units} CU` };
    const sent = await sendSigned(connection, [...front, ...ixs], [crank]);
    if (sent.outcome === "landed") {
      const meta = await landedMeta(connection, sent.signature);
      return { result: "landed", code: null, signature: sent.signature, units: meta.units, fee: meta.fee, memo: memoLines(meta.logs), bytes: sent.bytes };
    }
    const code = customCode(sent.err);
    return { result: sent.outcome, code, signature: sent.signature, detail: sent.err ? errText(sent.err) : "" };
  }

  // ---- once per bar: the tick ----
  async function doTick(c) {
    const bar = barOf(c.unixTimestamp);
    const hour = Math.floor(c.unixTimestamp / HOUR);
    await loadState(true); // the pool to read changes at adoption, which another cranker may have sent
    // in the bar the hour's claim falls in: what the pool claims add up to before anyone claims this hour
    if (Math.floor((c.unixTimestamp - hour * HOUR) / BAR) === Math.floor(cfg.claimAt / BAR) && done.claimBase[hour] === undefined) done.claimBase[hour] = st.poolClaimed ?? null;
    const r = await act("tick", [tickIx(A, tickPoolOf(st))], 400000, c.unixTimestamp);
    const record = { chain: c.unixTimestamp, slot: c.slot, action: "tick", bar, boundary: isBoundaryBar(bar), phase: PHASE_NAME[st.phase], ...r };
    // settled for this bar: it landed, or someone else's landed, or the window is over or not open
    const settledCodes = [12, 11, 13, 8]; // ALREADY_TICKED, OUTSIDE_WINDOW, TOO_EARLY, WRONG_PHASE
    if (r.result === "landed" || r.result === "would send" || settledCodes.includes(r.code)) done.tick.add(bar);
    done.tries[bar] = (done.tries[bar] ?? 0) + 1;
    if (done.tries[bar] >= 4) done.tick.add(bar);
    if (r.code === 12) record.result = r.result === "failed" ? "duplicate (another cranker's tick landed first)" : "already ticked (by another cranker)";
    if (isBoundaryBar(bar) && (r.result === "landed" || r.code === 12 || r.result === "would send")) done.boundaryLandedAt[hour] ??= c.unixTimestamp;
    if (r.result === "landed") record.detail = `${r.units} CU, fee ${r.fee} lamports, ${r.bytes} B, ${r.signature}${r.memo?.length ? `\n    diary: ${r.memo.join(" | ")}` : ""}`;
    say(record);
    // started in the middle of an hour whose boundary tick already landed: the buy is still due
    if (done.boundaryLandedAt[hour] === undefined && !done.buy.has(hour)) {
      const signal = decodeSignal((await connection.getAccountInfo(A.signal))?.data);
      if (signal?.unixHour === hour) done.boundaryLandedAt[hour] = c.unixTimestamp - cfg.buyDelay;
    }
  }

  // ---- once per hour, after the boundary tick: buy_and_burn ----
  async function doBuy(c) {
    const hour = Math.floor(c.unixTimestamp / HOUR);
    const signal = decodeSignal((await connection.getAccountInfo(A.signal))?.data);
    if (signal && signal.unixHour !== hour) {
      // the boundary tick landed but made no open call for this hour (the first tick of all is only a
      // baseline, a blind tick makes none) or it is not visible yet: look again in 5 s, for a minute
      if (buyLater(c.unixTimestamp, done.boundaryLandedAt[hour], cfg) === "skip") {
        done.buy.add(hour);
        say({ chain: c.unixTimestamp, action: "buy", result: "skipped", detail: "this hour's boundary tick made no open call (a baseline or blind tick): the program refuses a buy without one" });
      } else done.buyRetryAt[hour] = c.unixTimestamp + 5;
      return;
    }
    // State as it is now: the phase (and the DAMM v2 pool's accounts) may have changed since the last
    // read, and another cranker may have tried the hour already. The program refuses a second buy in an
    // hour (15) and a second wait (28), and a refused call still costs its sender a network fee, so look
    // before sending: after a random pause (crankers whose boundary ticks settled together would
    // otherwise all look at the same moment, see nothing and all send), at the newest bank; and act()
    // simulates first, so a call the program would refuse is never sent.
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * cfg.buyJitter * 1000)));
    await loadState(true);
    const now = decodeState((await fresh.getAccountInfo(A.state))?.data) ?? st;
    const at = (t) => new Date(t * 1000).toISOString().slice(11, 19);
    const settle = (r, detail) => {
      const next = buyNext({ ts: c.unixTimestamp, hour, ...r }, cfg);
      if (next === "done") done.buy.add(hour);
      else done.buyRetryAt[hour] = next;
      return `${detail}${next === "done" ? "; settled for this hour" : `; looks again at ${at(next)} UTC`}`;
    };
    if (now.phase !== PHASE.CURVE && now.phase !== PHASE.POOL) {
      done.buy.add(hour);
      say({ chain: c.unixTimestamp, action: "buy", result: "skipped", detail: `phase ${PHASE_NAME[now.phase] ?? now.phase}: no buy until the DAMM v2 pool is adopted` });
      return;
    }
    // the hour of adoption: its boundary tick was on the curve (or graduating), and adopt_pool zeroed the
    // previous hour's volume that the 25% cap is taken from, so a buy here could only wait (and a crank
    // that ran through the adoption has already settled this hour); the pool's first buy follows its
    // first boundary tick
    if (now.phase === PHASE.POOL && now.graduation?.adoptHour === hour) {
      done.buy.add(hour);
      say({ chain: c.unixTimestamp, action: "buy", result: "skipped", detail: "the DAMM v2 pool was adopted this hour: its first buy follows the next boundary tick" });
      return;
    }
    // The hour already waited (this crank's wait or anyone's): a further call that would wait again is
    // refused (28) and changes nothing, one that can buy still buys. A wait on the volume or the day cap
    // cannot pass within the hour, so the hour is settled without asking; any other is simulated again
    // (below), which sends nothing while it would still wait.
    if (now.hsHour === hour && now.lastBuyHour !== hour && now.hsReason !== SKIP.NONE && !RETRY_REASONS.has(now.hsReason)) {
      done.buy.add(hour);
      say({ chain: c.unixTimestamp, action: "buy", result: "waited this hour", detail: `reason ${SKIP_NAME[now.hsReason] ?? now.hsReason}, which does not pass within the hour; settled for this hour` });
      return;
    }
    const ix = now.phase === PHASE.POOL ? buyAndBurnPoolIx(A, now) : buyAndBurnCurveIx(A, poolKeys);
    const r = await act("buy", [ix], 400000, c.unixTimestamp);
    if (r.code === 14) {
      // NO_BOUNDARY_THIS_HOUR: the boundary tick is not visible yet, or the open call is blind
      if (buyLater(c.unixTimestamp, done.boundaryLandedAt[hour], cfg) === "skip") done.buy.add(hour);
      else done.buyRetryAt[hour] = c.unixTimestamp + 5;
      return;
    }
    const record = { chain: c.unixTimestamp, slot: c.slot, action: "buy", hour, phase: PHASE_NAME[now.phase], ...r };
    // State after the attempt: what landed, or why the program refused (the hour's wait, the last buy)
    const s = r.result === "would send" ? now : (await loadState(true)) ?? now;
    const reason = SKIP_NAME[s.hsReason] ?? s.hsReason;
    if (r.result === "landed") {
      const sig = decodeSignal((await connection.getAccountInfo(A.signal))?.data);
      record.hsReason = s.hsReason;
      record.detail = settle({ ...r, state: s }, `${r.units} CU, ${r.bytes} B, ${r.signature}; ${s.lastBuyHour === hour ? "bought and burned" : `waited (${reason})`}; totals: ${s.buys} buys, ${s.skips} waits, ${(Number(s.spent) / LAMPORTS_PER_SOL).toFixed(4)} SOL spent, ${s.burned} units burned; budget ${sig ? (Number(sig.budget) / LAMPORTS_PER_SOL).toFixed(4) : "?"} SOL`);
    } else {
      record.detail = settle({ ...r, state: s }, r.detail ?? "");
      if (r.code === 15) record.result = r.result === "failed" ? "duplicate (another cranker's buy landed first)" : "already bought this hour";
      // 28 in simulation: nothing was sent and nothing paid; the hour's wait stands until a call can buy
      if (r.code === 28) record.result = r.result === "failed" ? "refused on chain: the hour already waited (another cranker's wait landed first)" : `nothing to send: this hour waited (${reason}) and would wait again`;
      if (r.code === 16) record.result = "too soon: less than 30 minutes since the last buy";
      if (r.code === 30) {
        const live = now.graduation ? decodeDammPool((await connection.getAccountInfo(now.graduation.dammPool))?.data) : null;
        record.result = "no buy: Meteora's pool fee is above the fee at adoption (or one Hunch cannot model)";
        record.detail = `${record.detail}; fee at adoption ${now.graduation?.adoptFeeNum ?? "?"} / 1e9, the pool's base fee now ${live?.cliffFeeNumerator ?? "?"} / 1e9${live?.dynamicFee ? ", a dynamic fee on" : ""}`;
      }
    }
    say(record);
  }

  // ---- the graduation path, checked once a bar after the tick ----
  // withdraw_surplus once DBC reports the curve complete (until DBC records the creator's withdrawal);
  // adopt_pool once DBC reports the pool migrated into DAMM v2. DBC and the program refuse either a
  // second time, so a second cranker (or a restart) at worst simulates them and lets them be.
  // Two crankers that reach a one-time action together (both started after a migration, say) would both
  // send it, and one would fail on chain: each waits a random few seconds first, and act() simulates
  // against the newest bank, so the later one sees the earlier one's and sends nothing.
  const graduationPause = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * cfg.gradJitter * 1000)));
  async function doGraduation(c) {
    const bar = barOf(c.unixTimestamp);
    done.grad.add(bar);
    await loadState(true);
    if (!st || st.phase === PHASE.SETUP) return;
    const p = decodePool((await connection.getAccountInfo(st.pool))?.data);
    if (!p) return;
    // migration_progress: 0 on the curve, 1 complete, 2 locked vesting, 3 migrated into DAMM v2
    if (p.migrationProgress >= 1 && !p.creatorWithdrewSurplus && done.surplusTries < 6) {
      done.surplusTries++;
      await graduationPause();
      const r = await act("surplus", [withdrawSurplusIx(A, st)], 200000, c.unixTimestamp);
      const record = { chain: c.unixTimestamp, slot: c.slot, action: "surplus", phase: PHASE_NAME[st.phase], ...r };
      if (r.result !== "landed" && decodePool((await fresh.getAccountInfo(st.pool))?.data)?.creatorWithdrewSurplus) record.result = "already withdrawn (by another cranker)";
      if (r.result === "landed") {
        const s = await loadState(true);
        record.detail = `withdraw_surplus: ${(Number(s.surplus ?? 0n) / LAMPORTS_PER_SOL).toFixed(6)} SOL into the budget, ${r.units} CU, ${r.bytes} B, ${r.signature}`;
      }
      say(record);
    }
    // The creator fee DBC still holds for the budget. Each hourly curve buy claims it, but no curve buy runs
    // once the curve is complete, and buy_and_burn_pool never claims it: whatever accrued since the last
    // curve buy (all of the launch's, opening fees included, if the curve completes within its first hours)
    // would sit in DBC. claim_curve_fees (anyone, any phase after adoption) moves it into the budget; DBC
    // zeroes the counter, so this stops by itself. After a random pause and a fresh look, as above.
    if (p.migrationProgress >= 1 && poolKeys && p.creatorQuoteFee >= cfg.claimMin) {
      await graduationPause();
      const owed = decodePool((await fresh.getAccountInfo(st.pool))?.data)?.creatorQuoteFee ?? 0n;
      if (owed >= cfg.claimMin) {
        const r = await act("claim-curve", [claimCurveFeesIx(A, poolKeys)], 200000, c.unixTimestamp);
        const record = { chain: c.unixTimestamp, slot: c.slot, action: "claim-curve", phase: PHASE_NAME[st.phase], expected: String(owed), ...r };
        if (r.result === "landed") record.detail = `claim_curve_fees: ${(Number(owed) / LAMPORTS_PER_SOL).toFixed(6)} SOL of creator fee from DBC into the budget, ${r.units} CU, ${r.bytes} B, ${r.signature}`;
        say(record);
      }
    }
    if (st.phase !== PHASE.CURVE && st.phase !== PHASE.GRADUATING) return;
    if (p.isMigrated !== 1 || p.migrationProgress !== 3) {
      if (p.migrationProgress >= 1 && done.adoptNote !== Math.floor(c.unixTimestamp / HOUR)) {
        done.adoptNote = Math.floor(c.unixTimestamp / HOUR);
        say({ chain: c.unixTimestamp, action: "adopt", result: "waiting", detail: "the curve is complete; waiting for Meteora to migrate it into DAMM v2" });
      }
      return;
    }
    let candidates = [];
    try { candidates = await adoptPoolCandidates(connection, A, st); } catch (e) {
      say({ chain: c.unixTimestamp, action: "adopt", result: "error", detail: `finding the DAMM v2 pool: ${hide(e.message)}` });
      return;
    }
    if (!candidates.length) { say({ chain: c.unixTimestamp, action: "adopt", result: "waiting", detail: "DBC migrated, but the budget holds no DAMM v2 position NFT yet" }); return; }
    await graduationPause();
    for (const cand of candidates) {
      const r = await act("adopt", [adoptPoolIx(A, st, cand)], 200000, c.unixTimestamp);
      const record = { chain: c.unixTimestamp, slot: c.slot, action: "adopt", phase: PHASE_NAME[st.phase], ...r };
      record.detail = r.result === "landed" ? `adopt_pool ${cand.dammPool} (config ${cand.dammConfig}, position ${cand.position}), ${r.units} CU, ${r.bytes} B, ${r.signature}` : `${cand.dammPool}: ${r.detail ?? ""}`;
      if (r.code === 8) record.result = "already adopted (by another cranker)";
      say(record);
      if (r.result === "landed" || r.result === "would send" || r.code === 8) { await loadState(true); break; }
    }
  }

  // ---- pool phase, once an hour before the boundary: claim_pool_fees, when it moves enough ----
  async function doClaim(c) {
    const hour = Math.floor(c.unixTimestamp / HOUR);
    done.claim.add(hour);
    // One claim an hour across every cranker: a second one would land too (moving the fees of the seconds
    // in between). After a random pause, State at the newest bank: if the pool claims grew since this
    // crank's tick in this bar, another cranker has claimed.
    await graduationPause();
    await loadState(true);
    const now = decodeState((await fresh.getAccountInfo(A.state))?.data) ?? st;
    if (now.phase !== PHASE.POOL || !now.graduation) return;
    const base = done.claimBase[hour];
    if (base !== undefined && base !== null && now.poolClaimed !== null && now.poolClaimed > base) {
      say({ chain: c.unixTimestamp, action: "claim", result: "already claimed this hour (by another cranker)", detail: `the pool claims grew by ${now.poolClaimed - base} lamports since this bar's tick` });
      return;
    }
    const ix = claimPoolFeesIx(A, now);
    const sim = await simulate(fresh, [cuLimit(200000), ix], payer, [A.budgetWsol]).catch((e) => ({ err: hide(e.message), accounts: null }));
    if (sim.err) { say({ chain: c.unixTimestamp, action: "claim", result: "nothing to do", detail: errText(sim.err) }); return; }
    const before = BigInt((await fresh.getTokenAccountBalance(A.budgetWsol).catch(() => ({ value: { amount: "0" } }))).value.amount);
    const after = sim.accounts?.[0]?.data ? Buffer.from(sim.accounts[0].data[0], "base64").readBigUInt64LE(64) : before;
    const gain = after - before;
    if (gain < cfg.claimMin) { say({ chain: c.unixTimestamp, action: "claim", result: "not worth it", detail: `it would move ${gain} lamports (CLAIM_MIN ${cfg.claimMin})` }); return; }
    const r = await act("claim", [ix], 200000, c.unixTimestamp);
    const record = { chain: c.unixTimestamp, slot: c.slot, action: "claim", hour, expected: String(gain), ...r };
    if (r.result === "landed") {
      const s = await loadState(true);
      record.detail = `claim_pool_fees: about ${(Number(gain) / LAMPORTS_PER_SOL).toFixed(6)} SOL into the budget (claimed from the pool so far ${(Number(s.poolClaimed ?? 0n) / LAMPORTS_PER_SOL).toFixed(6)}), ${r.units} CU, ${r.bytes} B, ${r.signature}`;
    }
    say(record);
  }

  // ---- once per hour: is the brain book running short? ----
  async function doGrow(c) {
    const hour = Math.floor(c.unixTimestamp / HOUR);
    done.grow.add(hour);
    const book = decodeBook((await connection.getAccountInfo(st.book))?.data);
    if (!book) return;
    const today = book.launchDay === 0 ? 0 : Math.max(0, Math.floor(c.unixTimestamp / DAY) - book.launchDay);
    if (book.capacity > today + BOOK_GROW_BELOW) return;
    const r = await act("grow", [growBrainBookIx(A, payer)], 100000, c.unixTimestamp);
    say({ chain: c.unixTimestamp, action: "grow", ...r, detail: r.result === "landed" ? `book ${book.capacity} -> ${book.capacity + 92} daily records, ${r.signature}` : r.detail });
  }

  // ---- start ----
  const c0 = await clock();
  const s0 = await loadState(true);
  say({ chain: c0.unixTimestamp, action: "start", result: `${args.dry ? "dry (never sends)" : args.local ? "local" : "live"}`, detail: `program ${A.program}, ${s0 ? `phase ${PHASE_NAME[s0.phase]}, pool ${s0.pool}, ${s0.ticks} ticks so far` : "not initialized yet"}, payer ${payer}; window ${cfg.window} s, tick at second ${cfg.tickFrom}-${cfg.tickFrom + cfg.jitter}, buy ${cfg.buyDelay}-${cfg.buyDelay + cfg.buyJitter} s after the boundary tick (after a wait that can pass, looked at again every ${cfg.buyRetry} s until second ${cfg.buyUntil}), tip ${cfg.priority} micro-lamports/CU` });
  {
    // the plan and what it costs: about 120 ordinary ticks, 24 boundary ticks and 24 buys a day
    const fee = (cu) => 5000 + Math.ceil((cu * cfg.priority) / 1e6);
    const perDay = 120 * fee(60000) + 24 * fee(190000) + 24 * fee(120000);
    const bal = await connection.getBalance(payer).catch(() => null);
    say({
      chain: c0.unixTimestamp, action: "plan", result: args.dry ? "DRY: nothing will be sent (SEND=1 in the environment sends)" : "SENDING",
      detail: `about ${(perDay / LAMPORTS_PER_SOL).toFixed(5)} SOL a day in network fees at ${cfg.priority} micro-lamports/CU (a tick ${fee(60000)}-${fee(190000)} lamports, a buy about ${fee(120000)}); grow_brain_book about 0.03 SOL of rent every 92 days; the payer holds ${bal === null ? "?" : (bal / LAMPORTS_PER_SOL).toFixed(4)} SOL${bal ? `, about ${Math.floor(bal / perDay)} days` : ""}`,
    });
  }
  if (args.local && crank && !args.dry) {
    const bal = await connection.getBalance(crank.publicKey);
    if (bal < LAMPORTS_PER_SOL) await connection.confirmTransaction(await connection.requestAirdrop(crank.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
  }

  const started = Date.now();
  let lastPhaseNote = -1, lowNote = -1;
  for (;;) {
    if (args.for !== null && Date.now() - started > args.for * 1000) break;
    let c;
    try {
      c = await clock();
      await loadState();
    } catch (e) {
      say({ chain: lastClock?.unixTimestamp, action: "read", result: "error", detail: hide(e.message) });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const ts = c.unixTimestamp, hour = Math.floor(ts / HOUR), bar = barOf(ts);
    if (args.until !== null && ts >= args.until) break;
    if (!st || st.phase === PHASE.SETUP) {
      // started before the launch: wait for initialize, then for adopt_curve (checked every few seconds)
      const note = st ? "phase setup" : "not initialized";
      if (lastPhaseNote !== `${note} ${hour}`) {
        lastPhaseNote = `${note} ${hour}`;
        say({ chain: ts, action: "wait", result: note, detail: st ? "the curve is not adopted yet (init-hunch.mjs STEP=adopt)" : "no Hunch state on this cluster yet (init-hunch.mjs STEP=initialize)" });
      }
      await new Promise((r) => setTimeout(r, args.local ? 1000 : 5000));
      await loadState(true);
      if (!args.once) continue;
    } else {
      pickTickSecond(bar);
      for (const what of due(ts, done, { ...cfg, tickFrom: done.tickAt[bar], pool: st.phase === PHASE.POOL })) {
        try {
          if (what === "tick") await doTick(c);
          else if (what === "buy") await doBuy(c);
          else if (what === "grow") await doGrow(c);
          else if (what === "grad") await doGraduation(c);
          else if (what === "claim") await doClaim(c);
        } catch (e) {
          say({ chain: ts, action: what, result: "error", detail: hide(e.message) });
        }
      }
      if (!args.dry && lowNote !== hour) {
        lowNote = hour;
        const bal = await connection.getBalance(payer).catch(() => null);
        if (bal !== null && bal < 0.05 * LAMPORTS_PER_SOL) say({ chain: ts, action: "funds", result: "low", detail: `the crank key holds ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL; a day of ticks and buys takes about 0.002` });
      }
    }
    if (args.once) break;
    // sleep until the next thing that could be due, by the chain's clock
    const sec = ts - bar * BAR;
    const barOver = done.tick.has(bar) || sec >= cfg.window - 1;
    const nextTick = barOver ? (bar + 1) * BAR + cfg.tickFrom : bar * BAR + Math.max(sec + 1, done.tickAt[bar]);
    // (a buy that is due but held back by its slot wakes at the slot, not on every poll)
    const buyAt = done.boundaryLandedAt[hour] !== undefined && !done.buy.has(hour) ? buySlot(Math.max(ts, buyDueAt(done, hour, cfg)), cfg) : Infinity;
    const next = Math.min(nextTick, buyAt);
    const waitMs = Math.max(cfg.pollMs, Math.min(30000, ((next - ts) / rate) * 1000 - 1500));
    await new Promise((r) => setTimeout(r, waitMs));
  }
  say({ chain: lastClock?.unixTimestamp, action: "stop", result: "done" });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on("unhandledRejection", (e) => console.error(`note: ${hide(e?.message ?? e)}`));
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`STOPPED: ${hide(e?.message ?? e)}`); process.exit(1); });
}
