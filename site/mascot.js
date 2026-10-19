// The coin's mascot: a late-80s home computer drawn in 48 x 48 pixels, with its face on the screen.
// Built from design/mascot/beige-desk. On this site it never shows a made-up brain (learn plays
// "thinking" until the real 169 numbers arrive), its keys ignore typing in form fields, its bubble
// types each line out while its mouth moves, and the page gives it the coin's name and ticker.
//
//   import { createMascot } from "./mascot.js";
//   const m = createMascot(el, { name, ticker, size: 240, bubble: hostElement });
//   m.setState("busy");      idle, thinking, busy, quiet, boot, blind: stay until changed
//   m.setState("learn");     learn, hit, miss, burn: play once, then back to the lasting state
//   m.rest(text, cut?)       the line it shows when it has nothing else to say (typed in)
//   m.say(text)              a short line for a few seconds, then back to the resting line
//   m.poke(text?)            hop, press the space bar and say a line (the next of `lines` without one)
//   m.nudge(char?)           a small reaction: one of its keys goes down and it glances at them
//   m.write(ms)              types a few keys, looking down, as if writing its diary line
//   m.setBrain(w169)  m.setSize(px)  m.setLight(bool)  m.playing  m.destroy()
//
// Options: name, ticker (the name in capitals by default), size (CSS px tall, default 192; every art
// pixel is a whole number of device pixels, snapped down unless that loses more than 15% of the size,
// then up), state, keys (true by default: its keys press when the visitor types; give it to one copy
// only), lines (an array, or a function that returns one), brain (169 numbers), bubble ("above",
// "right", "auto", or an element that holds the bubble in the page's flow), light (a light page: the
// ground shadow is a little darker), clock (for tests only: a fixed clock freezes a frame).
// Nothing here follows the pointer. Under prefers-reduced-motion it holds one still pose per state and
// schedules no animation frames: it draws once on each change.

const W = 48, H = 48;          // the art
const GW = 22, GH = 14;        // the glass of its screen

const PAL = {
  O: "#1d1b18", // outline, slots
  H: "#fff8e7", // plastic, lit
  P: "#eee2c3", // plastic
  S: "#d2c19a", // plastic, shade
  D: "#a38f6a", // plastic, deep shade, pressed keys
  G: "#10211a", // glass
  g: "#1d3a2b", // glass glow, scanline
  L: "#2f8a58", // phosphor, dim
  F: "#6ef09a", // phosphor
  W: "#dcffe6", // phosphor, hot
  Y: "#ffcc4d", // coin, flame, drive light
  R: "#ff7a45", // flame, warning light
};
export const PALETTE = { ...PAL, shadow: "rgba(0,0,0,.26)" };

const u32 = (hex, a = 255) => {
  const n = parseInt(hex.slice(1), 16);
  return ((a << 24) | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
};
const COL = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, u32(v)]));
const GROUND = { dark: u32("#000000", 66), light: u32("#3b2f1a", 84) }; // ground shadow on each page

export const STATES = ["idle", "thinking", "busy", "quiet", "learn", "hit", "miss", "burn", "boot", "blind"];
const STEADY = new Set(["idle", "thinking", "busy", "quiet", "boot", "blind"]);
const ONCE = { learn: 1900, hit: 1900, miss: 2700, burn: 3800 };
const DESC = {
  idle: "waiting for the hour",
  thinking: "thinking about its call",
  busy: "calling it busier",
  quiet: "calling it quieter",
  learn: "learning: its 169 numbers flash on the screen",
  hit: "pleased: the call was right",
  miss: "the call was wrong, and it shrugs",
  burn: "a coin goes in and is burned",
  boot: "switched on, ready",
  blind: "cannot read its pool",
};

// ------------------------------------------------------------------ sprites

const rows = (s) => s.trim().split("\n").map((r) => r.trim());

// Adds a 1-pixel outline (orthogonal neighbours) round the filled cells.
function outlined(src) {
  const h = src.length + 2, w = src[0].length + 2;
  const g = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => src[y - 1]?.[x - 1] ?? "."));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (g[y][x] !== ".") continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const c = src[y - 1 + dy]?.[x - 1 + dx]; return c && c !== "."; });
    if (n) g[y][x] = "O";
  }
  return g.map((r) => r.join(""));
}

