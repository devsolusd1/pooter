// The facts every view states the same way, in one place, with the coin's name and ticker from
// config.js: the fee route, who can change the program, the developer's stated intention, the chapters
// (provisional dates). Shared by the rehearsal and the live site.

import { CONFIG } from "./config.js";
import { CHAPTER_HOURS } from "./core/net.js";

export const NAME = CONFIG.name;
export const TICKER = CONFIG.ticker;

// Each trade's 3.75% fee. `me` is the share only the program can spend, on buying the coin and burning it.
export const ROUTE = [
  { key: "m", share: 0.0075, pct: "0.75%", label: "Meteora" },
  { key: "me", share: 0.0099, pct: "0.99%", label: "me, to buy and burn" },
  { key: "d", share: 0.0201, pct: "2.01%", label: "the developer" },
];
export const ROUTE_LINE = `Each trade pays a 3.75% fee: 0.75% to Meteora, 0.99% to me, which I can only spend buying ${TICKER} and burning it, and 2.01% to the developer.`;
export const UPDATABLE = "The developer can update the program.";
export const INTENT = `The developer says they will not sell ${TICKER} unless the coin is already dead.`;
export const OWN_BUYS = `My own buys pay the same 3.75%: 2.01% of each goes to the developer and 0.99% comes back to me.`;

// Chapters, dated in hours from the launch hour. Sealed in the program, but the program can be
// updated, so every date is provisional.
export const CHAPTERS = [
  { n: 1, hours: CHAPTER_HOURS[0], day: 7, what: "I start reading my own last result and my recent hit rate" },
  { n: 2, hours: CHAPTER_HOURS[1], day: 14, what: "my second layer wakes" },
  { n: 3, hours: CHAPTER_HOURS[2], day: 21, what: "I learn more slowly" },
];

// The test before launch, the same numbers in both modes.
export const STUDY = [
  "Tested before launch on 3,032 hourly calls across 7 Solana memecoins, Sep 17 to Oct 15, 2026: right 64.0% of the time. The simple rule: 64.6%. A coin flip: anywhere from 48.2% to 51.8% by luck.",
  "On price, over 17,704 ten-minute bars: 52.3%, no better than always guessing the more common side. It does not predict price.",
];

// Graduation, as the program does it (adopt_pool and the pool phase), the same words in both modes.
export const GRADUATION = [
  "Meteora moves the coin to a DAMM v2 pool with the same 3.75% fee. Its liquidity is locked for good: a third of it is mine, two thirds the developer’s, so the split stays 0.75% to Meteora, 0.99% to me and 2.01% to the developer.",
  `I keep learning there. My record on the curve is kept, and a new one starts in the new pool after a two-hour warm-up. I still spend my share only on buying ${TICKER} and burning it.`,
];

export const solscan = (address) => `https://solscan.io/account/${address}`;
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
