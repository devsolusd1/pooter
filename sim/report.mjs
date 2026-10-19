import fs from 'node:fs';
const f = process.argv[2];
const o = JSON.parse(fs.readFileSync(f));
const ds = JSON.parse(fs.readFileSync('data/ds_pairs.json')).pairs;
const solUsd = 105.78;
const quoteRes = { HAMSTER: 62309 / solUsd, FOMO: 41130 / solUsd }; // GeckoTerminal reserve_in_usd for the DBC curves, taken as quote side (inferred)
for (const p of ds) if (p.liquidity?.quote) quoteRes[p.baseToken.symbol] = p.liquidity.quote;
const pct = v => (v == null ? '  -  ' : (v * 100).toFixed(1).padStart(5) + '%');
console.log('lrShift', o.lrShift, 'end', o.endTs);
for (const p of o.pools) {
  console.log(`\n${p.name} (${p.dex}) ${p.from.slice(0, 16)} -> ${p.to.slice(0, 16)}, ${p.days} d, bars ${p.bars}, bars with trades ${p.barsWithTrades}, raw 5m candles ${p.raw5m}, quote volume ${p.volQuoteTotal}`);
  for (const [k, t] of Object.entries(p.tasks)) {
    if (!t.n) { console.log(`  ${k.padEnd(9)} n 0`); continue; }
    const rules = Object.entries(t.rules).map(([r, q]) => `${r} ${pct(q.acc)}`).join(', ');
    console.log(`  ${k.padEnd(9)} n ${String(t.n).padStart(4)} acc ${pct(t.acc)} | majority ${pct(t.majority)} | band 50%±${(t.band * 100).toFixed(1)} | ${rules} | halves ${pct(t.firstHalf)} ${pct(t.secondHalf)} | fixed=float ${pct(t.fixedFloatAgree)}`);
  }
  const b = p.buyback; if (!b) continue;
  const Q = quoteRes[p.name];
  console.log(`  buyback: budget ${b.accrued.toFixed(1)} quote, unconditional 1h-drop ${pct(b.unconditionalDrop1h)}, quote reserve now ~${Q ? Q.toFixed(0) : '?'}`);
  for (const k of ['even', 'modelDown', 'quietMore', 'afterDrop', 'drip', 'dripQuiet', 'dripDrop']) {
    const r = b[k];
    console.log(`    ${k.padEnd(9)} buys ${String(r.buys).padStart(4)} spent ${pct(r.spentShare)} avgBuy vs VWAP ${pct(r.avgBuyVsVWAP)} vs even ${pct(r.avgBuyVsEven ?? 0)} | drop next 1h ${pct(r.dropAfter1h)} next 10m ${pct(r.dropAfter10m)} | max buy ${r.maxBuy.toFixed(2)} (${r.maxBuyHours}x avg hour) = ${Q ? pct(r.maxBuy / Q) : '?'} of reserve | push flips ${pct(r.pushFlipsToBuy)}`);
  }
}
console.log('\nAGGREGATE (excl. MONKEY)', JSON.stringify(o.aggregateExMonkey, null, 0));
// aggregate buyback across pools (mean of per-pool % vs even, and range)
const ks = ['modelDown', 'quietMore', 'afterDrop', 'drip', 'dripQuiet', 'dripDrop'];
for (const k of ks) {
  const v = o.pools.filter(p => p.buyback).map(p => p.buyback[k].avgBuyVsEven);
  const d = o.pools.filter(p => p.buyback).map(p => p.buyback[k].dropAfter1h - p.buyback.even.dropAfter1h);
  const m = o.pools.filter(p => p.buyback).map(p => p.buyback[k].pushFlipsToBuy ?? 0);
  const mx = o.pools.filter(p => p.buyback).map(p => p.buyback[k].maxBuyHours);
  const sp = o.pools.filter(p => p.buyback).map(p => p.buyback[k].spentShare);
  console.log('   maxBuy x avg hour', mx.join(' '), '| spent share', sp.map(pct).join(' '));
  console.log(k.padEnd(9), 'vs even: median', pct(v.sort((a, b) => a - b)[Math.floor(v.length / 2)]), 'range', pct(Math.min(...v)), pct(Math.max(...v)), '| better on', v.filter(x => x < 0).length, 'of', v.length, '| drop-after diff vs even mean', pct(d.reduce((a, b) => a + b, 0) / d.length), '| push flips mean', pct(m.reduce((a, b) => a + b, 0) / m.length));
}
const ev = o.pools.filter(p => p.buyback).map(p => p.buyback.even);
console.log('even: avg vs VWAP', ev.map(e => pct(e.avgBuyVsVWAP)).join(' '), '| drop after 1h', ev.map(e => pct(e.dropAfter1h)).join(' '));
console.log('unconditional drop 1h', o.pools.filter(p => p.buyback).map(p => pct(p.buyback.unconditionalDrop1h)).join(' '));
console.log('MACs total', o.opsTotalMac);