const SPR = {
  // the coin, 7 x 7, and its spin
  coin: rows(`
    ..OOO..
    .OHHYO.
    OHYYYYO
    OHYYYDO
    OYYYYDO
    .OYDDO.
    ..OOO..`),
  coinNarrow: rows(`
    .OOO.
    OHYYO
    OHYYO
    OYYDO
    OYYDO
    OYDDO
    .OOO.`),
  coinEdge: rows(`
    .O.
    OHO
    OYO
    OYO
    OYO
    ODO
    .O.`),
  coinFlat: rows(`
    .OOOOO.
    OHYYYDO
    .OOOOO.`),
  coinSlit: rows(`
    OYYYYYO`),
  z: outlined(rows(`
    HHHHH
    ...H.
    ..H..
    .H...
    HHHHH`)),
  zSmall: outlined(rows(`
    HHHH
    ..H.
    .H..
    HHHH`)),
  spark: outlined(rows(`
    .Y.
    YHY
    .Y.`)),
  sparkSmall: outlined(rows(`
    H`)),
  puff1: outlined(rows(`
    .HH.
    HHHH
    .SS.`)),
  puff2: outlined(rows(`
    ..HH..
    .HHHHH
    HHHHHH
    .SSSS.`)),
  puff3: outlined(rows(`
    .H...H
    HH..HH
    .S...S`)),
  // On the glass: a flame in three flickers.
  flame: [
    rows(`
      ...R...
      ...RR..
      ..RRR..
      ..RYRR.
      .RRYYR.
      .RYYYRR
      RRYHYYR
      RYYHHYR
      .RYYYR.`),
    rows(`
      ...R...
      ..RR...
      ..RRR..
      .RRYR..
      .RYYRR.
      RRYYYR.
      RYYHYRR
      RYHHYYR
      .RYYYR.`),
    rows(`
      .......
      ...R...
      ..RRR..
      ..RYR..
      .RRYRR.
      .RYYYR.
      RRYHYRR
      RYHHHYR
      .RYYYR.`),
  ],
  hat: rows(`
    ..F..
    .F.F.
    F...F`),
};

// 3 x 5 letters for the boot prompt, and the question mark of a blind screen.
const FONT = {
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  E: ["###", "#..", "##.", "#..", "###"],
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  "?": ["###", "..#", ".##", "...", ".#."],
};

// Keyboard: four rows of 2-pixel keys, staggered, and a space bar.
const KEYS = [];
const KEY_ROWS = [];
{
  const rowsDef = [
    { y: 41, xs: [8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38] },
    { y: 42, xs: [] },
    { y: 43, xs: [6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39] },
    { y: 44, xs: [5, 8, 11, 36, 39] },
  ];
  rowsDef.forEach((r) => {
    KEY_ROWS.push(r.xs.map((x) => { KEYS.push({ x, y: r.y, w: 2 }); return KEYS.length - 1; }));
  });
  KEYS[KEY_ROWS[3][4]].w = 3; // a wider key at the bottom right
}
const SPACE = KEYS.push({ x: 14, y: 44, w: 20 }) - 1;
const TYPE_ROWS = ["1234567890-=", "", "qwertyuiopasdfghjkl;'", "zxcvbnm,./"];

