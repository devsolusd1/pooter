// The token image with the site's mascot: the 8-bit computer (site/mascot.js, idle face, one frozen
// frame, art in mascot-art.mjs) on the site's warm charcoal, scaled by a whole number so every art pixel
// stays square.
// Usage: node make-mascot-image.mjs   writes image.png (1000 x 1000), the token image, and preview/mascot-96.png
import { writeFileSync, mkdirSync } from "node:fs";
import { box, render, png } from "./mascot-art.mjs";

const BG = [0x26, 0x26, 0x24];
const here = new URL(".", import.meta.url);
const b = box();
// 42 x 45 art pixels at 15: 630 x 675, whose corners sit inside a round crop of the 1000 px square
writeFileSync(new URL("image.png", here), png(1000, 1000, render(1000, 15, b, BG)));
mkdirSync(new URL("preview/", here), { recursive: true });
writeFileSync(new URL("preview/mascot-96.png", here), png(96, 96, render(96, 1, b, BG)));
console.log(`art ${b.w} x ${b.h} pixels; wrote image.png (1000 px) and preview/mascot-96.png`);
