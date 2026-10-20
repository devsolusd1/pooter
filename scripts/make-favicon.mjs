// The site's tab icons, drawn from the mascot's own pixels (launch/metadata/mascot-art.mjs):
//   site/favicon.svg         the monitor with its face, one rect per run of pixels (sharp at any size)
//   site/favicon.ico         16 and 32 px (the monitor) and 48 px (the whole computer), transparent
//   site/apple-touch-icon.png  180 px, the whole computer on the site's charcoal (iOS needs it opaque)
//   site/og.png              1200 x 630, the link preview on X and elsewhere (the whole computer on charcoal)
// Usage: node scripts/make-favicon.mjs
import { writeFileSync } from "node:fs";
import { ART, PAL, box, render, shrink, png } from "../launch/metadata/mascot-art.mjs";

const site = new URL("../site/", import.meta.url);
const BG = [0x26, 0x26, 0x24];
const monitor = box(3, 28);  // the monitor alone: rows 3 to 28 of the art (32 x 26)
const whole = box();         // the whole computer (42 x 45)

// SVG: the monitor centred in a square, horizontal runs of one colour merged into one rect
const side = Math.max(monitor.w, monitor.h), ox = (side - monitor.w) / 2, oy = (side - monitor.h) / 2;
const rects = [];
for (let y = monitor.y0; y <= monitor.y1; y++) {
  for (let x = monitor.x0; x <= monitor.x1;) {
    const ch = ART[y][x];
    let end = x;
    while (end + 1 <= monitor.x1 && ART[y][end + 1] === ch) end++;
    const p = PAL[ch];
    if (p) {
      const fill = "#" + p.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
      const op = p[3] < 255 ? ` fill-opacity="${(p[3] / 255).toFixed(2)}"` : "";
      rects.push(`<rect x="${x - monitor.x0 + ox}" y="${y - monitor.y0 + oy}" width="${end - x + 1}" height="1" fill="${fill}"${op}/>`);
    }
    x = end + 1;
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">${rects.join("")}</svg>\n`;
writeFileSync(new URL("favicon.svg", site), svg);

// ICO holding three PNGs
const m32 = render(32, 1, monitor);
const images = [
  [16, png(16, 16, shrink(m32, 32, 2))],
  [32, png(32, 32, m32)],
  [48, png(48, 48, render(48, 1, whole))],
];
const head = Buffer.alloc(6 + 16 * images.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
let offset = head.length;
images.forEach(([s, data], i) => {
  const e = 6 + 16 * i;
  head[e] = s; head[e + 1] = s; head[e + 2] = 0; head[e + 3] = 0;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
writeFileSync(new URL("favicon.ico", site), Buffer.concat([head, ...images.map(([, d]) => d)]));

// Apple touch icon: the whole computer at 3x on charcoal
writeFileSync(new URL("apple-touch-icon.png", site), png(180, 180, render(180, 3, whole, BG)));

// Link preview: the whole computer at 11x (462 x 495) on charcoal
writeFileSync(new URL("og.png", site), png(1200, 630, render(1200, 11, whole, BG, 630)));

console.log(`favicon.svg ${svg.length} bytes (${rects.length} rects), favicon.ico ${offset} bytes (16, 32, 48), apple-touch-icon.png 180 px, og.png 1200 x 630`);
