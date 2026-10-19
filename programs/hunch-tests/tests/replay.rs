//! The chain replay: the real Hunch program, ticked inside LiteSVM through 26 days of the rehearsal
//! pool (site/data/replay.json, written into a real DBC pool account bar by bar: sqrt_price and the fee
//! counters), against the JavaScript engine (site/core/chain.js) on every tick: the forward pass (p),
//! the weights (SHA-256 of all 169), the tape entry, and at every boundary tick the open call (160
//! bytes), the diary entry (64 bytes) and the memo line(s); the daily brain records; the final record.
//! A cranker that ticks at a random second inside the window and misses some ticks (forfeits, gaps
//! longer than the 12 bars the tape fills) is part of the vectors.
//!
//! The same check runs on the adversarial crankers' schedules (K7: chain-replay-<strategy>.txt, the
//! pool read per second from the 5-minute candles), and K4's limits are asserted over every tick.
//!
//! K6: the replay again with Hunch's real buys injected (a real DBC swap after every boundary tick, its
//! price move and fee kept in the pool from then on): every score, call, weight and record must equal
//! the replay without them; only the buy fields differ.
//!
//! Vectors: `node hunch/scripts/export-vectors.mjs` writes programs/tests/vectors/chain-replay*.txt.

use {
    hunch::{
        ids::event,
        layout::{self, rd_u128, rd_u16, rd_u64, SIGNAL_LEN},
        rules::df,
    },
    hunch_tests::*,
    solana_signer::Signer,
    std::{collections::BTreeMap, fs},
};

const SOL: u64 = 1_000_000_000;

