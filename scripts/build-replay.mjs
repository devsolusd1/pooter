// Builds hunch/site/data/replay.json: a real PumpSwap pool's 5-minute candles merged to the
// 10-minute bars Hunch would observe, exactly as hunch/sim/sim.mjs merges them (last close of the
// bar, summed quote volume, empty bars carry the previous close). Rehearsal data, not HUNCH.
// Usage: node hunch/scripts/build-replay.mjs [POOLNAME=JEANPHIL]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] || "JEANPHIL";
const src = resolve(here, `../sim/data/ohlcv_${name}.json`);
const out = resolve(here, "../site/data/replay.json");
const BAR = 600;
const SIG_FIGS = 6;

// Same merge as loadPool() in sim.mjs (with this pool's own last candle as the end).
export function mergeBars(rows, endTs = Math.floor(rows.at(-1)[0] / BAR) * BAR) {
  const start = Math.floor(rows[0][0] / BAR) * BAR;
  const nb = Math.floor((endTs - start) / BAR) + 1;
  const close = new Array(nb).fill(null), vol = new Array(nb).fill(0), trades = new Array(nb).fill(false);
  for (const [ts, , , , c, v] of rows) {
    const b = Math.floor((ts - start) / BAR);
    if (b < 0 || b >= nb) continue;
    close[b] = c; vol[b] += v; trades[b] = true; // rows ascending, so the later 5-minute close wins
  }
  let last = rows.find((r) => r[0] >= start)?.[1];
  for (let b = 0; b < nb; b++) { if (close[b] == null) close[b] = last; last = close[b]; }
  return { start, nb, close, vol, trades };
}

const sig = (v) => (v === 0 ? 0 : +v.toPrecision(SIG_FIGS));

// Pool reserves read from DexScreener's pairs API (liquidity.quote / liquidity.base) on
// 2026-10-15 at 21:25 UTC, five minutes after the window's last bar.
const END_READING = {
  JEANPHIL: { sol: 2091.3772, tokens: 27735708, price: 0.00007618, at: "2026-10-15T21:25Z", by: "DexScreener pairs API" },
};

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const j = JSON.parse(readFileSync(src, "utf8"));
  const rows = j.rows;
  const { start, nb, close, vol, trades } = mergeBars(rows);
  const iso = (s) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
  const missing5m = (rows.at(-1)[0] - rows[0][0]) / 300 + 1 - rows.length;
  const data = {
    v: 1,
    source: {
      rehearsal: true,
      note: `A real Solana pool (${j.name}/SOL on PumpSwap), replayed as a rehearsal. It is not HUNCH, and HUNCH is not live.`,
      symbol: j.name,
      quote: "SOL",
      dex: j.dex,
      pool: j.addr,
      from: iso(start),
      to: iso(start + (nb - 1) * BAR),
      days: +((nb * BAR) / 86400).toFixed(1),
      bars: nb,
      barSeconds: BAR,
      barsWithTrades: trades.filter(Boolean).length,
      candles: `${rows.length} five-minute OHLCV candles of the pool (${missing5m} missing), merged to 10-minute bars: last close of the bar, summed volume`,
      units: { close: "SOL per token", vol: "SOL traded in the bar" },
      rounding: `close and vol to ${SIG_FIGS} significant figures`,
      reserve: {
        estimate: true,
        method: "SOL reserve estimated as sqrt(k x price) on a constant-product curve; k runs from the opening (206.9M tokens, the pump.fun graduation deposit, at the first price) to a DexScreener reading of the pool at the end of the window, interpolated in log by cumulative volume (fees and liquidity adds grow k). Used only for the 1% buy cap",
        start: { tokens: 206900000, price: sig(rows[0][1]) },
        end: END_READING[name] ?? null,
      },
    },
    t0: start,
    step: BAR,
    close: close.map(sig),
    vol: vol.map(sig),
  };
  mkdirSync(dirname(out), { recursive: true });
  const text = JSON.stringify(data);
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${nb} bars ${data.source.from} -> ${data.source.to}, ${(text.length / 1024).toFixed(1)} KB`);
}
