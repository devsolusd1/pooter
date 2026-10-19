//! Kill test K2: the Rust network against the JavaScript engine, bar by bar.
//!
//! The vectors come from `node hunch/scripts/export-vectors.mjs` (it runs `site/core/net.js` and
//! `site/core/chain.js`):
//! - `vectors/v0/`: the chapter-0 network (the 8-8-1 the simulation and the site replay) on the
//!   rehearsal replay and the 7 simulated coins. The version-one model pinned to chapter 0 must give the
//!   same inputs, training steps, forward passes and 81-number brain hash on every bar. These files are
//!   byte-identical to the stage-1 vectors, so chapter 0 is the stage-1 network.
//! - `vectors/v1/`: version one with chapters, inputs 9 and 10 and missed ticks, driven by the chain
//!   engine: the same bars must give the same inputs, steps, all hidden values, output and the SHA-256
//!   of all 169 weights after every bar.

use hunch_net::{call_of, chapter_of, learning_count, Bar, Model, Weights, N_WEIGHTS, N_WEIGHTS_V0, SEED};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

fn vectors_dir(sub: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors").join(sub)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn nums(tokens: &[&str]) -> Vec<i64> {
    tokens.iter().map(|t| t.parse::<i64>().unwrap_or_else(|_| panic!("bad number {t}"))).collect()
}

fn coin_files(sub: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(vectors_dir(sub))
        .expect("run node hunch/scripts/export-vectors.mjs first")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "txt") && p.file_stem().is_some_and(|s| s != "seeds"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no vector files in {sub}");
    files
}

#[derive(Default, Debug)]
struct Tally {
    coin: String,
    bars: usize,
    learns: usize,
    thinks: usize,
    hourly_calls: usize,
    calls_same: usize,
    hourly_same: usize,
    raw_same: usize,
    learn_same: usize,
    hashes_same: usize,
    fills: usize,
    mismatches: Vec<String>,
}

impl Tally {
    fn bad(&mut self, msg: String) {
        if self.mismatches.len() < 20 {
            self.mismatches.push(msg);
        } else if self.mismatches.len() == 20 {
            self.mismatches.push("...".into());
        }
    }
    fn ok(&self) -> bool {
        self.mismatches.is_empty()
            && self.calls_same == self.thinks
            && self.raw_same == self.thinks
            && self.learn_same == self.learns
            && self.hashes_same == self.bars
    }
}

