// Live (site/config.js has the program, the mint and the pool): the page reads the coin's own accounts
// through /api/state every few seconds, decodes them here (./decode.js) and tells them as the coin
// would. Nothing is estimated: if an account cannot be read, the page says so.
//
// Every phase of the program is told: set up (initialized, not watching a pool yet), the curve, graduating
// (the curve is complete), the pool (after Meteora's migration to DAMM v2, which Hunch adopts), and blind
// (the pool's layout is not the one adopted: no calls, no buys). The page's name and ticker come from
// config.js; the diary's raw lines name the coin as the program stores it (State.ticker), and the page
// says so if the two differ.

import { CONFIG } from "./config.js";
import { decodeSnapshot, CALL, OUTCOME, PHASE, DF, SF, TF, SKIP } from "./decode.js";
import { fmtSol3, fmtTokens, WARM_HOURS } from "./core/chain.js";
import { learningCount } from "./core/net.js";
import { el, utc, clock, plural, times, split } from "./ui.js";
import { TICKER, CHAPTERS, solscan, short } from "./facts.js";

const STATUS = { [PHASE.SETUP]: "set up", [PHASE.CURVE]: "live", [PHASE.GRADUATING]: "graduating", [PHASE.POOL]: "graduated", [PHASE.BLIND]: "blind" };
const PHASE_WORD = { [PHASE.SETUP]: "setup", [PHASE.CURVE]: "curve", [PHASE.GRADUATING]: "graduating", [PHASE.POOL]: "pool", [PHASE.BLIND]: "blind" };
const word = (c) => (c === CALL.BUSIER ? "busy" : c === CALL.QUIETER ? "quiet" : null);
const side = (c) => (c === CALL.BUSIER ? "busier" : "quieter");
const sol = (l) => `${fmtSol3(l ?? 0n)} SOL`;
const big = (v) => BigInt(v ?? 0);
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
// "56/44", the called side first, from the lean the program stores (basis points toward busier)
const pair = (bps) => split(bps / 10000);
const link = (a, text = short(a)) => el("a", { href: solscan(a), target: "_blank", rel: "noopener", class: "addr", text });
const addrList = (rows) => rows.filter(([, a]) => a).flatMap(([k, a]) => [el("dt", { text: k }), el("dd", {}, link(a, a))]);
const WINDOW = 100;

// What a diary entry says about its hour, in a few words (the order of core/chain.js diaryLine).
function outcomeText(e) {
  if (e.flags & DF.BLIND) return "blind: my pool’s layout changed, so no call";
  if (e.outcome === OUTCOME.FORFEIT) return "forfeited: a tick was missed, so it counts as a miss";
  if (e.flags & DF.GRADUATING) return "graduating, not scored";
  if (e.outcome === OUTCOME.HIT || e.outcome === OUTCOME.MISS) {
    const came = e.outcome === OUTCOME.HIT ? e.call : e.call === CALL.BUSIER ? CALL.QUIETER : CALL.BUSIER;
    return `it came ${side(came)}`;
  }
  if (e.call === CALL.NONE) return "watching, no call yet";
  if (e.flags & DF.PAUSED) return "not scored: Meteora paused the pool";
  if (e.flags & DF.FEE_CHANGED) return "not scored: Meteora changed the pool’s fee";
  if (e.flags & DF.NO_OUTSIDE) return "not scored: no outside trades";
  if (e.flags & DF.TIE) return "it came level, not scored";
  return "not scored: warm-up";
}
// The buy clause of a diary entry: what the hour bought and burned, or why it waited.
function buyText(e) {
  if (big(e.bought) > 0n) return `Bought ${sol(e.bought)} of ${TICKER}, burned ${fmtTokens(e.burned)}.`;
  const f = e.flags, held = sol(big(e.held) * 10_000n);
  if (f & DF.BLIND) return "No buy: I couldn’t read my pool.";
  let why = "nobody ran the buy that hour";
  if (e.outcome === OUTCOME.FORFEIT && !(f & (DF.GUARD | DF.STALE | DF.BELOW_MIN | DF.VOLUME_CAP | DF.DAY_CAP | DF.NO_ATTEMPT))) why = "the hour’s opening tick was missed";
  else if (f & DF.GRADUATING) return "No buy: the curve is complete.";
  else if (f & DF.GUARD) why = `the price was ${Math.floor(e.detail / 10)}.${e.detail % 10}% over its hour median`;
  else if (f & DF.STALE) why = "the tape was stale";
  else if (f & DF.BELOW_MIN) why = "below 0.01 SOL";
  else if (f & DF.VOLUME_CAP) why = "the outside-volume cap";
  else if (f & DF.DAY_CAP) why = "the daily cap";
  else if (f & DF.PAUSED) why = "Meteora paused the pool";
  return `No buy (${why}); ${held} waited.`;
}
const SKIP_WORD = { [SKIP.BELOW_MIN]: "below 0.01 SOL", [SKIP.GUARD]: "the price guard", [SKIP.STALE]: "a stale tape", [SKIP.VOLUME_CAP]: "the outside-volume cap", [SKIP.DAY_CAP]: "the daily cap", [SKIP.IMPACT_CAP]: "the price-impact cap" };

