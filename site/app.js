// The page. The coin is a little beige computer: it speaks in the bubble over its head, its face
// follows the data, and the six keys under it are what you can ask it next (each opens a short view).
// While site/config.js has no program, mint and pool, the data is the rehearsal (a real pool replayed
// through the real network, ./rehearsal.js); once all three are set, it is the coin's own accounts on
// Solana, read through /api/state (./live.js).

import { isLive } from "./config.js";
import { NAME, TICKER, UPDATABLE } from "./facts.js";
import { el, anim, readTheme, paintBrain, reduced } from "./ui.js";
import { VIEWS, openMore } from "./views.js";
import { createMascot } from "./mascot.js";

const $ = (s) => document.querySelector(s);
const RANK = { bar: 0, hour: 1, data: 1, theme: 2, open: 3 };

// ---------- the name, everywhere ----------
document.title = NAME;
for (const n of document.querySelectorAll("[data-name]")) n.textContent = NAME;
for (const n of document.querySelectorAll("[data-ticker]")) n.textContent = TICKER;
$(".foot p").textContent = `${NAME} calls activity, not price, and its call is not a signal to trade. ${UPDATABLE}`;

// ---------- views, the keys that open them, and the coin ----------
const viewsEl = $(".views"), nav = $(".keys"), V = {}, sections = {}, keys = {};
let lens = "now", S = null, get = null, need = null;
const ctx = { redraw: () => invalidate("open") };
const loading = el("p", { class: "loading", text: "Loading…" });
viewsEl.replaceChildren(loading);
VIEWS.forEach((v, i) => {
  sections[v.id] = el("section", { class: "view", "data-view": v.id, hidden: v.id !== lens, "aria-label": v.label });
  viewsEl.append(sections[v.id]);
  V[v.id] = v.make(sections[v.id], ctx);
  keys[v.id] = nav.appendChild(el("button", { class: "key", "aria-pressed": String(v.id === lens), "aria-keyshortcuts": String(i + 1), onclick: () => { open(v.id); mascot.nudge(String(i + 1)); } },
    el("span", { class: "n", "aria-hidden": "true", text: String(i + 1) }),
    el("i", { class: "led", "aria-hidden": "true" }),
    el("span", { class: "cap", text: v.label })));
});
const voiceOf = (id) => VIEWS.find((v) => v.id === id).voice(S);

// the coin itself: one large copy, the only one that listens to the keyboard
const sizeFor = () => (innerWidth <= 760 ? 176 : innerWidth <= 1060 ? 216 : 288);
const isLight = () => document.documentElement.dataset.theme === "light";
const mascot = createMascot($(".me"), {
  name: NAME, ticker: TICKER, size: sizeFor(), state: "boot", bubble: $(".speech"), light: isLight(), lines: pokeLines,
});
mascot.rest(voiceOf(lens));
let rested = voiceOf(lens);
addEventListener("resize", () => mascot.setSize(sizeFor()));

// What it says when pressed: its plain lines, and this hour's lean when there is a call.
function pokeLines() {
  const L = [
    `Hi, I’m ${NAME}.`,
    "169 numbers. That’s my whole brain.",
    "I call activity, not price.",
    "Busier or quieter. One call an hour.",
    "I’m scored in public, next to a coin flip.",
    "A one-line rule is scored next to me.",
    "One line in my diary, every hour.",
    `A slice of every fee buys ${TICKER} to burn.`,
    "My call is not a signal to trade.",
    "The developer can update my program.",
  ];
  if (S?.call) L.splice(1, 0, `This hour I lean ${S.call} ${S.lean}.`);
  if (S?.mode === "rehearsal") L.splice(4, 0, `This is a rehearsal. ${TICKER} isn’t launched.`);
  return L;
}

function open(id, { faq } = {}) {
  if (!V[id]) return;
  if (faq) openMore("faq-" + faq);
  const from = lens;
  lens = id;
  for (const k in sections) { sections[k].hidden = k !== id; keys[k].setAttribute("aria-pressed", String(k === id)); }
  if (from !== id) { rested = voiceOf(id); mascot.rest(rested, true); }
  if (id === "now" && S?.call) callAt = Math.max(performance.now(), bootUntil); // the call shows on its face again
  invalidate("open");
  // the view comes up like a screen redrawing, top to bottom
  if (from !== id) anim(sections[id], [{ clipPath: "inset(0 0 100% 0)", opacity: 0.4 }, { clipPath: "inset(0 0 0% 0)", opacity: 1 }], { duration: 300, easing: "steps(6, end)" });
  try { history.replaceState(null, "", id === "now" ? location.pathname : "#" + id); } catch {}
  if (from !== id && nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
}
addEventListener("hashchange", () => open(location.hash.slice(1) || "now"));
$(".home").addEventListener("click", () => open("now"));
$(".status").addEventListener("click", () => open("faq", { faq: "live" }));

// typing 1 to 6 presses the matching key (not while typing into a field)
addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.key.length !== 1) return;
  const t = e.target, tag = t?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
  const v = VIEWS["123456".indexOf(e.key)];
  if (!v) return;
  open(v.id);
  const key = keys[v.id];
  key.classList.add("down");
  setTimeout(() => key.classList.remove("down"), 150);
});

