// The page's six views and their small drawings. Every view reads one plain snapshot S that the
// rehearsal (rehearsal.js) or the live reader (live.js) hands over, so both modes share these.
// Each view is built once; update(S, why) runs on every new bar or read (why: "bar", "hour", "data",
// "open" when it is shown, "theme").

import { el, sv, anim, more, openMore, recordWords, weightAlpha, paintBrain, readTheme } from "./ui.js";
import { NAME, TICKER, ROUTE, INTENT, UPDATABLE, OWN_BUYS, CHAPTERS, STUDY, GRADUATION, solscan, short } from "./facts.js";

const p = (text, cls) => el("p", { class: cls, text });
const link = (address, text = short(address)) => el("a", { href: solscan(address), target: "_blank", rel: "noopener", class: "addr", text });
const changed = (why) => why !== "bar";

// ---------------------------------------------------------------- drawings

// What each of the 169 numbers does, in the program's order (core/net.js).
function role(k) {
  if (k < 80) return `input ${(k % 10) + 1} to layer-1 unit ${Math.floor(k / 10) + 1}`;
  if (k < 88) return `layer-1 unit ${k - 79}’s bias`;
  if (k < 152) return `layer-1 unit ${((k - 88) % 8) + 1} to layer-2 unit ${Math.floor((k - 88) / 8) + 1}`;
  if (k < 160) return `layer-2 unit ${k - 151}’s bias`;
  if (k < 168) return `layer-2 unit ${k - 159} to the output`;
  return "the output’s bias";
}
const number = (v) => (v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(4)}`);

// The 169 numbers as 13 x 13 squares; `moved` rings the ones the last step changed. A readable grid
// (the brain photo's) lights a square and reads its number out when it is pointed at, tapped, or
// reached with the arrow keys.
function brainGrid(cls, readable = false) {
  const cells = Array.from({ length: 169 }, (_, k) => el("i", readable ? { "data-k": k } : {}));
  const node = el("div", { class: "grid " + cls, role: readable ? "group" : "img" }, cells);
  const out = readable ? el("p", { class: "readout", "aria-live": "polite" }) : null;
  let w = null, lit = -1, pinned = -1;
  function light(k) {
    if (lit >= 0) cells[lit].classList.remove("on");
    lit = k;
    if (k >= 0) cells[k].classList.add("on");
    if (out) out.textContent = k >= 0 && w ? `No. ${k + 1}: ${role(k)}. ${number(w[k])}` : "Point at a square, or tap it.";
  }
  if (readable) {
    node.tabIndex = 0;
    const at = (e) => (e.target?.dataset?.k != null ? +e.target.dataset.k : -1);
    node.addEventListener("pointerover", (e) => { if (e.pointerType === "mouse" && at(e) >= 0) light(at(e)); });
    node.addEventListener("pointerleave", () => light(pinned));
    node.addEventListener("click", (e) => { const k = at(e); if (k < 0) return; pinned = pinned === k ? -1 : k; light(k); });
    node.addEventListener("focus", () => { if (pinned < 0 && node.matches(":focus-visible")) { pinned = 84; light(84); } });
    node.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -13, ArrowDown: 13 }[e.key];
      if (d == null) return;
      e.preventDefault();
      const from = pinned < 0 ? 84 : pinned, to = from + d;
      if (to < 0 || to > 168 || (Math.abs(d) === 1 && Math.floor(to / 13) !== Math.floor(from / 13))) return;
      pinned = to;
      light(to);
    });
    light(-1);
  }
  return {
    node,
    out,
    set(w2, moved = null, label = "") {
      w = w2;
      node.setAttribute("aria-label", label || `${NAME}'s 169 numbers, one square each`);
      node.classList.toggle("lit", !!moved?.size);
      cells.forEach((c, k) => {
        const v = w[k];
        c.className = (v === 0 ? "" : v > 0 ? "pos" : "neg") + (moved?.has(k) ? " moved" : "") + (k === lit ? " on" : "");
        c.style.setProperty("--a", weightAlpha(v).toFixed(3));
      });
      if (out) light(lit);
    },
  };
}

// Bars of trading volume, oldest first; the newest in the accent.
function barsDrawing(vols) {
  const n = vols.length, mx = Math.max(...vols, 1e-12), bw = 240 / n;
  const s = sv("svg", { class: "bars", viewBox: "0 0 240 100", "aria-hidden": "true" });
  vols.forEach((v, i) => {
    const h = Math.max(3, (v / mx) * 92);
    s.append(sv("rect", { x: i * bw + 2, y: 100 - h, width: bw - 4, height: h, rx: 3, class: i === n - 1 ? "new" : null }));
  });
  return s;
}

