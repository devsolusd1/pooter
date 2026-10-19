//! tick, scoring and the accounts around them, against Meteora DBC's real bytecode: the 30-second
//! window, once per bar, the opening schedule, top level and alone, foreign accounts, forfeits, blind
//! mode, the CPI scan (K5); initialize, load_brain, adopt_curve's checks, read_call by CPI and the
//! brain book's growth.

use {
    hunch::{
        ids::{err, tag, CLAIM_CREATOR_TRADING_FEE2, SWAP2},
        layout::*,
        rules::{self, df, outcome, phase},
    },
    hunch_net::{Weights, ONE, SEED},
    hunch_tests::*,
    solana_address::Address,
    solana_keypair::Keypair,
    solana_signer::Signer,
    std::collections::BTreeSet,
};

const H0: i64 = 1_790_002_800; // a UTC hour start
const SOL: u64 = 1_000_000_000;
const BAR: i64 = 600;

fn code<T>(r: Result<T, litesvm::types::FailedTransactionMetadata>) -> Option<u32> {
    r.err().and_then(|e| custom_code(&e))
}
fn ix_error<T>(r: Result<T, litesvm::types::FailedTransactionMetadata>) -> Option<solana_instruction_error::InstructionError> {
    match r.err().map(|e| e.err) {
        Some(solana_transaction_error::TransactionError::InstructionError(_, ie)) => Some(ie),
        _ => None,
    }
}

fn launched() -> Env {
    let mut env = Env::new(H0 - 500);
    env.launch("good", H0 - 400, H0 - 300);
    env
}

/// Bar `b`: a round trip of `churn` lamports scaled by a pattern (so no two hours tie), then the tick.
fn bar(env: &mut Env, t: &Keypair, b: i64, churn: u64) {
    if churn > 0 {
        env.set_clock(H0 + b * BAR - 300, 0);
        env.churn(t, churn / 4 * (1 + ((b * 7 + b / 6 * 3) % 11) as u64));
    }
    env.tick_at(H0 + b * BAR + 1).unwrap_or_else(|e| panic!("tick bar {b}: {:?}\n{}", e.err, e.meta.logs.join("\n")));
}

#[test]
fn tick_window_once_per_bar_top_level_and_alone() {
    let mut env = launched();
    // second 30 of a bar: refused; second 29: accepted; again in the same bar: refused
    assert_eq!(code(env.tick_at(H0 + 30)), Some(err::OUTSIDE_WINDOW));
    assert_eq!(code(env.tick_at(H0 + 599)), Some(err::OUTSIDE_WINDOW));
    env.tick_at(H0 + 29).unwrap();
    assert_eq!(code(env.tick_at(H0 + 29)), Some(err::ALREADY_TICKED));
    env.set_clock(H0 + 600 + 5, 0);
    // by CPI, beside another instruction, twice in one transaction: refused
    let ix = env.tick_ix();
    let probe = env.via_probe(&ix);
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), probe])), Some(err::CALLED_BY_CPI));
    let payer = env.payer.pubkey();
    let other = Keypair::new().pubkey();
    assert_eq!(code(env.send_payer(&[ix.clone(), system_transfer(&payer, &other, 1)])), Some(err::NOT_ALONE));
    assert_eq!(code(env.send_payer(&[system_transfer(&payer, &other, 1), ix.clone()])), Some(err::NOT_ALONE));
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), ix.clone(), ix.clone()])), Some(err::NOT_ALONE));
    // foreign accounts: another DBC pool, a model that is not Hunch's, the budget's WSOL account swapped
    let other_pool = env.create_pool("good", true).pool;
    for (slot, addr) in [(6usize, other_pool), (1, Keypair::new().pubkey()), (7, ata_of(&payer, &wsol_mint()))] {
        let mut bad = ix.clone();
        bad.accounts[slot].pubkey = addr;
        assert_eq!(code(env.send_payer(&[cu_limit(400_000), bad])), Some(err::WRONG_ACCOUNT), "account {slot}");
    }
    // a fake instructions sysvar (to hide other instructions): refused
    let mut bad = ix.clone();
    bad.accounts[8].pubkey = Keypair::new().pubkey();
    assert!(env.send_payer(&[cu_limit(400_000), bad]).is_err());
    // the right accounts: accepted
    env.send_payer(&[cu_limit(400_000), ix]).unwrap();
}