/// Chapter 0 of version one against the stage-1 8-8-1 vectors.
fn run_v0(path: &PathBuf) -> Tally {
    let text = fs::read_to_string(path).unwrap();
    let mut t = Tally::default();
    let mut model: Option<Model> = None;
    let mut seen_final = false;
    for line in text.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let tok: Vec<&str> = line.split_whitespace().collect();
        match tok[0] {
            "coin" => {
                t.coin = tok[1].to_string();
                let seed: u32 = tok[9].parse().unwrap();
                assert_eq!(seed, SEED);
                model = Some(Model::new(seed));
            }
            "init" => {
                let want = nums(&tok[1..]);
                let got = model.as_ref().unwrap().weights.flat_v0();
                if want.len() != N_WEIGHTS_V0 || got.iter().zip(&want).any(|(a, b)| *a as i64 != *b) {
                    t.bad("starting weights differ".into());
                }
            }
            "b" => {
                assert_eq!(tok.len(), 33, "line shape: {line}");
                let m = model.as_mut().unwrap();
                let v = nums(&tok[1..32]);
                let (bar_t, ts, r_raw, lam) = (v[0], v[1], v[2], v[3]);
                let (xk, x) = (v[4], &v[5..13]);
                let (lk, sample, y, p_train, e_train) = (v[13], v[14], v[15], v[16], v[17]);
                let version = v[18];
                let (tk, z1, z2, p, call) = (v[19], &v[20..28], v[28], v[29], v[30]);
                let hash = tok[32];
                t.bars += 1;
                let out = m.step(&Bar { ts, ret_q: r_raw, lam: lam as u64, x9: 0, x10: 0 }, 0);
                if out.t != bar_t {
                    t.bad(format!("bar {bar_t}: index {}", out.t));
                }
                match out.x {
                    Some(gx) => {
                        if xk != 1 || gx[..8].iter().zip(x).any(|(a, b)| *a as i64 != *b) || gx[8] != 0 || gx[9] != 0 {
                            t.bad(format!("bar {bar_t}: inputs {gx:?} vs {x:?}"));
                        }
                    }
                    None if xk != 0 => t.bad(format!("bar {bar_t}: no inputs, js has {x:?}")),
                    None => {}
                }
                match out.learned {
                    Some(l) => {
                        t.learns += 1;
                        if lk == 1 && l.sample == sample && l.y as i64 == y && l.f.p == p_train && l.e == e_train {
                            t.learn_same += 1;
                        } else {
                            t.bad(format!("bar {bar_t}: learn {} {} {} {} vs js {lk} {sample} {y} {p_train} {e_train}", l.sample, l.y, l.f.p, l.e));
                        }
                    }
                    None if lk != 0 => t.bad(format!("bar {bar_t}: no learn, js learned sample {sample}")),
                    None => {}
                }
                if m.version as i64 != version {
                    t.bad(format!("bar {bar_t}: version {} vs {version}", m.version));
                }
                match out.thought {
                    Some(f) => {
                        t.thinks += 1;
                        let c = call_of(f.p) as i64;
                        let on_hour = ts % 3600 == 0;
                        t.hourly_calls += on_hour as usize;
                        if tk == 1 && c == call {
                            t.calls_same += 1;
                            t.hourly_same += on_hour as usize;
                        }
                        // the identity layer passes the first layer through unchanged
                        let identity = f.z2.iter().zip(f.h1.iter()).all(|(a, b)| a == b);
                        if tk == 1 && identity && f.z3 == z2 && f.p == p && f.z1.iter().zip(z1).all(|(a, b)| a == b) {
                            t.raw_same += 1;
                        } else {
                            t.bad(format!("bar {bar_t}: forward z1 {:?} z3 {} p {} vs js {z1:?} {z2} {p}", f.z1, f.z3, f.p));
                        }
                    }
                    None if tk != 0 => t.bad(format!("bar {bar_t}: no forward pass, js has one")),
                    None => {}
                }
                if hex(&Sha256::digest(m.weights.to_bytes_v0())) == hash {
                    t.hashes_same += 1;
                } else {
                    t.bad(format!("bar {bar_t}: 81-number hash differs"));
                }
                if !m.weights.frozen_parts_at_launch() {
                    t.bad(format!("bar {bar_t}: a frozen part moved in chapter 0"));
                }
            }
            "final" => {
                let want = nums(&tok[1..]);
                let got = model.as_ref().unwrap().weights.flat_v0();
                for (k, (a, b)) in got.iter().zip(&want).enumerate() {
                    if *a as i64 != *b {
                        t.bad(format!("final weight {k}: {a} vs js {b}"));
                    }
                }
                seen_final = true;
            }
            "finalhash" => {
                let h = hex(&Sha256::digest(model.as_ref().unwrap().weights.to_bytes_v0()));
                if h != tok[1] {
                    t.bad(format!("final hash {h} vs js {}", tok[1]));
                }
            }
            other => panic!("unknown line kind {other}"),
        }
    }
    assert!(seen_final, "{}: no final weights", path.display());
    t
}