// Why there is no call now.
function noCall({ phase, sg }) {
  if (!sg || phase === PHASE.SETUP) return { word: "set up", why: "Set up on Solana, not watching a pool yet." };
  if (phase === PHASE.BLIND) return { word: "blind", why: "My pool’s layout changed and I can’t read it: no calls and no buys until I can." };
  if (phase === PHASE.GRADUATING) return { word: "graduating", why: "The curve is complete. No hour is scored and nothing is bought until I move to the new pool." };
  if (sg.flags & SF.GAP) return { word: "no call", why: "A tick was missed in the hour before, so no call this hour. It counts as a miss." };
  if (phase === PHASE.POOL) return { word: "watching", why: "I moved to my new pool. The first call there comes at the next hour." };
  return { word: "watching", why: "The first call comes once I have two hours of trades." };
}
// Why the call shown will not be scored, when it will not.
function callNote({ phase, st, sg }) {
  if (!sg?.call) return null;
  if (phase === PHASE.GRADUATING) return "The curve is complete: this hour is not scored, and nothing is bought until I move to the new pool.";
  if (sg.flags & SF.PAUSED) return "Meteora paused the pool in the hour this call is measured against, so it will not be scored.";
  if (sg.flags & SF.FEE_CHANGED) return "Meteora changed the pool’s fee in the hour this call is measured against, so it will not be scored.";
  if (sg.unixHour < Math.max(st.startHour + WARM_HOURS, st.poolWarmEnd)) {
    return phase === PHASE.POOL ? "My first two hours in the new pool are a warm-up: this call is not scored." : "This call falls in my warm-up, so it is not scored.";
  }
  return null;
}