#[test]
fn ticks_wait_for_the_opening_schedule() {
    // a pool activated at a bar start: a tick 3 seconds later is inside the window but before the
    // 5-second opening fee schedule ends
    let mut env = Env::new(H0 - 100);
    env.launch("good", H0, H0 + 1);
    assert_eq!(code(env.tick_at(H0 + 3)), Some(err::TOO_EARLY));
    env.tick_at(H0 + 6).unwrap();
}

#[test]
fn a_missed_boundary_forfeits_two_hours_and_never_helps() {
    let mut env = launched();
    let t = env.trader(1_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=29 {
        bar(&mut env, &t, b, SOL);
    }
    let before = env.state();
    assert!(before.n > 0, "calls are scored from hour 3");
    // bar 30 (the boundary of hour 5) is missed; the next boundary (hour 6) forfeits hours 4 and 5
    env.set_clock(H0 + 30 * BAR - 300, 0);
    env.churn(&t, SOL);
    for b in 31..=36 {
        bar(&mut env, &t, b, SOL);
    }
    let st = env.state();
    let e = Entry::read(&env.last_diary());
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    println!("{text}");
    assert_eq!((e.outcome, e.detail), (outcome::FORFEIT, 2));
    assert!(e.flags & df::FORFEIT != 0);
    assert_eq!(st.forfeits, before.forfeits + 2);
    assert_eq!(st.n, before.n + 2);
    assert_eq!(st.hits, before.hits, "forfeits count as misses");
    assert!(text.contains("forfeit x2, a tick was missed.") && text.contains("no buy: the opening tick was missed"));
    // the open call of hour 6 is made, and its signal says what the last outcome was
    let s = env.signal_bytes();
    assert_eq!(s[sig::LAST_OUTCOME], outcome::FORFEIT);
    assert_eq!(rd_u32(&s, sig::FORFEITS), st.forfeits);
}

#[test]
fn blind_when_the_pool_layout_changes() {
    let mut env = launched();
    let t = env.trader(1_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=23 {
        bar(&mut env, &t, b, SOL);
    }
    let forfeits = env.state().forfeits;
    // the pool's discriminator changes (a new DBC layout): ticks still land, read nothing, say "blind"
    let pool = env.pool().pool;
    let good = env.svm.get_account(&pool).unwrap();
    let mut changed = good.clone();
    changed.data[0] ^= 0xff;
    env.svm.set_account(pool, changed).unwrap();
    let r = env.tick_at(H0 + 24 * BAR + 1).unwrap();
    assert!(rd_u16(&env.last_tape(), 6) & rules::tf::BLIND != 0);
    assert_eq!(env.signal_bytes()[sig::PHASE], phase::BLIND);
    let m = memos(&r.logs);
    println!("{}", m[0]);
    assert!(m[0].contains("blind: the pool layout changed, no calls, no buys."));
    env.donate(SOL);
    env.set_clock(H0 + 24 * BAR + 60, 0);
    assert_eq!(code(env.buy()), Some(err::NO_BOUNDARY_THIS_HOUR));
    // the layout comes back: the network reads again; the blind hour is not a forfeit
    env.svm.set_account(pool, good).unwrap();
    for b in 25..=36 {
        bar(&mut env, &t, b, SOL);
    }
    let st = env.state();
    assert_eq!(st.forfeits, forfeits, "a blind hour is not scored, not forfeited");
    assert_eq!(st.blind, 0);
    let e = Entry::read(&env.last_diary());
    assert!(matches!(e.outcome, outcome::HIT | outcome::MISS), "scoring resumes: {:?}", e);
}

#[test]
fn cpis_are_only_the_listed_ones() {
    // init, adopt, a day of ticks, claims and buys: every instruction Hunch invokes, by program and kind
    let mut env = Env::new(H0 - 500);
    env.set_clock(H0 - 400, 2_000);
    let keys = env.create_pool("good", true);
    let mut seen = BTreeSet::new();
    let mut record = |env: &Env, ixs: &[solana_instruction::Instruction], meta: &TransactionMetadata, seen: &mut BTreeSet<String>| {
        let keys = env.message_keys(ixs, &env.payer.pubkey());
        for list in &meta.inner_instructions {
            for ii in list.iter().filter(|ii| ii.stack_height == 2) {
                let pid = keys[ii.instruction.program_id_index as usize];
                let d = &ii.instruction.data;
                let kind = if pid == dbc() {
                    if d[..8] == CLAIM_CREATOR_TRADING_FEE2 { "DBC claim_creator_trading_fee2".to_string() } else if d[..8] == SWAP2 { "DBC swap2".to_string() } else { format!("DBC other {:?}", &d[..8]) }
                } else if pid == token_program() {
                    match d[0] { 17 => "Token sync_native".into(), 8 => "Token burn".into(), k => format!("Token other {k}") }
                } else if pid == memo_program() {
                    "Memo".into()
                } else if pid == env.hunch {
                    format!("Hunch event {}", d[1])
                } else if pid == system_program() {
                    match d[0] { 0 => "System create_account".into(), 2 => "System transfer".into(), k => format!("System other {k}") }
                } else if pid == ata_program() {
                    match d.first() { Some(1) => "ATA create_idempotent".into(), k => format!("ATA other {k:?}") }
                } else {
                    format!("OTHER {pid}")
                };
                seen.insert(kind);
            }
        }
    };
    let auth = env.authority.insecure_clone();
    let ix = env.initialize_ix(&auth.pubkey(), &keys.mint, SEED);
    let ixs = vec![cu_limit(400_000), ix];
    let msg_keys_payer = auth.pubkey();
    let r = env.send(&ixs, &[&auth]).unwrap();
    {
        let keys2 = solana_message::Message::new(&ixs, Some(&msg_keys_payer)).account_keys;
        for list in &r.inner_instructions {
            for ii in list.iter().filter(|ii| ii.stack_height == 2) {
                let pid = keys2[ii.instruction.program_id_index as usize];
                seen.insert(if pid == system_program() { "System create_account".to_string() } else if pid == ata_program() { "ATA create_idempotent".into() } else { format!("OTHER {pid}") });
            }
        }
    }
    env.set_clock(H0 - 300, 2_100);
    let ix = env.adopt_ix(&keys);
    let r = env.send_payer(&[ix.clone()]).unwrap();
    env.pool = Some(keys);
    record(&env, &[ix], &r, &mut seen);
    let t = env.trader(1_000 * SOL);
    for b in 0..=20i64 {
        if b > 0 {
            env.set_clock(H0 + b * BAR - 300, 0);
            env.churn(&t, SOL);
        }
        env.set_clock(H0 + b * BAR + 1, (b + 10) as u64 * 1000);
        let ixs = vec![cu_limit(400_000), env.tick_ix()];
        let r = env.send_payer(&ixs).unwrap();
        record(&env, &ixs, &r, &mut seen);
    }
    env.donate(SOL);
    env.set_clock(H0 + 3 * 3600 + 1300, 50_000);
    let ixs = vec![cu_limit(400_000), env.buy_ix()];
    let r = env.send_payer(&ixs).unwrap();
    record(&env, &ixs, &r, &mut seen);
    let ixs = vec![env.claim_ix()];
    let r = env.send_payer(&ixs).unwrap();
    record(&env, &ixs, &r, &mut seen);
    println!("every instruction Hunch invoked: {seen:#?}");
    let allowed = [
        "ATA create_idempotent", "DBC claim_creator_trading_fee2", "DBC swap2", "Hunch event 1", "Hunch event 2", "Hunch event 3", "Hunch event 4",
        "Hunch event 5", "Memo", "System create_account", "System transfer", "Token burn", "Token sync_native",
    ];
    for k in &seen {
        assert!(allowed.contains(&k.as_str()), "unexpected CPI: {k}");
    }
    assert!(seen.contains("DBC swap2") && seen.contains("Token burn") && seen.contains("Memo"));
}

#[test]
fn initialize_and_load_brain_are_the_upgrade_authority_s() {
    let mut env = Env::new(H0 - 500);
    env.set_clock(H0 - 400, 2_000);
    let keys = env.create_pool("good", true);
    // not the upgrade authority
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 10 * SOL).unwrap();
    let ix = env.initialize_ix(&stranger.pubkey(), &keys.mint, SEED);
    assert_eq!(code(env.send(&[cu_limit(400_000), ix], &[&stranger])), Some(err::NOT_AUTHORITY));
    // the ticker: 1 to 10 characters of A-Z and 0-9, or nothing is created
    for bad in [&b""[..], b"HOURHOGHOGS", b"hunch", b"Hunch", b"HUN-CH", b"HUNCH.", b"HUN CH", b"$HUNCH"] {
        assert_eq!(code(env.initialize_ticker(&keys.mint, SEED, bad)), Some(err::BAD_TICKER), "ticker {:?}", String::from_utf8_lossy(bad));
    }
    // a length byte that does not match the bytes, and the data without a ticker (the old layout)
    let auth = env.authority.insecure_clone();
    let mut ix = env.initialize_ix(&auth.pubkey(), &keys.mint, SEED);
    ix.data[46] = 4;
    assert_eq!(ix_error(env.send(&[cu_limit(400_000), ix.clone()], &[&auth])), Some(solana_instruction_error::InstructionError::InvalidInstructionData));
    ix.data.truncate(46);
    assert_eq!(ix_error(env.send(&[cu_limit(400_000), ix], &[&auth])), Some(solana_instruction_error::InstructionError::InvalidInstructionData));
    assert!(env.svm.get_account(&env.state).map(|a| a.owner != env.hunch).unwrap_or(true), "a refused initialize created nothing");
    println!("initialize refused the tickers \"\", HOURHOGHOGS (11), hunch, Hunch, HUN-CH, HUNCH., \"HUN CH\", $HUNCH");
    let r = env.initialize(&keys.mint, SEED).unwrap();
    assert_eq!(&env.state().ticker, b"HUNCH\0\0\0\0\0\0\0\0\0\0\0");
    println!("initialize: {} CU; rent for state, model, tape, open call, diary, brain book and the WSOL account", hunch_cu(&r.logs).unwrap());
    let mut rent = 0;
    for a in [env.state, env.model, env.tape, env.signal, env.diary, env.book, env.budget_wsol] {
        let acc = env.svm.get_account(&a).unwrap();
        println!("  {:>6} bytes  {:>10} lamports  {a}", acc.data.len(), acc.lamports);
        rent += acc.lamports;
    }
    println!("  total {:.5} SOL", rent as f64 / 1e9);
    assert_eq!(code(env.initialize(&keys.mint, SEED)), Some(err::ALREADY_INITIALIZED));
    // load_brain: a frozen part (layer 2) changed is refused; a chapter-0 number changed is accepted
    let auth = env.authority.insecure_clone();
    let mut w = Weights::from_seed(SEED);
    w.w2[0][1] = 5;
    let ix = env.load_brain_ix(&auth.pubkey(), &w.flat());
    assert_eq!(code(env.send(&[cu_limit(400_000), ix], &[&auth])), Some(err::BAD_BRAIN));
    let mut w = Weights::from_seed(SEED);
    w.w1[3][2] += ONE as i32 / 8;
    w.b3 = 1234;
    let ix = env.load_brain_ix(&auth.pubkey(), &w.flat());
    let ix_stranger = env.load_brain_ix(&stranger.pubkey(), &w.flat());
    assert_eq!(code(env.send(&[ix_stranger], &[&stranger])), Some(err::NOT_AUTHORITY));
    env.send(&[cu_limit(400_000), ix.clone()], &[&auth]).unwrap();
    assert_eq!(env.weights_bytes(), w.to_bytes().to_vec());
    let st = env.state();
    assert_eq!(st.brain_source, 1);
    assert_eq!(hex(&st.brain_hash), sha256_hex(&w.to_bytes()));
    // after adoption: refused
    env.set_clock(H0 - 300, 2_100);
    env.adopt(keys).unwrap();
    assert_eq!(code(env.send(&[cu_limit(400_000), ix], &[&auth])), Some(err::WRONG_PHASE));
}

#[test]
fn adopt_curve_checks_the_pool_and_the_config() {
    for (variant, transfer, want) in [
        ("fee50", true, err::CONFIG_MISMATCH),
        ("leftover", true, err::CONFIG_MISMATCH),
        ("schedule", true, err::CONFIG_MISMATCH),
        ("lp5050", true, err::CONFIG_MISMATCH),
        ("good", false, err::POOL_MISMATCH),
    ] {
        let mut env = Env::new(H0 - 500);
        env.set_clock(H0 - 400, 2_000);
        let keys = env.create_pool(variant, transfer);
        env.initialize(&keys.mint, SEED).unwrap();
        assert_eq!(code(env.adopt(keys)), Some(want), "{variant}, creator handed over: {transfer}");
        println!("{variant} (creator to the budget: {transfer}): refused with {want}");
    }
    // the pool of another mint than the one sealed at initialize
    let mut env = Env::new(H0 - 500);
    env.set_clock(H0 - 400, 2_000);
    let keys = env.create_pool("good", true);
    env.initialize(&Keypair::new().pubkey(), SEED).unwrap();
    assert_eq!(code(env.adopt(keys)), Some(err::WRONG_ACCOUNT));
    // the right one, once
    let mut env = launched();
    let st = env.state();
    assert_eq!(st.phase, phase::CURVE);
    assert_eq!(st.launch_hour as i64, (H0 - 300) / 3600);
    assert_eq!(env.token_amount(&env.budget_hunch()), 0);
    let keys = PoolKeys { pool: env.pool().pool, config: env.pool().config, mint: env.pool().mint, base_vault: env.pool().base_vault, quote_vault: env.pool().quote_vault };
    let ix = env.adopt_ix(&keys);
    assert_eq!(code(env.send_payer(&[ix])), Some(err::WRONG_PHASE));
}

#[test]
fn read_call_by_cpi_returns_the_open_call() {
    let mut env = launched();
    let t = env.trader(1_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=18 {
        bar(&mut env, &t, b, SOL);
    }
    let ix = env.read_call_ix();
    let r = env.send_payer(&[env.via_probe(&ix)]).unwrap();
    let sig = env.signal_bytes();
    assert_eq!(r.return_data.data, sig[..SIGNAL_LEN].to_vec());
    assert_eq!(Address::new_from_array(r.return_data.program_id.to_bytes()), env.hunch);
    let probe = probe_id().to_string();
    assert!(r.logs.iter().any(|l| l.contains(&probe) && l.starts_with("Program log:")), "logs the top-level program");
    assert!(r.logs.iter().any(|l| l.starts_with("Program log: 0x2,")), "logs stack height 2");
    println!(
        "read_call by CPI: call {} lean {} for unix hour {} ({} CU)",
        sig[sig::CALL],
        rd_u16(&sig, sig::LEAN),
        rd_u32(&sig, sig::UNIX_HOUR),
        hunch_cu(&r.logs).unwrap_or(0)
    );
    let r = env.send_payer(&[ix]).unwrap();
    assert_eq!(r.return_data.data.len(), SIGNAL_LEN);
}

#[test]
fn the_brain_book_grows_in_steps() {
    let mut env = launched();
    env.tick_at(H0 + 1).unwrap();
    let ix = env.grow_ix();
    assert_eq!(code(env.send_payer(&[ix.clone()])), Some(err::BOOK_HAS_ROOM));
    // 70 days after launch: fewer than 30 free daily records remain
    env.set_clock(H0 + 70 * 86_400, 0);
    let before = env.data(&env.book).len();
    let r = env.send_payer(&[ix.clone()]).unwrap();
    let after = env.data(&env.book);
    assert_eq!(after.len(), before + BOOK_STEP * BOOK_RECORD);
    assert_eq!(rd_u32(&after, 12) as usize, 2 * BOOK_STEP);
    println!("brain book {before} -> {} bytes ({} CU)", after.len(), hunch_cu(&r.logs).unwrap());
    assert_eq!(code(env.send_payer(&[ix])), Some(err::BOOK_HAS_ROOM));
    // the day-70 record lands in the grown part
    env.tick_at(H0 + 70 * 86_400 + 600 + 1).unwrap();
    let rec = env.record(70);
    assert_eq!(rd_u16(&rec, 0), 70);
    let _ = tag::TICK;
}