/// Version one with chapters against the chain engine's vectors.
fn run_v1(path: &PathBuf) -> Tally {
    let text = fs::read_to_string(path).unwrap();
    let mut t = Tally::default();
    let mut m = Model::new(SEED);
    let mut seen_final = false;
    let mut launch_hour = 0i64;
    for line in text.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let tok: Vec<&str> = line.split_whitespace().collect();
        match tok[0] {
            "coin" => {
                t.coin = tok[1].to_string();
                launch_hour = tok[5].parse().unwrap();
                assert_eq!(tok[7].parse::<u32>().unwrap(), SEED);
            }
            "init" => {
                let want = nums(&tok[1..]);
                let got = m.weights.flat();
                if want.len() != N_WEIGHTS || got.iter().zip(&want).any(|(a, b)| *a as i64 != *b) {
                    t.bad("starting weights differ".into());
                }
            }
            "b" => {
                assert_eq!(tok.len(), 48, "line shape: {line}");
                let v = nums(&tok[1..47]);
                let (bar_t, ts, fills, fill_lam, ret_q, lam, x9, x10, chapter) = (v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
                let (xk, x) = (v[9], &v[10..20]);
                let (lk, sample, y, p_train, e_train, version) = (v[20], v[21], v[22], v[23], v[24], v[25]);
                let (tk, z1, z2, z3, p, call) = (v[26], &v[27..35], &v[35..43], v[43], v[44], v[45]);
                let hash = tok[47];
                t.bars += 1;
                // the chapter is a function of the hour (the program applies it at boundary ticks)
                let hours = (ts.div_euclid(3600) - launch_hour).max(0) as u32;
                if chapter as u8 > chapter_of(hours) {
                    t.bad(format!("bar {bar_t}: chapter {chapter} ahead of its date ({hours} h)"));
                }
                for k in 0..fills {
                    m.feed(&Bar { ts: ts - (fills - k) * 600, ret_q: 0, lam: fill_lam as u64, x9: 0, x10: 0 }, true);
                    t.fills += 1;
                }
                let out = m.step(&Bar { ts, ret_q, lam: lam as u64, x9: x9 as i32, x10: x10 as i32 }, chapter as u8);
                if out.t != bar_t {
                    t.bad(format!("bar {bar_t}: index {}", out.t));
                }
                match out.x {
                    Some(gx) => {
                        if xk != 1 || gx.iter().zip(x).any(|(a, b)| *a as i64 != *b) {
                            t.bad(format!("bar {bar_t}: inputs {gx:?} vs {x:?}"));
                        }
                    }
                    None if xk != 0 => t.bad(format!("bar {bar_t}: no inputs, js has {x:?}")),
                    None => {}
                }
                match out.learned {
                    Some(l) => {
                        t.learns += 1;
                        if lk == 1 && l.sample == sample && l.y as i64 == y && l.f.p == p_train && l.e == e_train {
                            t.learn_same += 1;
                        } else {
                            t.bad(format!("bar {bar_t}: learn {} {} {} {} vs js {lk} {sample} {y} {p_train} {e_train}", l.sample, l.y, l.f.p, l.e));
                        }
                    }
                    None if lk != 0 => t.bad(format!("bar {bar_t}: no learn, js learned sample {sample}")),
                    None => {}
                }
                if m.version as i64 != version {
                    t.bad(format!("bar {bar_t}: version {} vs {version}", m.version));
                }
                match out.thought {
                    Some(f) => {
                        t.thinks += 1;
                        let on_hour = ts % 3600 == 0;
                        t.hourly_calls += on_hour as usize;
                        if tk == 1 && call_of(f.p) as i64 == call {
                            t.calls_same += 1;
                            t.hourly_same += on_hour as usize;
                        }
                        let same = tk == 1
                            && f.z3 == z3
                            && f.p == p
                            && f.z1.iter().zip(z1).all(|(a, b)| a == b)
                            && f.z2.iter().zip(z2).all(|(a, b)| a == b);
                        if same {
                            t.raw_same += 1;
                        } else {
                            t.bad(format!("bar {bar_t}: forward z3 {} p {} vs js {z3} {p}", f.z3, f.p));
                        }
                    }
                    None if tk != 0 => t.bad(format!("bar {bar_t}: no forward pass, js has one")),
                    None => {}
                }
                if hex(&Sha256::digest(m.weights.to_bytes())) == hash {
                    t.hashes_same += 1;
                } else {
                    t.bad(format!("bar {bar_t}: weights hash differs"));
                }
            }
            "final" => {
                let want = nums(&tok[1..]);
                assert_eq!(want.len(), N_WEIGHTS);
                for (k, (a, b)) in m.weights.flat().iter().zip(&want).enumerate() {
                    if *a as i64 != *b {
                        t.bad(format!("final weight {k}: {a} vs js {b}"));
                    }
                }
                seen_final = true;
            }
            "finalhash" => {
                let h = hex(&Sha256::digest(m.weights.to_bytes()));
                if h != tok[1] {
                    t.bad(format!("final hash {h} vs js {}", tok[1]));
                }
            }
            other => panic!("unknown line kind {other}"),
        }
    }
    assert!(seen_final, "{}: no final weights", path.display());
    t
}

fn report(title: &str, tallies: &[Tally]) -> bool {
    println!("{title}");
    println!("coin       bars  steps  fwd  | calls same  hourly same  raw outputs same  steps same  hashes same  filled");
    let mut all_ok = true;
    for t in tallies {
        println!(
            "{:<9} {:>5}  {:>5}  {:>5} | {:>5}/{:<5}  {:>4}/{:<4}  {:>5}/{:<5}        {:>5}/{:<5}  {:>5}/{:<5}  {:>4}",
            t.coin, t.bars, t.learns, t.thinks, t.calls_same, t.thinks, t.hourly_same, t.hourly_calls, t.raw_same, t.thinks,
            t.learn_same, t.learns, t.hashes_same, t.bars, t.fills
        );
        for m in &t.mismatches {
            println!("    MISMATCH {m}");
        }
        all_ok &= t.ok();
    }
    all_ok
}

#[test]
fn k2_chapter0_is_the_stage1_network() {
    let tallies: Vec<Tally> = coin_files("v0").iter().map(run_v0).collect();
    assert!(report("chapter 0 of version one against the stage-1 8-8-1 vectors:", &tallies), "K2 FAILED: chapter 0 differs from the 8-8-1 network");
}

