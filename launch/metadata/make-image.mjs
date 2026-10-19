// The token's picture: the site's brain photo (views.js "Brain photo", site.css .grid.big), drawn from
// the rehearsal's latest photo of the network. 169 numbers as 13 x 13 rounded squares, pixel k =
// number k, placed by the site's own fullBrain(); blue above zero, grey below, stronger when larger;
// a faint square for a number that is exactly zero (a unit not woken yet). No text, so it suits any name.
//
//   node make-image.mjs                      writes image-brain.png and image-brain.svg here (the token image is image.png, from make-mascot-image.mjs), previews in ./preview
//   node make-image.mjs --out DIR            writes them under DIR instead (DIR/preview for the previews)
//   node make-image.mjs --zoom               also writes the preview sheet at 3x, square pixels, for close looks
//   --floor A, --empty A                     try another faint-end opacity or empty-square opacity (defaults below)
//
// No dependencies: the squares are drawn with a 1-pixel anti-aliased edge and the PNG is encoded here
// with node's zlib, so the same data always gives the same file. The previews are the 1000-pixel image
// shrunk by area averaging (close to what a browser does), at 96, 48 and 32 pixels, and cut to a circle
// (and a rounded square) on a dark and a white ground, the way terminals and screeners show avatars.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createReplay } from "../../site/core/replay.js";
import { fullBrain, weightAlpha } from "../../site/ui.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const OUT = resolve(arg("--out") ?? HERE);
const ZOOM = process.argv.includes("--zoom");

// ---------- the look ----------
const SIZE = 1000;
const WHITE = [255, 255, 255];
const ACC = [43, 68, 255];          // --acc  #2b44ff
const INK = [20, 20, 24];           // --ink  #141418
const EMPTY = +(arg("--empty") ?? 0.06);   // a zero's square: ink at this opacity (the site's small grid uses .05)
// The squares sit on a 96-pixel lattice (a 48-pixel avatar on a 2x screen): there each square is 4 pixels
// with a 1-pixel gap, on whole pixels, and the block is 64 pixels wide with 16 of white around it. That
// keeps the gaps sharp at 96 and the block's corners well inside a round crop (about 32 of 500 px spare).
const LATTICE = 96, CELL_PX = 4, GAP_PX = 1;
const RADIUS = 0.2;                 // corner radius, as a share of a square's side (site: 4 px on ~23)
// Strength as opacity: the site's weightAlpha(), then lifted at the faint end so that small numbers
// still show at 48 pixels. The order of strengths is kept; only the floor moves.
const FLOOR = +(arg("--floor") ?? 0.25);
const alphaOf = (w) => FLOOR + (1 - FLOOR) * (weightAlpha(w) - 0.08) / 0.92;

// ---------- the brain: the rehearsal's latest daily photo, as the site's Brain photo shows it ----------
const data = JSON.parse(readFileSync(join(HERE, "../../site/data/replay.json"), "utf8"));
const replay = createReplay(data);
replay.runToEnd(false);
const photo = replay.history.snapshots.at(-1);
const w = fullBrain(photo.weights);
if (w.length !== 169) throw new Error(`expected 169 numbers, got ${w.length}`);

const colorOf = (v) => v === 0 ? mix(INK, WHITE, EMPTY) : mix(v > 0 ? ACC : INK, WHITE, alphaOf(v));
function mix(c, ground, a) { return c.map((x, i) => Math.round(ground[i] * (1 - a) + x * a)); }
const hex = (c) => "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");

// ---------- geometry ----------
const unit = SIZE / LATTICE;
const cell = CELL_PX * unit, gap = GAP_PX * unit, rad = cell * RADIUS, pitch = cell + gap;
const x0 = (SIZE - (13 * pitch - gap)) / 2;
const colors = Array.from(w, colorOf);

