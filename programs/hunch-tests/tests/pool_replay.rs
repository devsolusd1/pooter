//! The pool replay: graduation and the pool phase, the real program against chain.js on every tick.
//!
//! programs/tests/vectors/pool-replay.txt (written by export-vectors.mjs) runs the rehearsal pool on the
//! curve until a boundary on day 6 where the curve completes (graduating), then adopt_pool, then 7 days
//! on a DAMM v2 pool: the fee changed to 1.00% for 5 hours, a dynamic fee switched on for 5 hours, the
//! pool paused for 2 hours, liquidity added for 50 minutes, missed ticks and a missed boundary.
//!
//! The DAMM v2 accounts are built here to the shape of the pool DBC's real migration makes (the offsets
//! graduation.rs checks against Meteora's mainnet bytecode): a config naming DBC's pool authority, the pool
//! at the address DAMM v2 derives from it and the two mints, Hunch's position (33% of the migration's
//! liquidity, locked for good) and its
//! Token-2022 NFT account held by the budget. Every tick writes the pool's readings (sqrt_price, the fee
//! counters, liquidity, status, the fee fields, the volatility accumulator) and compares the forward pass,
//! the weights, the tape, and at boundaries the open call, the diary entry and the memo lines; the open
//! call after adoption and the fee fingerprint; the daily records; the final pool record.