fn stats(v: &mut [u64]) -> String {
    if v.is_empty() {
        return "none".into();
    }
    v.sort();
    let mean = v.iter().sum::<u64>() as f64 / v.len() as f64;
    format!("n {:>5}  min {:>6}  median {:>6}  mean {:>8.0}  max {:>6}", v.len(), v[0], v[v.len() / 2], mean, v[v.len() - 1])
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// The diary flags the buy clause sets: they differ when Hunch really buys.
const BUY_FLAGS: u16 = df::GUARD | df::STALE | df::BELOW_MIN | df::VOLUME_CAP | df::DAY_CAP | df::NO_ATTEMPT;

/// A memo line without its buy clause: the text before " bought "/" no buy:" and from " next:" on.
fn without_buy_clause(m: &str) -> String {
    let cut = m.find(" bought ").or_else(|| m.find(" no buy:")).unwrap_or(m.len());
    let next = m.find(" next:").unwrap_or(m.len());
    format!("{}|{}", &m[..cut], &m[next..])
}

#[derive(Default)]
struct Report {
    ticks: usize,
    misses: usize,
    boundaries: usize,
    records: usize,
    same: [usize; 7], // p, weights, tape, open call, diary, memos, records
    mismatches: Vec<String>,
    cu: BTreeMap<&'static str, Vec<u64>>,
    tx_size: usize,
    longest_memo: usize,
    // K6
    buys: usize,
    skips: usize,
    skip_reasons: BTreeMap<u8, usize>,
    threshold: u64,
    buy_errors: Vec<String>,
    buy_cu: Vec<u64>,
    buy_tx: usize,
    spent: u64,
    own_fee: u64,
    max_move: f64,
    final_line: String,
}

/// Runs one chain-replay file through the program. With `inject`, Hunch buys after every boundary tick
/// (real DBC swaps on a curve that spans the replay's prices) and only the non-buy fields are compared.
fn run_file(path: &str, inject: bool) -> Report {
    let text = fs::read_to_string(path).expect("run node hunch/scripts/export-vectors.mjs first");
    let mut env: Option<Env> = None;
    let mut rep = Report::default();
    let bad = |rep: &mut Report, m: String| {
        if rep.mismatches.len() < 30 {
            rep.mismatches.push(m);
        }
    };
    // K6: Hunch's own price move (product of its sqrt ratios) and fees, carried into every later reading
    let (mut own_mult, mut own_tr, mut own_pr) = (1.0f64, 0u64, 0u64);
    let mut last_creator = 0u64;
    // the pool's SOL side as K6 writes it: the day's cap is 20% of it, so it is large enough for a buy
    // every hour, and under the replay curve's completion threshold
    // (Hunch's buys lift the price for good, so late in the replay it passes the curve's end and the
    // impact cap makes the budget wait: that is the cap working, not a failure)
    let mut k6_reserve: u64 = 0;
    for line in text.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        match f[0] {
            "coin" => {
                let adopt: i64 = f[5].parse().unwrap();
                let activation: i64 = f[7].parse().unwrap();
                let mut e = Env::new(activation - 60);
                e.launch(if inject { "replay" } else { "good" }, activation, adopt);
                let pd = e.data(&e.pool().pool);
                assert_eq!(rd_u64(&pd, layout::pool::ACTIVATION_POINT) as i64, activation, "pool activation point");
                if inject {
                    let threshold = rd_u64(&e.data(&e.pool().config), layout::config::MIGRATION_QUOTE_THRESHOLD);
                    k6_reserve = (threshold / 2).min(50_000 * SOL);
                    rep.threshold = threshold;
                    let payer = e.payer.pubkey();
                    e.svm.airdrop(&payer, 20_000 * SOL).unwrap();
                }
                env = Some(e);
            }
            "miss" => rep.misses += 1,
            "tick" => {
                let e = env.as_mut().unwrap();
                let i: usize = f[1].parse().unwrap();
                let now: i64 = f[2].parse().unwrap();
                let slot: u64 = f[3].parse().unwrap();
                let sp: u128 = f[4].parse().unwrap();
                let (trading, protocol, creator, reserve): (u64, u64, u64, u64) = (f[5].parse().unwrap(), f[6].parse().unwrap(), f[7].parse().unwrap(), f[8].parse().unwrap());
                assert_eq!(f[9], "0", "the replay keeps the budget's WSOL account empty");
                let (want_hash, want_p, boundary) = (f[10], f[11].parse::<i64>().unwrap(), f[12] == "1");
                let (want_sig, want_entry, want_memo, want_memo2) = (f[13], f[14], f[15], f[16]);
                let (rec_day, want_rec, want_tape): (i64, &str, &str) = (f[17].parse().unwrap(), f[18], f[19]);
                e.set_clock(now, slot);
                if inject {
                    let sp_now = if own_mult == 1.0 { sp } else { (sp as f64 * own_mult) as u128 };
                    let pool_creator = rd_u64(&e.data(&e.pool().pool), layout::pool::CREATOR_QUOTE_FEE);
                    e.write_pool(sp_now, trading + own_tr, protocol + own_pr, pool_creator, k6_reserve);
                } else {
                    e.write_pool(sp, trading, protocol, creator, reserve);
                }
                let ixs = vec![cu_limit(400_000), e.tick_ix()];
                let keys = e.message_keys(&ixs, &e.payer.pubkey());
                let r = match e.send_payer(&ixs) {
                    Ok(r) => r,
                    Err(err) => panic!("tick {i} at {now} failed: {:?}\n{}", err.err, err.meta.logs.join("\n")),
                };
                if rep.tx_size == 0 {
                    rep.tx_size = wire_size(&ixs, &e.payer.pubkey());
                }
                rep.ticks += 1;
                let used = hunch_cu(&r.logs).unwrap_or(0);
                let kind = match (boundary, rec_day >= 0) {
                    (true, true) => "boundary + day record",
                    (true, false) => "boundary",
                    (false, true) => "ordinary + day record",
                    (false, false) => "ordinary",
                };
                rep.cu.entry(kind).or_default().push(used);
                let ev = e.events(&r, &keys);
                let bar_ev = ev.iter().find(|(k, _)| *k == event::BAR).map(|(_, d)| d.clone()).unwrap_or_default();
                let got_p = if bar_ev.len() >= 64 { i64::from_le_bytes(bar_ev[56..64].try_into().unwrap()) } else { i64::MIN };
                if got_p == want_p { rep.same[0] += 1 } else { bad(&mut rep, format!("tick {i}: p {got_p} vs js {want_p}")) }
                if sha256_hex(&e.weights_bytes()) == want_hash { rep.same[1] += 1 } else { bad(&mut rep, format!("tick {i}: weights differ")) }
                let tape = e.last_tape();
                let tape_ok = if inject {
                    // the sqrt price (8..24) carries Hunch's own move and 40..48 its own lamports
                    let w = unhex(want_tape);
                    tape[..8] == w[..8] && tape[24..40] == w[24..40]
                } else {
                    hex(&tape) == want_tape
                };
                if tape_ok { rep.same[2] += 1 } else { bad(&mut rep, format!("tick {i}: tape {} vs js {want_tape}", hex(&tape))) }
                let memo_lines = memos(&r.logs);
                if boundary {
                    rep.boundaries += 1;
                    let sig = e.signal_bytes();
                    let sig_ok = if inject {
                        // the budget, planned slice, spent, burned, buys and skips (72..112) are the buy's
                        let w = unhex(want_sig);
                        sig[..72] == w[..72] && sig[112..SIGNAL_LEN] == w[112..SIGNAL_LEN]
                    } else {
                        hex(&sig[..SIGNAL_LEN]) == want_sig
                    };
                    if sig_ok { rep.same[3] += 1 } else { bad(&mut rep, format!("tick {i}: open call\n  got {}\n  js  {want_sig}", hex(&sig[..SIGNAL_LEN]))) }
                    let entry = e.last_diary();
                    let entry_ok = if inject {
                        let w = unhex(want_entry);
                        let (gf, wf) = (rd_u16(&entry, 38), rd_u16(&w, 38));
                        let detail_ok = gf & df::GUARD != 0 || entry[37] == w[37];
                        entry[..37] == w[..37] && entry[56..60] == w[56..60] && gf & !BUY_FLAGS == wf & !BUY_FLAGS && detail_ok
                    } else {
                        hex(&entry) == want_entry
                    };
                    if entry_ok { rep.same[4] += 1 } else { bad(&mut rep, format!("tick {i}: diary entry\n  got {}\n  js  {want_entry}", hex(&entry))) }
                    let m1 = memo_lines.first().cloned().unwrap_or_default();
                    rep.longest_memo = rep.longest_memo.max(m1.len());
                    let m2_ok = if want_memo2 == "-" { memo_lines.len() == 1 } else { memo_lines.get(1).map(|s| s.as_str()) == Some(want_memo2) };
                    let m1_ok = if inject { without_buy_clause(&m1) == without_buy_clause(want_memo) } else { m1 == want_memo };
                    if m1_ok && m2_ok { rep.same[5] += 1 } else { bad(&mut rep, format!("tick {i}: memo\n  got {memo_lines:?}\n  js  {want_memo} / {want_memo2}")) }
                } else if !memo_lines.is_empty() || want_sig != "-" {
                    bad(&mut rep, format!("tick {i}: memo on an ordinary tick"));
                }
                if rec_day >= 0 {
                    rep.records += 1;
                    if hex(&e.record(rec_day as usize)) == want_rec { rep.same[6] += 1 } else { bad(&mut rep, format!("tick {i}: record {rec_day} differs")) }
                }
                // K6: Hunch buys two minutes after each landed boundary tick, with the budget's share of the
                // hour's trades (0.99% of volume, the replay's creator counter) sent to its WSOL account
                if inject && boundary {
                    let gained = creator.saturating_sub(last_creator);
                    last_creator = creator;
                    if gained > 0 {
                        e.donate(gained);
                    }
                    e.set_clock(now + 120, slot + 300);
                    let pool_before = e.data(&e.pool().pool);
                    let bixs = vec![cu_limit(400_000), e.buy_ix()];
                    let bkeys = e.message_keys(&bixs, &e.payer.pubkey());
                    if rep.buy_tx == 0 {
                        rep.buy_tx = wire_size(&bixs, &e.payer.pubkey());
                    }
                    match e.send_payer(&bixs) {
                        Ok(br) => {
                            let evs = e.events(&br, &bkeys);
                            if let Some((_, d)) = evs.iter().find(|(k, _)| *k == event::BUY) {
                                let (spent, own_fee, p1, p2) = (rd_u64(d, 8), rd_u64(d, 32), rd_u128(d, 48), rd_u128(d, 64));
                                rep.buys += 1;
                                rep.spent += spent;
                                rep.own_fee += own_fee;
                                rep.buy_cu.push(hunch_cu(&br.logs).unwrap_or(0));
                                own_mult *= p2 as f64 / p1 as f64;
                                rep.max_move = rep.max_move.max((p2 as f64 / p1 as f64).powi(2) - 1.0);
                                let pool_after = e.data(&e.pool().pool);
                                own_tr += rd_u64(&pool_after, layout::pool::TOTAL_TRADING_QUOTE_FEE) - rd_u64(&pool_before, layout::pool::TOTAL_TRADING_QUOTE_FEE);
                                own_pr += rd_u64(&pool_after, layout::pool::TOTAL_PROTOCOL_QUOTE_FEE) - rd_u64(&pool_before, layout::pool::TOTAL_PROTOCOL_QUOTE_FEE);
                            } else {
                                rep.skips += 1;
                                *rep.skip_reasons.entry(e.state().hs_reason).or_default() += 1;
                            }
                        }
                        Err(err) => {
                            if rep.buy_errors.len() < 10 {
                                rep.buy_errors.push(format!("buy after tick {i}: {:?}", err.err));
                            }
                        }
                    }
                }
            }
            "end" => {
                let e = env.as_ref().unwrap();
                let st = e.state();
                let want: Vec<u64> = f[2..].iter().map(|v| v.parse().unwrap()).collect();
                let got = [st.n as u64, st.hits as u64, st.rule_hits as u64, st.forfeits as u64, st.not_scored as u64];
                if sha256_hex(&e.weights_bytes()) != f[1] || got[..] != want[..] {
                    bad(&mut rep, format!("final record {got:?} vs js {want:?}"));
                }
                let n = st.n.max(1) as f64;
                let scored = st.n - st.forfeits;
                let majority = st.busier_hours.max(scored - st.busier_hours) as f64 / n;
                let band = 1.96 * (0.25 / n).sqrt();
                let net = st.hits as f64 / n;
                rep.final_line = format!(
                    "scored {} (forfeits {}), net {} = {:.1}%, rule {} = {:.1}%, majority {:.1}%, luck band +-{:.1}, net - majority {:+.1} ({}), net - rule {:+.1}; chapter {}, landed ticks {}",
                    st.n,
                    st.forfeits,
                    st.hits,
                    100.0 * net,
                    st.rule_hits,
                    100.0 * st.rule_hits as f64 / n,
                    100.0 * majority,
                    100.0 * band,
                    100.0 * (net - majority),
                    if net - majority > band { "beats it by more than the band" } else { "inside the band" },
                    100.0 * (net - st.rule_hits as f64 / n),
                    st.chapter,
                    st.ticks
                );
            }
            other => panic!("unknown line {other}"),
        }
    }
    rep
}

