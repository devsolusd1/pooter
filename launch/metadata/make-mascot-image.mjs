// The token image with the site's mascot: the 8-bit computer (site/mascot.js, idle face, one frozen
// frame) on the site's warm charcoal, scaled by a whole number so every art pixel stays square.
// The art below was read from the mascot's own canvas at 48 x 48 (clock fixed, state idle).
// Usage: node make-mascot-image.mjs   writes image.png (1000 x 1000), the token image, and preview/mascot-96.png
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x26, 0x26, 0x24];
const PAL = {
  a: [29, 27, 24, 255], b: [210, 193, 154, 255], c: [255, 248, 231, 255], d: [238, 226, 195, 255],
  e: [16, 33, 26, 255], f: [29, 58, 43, 255], g: [220, 255, 230, 255], h: [110, 240, 154, 255],
  i: [163, 143, 106, 255], j: [0, 0, 0, 66],
};
const ART = [
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

// the art's own box, so it is centred by what is drawn, not by its 48 x 48 frame
let x0 = 48, x1 = -1, y0 = 48, y1 = -1;
ART.forEach((row, y) => [...row].forEach((ch, x) => {
  if (ch === ".") return;
  x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
}));

function render(size, scale) {
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) BG.forEach((v, k) => (px[i * 3 + k] = v));
  const ox = Math.round((size - (x1 - x0 + 1) * scale) / 2), oy = Math.round((size - (y1 - y0 + 1) * scale) / 2);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = PAL[ART[y][x]];
    if (!p) continue;
    const a = p[3] / 255;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = ((oy + (y - y0) * scale + dy) * size + ox + (x - x0) * scale + dx) * 3;
      for (let k = 0; k < 3; k++) px[i + k] = Math.round(p[k] * a + px[i + k] * (1 - a));
    }
  }
  return png(size, size, px);
}

function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

const here = new URL(".", import.meta.url);
// 42 x 45 art pixels at 15: 630 x 675, whose corners sit inside a round crop of the 1000 px square
writeFileSync(new URL("image.png", here), render(1000, 15));
mkdirSync(new URL("preview/", here), { recursive: true });
writeFileSync(new URL("preview/mascot-96.png", here), render(96, 1));
console.log(`art ${x1 - x0 + 1} x ${y1 - y0 + 1} pixels; wrote image.png (1000 px) and preview/mascot-96.png`);