export function start(page) {
  const N = page.notice;
  const label = el("span", { class: "label", text: "Live: reading my accounts on Solana…" });
  const list = el("dl", { class: "src addrs", hidden: true });
  const listBtn = el("button", { class: "link", "aria-expanded": "false", onclick: () => { list.hidden = !list.hidden; listBtn.setAttribute("aria-expanded", String(!list.hidden)); } }, "Which accounts?");
  N.classList.add("live");
  N.replaceChildren(el("div", { class: "nrow" }, el("i", { class: "rec", "aria-hidden": "true" }), label, el("span", { class: "nctl" }, listBtn)), list);
  page.status("live");

  let L = null, at = 0, failing = null, problems = null, stale = false, prevW = null, moved = null, movedCount = null, lastVersion = -1;

  async function refresh() {
    try {
      const r = await fetch(CONFIG.api, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!j) throw new Error(`the reader answered ${r.status}`);
      if (j.error) throw new Error(j.error);
      if (j.live === false) throw new Error(j.reason ?? "the reader is not set up");
      const s = decodeSnapshot(j);
      L = derive(s);
      at = j.at; stale = !!j.stale; failing = null;
      const notes = [...s.errors];
      // the diary's lines name the coin as the program stores it; the rest of the page as config.js does
      if (s.state && s.state.ticker !== TICKER) notes.push(`the program names the coin ${s.state.ticker}, this page ${TICKER}`);
      problems = !j.accounts?.state ? "my accounts are not on chain yet (the program has not been set up)" : notes.length ? notes.join("; ") : null;
      if (L.ok) {
        // what the last learning step moved: the weights now against the last read, when it learned since
        const m = s.model;
        if (prevW && m.version !== lastVersion) {
          moved = new Set();
          for (let k = 0; k < 169; k++) if (m.weights[k] !== prevW[k]) moved.add(k);
          movedCount = moved.size;
        }
        prevW = Int32Array.from(m.weights); lastVersion = m.version;
        page.status(STATUS[L.phase] ?? "live");
        addresses();
        page.render(snapshot, "data");
      } else page.failed(`My accounts could not be read yet (${problems ?? "some are missing"}). This page tries again every ${Math.round(CONFIG.refreshMs / 1000)} seconds.`);
    } catch (err) {
      failing = err.message || String(err);
      if (!L) page.failed(`My accounts could not be read yet (${failing}). This page tries again every ${Math.round(CONFIG.refreshMs / 1000)} seconds.`);
    }
    showLabel();
    setTimeout(refresh, document.hidden ? CONFIG.refreshMs * 4 : CONFIG.refreshMs);
  }

  function showLabel() {
    const why = failing ?? problems;
    if (!L) { label.textContent = why ? `Live, but my accounts could not be read: ${why}. Trying again.` : "Live: reading my accounts on Solana…"; return; }
    const age = Math.max(0, Math.round(Date.now() / 1000 - at));
    label.textContent = `Live: my own accounts on Solana, read at slot ${L.s.slot.toLocaleString("en-US")}, ${age < 90 ? `${age} s` : `${Math.round(age / 60)} min`} ago.` +
      (stale || failing ? " The reader could not reach Solana just now: this is the last read." : "") +
      (problems ? ` Not as expected: ${problems}.` : "");
  }
  setInterval(() => { if (L) showLabel(); }, 1000);

  function addresses() {
    const A = L.s.addresses, st = L.st, grad = st && st.adoptTs > 0;
    list.replaceChildren(...addrList([["program", A.program], [TICKER, A.mint], [grad ? "curve" : "pool", A.pool],
      ...(grad ? [["new pool", st.dammPool], ["my position", st.position]] : []),
      ["open call", A.signal], ["diary", A.diary], ["model", A.model], ["brain book", A.book], ["state", A.state], ["tape", A.tape], ["budget", A.budget]]));
  }

  function snapshot() {
    const { s, st, sg, phase, entries: E, nowHour, launchHour } = L, m = s.model;
    const call = phase === PHASE.BLIND ? null : word(sg?.call);
    const graduated = st.adoptTs > 0;
    const nextAt = (nowHour + 1) * 3600, left = Math.ceil((nextAt - Date.now() / 1000) / 60);
    const dayStart = Math.floor(nowHour / 24) * 24;
    const todays = E.filter((e) => e.unixHour >= dayStart && big(e.bought) > 0n);
    // a buy in the current hour reaches the diary only at the next boundary; until then it is in State
    if (st.hsHour >= dayStart && st.hsReason === SKIP.NONE && st.hsBought > 0n && !E.some((e) => e.unixHour === st.hsHour))
      todays.push({ bought: st.hsBought, burned: st.hsBurned });
    const spent = todays.reduce((a, e) => a + big(e.bought), 0n), burned = todays.reduce((a, e) => a + big(e.burned), 0n);
    const dated = phase !== PHASE.SETUP, dayNo = Math.max(0, Math.floor((nowHour - launchHour) / 24));
    const onCurve = s.pool?.creatorQuoteFee ?? 0n;
    const pd = s.programData;
    return {
      mode: "live",
      hour: { label: `Hour ${nowHour - launchHour}`, when: utc(nowHour * 3600) },
      call, lean: call ? pair(sg.lean) : null, noCall: call ? null : noCall(L), note: call ? callNote(L) : null,
      next: left > 0 ? `next call in ${left} min` : `next call once the ${clock(nextAt)} tick lands`,
      record: record(),
      recordBefore: graduated ? { n: st.prevN, hits: st.prevHits, ruleHits: st.prevRuleHits, all: true, unit: "scored hours on the curve" } : null,
      brain: { w: Float64Array.from(m.weights, (q) => q / 65536) },
      pulse: m.version,
      // for the mascot's face: the phase, the minutes before a call, buys so far, the hour last scored
      beat: {
        phase: PHASE_WORD[phase] ?? "curve",
        soon: phase !== PHASE.SETUP && phase !== PHASE.BLIND && phase !== PHASE.GRADUATING && left <= 2,
        buys: Number(st.buys ?? 0), ...lastScored(), line: E.length ? E.at(-1).unixHour : null,
      },
      bars: L.bars.slice(-12).map((b) => b.vol),
      lesson: m.sample ? { came: m.sample.nextVol === m.sample.lastVol ? null : m.sample.nextVol > m.sample.lastVol ? "busier" : "quieter", moved, count: movedCount } : null,
      burn: {
        today: todays.length ? `Today (UTC) I bought ${TICKER} ${times(todays.length)} with ${sol(spent)}, and burned ${fmtTokens(burned)} of it.` : "No buys yet today (UTC).",
        hour: hourBuy(),
        held: graduated
          ? `Right now ${sol(s.held ?? 0n)} waits to be spent in my budget${onCurve > 0n ? `, and ${sol(onCurve)} is still on the old curve` : ""}. My share of the new pool’s fees joins it when anyone claims it; until then it sits in the pool, where this page does not read it. In all: ${sol(st.spent)} spent in ${plural(st.buys, "buy")}, ${fmtTokens(st.burned)} ${TICKER} burned.${supply()}`
          : `Right now ${sol((s.held ?? 0n) + onCurve)} waits to be spent (${sol(s.held ?? 0n)} in my budget, ${sol(onCurve)} still on the pool). In all: ${sol(st.spent)} spent in ${plural(st.buys, "buy")}, ${fmtTokens(st.burned)} ${TICKER} burned.${supply()}`,
        route: graduated ? `Since graduation the fee is the new pool’s, and my locked share of its liquidity still brings me 0.99% of each trade. My position has brought ${sol(st.poolClaimed)} so far.` : null,
        moved: `In all I spent ${sol(st.spent)} and burned ${fmtTokens(st.burned)} ${TICKER} myself. ${movedLine()}`,
      },
      diary: diary(),
      diaryEmpty: phase === PHASE.SETUP ? "No lines yet. The first is written when my first full hour watching a pool ends." : "No lines yet.",
      photos: [{
        key: "now", label: `Day ${dayNo}, now`, short: "now", w: Float64Array.from(m.weights, (q) => q / 65536), hash: m.hash,
        when: m.ts ? `My brain as my model account holds it (${utc(m.ts)}). ${learningCount(L.chapter)} of the 169 learn now.`
          : `My brain as it was set up, before its first step. ${learningCount(L.chapter)} of the 169 will learn at first.`,
        hashNote: "SHA-256 of my 676 bytes, worked out in this page.",
      }],
      book: (s.book?.records ?? []).slice(-14).reverse().map((r) => ({ day: r.day, when: utc(r.unixTime), right: `${r.hits}/${r.n}`, hash: r.hash })),
      faq: {
        key: `${phase}|${st.adoptTs}|${pd?.authority ?? "?"}|${L.chapter}|${launchHour}|${st.withdrawals}|${st.withdrawn}`,
        developer: CONFIG.developer,
        moved: movedLine(),
        upgrade: pd ? (pd.authority ? ["Yes. The developer can update the program. Its upgrade authority is ", link(pd.authority), "."] : "No. No one can update the program now: its upgrade authority is gone.")
          : "Yes, the developer can update the program. Who holds that power could not be read just now.",
        live: [
          el("p", { text: `Yes. ${liveLine()} This page reads my accounts every ${Math.round(CONFIG.refreshMs / 1000)} seconds. Nothing on it is an estimate.` }),
          el("dl", { class: "addrs" }, addrList([["program", s.addresses.program], [TICKER, s.addresses.mint], [graduated ? "curve" : "pool", s.addresses.pool],
            ...(graduated ? [["new pool", st.dammPool]] : [])])),
        ],
        chapterDates: CHAPTERS.map((c) => (dated ? `${utc((launchHour + c.hours) * 3600, false)} (day ${c.day})` : `Day ${c.day}`) + (L.chapter >= c.n ? ", begun" : "")),
      },
    };

    function supply() { return s.mint ? ` ${TICKER} supply now: ${fmtTokens(s.mint.supply)}.` : ""; }
    // what the developer has moved from my budget to their wallet (withdraw_budget), from my state, never from memos
    function movedLine() {
      const n = Number(st.withdrawals ?? 0);
      if (!n) return "The developer has not moved any of my budget to their wallet yet.";
      const when = utc(st.lastWithdrawHour * 3600);
      return n === 1
        ? `The developer has moved ${sol(st.withdrawn)} of my budget to their wallet, once, in the hour from ${when}.`
        : `The developer has moved ${sol(st.withdrawn)} of my budget to their wallet, ${times(n)}, the last in the hour from ${when}.`;
    }
    function lastScored() {
      for (let i = E.length - 1; i >= 0; i--) {
        const e = E[i];
        if (e.outcome === OUTCOME.HIT || e.outcome === OUTCOME.MISS || e.outcome === OUTCOME.FORFEIT) return { scored: e.unixHour, hit: e.outcome === OUTCOME.HIT };
      }
      return { scored: null, hit: null };
    }
    function liveLine() {
      if (phase === PHASE.SETUP) return "Set up on Solana, not watching a pool yet.";
      const since = `Live on Solana since ${utc(st.launchTs)}.`;
      if (graduated) return `${since} Graduated ${utc(st.adoptTs)}: I now read my Meteora DAMM v2 pool.`;
      if (phase === PHASE.GRADUATING) return `${since} The curve is complete: I move to a Meteora DAMM v2 pool once Meteora migrates it.`;
      return since;
    }
    function hourBuy() {
      if (phase === PHASE.SETUP) return "Nothing to buy yet: I’m not watching a pool.";
      if (phase === PHASE.BLIND) return "No buys while I can’t read my pool.";
      if (phase === PHASE.GRADUATING) return "The curve is complete: nothing is bought until I move to the new pool.";
      if (phase === PHASE.POOL && sg?.poolStatus) return "Meteora has paused the pool: nothing is bought until it reopens.";
      // buy_and_burn_pool refuses a fee above the one at adoption (error 30); the open call holds the fee at this hour's first tick
      const adoptBps = Number(st.adoptFeeNum / 100_000n);
      if (phase === PHASE.POOL && sg && sg.poolFeeBps > adoptBps) return `At this hour’s first tick the pool’s fee was ${sg.poolFeeBps / 100}%, above the ${adoptBps / 100}% it had at graduation: nothing is bought while it stays higher.`;
      if (st.hsHour === nowHour && st.hsReason === SKIP.NONE && st.hsBought > 0n) return `This hour: bought ${sol(st.hsBought)}, burned ${fmtTokens(st.hsBurned)} ${TICKER}. Exact, from my account.`;
      if (st.hsHour === nowHour && st.hsReason !== SKIP.NONE) return `This hour I waited: ${SKIP_WORD[st.hsReason] ?? "a cap"}. ${sol(st.hsHeld)} waits; a later try this hour can still buy if that changes.`;
      const why = sg?.mult === 10 ? "×1.0: my lean is too slight to change it" : `×${(sg?.mult / 10).toFixed(1)} because I called ${call}`;
      return sg?.call ? `This hour’s buy is about ${sol(sg.plannedSlice)} (${why}); anyone can run it once the hour’s first tick lands.` : "Anyone can run the hour’s buy once its first tick lands.";
    }
  }

  // The last 100 scored hours: totals now, less the diary line from 100 scored hours ago. After graduation
  // the record is the new pool's (the curve's is kept apart), so only the pool's lines count.
  function record() {
    const { sg, st, entries } = L;
    const graduated = st.adoptTs > 0, unit = graduated ? "scored hours since graduation" : "scored hours";
    if (!sg?.n) return graduated ? { n: 0, unit, empty: "Nothing scored since graduation yet. The new pool’s first two hours are a warm-up." } : null;
    const E = graduated ? entries.filter((e) => e.unixHour >= st.adoptHour) : entries;
    if (sg.n <= WINDOW) return { n: sg.n, hits: sg.hits, ruleHits: sg.ruleHits, recent: false, unit };
    for (let i = E.length - 1; i >= 0; i--) {
      const b = E[i];
      if (b.n <= sg.n - WINDOW) return { n: sg.n - b.n, hits: sg.hits - b.hits, ruleHits: sg.ruleHits - b.ruleHits, recent: true, unit };
    }
    return { n: sg.n, hits: sg.hits, ruleHits: sg.ruleHits, recent: true, unit };
  }

  function diary() {
    const { sg, st, phase, entries: E, nowHour, launchHour } = L, rows = [];
    if (sg?.call && phase !== PHASE.BLIND) rows.push({ now: true, label: `Hour ${nowHour - launchHour}`, when: "now", text: `Leans ${word(sg.call)} ${pair(sg.lean)}. Scored when the hour ends.` });
    for (const e of E.filter((x) => x.unixHour < nowHour).slice(-6).reverse()) {
      const scored = e.outcome === OUTCOME.HIT || e.outcome === OUTCOME.MISS || e.outcome === OUTCOME.FORFEIT;
      // graduation sits between the pool's first line and the curve's last
      if (st.adoptTs > 0 && e.unixHour < st.adoptHour && !rows.some((r) => r.grad)) rows.push(gradRow());
      rows.push({
        label: `Hour ${e.hour}`, when: utc(e.unixHour * 3600).replace(" UTC", ""),
        text: e.call ? `Leaned ${word(e.call)} ${pair(e.lean)}; ${outcomeText(e)}.` : `${cap(outcomeText(e))}.`,
        result: scored ? (e.outcome === OUTCOME.HIT ? "hit" : "miss") : null,
        buy: buyText(e), raw: e.line,
      });
    }
    if (st.adoptTs > 0 && rows.length < 6 && !rows.some((r) => r.grad)) rows.push(gradRow());
    return rows.slice(0, 6);
    function gradRow() {
      return { grad: true, label: "Graduated", when: utc(st.adoptTs).replace(" UTC", ""), text: "I moved to my Meteora DAMM v2 pool. My record starts over there; the curve’s is kept." };
    }
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && L) page.render(snapshot, "data"); });
  refresh();
}

// One read of the accounts, and what the page needs from it.
function derive(s) {
  const st = s.state, sg = s.signal, entries = s.diary?.entries ?? [];
  const nowHour = sg?.unixHour || Math.floor(s.at / 3600);
  const launchHour = st && st.phase !== PHASE.SETUP ? st.launchHour : nowHour;
  // blind is the open call's phase (the state keeps its own phase and sets its blind flag)
  const phase = st && (st.blind || sg?.phase === PHASE.BLIND) ? PHASE.BLIND : st?.phase ?? PHASE.SETUP;
  // outside volume per bar: the growth of the tape's cumulative count between landed bars
  const tape = s.tape?.entries ?? [], bars = [];
  for (let i = 1; i < tape.length; i++) {
    const a = tape[i - 1], b = tape[i];
    if (b.flags & TF.BLIND || a.flags & TF.BLIND) continue;
    bars.push({ bar: b.bar, vol: Number(b.cum - a.cum) });
  }
  return { s, st, sg, phase, entries, nowHour, launchHour, bars, chapter: st?.chapter ?? 0, ok: !!(st && sg && s.diary && s.model) };
}
