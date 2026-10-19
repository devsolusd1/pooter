// Small DOM, motion, colour and wording helpers shared by the page's modules.

const SVGNS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, ...kids) {
  const e = tag === "svg" || attrs.svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false || k === "svg") continue;
    if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k);
  return e;
}
export const sv = (tag, attrs = {}) => el(tag, { ...attrs, svg: true });

// ---------- words and numbers ----------
export const int = (n) => Math.round(n).toLocaleString("en-US");
export const plural = (n, one, many = one + "s") => `${int(n)} ${n === 1 ? one : many}`;
export const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${int(n)} times`);

// "56/44": the lean toward the called side first, from p = the lean toward busier (0..1).
// Near even it keeps a decimal, so a call never reads "50/50".
export function split(p) {
  const m = Math.max(p, 1 - p) * 100;
  const d = m >= 50.5 ? 0 : m >= 50.05 ? 1 : 2, f = 10 ** d;
  const a = Math.min(99 * f, Math.round(m * f));
  return `${(a / f).toFixed(d)}/${((100 * f - a) / f).toFixed(d)}`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => String(n).padStart(2, "0");
export function utc(ts, withTime = true) {
  const d = new Date(ts * 1000);
  const day = `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withTime ? `${day}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC` : day;
}
export const clock = (ts) => { const d = new Date(ts * 1000); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`; };

// The record, said as a sentence beside a coin flip (and its luck band) and the one-line rule.
// r: { n, hits, ruleHits, recent: true when n is the last 100, all: true when n is a whole finished record,
//      unit: "hours" | "scored hours" | ..., empty: what to say when nothing is scored yet }
export function recordWords(r) {
  if (!r || !r.n) return { lead: r?.empty ?? "Nothing scored yet.", rest: "The first call is scored an hour after it is made." };
  // the coin flip's 95% luck band, in calls out of n
  const half = 1.96 * Math.sqrt(0.25 * r.n), lo = Math.max(0, Math.round(r.n / 2 - half)), hi = Math.min(r.n, Math.round(r.n / 2 + half));
  return {
    lead: `Right ${int(r.hits)} ${r.hits === 1 ? "time" : "times"} in ${r.recent ? "the last" : r.all ? "my" : "my first"} ${int(r.n)} ${r.unit}.`,
    rest: `A coin flip gets about ${int(r.n / 2)}, anywhere from ${int(lo)} to ${int(hi)} by luck; a simple rule gets ${int(r.ruleHits)}.`,
  };
}

// ---------- motion: every animation goes through these, so reduced motion stops them all ----------
const RM = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const reduced = () => !!RM?.matches;
export function anim(node, frames, opts) {
  if (reduced() || typeof node?.animate !== "function") return null;
  return node.animate(frames, opts);
}

// Type a line in, a few characters a frame. The rest is laid out unseen from the start, so nothing
// below the line moves while it types.
export function typeInto(node, text, ms = 520) {
  cancelAnimationFrame(node._raf);
  if (reduced() || node.textContent === text) { node.textContent = text; return; }
  const t0 = performance.now(), ghost = el("span", { class: "ghost" });
  const tick = () => {
    const n = Math.ceil(Math.max(0, Math.min(1, (performance.now() - t0) / ms)) * text.length);
    ghost.textContent = text.slice(n);
    node.replaceChildren(text.slice(0, n), ghost);
    if (n < text.length) node._raf = requestAnimationFrame(tick); else node.textContent = text;
  };
  tick();
}

// A "+ more" button and the body it opens. Open ones stay open when a view redraws.
const opened = new Set();
export function more(key, label, ...kids) {
  const body = el("div", { class: "more-body", hidden: !opened.has(key) }, ...kids);
  const btn = el("button", { class: "more", "aria-expanded": String(opened.has(key)) }, label);
  btn.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    open ? opened.add(key) : opened.delete(key);
    if (open) anim(body, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "ease-out" });
  });
  return [btn, body];
}
export const openMore = (key) => opened.add(key);

// ---------- colour ----------
export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (k) => cs.getPropertyValue(k).trim();
  return { acc: get("--acc-rgb"), ink: get("--ink-rgb"), tile: get("--tile") };
}
export const rgba = (rgb, a) => `rgba(${rgb.split(/[\s,]+/).join(",")},${a})`;
// A weight's strength as an opacity: accent above zero, ink below.
export const weightAlpha = (w, scale = 0.6) => 0.08 + 0.92 * Math.min(1, Math.abs(w) / scale) ** 0.75;

// The 169 numbers as a 13 x 13 picture, in the program's own order (pixel k = number k).
export function paintBrain(g, w, T, size = 13) {
  const c = size / 13;
  g.clearRect(0, 0, size, size);
  for (let k = 0; k < 169; k++) {
    const v = w[k];
    g.fillStyle = v === 0 ? T.tile : rgba(v > 0 ? T.acc : T.ink, weightAlpha(v));
    g.fillRect((k % 13) * c, Math.floor(k / 13) * c, c, c);
  }
}

// The rehearsal's network is the program's at day 0: its 81 learning numbers, the rest as the program
// starts them (inputs 9 and 10 at zero, the second layer a plain pass-through). 81 -> 169, same order.
export function fullBrain(w81) {
  const w = new Float64Array(169);
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) w[j * 10 + i] = w81[j * 8 + i];
    w[80 + j] = w81[64 + j];
    w[88 + j * 8 + j] = 1;
    w[160 + j] = w81[72 + j];
  }
  w[168] = w81[80];
  return w;
}
// Where each of the 81 lives among the 169.
export const FULL_INDEX = Array.from({ length: 81 }, (_, i) =>
  i < 64 ? (i >> 3) * 10 + (i & 7) : i < 72 ? 80 + (i - 64) : i < 80 ? 160 + (i - 72) : 168);
