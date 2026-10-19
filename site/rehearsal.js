// The rehearsal (while site/config.js has no program, mint and pool): a real pool's 10-minute bars
// replayed through the real network and the real buy rule (./core), told as the coin would tell it.
// Nothing here is the coin's: dates are the real pool's, shown as replay time; burns are estimates.

import { createReplay, loadReplay, fmtSol, fmtCount, STEPS_PER_DAY } from "./core/replay.js";
import { el, utc, plural, times, split, fullBrain, FULL_INDEX } from "./ui.js";
import { TICKER, solscan } from "./facts.js";

const START = 5 * STEPS_PER_DAY;          // open five days in, so the record already covers 100 hours
const SPEEDS = [{ sps: 0.5, label: "Faster" }, { sps: 3, label: "Slower" }];   // an hour every 12 s, or every 2 s
const WINDOW = 100;

export async function start(page) {
  page.status("not launched");
  const N = page.notice;
  const label = el("span", { class: "label", text: `Rehearsal: a real pool’s trades, replayed through my real network. ${TICKER} is not launched.` });
  const src = el("p", { class: "src", hidden: true });
  const srcBtn = el("button", { class: "link", "aria-expanded": "false", onclick: () => { src.hidden = !src.hidden; srcBtn.setAttribute("aria-expanded", String(!src.hidden)); } }, "Which data?");
  const playBtn = el("button", { class: "pill sm" }, "Pause");
  let speed = 0;
  const speedBtn = el("button", { class: "pill sm", onclick: () => { speed = 1 - speed; replay.setSpeed(SPEEDS[speed].sps); speedBtn.textContent = SPEEDS[speed].label; } }, SPEEDS[0].label);
  N.replaceChildren(el("div", { class: "nrow" }, el("i", { class: "rec", "aria-hidden": "true" }), label, el("span", { class: "nctl" }, srcBtn, playBtn, speedBtn)), src);

  let data;
  try { data = await loadReplay(new URL("./data/replay.json", import.meta.url)); }
  catch (err) { page.failed("The replay data did not load. Reload to try again."); throw err; }
  const s0 = data.source, day = (iso) => utc(Date.parse(iso) / 1000, false);
  const from = `${s0.symbol}/${s0.quote} on PumpSwap, ${day(s0.from)} to ${day(s0.to)}, ${new Date(s0.to).getUTCFullYear()}`;
  src.replaceChildren(`A real Solana pool, ${from}. It is not ${TICKER}. `, el("a", { href: solscan(s0.pool), target: "_blank", rel: "noopener", text: "See it on Solscan" }));

  const replay = createReplay(data, { speed: SPEEDS[0].sps, startAt: START });
  // the replay starts a fresh history when it goes back ("Replay again"): always read the current one
  let H = replay.history;
  let pulse = 0;

  playBtn.addEventListener("click", () => { if (replay.done) { replay.seek(START); replay.play(); } else replay.toggle(); });
  const syncPlay = () => { playBtn.textContent = replay.done ? "Replay again" : replay.playing ? "Pause" : "Play"; };
  for (const t of ["play", "pause", "end"]) replay.on(t, syncPlay);
  replay.on("learn", () => { pulse++; });
  replay.on("stats", (e) => page.render(snapshot, e.step % 6 === 0 ? "hour" : "bar"));
  replay.on("seek", () => page.render(snapshot, "data"));

  const FAQ = {
    key: "rehearsal",
    developer: null,
    upgrade: "Yes. The developer can update the program. At launch this page will show who holds that power.",
    live: [
      el("p", { text: `Not yet. ${TICKER} is not launched and has no address. This page replays a real pool’s trades through my real network: ${from}. That pool is not ${TICKER}, and the burns here are estimates.` }),
      el("p", {}, el("a", { href: solscan(s0.pool), target: "_blank", rel: "noopener", text: "See that pool on Solscan" })),
    ],
    chapterNote: "This rehearsal stays at my day-0 network.",
  };

  function snapshot() {
    H = replay.history;
    const st = replay.stats, sig = replay.signal, pos = replay.position;
    const calls = H.calls, c = calls.at(-1);
    const call = c ? c.call : null;
    // the record: the last 100 scored calls, beside the one-line rule on the same hours
    let n = 0, hits = 0, ruleHits = 0, scored = null;
    for (let i = calls.length - 1; i >= 0 && n < WINDOW; i--) {
      const x = calls[i];
      if (x.came == null) continue;
      scored ??= x;
      n++; hits += x.hit ? 1 : 0; ruleHits += x.rule === x.came ? 1 : 0;
    }
    const left = ((6 - (pos % 6)) % 6 + 1) * 10;
    const today = Math.floor((sig?.step ?? 0) / STEPS_PER_DAY);
    const drips = H.drips.filter((d) => Math.floor(d.step / STEPS_PER_DAY) === today && d.spend > 0);
    const spent = drips.reduce((a, d) => a + d.spend, 0), burned = drips.reduce((a, d) => a + d.burnedEst, 0);
    const d = H.drips.at(-1), le = H.learns.at(-1);
    return {
      mode: "rehearsal",
      hour: { label: `Hour ${c?.hour ?? 0}`, when: c ? `replay of ${utc(c.ts)}` : "" },
      call, lean: c ? split(c.p) : null,
      next: replay.done ? "the replay has ended" : `next call in ${left} min`,
      record: { n, hits, ruleHits, recent: n >= WINDOW, unit: "hours" },
      brain: { w: Float64Array.from(replay.model.net.weights.flat(), (q) => q / 65536) },
      pulse,
      // for the mascot's face: what just happened (the hour last scored, the newest diary line, buys so far)
      beat: {
        phase: "curve", soon: !replay.done && left === 10, buys: st.buys,
        scored: scored ? scored.hour : null, hit: scored && scored.hit != null ? !!scored.hit : null,
        line: H.diary.at(-1)?.hour ?? null,
      },
      bars: Array.from(data.vol.slice(Math.max(0, pos - 12), pos)),
      lesson: le && { came: le.y === "busy" ? "busier" : "quieter", count: le.changed.length, moved: new Set(le.changed.map(([i]) => FULL_INDEX[i])) },
      burn: {
        today: drips.length ? `So far on day ${today} I bought ${TICKER} ${times(drips.length)} with ${fmtSol(spent)} SOL, and burned about ${fmtCount(burned)} of it.` : `No buys yet on day ${today}.`,
        hour: d ? `This hour: ${fmtSol(d.spend)} SOL, ×${d.factor} because I called ${d.call}${d.capped ? ", held lower by a cap of 1% of the pool" : ""}. Burns are estimates in the rehearsal.` : "",
        held: `Right now I hold ${fmtSol(st.budget)} SOL to spend. In all: ${fmtSol(st.spent)} SOL spent in ${plural(st.buys, "buy")}, about ${fmtCount(st.burnedEst)} ${TICKER} burned (an estimate).`,
      },
      diary: diary(c),
      photos: H.snapshots.map((s) => ({
        key: s.day, label: `Day ${s.day}`, short: String(s.day), w: fullBrain(s.weights), hash: s.hash,
        when: `Taken at hour ${s.step / 6}, replay of ${utc(s.ts)}. In this rehearsal 81 of the 169 learn; the rest stay as they start until their chapters.`,
        hashNote: "SHA-256 of the 81 numbers that learn here. At launch it will cover all 169, with the slot it was taken at.",
      })),
      book: null,
      faq: FAQ,
    };
  }

  // the last lines, newest first: the open call, then the hours already scored
  function diary(c) {
    const rows = [];
    if (c && c.came === undefined) rows.push({ now: true, label: `Hour ${c.hour}`, when: "now", text: `Leans ${c.call} ${split(c.p)}. Scored when the hour ends.` });
    const byHour = new Map(H.calls.slice(-12).map((x) => [x.hour, x]));
    for (const e of H.diary.slice(-6).reverse()) {
      const x = byHour.get(e.hour);
      rows.push({
        label: `Hour ${e.hour}`, when: utc(e.ts - 3600).replace(" UTC", ""),
        text: `Leaned ${e.call}${x ? " " + split(x.p) : ""}. It came ${e.came === "busy" ? "busier" : e.came === "quiet" ? "quieter" : "level"}.`,
        result: e.hit == null ? null : e.hit ? "hit" : "miss",
        buy: e.spend > 0 ? `Bought ${fmtSol(e.spend)} SOL of ${TICKER}, burned ≈${fmtCount(e.burnedEst)}.` : "No buy.",
      });
    }
    return rows.slice(0, 6);
  }

  page.render(snapshot, "data");
  syncPlay();
  replay.play();
}