// the 1000-pixel picture: each pixel takes the coverage of the one square it can fall in
function draw() {
  const img = new Float64Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - x0;
      const col = Math.min(12, Math.max(0, Math.floor((px + gap / 2) / pitch)));
      const row = Math.min(12, Math.max(0, Math.floor((py + gap / 2) / pitch)));
      const cx = col * pitch + cell / 2, cy = row * pitch + cell / 2;
      const a = coverage(px - cx, py - cy, cell / 2, rad);
      const c = colors[row * 13 + col], o = (y * SIZE + x) * 3;
      for (let i = 0; i < 3; i++) img[o + i] = WHITE[i] * (1 - a) + c[i] * a;
    }
  }
  return { w: SIZE, h: SIZE, px: img };
}
// share of a pixel inside a rounded square (signed distance, one-pixel ramp)
function coverage(dx, dy, half, r) {
  const qx = Math.abs(dx) - (half - r), qy = Math.abs(dy) - (half - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.min(1, Math.max(0, 0.5 - d));
}

function svg() {
  const rects = colors.map((c, k) => {
    const x = x0 + (k % 13) * pitch, y = x0 + Math.floor(k / 13) * pitch;
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${rad.toFixed(2)}" fill="${hex(c)}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">\n` +
    `<rect width="${SIZE}" height="${SIZE}" fill="#ffffff"/>\n${rects.join("\n")}\n</svg>\n`;
}

// ---------- shrinking, cropping, sheets ----------
// area-average resample (each target pixel is the mean of the source area it covers)
function shrink(src, T) {
  const S = src.w, k = S / T;
  const weights = Array.from({ length: T }, (_, i) => {
    const a = i * k, b = a + k, out = [];
    for (let s = Math.floor(a); s < Math.min(S, Math.ceil(b)); s++) out.push([s, (Math.min(b, s + 1) - Math.max(a, s)) / k]);
    return out;
  });
  const mid = new Float64Array(T * S * 3);       // rows of the source, columns shrunk
  for (let y = 0; y < S; y++) for (let i = 0; i < T; i++) for (const [s, f] of weights[i]) for (let c = 0; c < 3; c++) mid[(y * T + i) * 3 + c] += src.px[(y * S + s) * 3 + c] * f;
  const px = new Float64Array(T * T * 3);
  for (let j = 0; j < T; j++) for (const [s, f] of weights[j]) for (let i = 0; i < T; i++) for (let c = 0; c < 3; c++) px[(j * T + i) * 3 + c] += mid[(s * T + i) * 3 + c] * f;
  return { w: T, h: T, px };
}
function canvas(w, h, ground) {
  const px = new Float64Array(w * h * 3);
  for (let i = 0; i < w * h; i++) px.set(ground, i * 3);
  return { w, h, px };
}
// put `img` on `dst` at (ox, oy), cut to a circle (round) or a rounded square (corner = share of side)
function place(dst, img, ox, oy, shape = "round") {
  const n = img.w, R = n / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x + 0.5 - R, dy = y + 0.5 - R;
    const a = shape === "round" ? Math.min(1, Math.max(0, 0.5 - (Math.hypot(dx, dy) - R))) : coverage(dx, dy, R, n * shape);
    const o = ((oy + y) * dst.w + ox + x) * 3, s = (y * n + x) * 3;
    for (let c = 0; c < 3; c++) dst.px[o + c] = dst.px[o + c] * (1 - a) + img.px[s + c] * a;
  }
}
function magnify(img, k) {
  const out = canvas(img.w * k, img.h * k, [0, 0, 0]);
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
    const s = (Math.floor(y / k) * img.w + Math.floor(x / k)) * 3, o = (y * out.w + x) * 3;
    for (let c = 0; c < 3; c++) out.px[o + c] = img.px[s + c];
  }
  return out;
}

// ---------- PNG (8-bit RGB, no filter, zlib) ----------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, body) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
  len.writeUInt32BE(body.length);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
function png(img) {
  const raw = Buffer.alloc((img.w * 3 + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (img.w * 3 + 1)] = 0;
    for (let i = 0; i < img.w * 3; i++) raw[y * (img.w * 3 + 1) + 1 + i] = Math.max(0, Math.min(255, Math.round(img.px[y * img.w * 3 + i])));
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(img.w, 0); head.writeUInt32BE(img.h, 4);
  head[8] = 8; head[9] = 2; head[10] = 0; head[11] = 0; head[12] = 0;   // 8 bits, RGB, deflate, no filter, no interlace
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- write ----------
const PREVIEW = join(OUT, "preview");
mkdirSync(PREVIEW, { recursive: true });
const big = draw();
const file = png(big);
writeFileSync(join(OUT, "image-brain.png"), file);
writeFileSync(join(OUT, "image-brain.svg"), svg());
const s96 = shrink(big, 96), s48 = shrink(big, 48), s32 = shrink(big, 32);
writeFileSync(join(PREVIEW, "icon-96.png"), png(s96));
writeFileSync(join(PREVIEW, "icon-48.png"), png(s48));
// one sheet: a dark terminal row and a white row, each with round 96, 48 and 32 and a rounded-square 48
const DARK = [14, 16, 22], ROW = 120, sheet = canvas(16 + 96 + 16 + 48 + 16 + 32 + 16 + 48 + 16, ROW * 2, DARK);
for (let y = ROW; y < ROW * 2; y++) for (let x = 0; x < sheet.w; x++) sheet.px.set([246, 246, 248], (y * sheet.w + x) * 3);
for (const r of [0, 1]) {
  const top = r * ROW + (ROW - 96) / 2, mid = (n) => r * ROW + (ROW - n) / 2;
  place(sheet, s96, 16, top);
  place(sheet, s48, 128, mid(48));
  place(sheet, s32, 192, mid(32));
  place(sheet, s48, 240, mid(48), 0.22);
}
writeFileSync(join(PREVIEW, "circle-preview.png"), png(sheet));
if (ZOOM) writeFileSync(join(PREVIEW, "circle-preview@3x.png"), png(magnify(sheet, 3)));

const pos = w.filter((v) => v > 0).length, neg = w.filter((v) => v < 0).length;
console.log(`brain    day ${photo.day} photo of the rehearsal (hour ${photo.step / 6}), weights hash ${photo.hash.slice(0, 16)}...`);
console.log(`numbers  ${pos} above zero (blue), ${neg} below (grey), ${169 - pos - neg} exactly zero (faint)`);
console.log(`image    ${join(OUT, "image-brain.png")}  ${SIZE} x ${SIZE}, ${file.length} bytes, sha256 ${createHash("sha256").update(file).digest("hex")}`);
console.log(`previews ${PREVIEW}: icon-96.png, icon-48.png, circle-preview.png${ZOOM ? ", circle-preview@3x.png" : ""}`);