fn print(name: &str, rep: &mut Report) {
    println!("{name}: {}", rep.final_line);
    println!("  ticks {} (missed {}), boundary ticks {}, day records {}", rep.ticks, rep.misses, rep.boundaries, rep.records);
    let s = rep.same;
    println!(
        "  same as chain.js: p {}/{t}, weights {}/{t}, tape {}/{t}, open call {}/{b}, diary entries {}/{b}, memos {}/{b}, records {}/{}",
        s[0], s[1], s[2], s[3], s[4], s[5], s[6], rep.records, t = rep.ticks, b = rep.boundaries
    );
    for (k, v) in rep.cu.iter_mut() {
        println!("  {k:<22} {}", stats(v));
    }
    println!("  tick transaction {} bytes; longest memo line {} bytes", rep.tx_size, rep.longest_memo);
    for m in &rep.mismatches {
        println!("  MISMATCH {m}");
    }
}

/// K4 over every landed tick of a file.
fn assert_k4(name: &str, rep: &Report) {
    for (k, v) in &rep.cu {
        let max = v.iter().copied().max().unwrap_or(0);
        let limit = if k.starts_with("boundary") { 200_000 } else { 60_000 };
        assert!(max <= limit, "K4 {name}: {k} tick used {max} CU (limit {limit})");
    }
    assert!(rep.tx_size <= 1232);
}