// ------------------------------------------------------------------ small helpers

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash3 = (a, b, c) => {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Which of its keys a typed key presses (-1: none).
function keyFor(k) {
  if (!k) return -1;
  const key = k.length === 1 ? k.toLowerCase() : k;
  if (key === " ") return SPACE;
  if (key === "Enter") return KEY_ROWS[2][KEY_ROWS[2].length - 1];
  if (key === "Backspace") return KEY_ROWS[0][KEY_ROWS[0].length - 1];
  if (key === "Shift") return KEY_ROWS[3][0];
  if (key.length !== 1) return -1;
  const r = TYPE_ROWS.findIndex((row) => row.includes(key));
  if (r >= 0) {
    const row = TYPE_ROWS[r], keys = KEY_ROWS[r];
    return keys[Math.round((row.indexOf(key) * (keys.length - 1)) / (row.length - 1))];
  }
  return KEY_ROWS[1].length ? KEY_ROWS[1][Math.floor(hash3(key.charCodeAt(0), 5, 1) * KEY_ROWS[1].length)] : KEY_ROWS[2][Math.floor(hash3(key.charCodeAt(0), 5, 1) * KEY_ROWS[2].length)];
}

// The real numbers in four levels of glow (strongest a tenth or so in the hottest green).
function brainLevels(w) {
  const mags = Array.from(w, (v) => Math.abs(+v || 0));
  const sorted = [...mags].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const [a, b, c] = [q(0.3), q(0.62), q(0.88)];
  return mags.map((m) => (m >= c && m > 0 ? "W" : m >= b && m > 0 ? "F" : m >= a && m > 0 ? "L" : "g"));
}

// ------------------------------------------------------------------ styles

let styled = false;
function injectStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const css = `
.bdm{position:relative;display:inline-block;vertical-align:bottom;line-height:0}
.bdm-hit{display:block;margin:0;padding:0;border:0;background:none;color:inherit;cursor:pointer;border-radius:12px;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.bdm-hit:focus-visible{outline:2px solid var(--bdm-focus,#6ef09a);outline-offset:4px}
.bdm canvas{display:block}
.bdm-say{position:absolute;left:50%;z-index:3;box-sizing:border-box;margin:0;width:max-content;max-width:min(var(--bdm-say-max,250px),calc(100vw - 32px));padding:8px 14px 9px;border:2px solid var(--bdm-say-edge,#1d1b18);border-radius:12px;background:var(--bdm-say-bg,#fff8e7);color:var(--bdm-say-ink,#1d1b18);font:var(--bdm-say-weight,500) var(--bdm-say-size,15px)/1.3 var(--bdm-say-font,inherit);letter-spacing:-.005em;text-align:center;text-wrap:balance;pointer-events:none;transform:translateX(calc(-50% + var(--bdm-shift,0px)))}
.bdm-say.bdm-flow{position:relative;left:auto;bottom:auto;transform:none;margin:0 auto;max-width:100%;pointer-events:auto}
.bdm-say.bdm-right{transform:none;text-align:left}
.bdm-tail{position:absolute;left:calc(50% - 12px - var(--bdm-shift,0px));top:100%;width:24px;height:12px;overflow:visible}
.bdm-right .bdm-tail{left:-16px;top:10px;transform:rotate(90deg)}
.bdm-tail .e{fill:var(--bdm-say-edge,#1d1b18)}.bdm-tail .f{fill:var(--bdm-say-bg,#fff8e7)}
.bdm-ghost{color:transparent}
.bdm-say[hidden]{display:none}
.bdm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;
  const s = document.createElement("style");
  s.dataset.bdm = "";
  s.textContent = css;
  document.head.append(s);
}

// ------------------------------------------------------------------ the mascot

let count = 0;

export function createMascot(container, opts = {}) {
  injectStyles();
  const name = opts.name || "Pooter";
  const ticker = opts.ticker || name.toUpperCase();
  const DEFAULT_LINES = [
    `Hi, I’m ${name}.`,
    "169 numbers. That’s my whole brain.",
    "I call activity, not price.",
    "Busier or quieter. One call an hour.",
    "I’m scored in public, next to a coin flip.",
    "A one-line rule is scored next to me.",
    "One line in my diary, every hour.",
    `A slice of every fee buys ${ticker} to burn.`,
    "My call is not a signal to trade.",
    "The developer can update my program.",
  ];
  const lineList = () => {
    const l = typeof opts.lines === "function" ? opts.lines() : opts.lines;
    return l && l.length ? l : DEFAULT_LINES;
  };
  const id = ++count;
  const clock = opts.clock || (() => performance.now()); // a fixed clock freezes a frame (for tests)
  const rand = rng(0x9e3779b1 ^ (id * 2654435761));

  // DOM
  const root = document.createElement("div");
  root.className = "bdm";
  const hit = document.createElement("button");
  hit.type = "button";
  hit.className = "bdm-hit";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  hit.append(canvas);
  const bubble = document.createElement("p");
  bubble.className = "bdm-say";
  const words = document.createElement("span");
  bubble.append(words);
  // the tail: stepped like the art, a 2 px edge round a cream fill that opens the bubble's border
  bubble.insertAdjacentHTML("beforeend", '<svg class="bdm-tail" viewBox="0 0 24 12" aria-hidden="true" shape-rendering="crispEdges">' +
    '<path class="e" d="M0 0h24v2h-2v2h-2v2h-2v2h-2v2h-2v2h-4v-2h-2v-2h-2v-2h-2v-2h-2v-2h-2z"/>' +
    '<path class="f" d="M4 0h16v4h-2v2h-2v2h-2v2h-4v-2h-2v-2h-2v-2h-2z"/></svg>');
  bubble.hidden = true;
  // short lines are read out once, whole (the bubble itself types, and is read in place)
  const sr = document.createElement("span");
  sr.className = "bdm-sr";
  sr.setAttribute("aria-live", "polite");
  const host = typeof Element !== "undefined" && opts.bubble instanceof Element ? opts.bubble : null;
  const placement = host ? "flow" : ["above", "right", "auto"].includes(opts.bubble) ? opts.bubble : "above";
  if (host) { bubble.classList.add("bdm-flow"); host.append(bubble); } else root.append(bubble);
  root.append(hit, sr);
  container.append(root);
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const octx = off.getContext("2d");
  const img = octx.createImageData(W, H);
  const buf = new Uint32Array(img.data.buffer);

  // state
  let steady = STEADY.has(opts.state) ? opts.state : "idle";
  let steadyAt = clock();
  let once = ONCE[opts.state] ? { name: opts.state, at: clock(), hold: false } : null;
  let brain = opts.brain && opts.brain.length === 169 ? brainLevels(opts.brain) : null; // never a made-up one
  let ground = opts.light ? GROUND.light : GROUND.dark;
  let blinkAt = clock() + 1200 + rand() * 2500;
  let hopAt = -1e9, nudgeAt = -1e9, pleasedUntil = 0, lookDownUntil = 0, talkUntil = 0, writeAt = 0, writeUntil = 0;
  let hover = false, pressed = false;
  const keyUntil = new Map();
  let lineIx = 0, sayTimer = 0, typeTimer = 0, stillTimer = 0, restText = "", saying = false;
  let size = opts.size || 192, k = 1, px = 1;
  let raf = 0, last = 0, visible = !document.hidden, onScreen = true, alive = true;
  const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  let still = mq.matches;

  // ---------------------------------------------------------------- drawing primitives
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c === "~" ? ground : COL[c]; };
  const rect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c); };
  const sprite = (x, y, src) => src.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] !== ".") set(x + i, y + j, r[i]); });

  // the screen is drawn into its own little grid, then glows
  const scr = new Array(GW * GH);
  const s = (x, y, c) => { if (x >= 0 && y >= 0 && x < GW && y < GH) scr[y * GW + x] = c; };
  const srect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) s(x + i, y + j, c); };
  const ssprite = (x, y, src, map) => src.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] !== ".") s(x + i, y + j, map ? map[r[i]] ?? r[i] : r[i]); });

  // rounded box with outline and simple light from the top left
  function box(x0, y0, w, h, r, fill, lit, shade) {
    const inside = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      const cx = x < r ? r - x : x > w - 1 - r ? x - (w - 1 - r) : 0;
      const cy = y < r ? r - y : y > h - 1 - r ? y - (h - 1 - r) : 0;
      return cx + cy <= r;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1);
      let c = fill;
      if (edge) c = "O";
      else if (!inside(x, y - 2) || !inside(x - 2, y)) c = lit;
      else if (!inside(x + 2, y) || !inside(x, y + 2)) c = shade;
      set(x0 + x, y0 + y, c);
    }
  }

  // ---------------------------------------------------------------- faces on the glass
  const eyes = (lx, rx, y, w, h, hiAt = "tl") => {
    srect(lx, y, w, h, "F"); srect(rx, y, w, h, "F");
    const hx = hiAt.includes("r") ? w - 1 : 0, hy = hiAt.includes("b") ? h - 1 : 0;
    s(lx + hx, y + hy, "W"); s(rx + hx, y + hy, "W");
  };
  const smile = () => { s(8, 9, "F"); s(13, 9, "F"); srect(9, 10, 4, 1, "F"); };
  const grin = () => { s(7, 8, "F"); s(14, 8, "F"); srect(8, 9, 6, 1, "F"); srect(9, 10, 4, 1, "W"); };
  const oMouth = () => { srect(10, 9, 2, 1, "F"); s(9, 10, "F"); s(12, 10, "F"); srect(10, 11, 2, 1, "F"); };
  const happyEyes = () => { ssprite(3, 3, SPR.hat); ssprite(14, 3, SPR.hat); };
  // while a line types out, the mouth opens and closes
  const talking = (now) => !still && now < talkUntil && Math.floor(now / 120) % 2 === 0;

  function faceIdle(t, now) {
    let blink = 0;
    if (!still) {
      const b = now - blinkAt;
      if (b > 0 && b < 60) blink = 1; else if (b >= 60 && b < 140) blink = 2; else if (b >= 140 && b < 200) blink = 1;
    }
    const down = now < lookDownUntil || now < writeUntil ? 1 : 0;
    if (now < pleasedUntil) { happyEyes(); talking(now) ? oMouth() : grin(); return; }
    if (blink === 2) { srect(4, 6 + down, 3, 1, "F"); srect(15, 6 + down, 3, 1, "F"); }
    else if (blink === 1) eyes(4, 15, 5 + down, 3, 2);
    else eyes(4, 15, 3 + down, 3, 4);
    talking(now) ? oMouth() : smile();
    // a scanline rolls down now and then
    if (!still) {
      const p = (t + 3000) % 6400;
      if (p < 1400) { const row = Math.floor((p / 1400) * GH); for (let x = 0; x < GW; x++) if (scr[row * GW + x] === "G") s(x, row, "g"); }
    }
  }

  function faceThinking(t) {
    eyes(5, 16, 1, 3, 3, "tr");
    const n = still ? 3 : Math.floor(t / 300) % 4;
    for (let i = 0; i < n; i++) srect(6 + i * 4, 9, 2, 2, "F");
  }

  function faceBusy(t, now) {
    if (now < pleasedUntil) { happyEyes(); } else {
      srect(3, 2, 4, 5, "F"); srect(15, 2, 4, 5, "F");
      s(3, 2, "W"); s(4, 2, "W"); s(3, 3, "W"); s(15, 2, "W"); s(16, 2, "W"); s(15, 3, "W");
    }
    const kk = still ? 99 : Math.floor((t % 1500) / 95);
    for (let i = 0; i < 5; i++) {
      const h = clamp(kk - i, 0, i + 1);
      if (!h) continue;
      srect(4 + i * 3, 13 - h, 2, h, "F");
      srect(4 + i * 3, 13 - h, 2, 1, "W");
    }
  }

  function faceQuiet(t, now) {
    if (now < pleasedUntil) { eyes(4, 15, 4, 3, 3); smile(); return; }
    srect(4, 5, 3, 1, "L"); srect(15, 5, 3, 1, "L");
    srect(4, 6, 3, 1, "F"); srect(15, 6, 3, 1, "F");
    s(9, 9, "F"); s(12, 9, "F"); srect(10, 10, 2, 1, "F");
  }

  // its real numbers, wiped in row by row (only ever the numbers the page gave it)
  function faceLearn(t) {
    if (!still && (t < 90 || (t >= 1480 && t < 1560))) { srect(0, 0, GW, GH, "W"); return; }
    if (t >= 1560 && !still) { happyEyes(); smile(); return; }
    const reveal = still ? 13 : Math.floor((t - 90) / 32);
    for (let i = 0; i < 169; i++) {
      const x = i % 13, y = (i / 13) | 0;
      if (y > reveal) continue;
      let c = brain[i];
      if (!still && t > 600 && hash3(i, Math.floor(t / 140), id) < 0.05) c = c === "W" ? "F" : c === "g" ? "L" : "W";
      s(4 + x, y, y === reveal && !still ? "W" : c);
    }
  }

  function faceHit() {
    happyEyes(); grin();
  }

  function faceMiss(t) {
    if (still || t < 1700) {
      eyes(3, 14, 4, 3, 3);
      const ph = still ? 0 : Math.floor(t / 150) % 2;
      for (let i = 0; i < 8; i++) s(7 + i, 9 + ((i + ph) % 2), "F");
      if (!still) { const dy = clamp(Math.floor(t / 260), 0, 5); s(19, 1 + dy, "W"); s(19, 2 + dy, "L"); }
      else { s(19, 3, "W"); s(19, 4, "L"); }
    } else if (t < 2250) {
      srect(4, 5, 3, 1, "F"); srect(15, 5, 3, 1, "F");
      srect(8, 10, 6, 1, "F");
    } else { eyes(4, 15, 3, 3, 4); smile(); }
  }

  function faceBurn(t) {
    if (still) { ssprite(7, 3, SPR.flame[0]); return; }
    if (t < 1180) {
      eyes(5, 16, 5, 3, 3, "br");     // watching the coin come down beside it
      srect(10, 10, 2, 2, "F");
    } else if (t < 1500) {
      ssprite(4, 4, [".F.", "F.F"]); ssprite(15, 4, [".F.", "F.F"]); smile();
    } else if (t < 2950) {
      ssprite(7, 3, SPR.flame[Math.floor(t / 110) % 3]);
    } else { happyEyes(); smile(); }
  }

  // warm-up, then READY typed a letter at a time (each letter presses its key), then a cursor
  function faceBoot(t) {
    if (!still && t < 260) { srect(10, 6, 2, 2, "W"); return; }
    if (!still && t < 520) { const hw = Math.ceil(((t - 260) / 260) * 11); srect(11 - hw, 6, hw * 2, 2, "W"); return; }
    if (!still && t < 640) { srect(0, 0, GW, GH, "L"); return; }
    const n = still ? 5 : clamp(Math.floor((t - 640) / 150) + 1, 0, 5);
    let x = 2;
    for (const ch of "READY".slice(0, n)) { ssprite(x, 2, FONT[ch], { "#": "F" }); x += 4; }
    if (n < 5) srect(x, 2, 3, 5, "L");
    else if (still || Math.floor((t - 1390) / 530) % 2 === 0) srect(2, 8, 3, 5, "F");
  }

  // dim static only, with a rolling band, and a question mark now and then
  function faceBlind(t) {
    const f = still ? 3 : Math.floor(t / 70);
    const band = still ? 4 : (Math.floor(t / 55) % (GH + 6)) - 3;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      let r = hash3(x, y, f + id * 977);
      if (y >= band && y < band + 2) r = Math.min(0.999, r + 0.3);
      s(x, y, r < 0.5 ? "G" : r < 0.84 ? "g" : "L");
    }
    const c = still ? 1200 : t % 2600;
    if (c > 900 && c < 1800) {
      srect(7, 1, 8, 12, "G");
      FONT["?"].forEach((r, j) => { for (let i = 0; i < 3; i++) if (r[i] === "#") srect(8 + i * 2, 2 + j * 2, 2, 2, "F"); });
    }
  }

  // ---------------------------------------------------------------- one frame
  function render(now) {
    buf.fill(0);
    const cur = once ? once.name : steady;
    const face = cur === "learn" && !brain ? "thinking" : cur; // no numbers yet: it thinks instead
    const t = once ? (now - once.at) % (ONCE[once.name] + (once.hold ? 900 : 0)) : now - steadyAt;

    // where the head sits
    let dy = 0, dx = 0;
    if (!still) {
      if (cur === "idle" || cur === "thinking") dy = ((now - steadyAt) % 3600) > 1900 ? 1 : 0;
      if (cur === "busy") dy = -1;
      if (cur === "quiet") dy = ((now - steadyAt) % 5200) > 2600 ? 2 : 1;
      if (cur === "miss" && t >= 1700 && t < 2160) dx = [-1, 1, -1, 1, 0][Math.floor((t - 1700) / 92)] ?? 0;
      const hops = [-1, -2, -3, -3, -2, -1, 0, 1, 0];
      const hopT = cur === "hit" && t < 460 ? t : now - hopAt;
      if (hopT >= 0 && hopT < 450) dy += hops[Math.floor(hopT / 50)];
      const nt = now - nudgeAt;
      if (nt >= 0 && nt < 240) dy += [1, 0, -1, 0][Math.floor(nt / 60)];
      if (hover) dy -= 1;
      if (pressed) dy += 1;
    } else if (cur === "quiet") dy = 1;
    const mx = 8 + dx, my = 5 + dy;

    // ground shadows
    rect(6, 39, 36, 1, "~");
    rect(5, 47, 38, 1, "~");

    // a puff of smoke rises from behind the screen
    if (cur === "burn") {
      const a = still ? 700 : t - 2100;
      const path = [[35, 8, "puff1"], [37, 6, "puff1"], [39, 3, "puff2"], [40, 0, "puff2"], [40, -2, "puff3"], [41, -4, "puff3"]];
      const f = Math.floor(a / 230);
      if (a >= 0 && f < path.length) sprite(path[f][0], path[f][1], SPR[path[f][2]]);
    }

    // base unit, on two little feet
    rect(8, 39, 3, 1, "O"); rect(37, 39, 3, 1, "O");
    box(5, 31, 38, 8, 1, "P", "H", "S");
    for (const x of [9, 11, 13, 15, 17]) rect(x, 34, 1, 2, "D");   // vents
    rect(28, 34, 11, 1, "O");                  // disk slot
    rect(28, 35, 11, 1, "S");
    // the drive light blinks gold from the moment the coin goes in until the flame dies down
    const driveOn = (cur === "burn" && (still || (t > 1180 && t < 2950 && Math.floor(t / 110) % 2 === 0)))
      || (face === "thinking" && !still && hash3(Math.floor(t / 120), 3, id) < 0.4);
    rect(28, 36, 2, 1, driveOn ? "Y" : "D");   // drive light
    rect(36, 36, 3, 1, "S");                    // eject

    // neck
    rect(20, 28, 8, 1, "O");
    rect(20, 29, 1, 2, "O"); rect(27, 29, 1, 2, "O");
    rect(21, 29, 6, 1, "D"); rect(21, 30, 6, 1, "S");

    // keyboard
    rect(6, 40, 36, 1, "O");
    set(5, 41, "O"); set(42, 41, "O"); rect(6, 41, 36, 1, "D");
    set(4, 42, "O"); set(43, 42, "O"); rect(5, 42, 38, 1, "D");
    set(4, 43, "O"); set(43, 43, "O"); rect(5, 43, 38, 1, "D");
    set(3, 44, "O"); set(44, 44, "O"); rect(4, 44, 40, 1, "D");
    set(3, 45, "O"); set(44, 45, "O"); rect(4, 45, 40, 1, "D");
    rect(4, 46, 40, 1, "O");
    const down = new Set();
    for (const [ix, until] of keyUntil) { if (now < until) down.add(ix); else keyUntil.delete(ix); }
    if (!still) {
      if (face === "thinking") {
        const step = Math.floor(t / 170);
        if (t % 170 < 110) down.add(Math.floor(hash3(step, 11, id) * (KEYS.length - 1)));
      }
      if (cur === "boot") for (let i = 0; i < 5; i++) { const a = t - 640 - i * 150; if (a >= 0 && a < 90) down.add(keyFor("ready"[i])); }
      if (now < writeUntil) {
        const a = now - writeAt, step = Math.floor(a / 150);
        if (a % 150 < 95) down.add(Math.floor(hash3(step, 17, id) * (KEYS.length - 1)));
      }
    }
    // at 2 screen pixels per art pixel or less a one-pixel key press reads as texture: skip it
    const showPress = px > 2;
    KEYS.forEach((kk, ix) => rect(kk.x, kk.y, kk.w, 1, showPress && down.has(ix) ? "S" : ix === SPACE ? "H" : "P"));

    // monitor: the back of the tube shows above, low and in shade, then the front
    box(mx + 6, my - 2, 20, 5, 2, "D", "S", "D");
    box(mx, my, 32, 24, 2, "P", "H", "S");
    rect(mx + 3, my + 2, 26, 1, "S");           // recess, top
    rect(mx + 3, my + 2, 1, 17, "S");           // recess, left
    rect(mx + 3, my + 19, 26, 1, "H");          // recess, bottom lip
    rect(mx + 28, my + 2, 1, 18, "H");          // recess, right
    rect(mx + 4, my + 3, 24, 16, "O");          // screen frame
    for (const x of [4, 6, 8, 10]) rect(mx + x, my + 20, 1, 2, "D");   // grille
    // power light
    let led = "F";
    if (!still) {
      if (face === "thinking") led = Math.floor(t / 260) % 2 ? "L" : "F";
      if (cur === "busy") led = Math.floor(t / 170) % 2 ? "W" : "F";
      if (cur === "quiet") led = Math.floor(t / 1300) % 2 ? "L" : "F";
      if (face === "learn") led = "W";
      if (cur === "blind") led = Math.floor(t / 600) % 2 ? "D" : "R";
    } else if (cur === "blind") led = "R";
    rect(mx + 25, my + 20, 2, 1, led);

    // the glass
    scr.fill("G");
    ({ idle: faceIdle, thinking: faceThinking, busy: faceBusy, quiet: faceQuiet, learn: faceLearn, hit: faceHit,
      miss: faceMiss, burn: faceBurn, boot: faceBoot, blind: faceBlind })[face](t, now);
    // glow: dark glass next to a lit pixel warms up a little
    if (cur !== "blind") {
      const lit = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && "FWYRH".includes(scr[y * GW + x]);
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        if (scr[y * GW + x] === "G" && (lit(x - 1, y) || lit(x + 1, y) || lit(x, y - 1) || lit(x, y + 1))) scr[y * GW + x] = "g";
      }
    }
    // a glint on the curved glass
    if (scr[1 * GW + 1] === "G") scr[1 * GW + 1] = "g";
    if (scr[1 * GW + 2] === "G") scr[1 * GW + 2] = "g";
    if (scr[2 * GW + 1] === "G") scr[2 * GW + 1] = "g";
    const gx = mx + 5, gy = my + 4;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) set(gx + x, gy + y, scr[y * GW + x]);
    for (const [x, y] of [[0, 0], [GW - 1, 0], [0, GH - 1], [GW - 1, GH - 1]]) set(gx + x, gy + y, "O");

    // things in front
    if (cur === "burn") drawCoin(t);
    if (cur === "quiet") drawZs(now - steadyAt);
    if (cur === "hit" && (still || t < 1500)) {
      const on = still || Math.floor(t / 180) % 2 === 0;
      sprite(1, 7, on ? SPR.spark : SPR.sparkSmall);
      sprite(41, 3, on ? SPR.sparkSmall : SPR.spark);
    }

    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, W * k, H * k);
  }

  // a 7 x 7 coin falls beside the screen, slides slowly along the box and goes into the disk slot
  function drawCoin(t) {
    if (still) { sprite(31, 33, SPR.coinFlat); return; }
    if (t < 700) {
      const p = t / 700, y = Math.round(4 + 26 * p * p);
      const spin = [SPR.coin, SPR.coinNarrow, SPR.coinEdge, SPR.coinNarrow][Math.floor(t / 100) % 4];
      sprite(44 - ((spin[0].length / 2) | 0), y, spin);
    } else if (t < 1180) {
      sprite(41 - Math.floor((t - 700) / 48), 30, SPR.coin);
    } else if (t < 1300) sprite(31, 30, SPR.coin);
    else if (t < 1380) sprite(31, 33, SPR.coinFlat);
    else if (t < 1450) sprite(31, 34, SPR.coinSlit);
  }

  function drawZs(t) {
    if (still) { sprite(40, 7, SPR.z); sprite(42, 0, SPR.zSmall); return; }
    const a = t % 2100;
    if (a < 1900) sprite(40 + Math.floor(a / 700), 11 - Math.floor(a / 210), a < 700 ? SPR.zSmall : SPR.z);
  }

  // ---------------------------------------------------------------- loop
  function frame() {
    raf = 0;
    const now = clock();
    if (!alive) return;
    if (once && !once.hold && now - once.at >= ONCE[once.name]) { once = null; updateLabel(); }
    if (now - blinkAt > 220) blinkAt = now + 2600 + rand() * 3400;
    if (now - last >= 55) { last = now; render(now); }
    schedule();
  }
  function schedule() {
    if (!raf && alive && !still && visible && onScreen) raf = requestAnimationFrame(frame);
  }
  // reduced motion: draw on change only, and once more when a one-shot state ends
  function redraw() {
    if (!still) { last = 0; schedule(); return; }
    const now = clock();
    if (once && !once.hold && now - once.at >= ONCE[once.name]) { once = null; updateLabel(); }
    render(now);
    clearTimeout(stillTimer);
    const ends = [once && !once.hold ? once.at + ONCE[once.name] : 0, pleasedUntil].filter((v) => v > now);
    if (ends.length) stillTimer = setTimeout(redraw, Math.min(...ends) - now + 20);
  }

  // ---------------------------------------------------------------- size
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const exact = (size * dpr) / H;
    let kk = Math.floor(exact + 0.01);
    if (kk < 1 || kk < exact * 0.85) kk = Math.ceil(exact - 0.01); // snapping down would lose too much
    k = Math.max(1, kk);
    px = k / dpr;
    canvas.width = W * k; canvas.height = H * k;
    canvas.style.width = canvas.style.height = `${W * px}px`;
    last = 0;
    place();
    if (still || !raf) render(clock());
  }

  // ---------------------------------------------------------------- the bubble
  // above the head (kept inside the viewport), to the right of it, or in the page's flow
  function place() {
    if (host) return;
    let mode = placement;
    if (mode === "auto") mode = window.innerWidth - root.getBoundingClientRect().right > 260 ? "right" : "above";
    bubble.classList.toggle("bdm-right", mode === "right");
    bubble.style.setProperty("--bdm-shift", "0px");
    if (mode === "right") {
      bubble.style.left = `${(W - 6) * px + 16}px`;
      bubble.style.top = `${4 * px}px`;
      bubble.style.bottom = "";
      return;
    }
    bubble.style.left = "50%";
    bubble.style.top = "";
    bubble.style.bottom = `${(H - 1) * px + 12}px`;
    if (bubble.hidden) return;
    const r = bubble.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    const shift = r.left < 10 ? 10 - r.left : r.right > vw - 10 ? vw - 10 - r.right : 0;
    bubble.style.setProperty("--bdm-shift", `${Math.round(shift)}px`);
  }

  // Types a line in. The rest of the line is laid out unseen from the start, so the bubble has its
  // full size at once and nothing moves while it types.
  function show(text, typed) {
    clearTimeout(typeTimer);
    bubble.hidden = !text;
    if (!text) { talkUntil = 0; return; }
    if (still || !typed) { words.replaceChildren(text); talkUntil = 0; place(); return; }
    const per = clamp(1300 / text.length, 12, 30), t0 = performance.now();
    const seen = document.createTextNode(""), ghost = document.createElement("span");
    ghost.className = "bdm-ghost";
    ghost.textContent = text;
    words.replaceChildren(seen, ghost);
    place();
    talkUntil = clock() + per * text.length;
    const step = () => {
      const n = Math.min(text.length, Math.ceil((performance.now() - t0) / per));
      if (n >= text.length) { words.replaceChildren(text); return; }
      seen.data = text.slice(0, n);
      ghost.textContent = text.slice(n);
      typeTimer = setTimeout(step, 24);
    };
    step();
    schedule();
  }
  function pop() {
    if (still || typeof bubble.animate !== "function") return;
    try { bubble.animate([{ scale: "0.94" }, { scale: "1" }], { duration: 150, easing: "steps(3, end)" }); } catch {}
  }
  // the line it rests on (the page's line for what is open); `cut` drops a short line still showing
  function rest(text, cut = false) {
    restText = text || "";
    if (cut && saying) { saying = false; clearTimeout(sayTimer); }
    if (!saying) show(restText, true);
  }
  // a short line for a while, then back to the resting line
  function say(text, ms) {
    if (!text) return;
    saying = true;
    show(text, true);
    pop();
    sr.textContent = text;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { saying = false; show(restText, false); }, ms ?? clamp(1800 + text.length * 55, 2800, 5600));
  }
  function nextLine() { const L = lineList(); const l = L[lineIx % L.length]; lineIx++; return l; }

  function press(ix, ms = 140) { if (ix >= 0) keyUntil.set(ix, clock() + ms); }

  function poke(text) {
    const now = clock();
    if (!still) { hopAt = now; press(SPACE, 180); }
    if (steady !== "blind" && steady !== "boot" && !once) pleasedUntil = now + 900;
    say(text || nextLine());
    redraw();
  }
  function nudge(ch) {
    const now = clock();
    if (!still) { nudgeAt = now; press(ch ? keyFor(ch) : Math.floor(rand() * KEYS.length), 160); lookDownUntil = now + 650; }
    redraw();
  }
  function write(ms = 1300) {
    if (still) return;
    writeAt = clock(); writeUntil = writeAt + ms;
    schedule();
  }

  // A one-shot state plays over the current one. A lasting state set during a one-shot waits for it to
  // finish (so "learn" then "busy" plays in order), unless { now: true }; a held one-shot always gives way.
  function setState(st, o = {}) {
    if (!STATES.includes(st)) return;
    const now = clock();
    if (ONCE[st]) once = { name: st, at: now, hold: !!o.hold };
    else {
      const clears = once && (once.hold || o.now);
      if (st === steady && !o.restart && !clears) return; // nothing changes: keep its face as it is
      if (st !== steady || o.restart) { steady = st; steadyAt = now; }
      if (clears) once = null;
    }
    pleasedUntil = 0;
    updateLabel();
    redraw();
  }

  function updateLabel() {
    let cur = once ? once.name : steady;
    if (cur === "learn" && !brain) cur = "thinking";
    hit.setAttribute("aria-label", `${name}, a little beige computer, ${DESC[cur]}. Press to hear a line.`);
  }

  // ---------------------------------------------------------------- events
  const onClick = () => poke();
  const onDown = (e) => { if (e.button === 0 || e.pointerType === "touch") { pressed = true; redraw(); } };
  const onUp = () => { if (pressed) { pressed = false; redraw(); } };
  const onEnter = (e) => { if (e.pointerType === "mouse") { hover = true; redraw(); } };
  const onLeave = () => { hover = false; pressed = false; redraw(); };
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || still) return;
    // typing into a form field is not typing at it
    const tg = e.target, tag = tg && tg.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (tg && tg.isContentEditable)) return;
    const ix = keyFor(e.key);
    if (ix < 0) return;
    press(ix);
    lookDownUntil = clock() + 700;
    schedule();
  };
  const onVis = () => { visible = !document.hidden; if (visible) schedule(); };
  const onMotion = () => { still = mq.matches; if (still) { cancelAnimationFrame(raf); raf = 0; } redraw(); };
  const onResize = () => layout();

  hit.addEventListener("click", onClick);
  hit.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  hit.addEventListener("pointerenter", onEnter);
  hit.addEventListener("pointerleave", onLeave);
  const listens = opts.keys !== false;
  if (listens) window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVis);
  mq.addEventListener?.("change", onMotion);
  window.addEventListener("resize", onResize);
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => {
    onScreen = es.some((e) => e.isIntersecting);
    if (onScreen) schedule();
  }) : null;
  io?.observe(root);

  updateLabel();
  layout();
  schedule();

  return {
    get state() { return once ? once.name : steady; },
    // a one-shot state is still playing
    get playing() { return !!once && (once.hold || clock() - once.at < ONCE[once.name]); },
    setState,
    rest,
    say,
    poke,
    nudge,
    write,
    setBrain(w) { if (w && w.length === 169) { brain = brainLevels(w); if (state() === "learn") redraw(); } },
    setSize(v) { if (v !== size) { size = v; layout(); } },
    setLight(v) { ground = v ? GROUND.light : GROUND.dark; redraw(); },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      clearTimeout(sayTimer); clearTimeout(stillTimer); clearTimeout(typeTimer);
      hit.removeEventListener("click", onClick);
      hit.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      hit.removeEventListener("pointerenter", onEnter);
      hit.removeEventListener("pointerleave", onLeave);
      if (listens) window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      mq.removeEventListener?.("change", onMotion);
      window.removeEventListener("resize", onResize);
      io?.disconnect();
      bubble.remove();
      root.remove();
    },
  };
  function state() { return once ? once.name : steady; }
}