#[test]
fn k2_v1_matches_js_with_chapters() {
    let tallies: Vec<Tally> = coin_files("v1").iter().map(run_v1).collect();
    assert!(report("version one (chapters, inputs 9-10, missed ticks) against net.js + chain.js:", &tallies), "K2 FAILED: version one differs from net.js");
}

#[test]
fn starting_weights_match_js_for_256_seeds() {
    for (sub, len) in [("v0", N_WEIGHTS_V0), ("v1", N_WEIGHTS)] {
        let text = fs::read_to_string(vectors_dir(sub).join("seeds.txt")).expect("seeds.txt");
        let mut n = 0;
        for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
            let v = nums(&line.split_whitespace().collect::<Vec<_>>());
            let seed = v[0] as u32;
            let w = Weights::from_seed(seed);
            let got: Vec<i32> = if len == N_WEIGHTS { w.flat().to_vec() } else { w.flat_v0().to_vec() };
            assert_eq!(v.len() - 1, len);
            for (k, (a, b)) in got.iter().zip(&v[1..]).enumerate() {
                assert_eq!(*a as i64, *b, "{sub} seed {seed} weight {k}");
            }
            n += 1;
        }
        assert_eq!(n, 256);
    }
}

#[test]
fn chapters_wake_without_moving_the_call_and_free_the_right_numbers() {
    use hunch_net::ONE;
    assert_eq!((chapter_of(0), chapter_of(167), chapter_of(168), chapter_of(335), chapter_of(336), chapter_of(504)), (0, 0, 1, 1, 2, 3));
    assert_eq!((learning_count(0), learning_count(1), learning_count(2), learning_count(3)), (81, 97, 169, 169));
    // a training step whose signals reach every number: count what moved per chapter
    let x = [ONE as i32 / 2, -(ONE as i32) / 3, ONE as i32, ONE as i32 / 5, -(ONE as i32) / 7, ONE as i32 / 4, 30000, -20000, ONE as i32, -(ONE as i32) / 2];
    for chapter in 0..4u8 {
        let mut w = Weights::from_seed(SEED);
        // make every first-layer unit live and every output weight positive, so every signal is non-zero
        for j in 0..8 {
            w.b1[j] = 4 * ONE as i32;
            w.w3[j] = ONE as i32 / 2 + j as i32 * 100;
        }
        let before = w.flat();
        let p_before = w.forward(&x).p;
        // waking a chapter does not move the call: same weights, same output
        assert_eq!(w.forward(&x).p, p_before);
        w.train(&x, 0, chapter);
        let moved = before.iter().zip(w.flat().iter()).filter(|(a, b)| a != b).count();
        assert_eq!(moved, learning_count(chapter), "chapter {chapter} moved {moved} numbers");
        // chapter 0 keeps every launch freeze; chapter 1 moves inputs 9-10 but keeps layer 2 the identity
        assert_eq!(w.frozen_parts_at_launch(), chapter == 0);
        let identity = (0..8).all(|k| (0..8).all(|j| w.w2[k][j] == if j == k { ONE as i32 } else { 0 }) && w.b2[k] == 0);
        assert_eq!(identity, chapter <= 1);
    }
    // flat <-> from_flat round trip
    let w = Weights::from_seed(99);
    assert_eq!(Weights::from_flat(&w.flat()), w);
}

#[test]
fn fixed_point_edges() {
    use hunch_net::fixed::*;
    assert_eq!(log2q(0), 0);
    assert_eq!(log2q(1), 0);
    assert_eq!(log2q(2), ONE);
    assert_eq!(log2q(3), ONE + ONE / 2);
    assert_eq!(log2q(u64::MAX), 63 * ONE + (ONE - 1));
    assert_eq!(sig_q(0), 32768);
    assert_eq!(sig_q(-8 * ONE), 22);
    assert_eq!(sig_q(8 * ONE), 65514);
    assert_eq!(sig_q(i64::MIN / 4), 22);
    assert_eq!(mul_q(-1, 1), -1); // floors like JS Math.floor
    assert_eq!(div_q(-1, 3), -21845); // truncates like Math.trunc
    assert_eq!(rshr(-64, 7), 0);
    assert_eq!(rshr(64, 7), 1);
    assert_eq!(mul_q(ONE, 123_456_789), 123_456_789); // the identity layer is exact
    assert_eq!(std::mem::size_of::<Model>() % 8, 0);
    assert_eq!(std::mem::size_of::<Weights>(), 680);
}