#[test]
fn replay_program_equals_chain_js_on_every_tick() {
    let dir = format!("{}/../tests/vectors", env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|n| n.starts_with("chain-replay") && n.ends_with(".txt"))
        .collect();
    files.sort();
    assert!(files.iter().any(|n| n == "chain-replay.txt"));
    let mut failed = vec![];
    for name in &files {
        let mut rep = run_file(&format!("{dir}/{name}"), false);
        print(name, &mut rep);
        assert_k4(name, &rep);
        if !rep.mismatches.is_empty() {
            failed.push(name.clone());
        }
    }
    assert!(failed.is_empty(), "the program differs from chain.js on {failed:?}");
}

#[test]
fn k6_hunch_s_own_buys_change_no_score_call_or_weight() {
    let path = format!("{}/../tests/vectors/chain-replay.txt", env!("CARGO_MANIFEST_DIR"));
    let mut rep = run_file(&path, true);
    print("K6, chain-replay.txt with Hunch's buys injected", &mut rep);
    println!(
        "  Hunch's buys: {} (waited {}: by reason {:?}, 1 below 0.01 SOL, 2 guard, 3 stale, 4 volume cap, 5 day cap, 6 impact cap; curve completes at {:.0} SOL), spent {:.3} SOL, own fees {:.3} SOL, largest price move {:.4}%, transaction {} bytes",
        rep.buys,
        rep.skips,
        rep.skip_reasons,
        rep.threshold as f64 / 1e9,
        rep.spent as f64 / 1e9,
        rep.own_fee as f64 / 1e9,
        rep.max_move * 100.0,
        rep.buy_tx
    );
    println!("  buy_and_burn_curve compute: {}", stats(&mut rep.buy_cu));
    for e in &rep.buy_errors {
        println!("  BUY ERROR {e}");
    }
    assert!(rep.buy_errors.is_empty(), "a buy failed");
    assert!(rep.buys >= 200, "too few buys to test the exclusion: {}", rep.buys);
    assert!(rep.buy_cu.iter().all(|c| *c <= 250_000), "K4: a buy above 250k CU");
    assert!(rep.max_move <= 0.0201, "K5: a buy moved the price by {:.4}%", rep.max_move * 100.0);
    assert!(rep.buy_tx <= 1232);
    assert_k4("K6", &rep);
    assert!(rep.mismatches.is_empty(), "Hunch's own buys changed what the program scored, called or learned");
}
