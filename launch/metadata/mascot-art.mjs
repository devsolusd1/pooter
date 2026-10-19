// The site's mascot (site/mascot.js), one frozen idle frame read from its own canvas at 48 x 48, and a
// small PNG writer. Shared by make-mascot-image.mjs (the token image) and scripts/make-favicon.mjs.
import { deflateSync } from "node:zlib";

export const PAL = {
  a: [29, 27, 24, 255], b: [210, 193, 154, 255], c: [255, 248, 231, 255], d: [238, 226, 195, 255],
  e: [16, 33, 26, 255], f: [29, 58, 43, 255], g: [220, 255, 230, 255], h: [110, 240, 154, 255],
  i: [163, 143, 106, 255], j: [0, 0, 0, 66],
};
export const ART = [
  "................................................",
  "................................................",
  "................................................",
  "................aaaaaaaaaaaaaaaa................",
  "...............abbbbbbbbbbbbbbbba...............",
  "..........aaaaaaaaaaaaaaaaaaaaaaaaaaaa..........",
  ".........acccccccccccccccccccccccccccca.........",
  "........acdbbbbbbbbbbbbbbbbbbbbbbbbbcdca........",
  "........acdbaaaaaaaaaaaaaaaaaaaaaaaacdba........",
  "........acdbaaeeeeeeeeeeeeeeeeeeeeaacdba........",
  "........acdbaeffeeeeeeeeeeeeeeeeeeeacdba........",
  "........acdbaefeefffeeeeeeeefffeeeeacdba........",
  "........acdbaeeefghhfeeeeeefghhfeeeacdba........",
  "........acdbaeeefhhhfeeeeeefhhhfeeeacdba........",
  "........acdbaeeefhhhfeeeeeefhhhfeeeacdba........",
  "........acdbaeeefhhhfeeeeeefhhhfeeeacdba........",
  "........acdbaeeeefffeeeeeeeefffeeeeacdba........",
  "........acdbaeeeeeeeefeeeefeeeeeeeeacdba........",
  "........acdbaeeeeeeefhffffhfeeeeeeeacdba........",
  "........acdbaeeeeeeeefhhhhfeeeeeeeeacdba........",
  "........acdbaeeeeeeeeeffffeeeeeeeeeacdba........",
  "........acdbaeeeeeeeeeeeeeeeeeeeeeeacdba........",
  "........acdbaaeeeeeeeeeeeeeeeeeeeeaacdba........",
  "........acdbaaaaaaaaaaaaaaaaaaaaaaaacdba........",
  "........acdccccccccccccccccccccccccccdba........",
  "........acddididididdddddddddddddhhdddba........",
  "........acddididididddddddddddddddddddba........",
  ".........acbbbbbbbbbbbbbbbbbbbbbbbbbbba.........",
  "..........aaaaaaaaaaaaaaaaaaaaaaaaaaaa..........",
  "....................aiiiiiia....................",
  "....................abbbbbba....................",
  "......aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa......",
  ".....acccccccccccccccccccccccccccccccccccca.....",
  ".....acddddddddddddddddddddddddddddddddddba.....",
  ".....acddidididididdddddddddaaaaaaaaaaaddba.....",
  ".....acddidididididdddddddddbbbbbbbbbbbddba.....",
  ".....acdddddddddddddddddddddiiddddddbbbddba.....",
  ".....acbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....",
  "......aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa......",
  "......jjaaajjjjjjjjjjjjjjjjjjjjjjjjjjaaajj......",
  "......aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa......",
  ".....aiiddiddiddiddiddiddiddiddiddiddiddiia.....",
  "....aiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiia....",
  "....aiddiddiddiddiddiddiddiddiddiddiddiddiia....",
  "...aiddiddiddicccccccccccccccccccciiddidddiia...",
  "...aiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiia...",
  "....aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa....",
  ".....jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj.....",
];

// the box of the drawn pixels inside rows y0..y1 (inclusive), so a crop is centred by what is drawn
export function box(top = 0, bottom = ART.length - 1) {
  let x0 = 48, x1 = -1, y0 = 48, y1 = -1;
  for (let y = top; y <= bottom; y++) [...ART[y]].forEach((ch, x) => {
    if (ch === ".") return;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  });
  return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// draws the art (rows inside b) at a whole-number scale, centred on a size x size RGBA canvas over bg
// ([r, g, b] or null for transparent)
export function render(size, scale, b = box(), bg = null) {
  const px = Buffer.alloc(size * size * 4);
  if (bg) for (let i = 0; i < size * size; i++) px.set([...bg, 255], i * 4);
  const ox = Math.round((size - b.w * scale) / 2), oy = Math.round((size - b.h * scale) / 2);
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
    const p = PAL[ART[y][x]];
    if (!p) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = ((oy + (y - b.y0) * scale + dy) * size + ox + (x - b.x0) * scale + dx) * 4;
      over(px, i, p);
    }
  }
  return px;
}

// p over the pixel at i (straight alpha)
function over(px, i, p) {
  const a = p[3] / 255, ba = px[i + 3] / 255, oa = a + ba * (1 - a);
  if (oa === 0) return;
  for (let k = 0; k < 3; k++) px[i + k] = Math.round((p[k] * a + px[i + k] * ba * (1 - a)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

// box-filter downscale of a square RGBA image by a whole factor
export function shrink(px, size, f) {
  const n = size / f, out = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let r = 0, g = 0, bl = 0, a = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const i = ((y * f + dy) * size + x * f + dx) * 4, w = px[i + 3];
      r += px[i] * w; g += px[i + 1] * w; bl += px[i + 2] * w; a += w;
    }
    const o = (y * n + x) * 4;
    if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(bl / a); }
    out[o + 3] = Math.round(a / (f * f));
  }
  return out;
}

export function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