use {
    hunch::{
        ids::{self, event},
        layout::{self, *},
        rules::phase,
    },
    hunch_tests::*,
    solana_account::Account,
    solana_address::Address,
    solana_keypair::Keypair,
    solana_signer::Signer,
    std::fs,
};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn set(env: &mut Env, a: Address, owner: Address, data: Vec<u8>) {
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(a, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
}

/// The pool's readings written into its account (the fee bytes are pool[8..80] ++ pool[484..487]).
#[allow(clippy::too_many_arguments)]
fn write_damm(d: &mut [u8], sp: u128, lp_b: u128, prot_b: u64, liquidity: u128, status: u8, fee: &[u8], vol_acc: u128, token_b: u64) {
    d[8..80].copy_from_slice(&fee[..72]);
    d[484..487].copy_from_slice(&fee[72..75]);
    wr_u128(d, damm::SQRT_PRICE, sp);
    wr_u128(d, damm::TOTAL_LP_B_FEE, lp_b);
    wr_u64(d, damm::TOTAL_PROTOCOL_B_FEE, prot_b);
    wr_u128(d, damm::LIQUIDITY, liquidity);
    d[damm::POOL_STATUS] = status;
    wr_u128(d, damm::VOLATILITY_ACCUMULATOR, vol_acc);
    wr_u64(d, damm::TOKEN_B_AMOUNT, token_b);
}

#[derive(Default)]
struct Report {
    ticks: usize,
    pool_ticks: usize,
    boundaries: usize,
    records: usize,
    same: [usize; 7],
    mismatches: Vec<String>,
    cu_pool: Vec<u64>,
    cu_pool_boundary: Vec<u64>,
    memos: Vec<String>,
}

#[test]
fn pool_replay_program_equals_chain_js_on_every_tick() {
    let path = format!("{}/../tests/vectors/pool-replay.txt", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).expect("run node hunch/scripts/export-vectors.mjs first");
    let mut env: Option<Env> = None;
    let mut rep = Report::default();
    let bad = |rep: &mut Report, m: String| {
        if rep.mismatches.len() < 30 {
            rep.mismatches.push(m);
        }
    };
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
                e.launch("good", activation, adopt);
                env = Some(e);
            }
            "miss" => {}
            "adopt" => {
                let e = env.as_mut().unwrap();
                let now: i64 = f[1].parse().unwrap();
                e.set_clock(now, f[2].parse().unwrap());
                // DBC reports the pool migrated
                let dbc_pool = e.pool().pool;
                let mut a = e.svm.get_account(&dbc_pool).unwrap();
                a.data[pool::IS_MIGRATED] = 1;
                a.data[pool::MIGRATION_PROGRESS] = pool::MIGRATION_CREATED_POOL;
                e.svm.set_account(dbc_pool, a).unwrap();
                // the DAMM v2 accounts, as DBC's migration makes them
                let mint = e.pool().mint;
                let config = Keypair::new().pubkey();
                let mut c = vec![0u8; damm_config::LEN];
                c[..8].copy_from_slice(&ids::DAMM_CONFIG_DISC);
                c[damm_config::POOL_CREATOR_AUTHORITY..damm_config::POOL_CREATOR_AUTHORITY + 32].copy_from_slice(dbc_pool_authority().as_ref());
                c[202] = 1; // config type: dynamic
                set(e, config, damm(), c);
                let pool_addr = damm_pool_address(&config, &mint, &wsol_mint());
                let nft_mint = Keypair::new().pubkey();
                let k = DammKeys {
                    pool: pool_addr,
                    config,
                    vault_a: damm_vault(&mint, &pool_addr),
                    vault_b: damm_vault(&wsol_mint(), &pool_addr),
                    position: damm_position(&nft_mint),
                    nft: damm_nft_account(&nft_mint),
                    nft_mint,
                };
                let liquidity: u128 = f[6].parse().unwrap();
                let mut p = vec![0u8; damm::LEN];
                p[..8].copy_from_slice(&ids::DAMM_POOL_DISC);
                p[damm::TOKEN_A_MINT..damm::TOKEN_A_MINT + 32].copy_from_slice(mint.as_ref());
                p[damm::TOKEN_B_MINT..damm::TOKEN_B_MINT + 32].copy_from_slice(wsol_mint().as_ref());
                p[damm::TOKEN_A_VAULT..damm::TOKEN_A_VAULT + 32].copy_from_slice(k.vault_a.as_ref());
                p[damm::TOKEN_B_VAULT..damm::TOKEN_B_VAULT + 32].copy_from_slice(k.vault_b.as_ref());
                p[damm::CREATOR..damm::CREATOR + 32].copy_from_slice(dbc_pool_authority().as_ref());
                wr_u128(&mut p, damm::SQRT_MIN_PRICE, MIN_SQRT_PRICE);
                wr_u128(&mut p, damm::SQRT_MAX_PRICE, f[11].parse().unwrap());
                wr_u128(&mut p, damm::PERMANENT_LOCK_LIQUIDITY, liquidity);
                write_damm(&mut p, f[3].parse().unwrap(), f[4].parse().unwrap(), f[5].parse().unwrap(), liquidity, f[7].parse().unwrap(), &unhex(f[8]), f[9].parse().unwrap(), f[10].parse().unwrap());
                set(e, pool_addr, damm(), p);
                let mut pos = vec![0u8; position::LEN];
                pos[..8].copy_from_slice(&ids::DAMM_POSITION_DISC);
                pos[position::POOL..position::POOL + 32].copy_from_slice(pool_addr.as_ref());
                pos[position::NFT_MINT..position::NFT_MINT + 32].copy_from_slice(nft_mint.as_ref());
                // the creator's 33% of what DBC's migration builds from the config's threshold and migration
                // price (adopt_pool's bar reads those, not the pool's counters)
                let cfg = e.data(&e.pool().config);
                let l_mig = hunch::rules::migration_liquidity(rd_u64(&cfg, config::MIGRATION_QUOTE_THRESHOLD), rd_u128(&cfg, config::MIGRATION_SQRT_PRICE)).unwrap();
                wr_u128(&mut pos, position::PERMANENT_LOCKED_LIQUIDITY, l_mig * 33 / 100);
                set(e, k.position, damm(), pos);
                let mut nft = vec![0u8; TOKEN_ACCOUNT_LEN];
                nft[0..32].copy_from_slice(nft_mint.as_ref());
                nft[32..64].copy_from_slice(e.budget.as_ref());
                wr_u64(&mut nft, 64, 1);
                nft[108] = 1; // initialized
                set(e, k.nft, token_2022(), nft);
                let r = e.adopt_pool(k);
                let r = r.unwrap_or_else(|x| panic!("adopt_pool: {:?}\n{}", x.err, x.meta.logs.join("\n")));
                println!("adopt_pool on the built pool: {} CU", hunch_cu(&r.logs).unwrap_or(0));
                let st = e.state();
                assert_eq!(st.phase, phase::POOL);
                let sig = e.signal_bytes();
                if hex(&sig[..SIGNAL_LEN]) != f[12] {
                    bad(&mut rep, format!("adopt: open call\n  got {}\n  js  {}", hex(&sig[..SIGNAL_LEN]), f[12]));
                }
                if st.adopt_fee_fp.to_string() != f[13] {
                    bad(&mut rep, format!("adopt: fee fingerprint {} vs js {}", st.adopt_fee_fp, f[13]));
                }
            }
            "tick" | "ptick" => {
                let e = env.as_mut().unwrap();
                let pool_line = f[0] == "ptick";
                let i: usize = f[1].parse().unwrap();
                let now: i64 = f[2].parse().unwrap();
                let slot: u64 = f[3].parse().unwrap();
                e.set_clock(now, slot);
                let o = if pool_line {
                    let k = e.damm_keys().pool;
                    let mut a = e.svm.get_account(&k).unwrap();
                    write_damm(
                        &mut a.data,
                        f[4].parse().unwrap(),
                        f[5].parse().unwrap(),
                        f[6].parse().unwrap(),
                        f[7].parse().unwrap(),
                        f[8].parse().unwrap(),
                        &unhex(f[9]),
                        f[10].parse().unwrap(),
                        f[11].parse().unwrap(),
                    );
                    e.svm.set_account(k, a).unwrap();
                    assert_eq!(f[12], "0");
                    13
                } else {
                    e.write_pool(f[4].parse().unwrap(), f[5].parse().unwrap(), f[6].parse().unwrap(), f[7].parse().unwrap(), f[8].parse().unwrap());
                    assert_eq!(f[9], "0");
                    10
                };
                let (want_hash, want_p, boundary) = (f[o], f[o + 1].parse::<i64>().unwrap(), f[o + 2] == "1");
                let (want_sig, want_entry, want_memo, want_memo2) = (f[o + 3], f[o + 4], f[o + 5], f[o + 6]);
                let (rec_day, want_rec, want_tape): (i64, &str, &str) = (f[o + 7].parse().unwrap(), f[o + 8], f[o + 9]);
                let ixs = vec![cu_limit(400_000), e.tick_ix()];
                let keys = e.message_keys(&ixs, &e.payer.pubkey());
                let r = match e.send_payer(&ixs) {
                    Ok(r) => r,
                    Err(err) => panic!("{} {i} at {now} failed: {:?}\n{}", f[0], err.err, err.meta.logs.join("\n")),
                };
                rep.ticks += 1;
                let cu = hunch_cu(&r.logs).unwrap_or(0);
                if pool_line {
                    rep.pool_ticks += 1;
                    if boundary { rep.cu_pool_boundary.push(cu) } else { rep.cu_pool.push(cu) }
                }
                let ev = e.events(&r, &keys);
                let bar_ev = ev.iter().find(|(k, _)| *k == event::BAR).map(|(_, d)| d.clone()).unwrap_or_default();
                let got_p = if bar_ev.len() >= 64 { i64::from_le_bytes(bar_ev[56..64].try_into().unwrap()) } else { i64::MIN };
                if got_p == want_p { rep.same[0] += 1 } else { bad(&mut rep, format!("{} {i}: p {got_p} vs js {want_p}", f[0])) }
                if sha256_hex(&e.weights_bytes()) == want_hash { rep.same[1] += 1 } else { bad(&mut rep, format!("{} {i}: weights differ", f[0])) }
                let tape = e.last_tape();
                if hex(&tape) == want_tape { rep.same[2] += 1 } else { bad(&mut rep, format!("{} {i}: tape {} vs js {want_tape}", f[0], hex(&tape))) }
                let memo_lines = memos(&r.logs);
                if boundary {
                    rep.boundaries += 1;
                    let sig = e.signal_bytes();
                    if hex(&sig[..SIGNAL_LEN]) == want_sig { rep.same[3] += 1 } else { bad(&mut rep, format!("{} {i}: open call\n  got {}\n  js  {want_sig}", f[0], hex(&sig[..SIGNAL_LEN]))) }
                    let entry = e.last_diary();
                    if hex(&entry) == want_entry { rep.same[4] += 1 } else { bad(&mut rep, format!("{} {i}: diary entry\n  got {}\n  js  {want_entry}", f[0], hex(&entry))) }
                    let m1 = memo_lines.first().cloned().unwrap_or_default();
                    let m2_ok = if want_memo2 == "-" { memo_lines.len() == 1 } else { memo_lines.get(1).map(|s| s.as_str()) == Some(want_memo2) };
                    if m1 == want_memo && m2_ok { rep.same[5] += 1 } else { bad(&mut rep, format!("{} {i}: memo\n  got {memo_lines:?}\n  js  {want_memo} / {want_memo2}", f[0])) }
                    if pool_line && (m1.contains("Meteora") || want_memo2 != "-") && rep.memos.len() < 12 {
                        rep.memos.push(memo_lines.join(" | "));
                    }
                } else if !memo_lines.is_empty() || want_sig != "-" {
                    bad(&mut rep, format!("{} {i}: memo on an ordinary tick", f[0]));
                }
                if rec_day >= 0 {
                    rep.records += 1;
                    if hex(&e.record(rec_day as usize)) == want_rec { rep.same[6] += 1 } else { bad(&mut rep, format!("{} {i}: record {rec_day} differs", f[0])) }
                }
            }
            "end" => {
                let e = env.as_ref().unwrap();
                let st = e.state();
                let want: Vec<u64> = f[2..].iter().map(|v| v.parse().unwrap()).collect();
                let got = [st.n as u64, st.hits as u64, st.rule_hits as u64, st.forfeits as u64, st.not_scored as u64];
                println!(
                    "pool record: scored {} (forfeits {}), net {}, rule {}, not scored {}; the curve's record kept: {}/{} (rule {}), forfeits {}, not scored {}",
                    st.n, st.forfeits, st.hits, st.rule_hits, st.not_scored, st.prev_hits, st.prev_n, st.prev_rule_hits, st.prev_forfeits, st.prev_not_scored
                );
                if sha256_hex(&e.weights_bytes()) != f[1] || got[..] != want[..] {
                    bad(&mut rep, format!("final record {got:?} vs js {want:?}"));
                }
            }
            other => panic!("unknown line {other}"),
        }
    }
    let s = rep.same;
    println!(
        "pool replay: ticks {} ({} on DAMM v2), boundary ticks {}, day records {}; same as chain.js: p {}/{t}, weights {}/{t}, tape {}/{t}, open call {}/{b}, diary entries {}/{b}, memos {}/{b}, records {}/{}",
        rep.ticks, rep.pool_ticks, rep.boundaries, rep.records, s[0], s[1], s[2], s[3], s[4], s[5], s[6], rep.records, t = rep.ticks, b = rep.boundaries
    );
    let mx = |v: &Vec<u64>| v.iter().copied().max().unwrap_or(0);
    println!("pool ticks: ordinary max {} CU, boundary max {} CU", mx(&rep.cu_pool), mx(&rep.cu_pool_boundary));
    for m in &rep.memos {
        println!("  memo: {m}");
    }
    for m in &rep.mismatches {
        println!("  MISMATCH {m}");
    }
    assert!(mx(&rep.cu_pool) <= 60_000 && mx(&rep.cu_pool_boundary) <= 200_000, "K4 on the pool");
    assert!(rep.mismatches.is_empty(), "the program differs from chain.js in the pool phase");
    let _ = layout::sig::PHASE;
}