// This hour, and the next as the call sees it: taller if busier, shorter if quieter.
function callDrawing(call) {
  const s = sv("svg", { class: "bars", viewBox: "0 0 240 116", "aria-hidden": "true" });
  const now = 50, next = call === "busy" ? 82 : call === "quiet" ? 22 : now;
  const label = (x, text) => { const t = sv("text", { x, y: 114, "text-anchor": "middle" }); t.textContent = text; return t; };
  s.append(
    sv("rect", { x: 40, y: 98 - now, width: 64, height: now, rx: 6 }),
    sv("rect", { x: 136, y: 98 - next, width: 64, height: next, rx: 6, class: "guess " + (call ?? "") }),
    label(72, "this hour"), label(168, "next hour"));
  return s;
}

// ---------------------------------------------------------------- now
function nowView(root, ctx) {
  const k = p("", "k"), word = el("p", { class: "word" }), lean = p("", "lean"), when = p("", "when"), note = p("", "note");
  const lead = p("", "rec-lead"), rest = p("", "rec-rest");
  const [ruleB, ruleBody] = more("rule", "What simple rule?",
    p("“Busier if the last hour was quieter than usual.” I do about as well as it, not better."),
    p("I call activity, never price. It is not a signal to trade."));
  // after graduation: the curve's record, kept apart from the new pool's
  const beforeLead = p(""), beforeRest = p("", "fine");
  const [beforeB, beforeBody] = more("before", "My record on the curve", beforeLead, beforeRest);
  beforeB.hidden = true;
  root.append(el("div", { class: "now" }, k, word, lean, when, note,
    el("div", { class: "panel record" }, lead, rest, el("div", { class: "after" }, ruleB, beforeB, ruleBody, beforeBody))));
  let shown = null;
  return {
    update(S, why) {
      const w = S.call ?? S.noCall?.word ?? "…";
      k.textContent = S.mode === "live" ? "My call for this hour" : `My call for ${S.hour.label.toLowerCase()}`;
      if (w !== shown) {
        const fresh = el("span", { class: S.call ?? "none", text: w });
        word.replaceChildren(fresh);
        if (shown && why !== "open") anim(fresh, [{ transform: "translateY(55%)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, easing: "cubic-bezier(.2,.7,.2,1)" });
        shown = w;
      }
      lean.textContent = S.call ? `leans ${S.call} ${S.lean} · ${S.next}` : S.noCall?.why ?? "";
      when.textContent = `${S.hour.label} · ${S.hour.when}`;
      note.textContent = S.note ?? "";
      note.hidden = !S.note;
      const r = recordWords(S.record);
      lead.textContent = r.lead;
      rest.textContent = r.rest;
      beforeB.hidden = !S.recordBefore;
      if (!S.recordBefore) beforeBody.hidden = true;
      else {
        const b = recordWords(S.recordBefore);
        beforeLead.textContent = b.lead;
        beforeRest.textContent = `${b.rest} My record starts over in the new pool; this one is kept as it was.`;
      }
    },
  };
}

// ---------------------------------------------------------------- how it works
function howView(root, ctx) {
  const d1 = el("div", { class: "art" }), d2 = el("div", { class: "art" }), grid = brainGrid("small"), d3 = el("div", { class: "art" }, grid.node);
  const t1 = p(""), t2 = p(""), t3 = p("");
  const step = (n, title, art, text) => el("li", { class: "panel step" }, art, el("h3", {}, el("span", { class: "n", text: n }), title), text);
  const [readB, readBody] = more("reads", "What do I read?",
    p("How much was traded and how the price moved, how busy this hour is against usual and against the hour before, how jumpy it was, and the time of day. From day 7, also my own last result and my recent hit rate."),
    p(`Only other people’s trades: my own buys are taken out.`));
  const [mathB, mathBody] = more("math", "The math, briefly",
    p("10 inputs, two layers of 8 units, one output: 169 numbers, kept as whole numbers (Q16.16) so every computer gets exactly the same answer."),
    p("Each step moves a number by its share of the error, a small fixed amount at a time. No server: the program does it on Solana."));
  root.append(el("ol", { class: "steps" },
    step("1", "I watch", d1, t1),
    step("2", "I call", d2, t2),
    step("3", "I learn", d3, t3)), el("div", { class: "after" }, readB, readBody, mathB, mathBody));
  return {
    update(S) {
      d1.replaceChildren(barsDrawing(S.bars.length ? S.bars : [0]));
      t1.textContent = "Every 10 minutes I read my pool’s trades.";
      d2.replaceChildren(callDrawing(S.call));
      t2.textContent = S.call ? `Every hour I call the next one: busier or quieter. Now I lean ${S.call} ${S.lean}.` : "Every hour I call the next one: busier or quieter.";
      grid.set(S.brain.w, S.lesson?.moved, "My 169 numbers; the ones my last step moved are lit");
      const L = S.lesson;
      t3.textContent = L?.came
        ? `An hour later I see what came and nudge my numbers toward it. Last time it came ${L.came}${L.count != null ? `, and ${L.count} numbers moved` : ""}.`
        : "An hour later I see what came and nudge my numbers toward it.";
    },
  };
}

// ---------------------------------------------------------------- buy and burn
function burnView(root, ctx) {
  const today = p("", "say"), hour = p("", "fine"), body = el("div"), routeNote = p("", "fine");
  const [howB, howBody] = more("drip", "How big is each buy?", body);
  root.append(
    el("div", { class: "panel route" },
      p("Each trade pays a 3.75% fee.", "k"),
      el("div", { class: "route-bar" }, ROUTE.map((r) => el("span", { class: "seg " + r.key, style: `flex:${r.share * 1000} 1 0` }))),
      el("div", { class: "route-legend" }, ROUTE.map((r) => el("span", { style: `flex:${r.share * 1000} 1 0` }, el("b", { text: r.pct }), r.label))),
      routeNote),
    el("div", { class: "panel" }, today, hour, howB, howBody));
  return {
    update(S, why) {
      const B = S.burn;
      today.textContent = B.today;
      hour.textContent = B.hour;
      routeNote.textContent = B.route ?? "";
      routeNote.hidden = !B.route;
      if (changed(why)) body.replaceChildren(
        p(S.mode === "live"
          ? "Each hour I spend a sixth of what I hold: ×1.5 when I lean quiet by 55/45 or more, ×0.5 when I lean busy by as much, ×1 in between. Caps keep each buy small next to the pool."
          : "Each hour I spend a sixth of what I hold: ×1.5 when I call quiet, ×0.5 when I call busy. A cap keeps each buy under 1% of the pool’s SOL."),
        p(B.held),
        p("Does my call make the buying smarter? No. In a replay before launch, a plain drip that ignored my call did about as well."),
        p(OWN_BUYS),
        p(`Only the program can spend this budget, and only on buying ${TICKER} and burning it. ${UPDATABLE}`));
    },
  };
}

// ---------------------------------------------------------------- diary
function diaryView(root, ctx) {
  const list = el("ol", { class: "diary" }), note = p("", "fine");
  let raw = false, key = "";
  const rawBtn = el("button", { class: "pill sm", "aria-pressed": "false", onclick: () => { raw = !raw; rawBtn.setAttribute("aria-pressed", String(raw)); key = ""; ctx.redraw(); } }, "Show the lines as written on chain");
  root.append(list, el("div", { class: "after" }, note, rawBtn));
  return {
    update(S, why) {
      const k = S.diary.map((d) => d.label + d.text + d.result).join("|") + raw;
      if (k === key && why !== "theme") return;
      key = k;
      rawBtn.hidden = S.mode !== "live" || !S.diary.some((d) => d.raw);
      note.textContent = S.mode === "live" ? "Rebuilt in this page from my diary account, which keeps the last 144 hours." : "Lines from the rehearsal, dated by the replayed pool’s clock. Burns are estimates (≈).";
      list.replaceChildren(...(S.diary.length ? [] : [el("li", { class: "line" }, p(S.diaryEmpty ?? "No lines yet.", "lt"))]), ...S.diary.map((d) => el("li", { class: "line" + (d.now ? " now" : "") + (d.grad ? " grad" : "") },
        el("p", { class: "lh" }, el("b", { text: d.label }), " ", el("span", { text: d.when })),
        raw && d.raw ? p(d.raw, "raw") : el("p", { class: "lt" }, d.text, d.result ? el("span", { class: "tag " + d.result, text: d.result }) : null),
        raw && d.raw ? null : d.buy ? p(d.buy, "lb") : null)));
    },
  };
}

// ---------------------------------------------------------------- brain photo
function photoView(root, ctx) {
  const grid = brainGrid("big", true), day = p("", "day"), taken = p("", "fine"), thumbs = el("div", { class: "thumbs" });
  const hash = p("", "hash"), extra = el("div");
  const [hashB, hashBody] = more("hash", "Its fingerprint", hash, extra);
  root.append(el("div", { class: "photo" },
    el("div", { class: "panel frame" }, grid.node, grid.out),
    el("div", {}, day, taken, p("Green above zero, grey below, stronger when larger. An empty square has not woken yet.", "fine"), thumbs, hashB, hashBody)));
  let picked = null, key = "";
  function draw(S) {
    const list = S.photos, ph = list.find((x) => x.key === picked) ?? list.at(-1);
    if (!ph) { day.textContent = "No photo yet."; return; }
    grid.set(ph.w, null, `${ph.label}: 169 numbers, one square each`);
    day.textContent = ph.label;
    taken.textContent = ph.when;
    hash.textContent = ph.hash.match(/.{16}/g).join("\n");
    extra.replaceChildren(p(ph.hashNote));
    if (S.book) extra.append(p("One record a day in my brain book: the day, this fingerprint and the slot.", "fine"),
      el("ul", { class: "book" }, S.book.length ? S.book.map((r) => el("li", {}, el("b", { text: `Day ${r.day}` }), ` ${r.when} · right ${r.right} · `, el("span", { class: "mono", title: r.hash, text: r.hash.slice(0, 12) + "…" }))) : el("li", { text: "No record yet." })));
    const T = readTheme(), recent = list.slice(-8);
    thumbs.hidden = recent.length < 2;
    thumbs.replaceChildren(...recent.map((x) => {
      const c = el("canvas", { width: 13, height: 13 });
      paintBrain(c.getContext("2d"), x.w, T);
      return el("button", { class: "thumb", "aria-pressed": String(x === ph), "aria-label": x.label, onclick: () => { picked = x === list.at(-1) ? null : x.key; key = ""; draw(S); } }, c, el("span", { text: x.short }));
    }));
  }
  return {
    update(S, why) {
      const k = S.photos.map((x) => x.key).join() + (S.photos.at(-1)?.hash ?? "");
      if (k === key && why !== "theme" && why !== "open") return;
      key = k;
      draw(S);
    },
  };
}

// ---------------------------------------------------------------- questions
function faqView(root, ctx) {
  const list = el("div", { class: "faq" });
  root.append(list);
  let built = null;
  const qa = (key, q, ...a) => { const [b, body] = more("faq-" + key, q, ...a); b.classList.add("q"); return el("div", { class: "qa" }, b, body); };
  return {
    update(S, why) {
      const F = S.faq;
      if (built === F.key && why !== "open") return;
      built = F.key;
      list.replaceChildren(
        qa("price", "Do you predict the price?", p("No. I call activity: whether the next hour will be busier or quieter than the last. On price, tests found nothing better than chance.")),
        qa("signal", "Is your call a trading signal?", p("No. It is not advice and not a signal to trade. It is one public guess an hour, scored in the open, next to a coin flip and a simple rule.")),
        qa("rule", "What is the simple rule?", p("“Busier if the last hour was quieter than usual.” I do about as well as it, never better.")),
        qa("fee", "Who gets the fee?", p(`Each trade pays 3.75%: 0.75% to Meteora, 0.99% to me, which I can only spend buying ${TICKER} and burning it, and 2.01% to the developer.`)),
        qa("graduation", "What happens when the curve is complete?", ...GRADUATION.map((t) => p(t))),
        qa("sell", "Will the developer sell?", el("p", {}, INTENT, ...(F.developer ? [" Their wallet: ", link(F.developer), "."] : []))),
        qa("update", "Can the developer change you?", el("p", {}, F.upgrade)),
        qa("live", "Is this live?", ...F.live),
        qa("later", "What changes later?", el("ul", {}, CHAPTERS.map((c, i) => el("li", {}, el("b", { text: F.chapterDates?.[i] ?? `Day ${c.day}` }), `: ${c.what}.`))),
          p(`Sealed in the program, but the dates can change: ${UPDATABLE.toLowerCase()}${F.chapterNote ? " " + F.chapterNote : ""}`, "fine")),
        qa("study", "Where do the numbers come from?", ...STUDY.map((t) => p(t))));
    },
  };
}

export const VIEWS = [
  { id: "now", label: "Now", make: nowView, voice: () => `I’m ${NAME}, a tiny neural network in a Solana coin. Each hour I call it: busier or quieter?` },
  { id: "how", label: "How it works", make: howView, voice: () => "Three things, over and over, inside a Solana program. No server." },
  { id: "burn", label: "Buy and burn", make: burnView, voice: () => `A slice of every trade comes to me. I can only spend it buying ${TICKER} and burning it.` },
  { id: "diary", label: "Diary", make: diaryView, voice: (S) => (S?.mode === "live" ? "Every hour I write one line on chain." : "Every hour I write one line.") },
  { id: "photo", label: "Brain photo", make: photoView, voice: () => "Once a day I take a photo of my brain: 169 numbers, one square each." },
  { id: "faq", label: "Questions", make: faqView, voice: () => "Fair questions. Short answers." },
];
export { openMore };