// ---------- theme: the warm grey for everyone; light only by the button, remembered on this device ----------
const themeBtn = $(".theme");
function applyTheme(light) {
  document.documentElement.dataset.theme = light ? "light" : "dark";
  themeBtn.setAttribute("aria-pressed", String(light));
  $('meta[name="theme-color"]')?.setAttribute("content", light ? "#faf9f5" : "#262624");
  mascot.setLight(light);
  paintMark();
  invalidate("theme");
}
themeBtn.addEventListener("click", () => {
  const light = !isLight();
  try { localStorage.setItem("hunch-look", light ? "light" : "dark"); } catch {}
  applyTheme(light);
});

// ---------- the coin's face follows the data, calmly ----------
// Lasting faces: boot (switching on, or set up and not watching a pool), blind, the hour's call for a
// while after it is made, thinking just before the next call, idle otherwise. One-off faces (a scored
// hour, a learning step, a buy and burn, a new diary line) play one at a time, a breath apart, each
// kind at most once in a while, so a fast replay does not make it twitch.
const HOLD = 8000, GAP = 1200, DWELL = 2000;
// cooldowns by kind (a hit and a miss share one)
const KIND = { hit: "score", miss: "score", learn: "learn", burn: "burn", write: "write" };
const COOL = { score: 20000, learn: 30000, burn: 36000, write: 12000 };
const bootUntil = performance.now() + 1500;
let seen = null, queue = [], played = {}, shotEnd = bootUntil, wasPlaying = false, callAt = -1e9, steadyAt = 0, steady = "boot", brainKey = null;

function notice() {
  const b = S.beat, now = performance.now();
  const k = { scored: b.scored, line: b.line, buys: b.buys, pulse: S.pulse, call: `${S.hour.label}|${S.call}` };
  if (brainKey !== S.pulse) { mascot.setBrain(S.brain.w); brainKey = S.pulse; }
  if (!seen) { seen = k; if (S.call) callAt = Math.max(now, bootUntil); settle(); return; }
  // a newly scored hour shows as pleased or rueful; when that played lately, its diary line is typed instead
  const scoredNow = k.scored !== seen.scored && b.hit != null && cue(b.hit ? "hit" : "miss");
  if (!scoredNow && k.line !== seen.line) cue("write");
  if (k.pulse !== seen.pulse) cue("learn");
  if (k.buys > seen.buys) cue("burn");
  if (k.call !== seen.call && S.call) callAt = now;
  seen = k;
  settle();
}
function cue(name) {
  const now = performance.now(), kind = KIND[name];
  if (now - (played[kind] ?? -1e9) < COOL[kind] || queue.some((q) => KIND[q] === kind) || queue.length >= 2) return false;
  queue.push(name);
  return true;
}
function lasting(now) {
  const b = S.beat;
  // (on arriving just before a call, READY stays up a little longer, until the call comes)
  if (now < bootUntil || b.phase === "setup" || (steady === "boot" && b.soon && now < bootUntil + 2500)) return "boot";
  if (b.phase === "blind") return "blind";
  if (S.call && now - callAt < HOLD) return S.call;
  if (b.soon) return "thinking";
  return "idle";
}
function settle() {
  if (!S || document.hidden) return;
  const now = performance.now();
  if (mascot.playing) { shotEnd = now; wasPlaying = true; }
  else {
    // the lasting face is back in view: let it be seen a moment before it changes
    if (wasPlaying) { wasPlaying = false; steadyAt = now; }
    // (not just before a call: the call comes first)
    if (queue.length && now >= shotEnd + GAP && now >= bootUntil && !S.beat.soon) {
      const name = queue.shift();
      played[KIND[name]] = now;
      if (name === "write") { mascot.write(1300); shotEnd = now + 1300; }
      else { mascot.setState(name); shotEnd = now; wasPlaying = true; }
    }
  }
  let want = lasting(now);
  // once it has switched on, the hour's call is the first face it shows, for its full while
  if (steady === "boot" && want !== "boot" && want !== "blind" && S.call) { callAt = now; want = S.call; }
  // a new call, boot and blind show at once; anything else waits until the face has been seen a moment
  if (want !== steady && (want === S.call || want === "boot" || want === "blind" || now - steadyAt >= DWELL)) {
    steady = want;
    steadyAt = now;
  }
  mascot.setState(steady);
}
setInterval(settle, 400);

// ---------- drawing: once per burst of changes, for whatever changed most ----------
// (a replay catching up after a hidden tab can send hundreds of bars in one go: one snapshot, one draw)
function invalidate(why) {
  if (need == null) queueMicrotask(draw);
  if (need == null || RANK[why] > RANK[need]) need = why;
}
function draw() {
  const why = need;
  need = null;
  if (!get) return;
  S = get();
  if (why !== "bar") paintMark();
  V[lens].update(S, why);
  const line = voiceOf(lens);
  if (line !== rested) { rested = line; mascot.rest(line); }
  notice();
}
// the mark beside the name: the brain now, 13 x 13 pixels
const markCv = $(".mark");
function paintMark() { if (S) paintBrain(markCv.getContext("2d"), S.brain.w, readTheme()); }

// ---------- the source hands over each new snapshot ----------
// `snapshot` is a function: it runs once per draw, not once per bar
const page = {
  render(snapshot, why) {
    if (!get) { loading.remove(); invalidate("open"); }
    get = snapshot;
    invalidate(why);
  },
  notice: $(".notice"),
  status: (text) => { $(".status").textContent = text.charAt(0).toUpperCase() + text.slice(1); },
  failed(text) { if (!S) loading.textContent = text; },
};

applyTheme(isLight());
const start = location.hash.slice(1);
if (V[start]) open(start);

const source = isLive() ? await import("./live.js") : await import("./rehearsal.js");
source.start(page);
