//! The compiled bench program inside LiteSVM: one transaction per 10-minute bar, every coin file.
//! Measures the compute units of one feed + learn + think, and checks that the VM's forward pass on
//! every bar and its final weights equal net.js's (the same vectors as hunch-net's own test).
//!
//! Build the program first (`cargo build-sbf` in `../hunch-net-bench`) and point `HUNCH_BENCH_SO` at it.

use {
    hunch_net::{Weights, N_WEIGHTS, SEED},
    hunch_net_bench::ACCOUNT_LEN,
    litesvm::LiteSVM,
    sha2::{Digest, Sha256},
    solana_account::Account,
    solana_address::Address,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_transaction::Transaction,
    std::{fs, path::PathBuf},
};

const PROGRAM: Address = Address::new_from_array([0x48; 32]);

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    state: Address,
}

impl Env {
    fn new() -> Self {
        let so = std::env::var("HUNCH_BENCH_SO").expect("set HUNCH_BENCH_SO to the built hunch_net_bench.so");
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM, &so).unwrap_or_else(|e| panic!("could not load {so}: {e:?}"));
        let payer = Keypair::new(); // throwaway, lives only in this simulator
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        let state = Keypair::new().pubkey();
        let lamports = svm.minimum_balance_for_rent_exemption(ACCOUNT_LEN);
        svm.set_account(state, Account { lamports, data: vec![0; ACCOUNT_LEN], owner: PROGRAM, executable: false, rent_epoch: 0 })
            .unwrap();
        Env { svm, payer, state }
    }

    /// Sends one instruction; returns compute units and the transaction's wire size.
    fn send(&mut self, data: Vec<u8>) -> (u64, usize) {
        let ix = Instruction::new_with_bytes(PROGRAM, &data, vec![AccountMeta::new(self.state, false)]);
        let message = Message::new(&[ix], Some(&self.payer.pubkey()));
        let size = wire_size(&message, data.len());
        let tx = Transaction::new(&[&self.payer], message, self.svm.latest_blockhash());
        let meta = self.svm.send_transaction(tx).unwrap_or_else(|e| panic!("transaction failed: {:?}", e.meta.logs));
        (meta.compute_units_consumed, size)
    }

    fn out(&self) -> (i64, i64, Vec<u8>) {
        let d = self.svm.get_account(&self.state).unwrap().data;
        let m = hunch_net_bench::MODEL_LEN;
        let p = i64::from_le_bytes(d[m..m + 8].try_into().unwrap());
        let z2 = i64::from_le_bytes(d[m + 8..m + 16].try_into().unwrap());
        (p, z2, d)
    }
}

/// Legacy transaction size: one signature, then the message (header, keys, blockhash, one instruction).
fn wire_size(m: &Message, data_len: usize) -> usize {
    let keys = m.account_keys.len();
    let ix_accounts = m.instructions[0].accounts.len();
    1 + 64 + 3 + 1 + 32 * keys + 32 + 1 + 1 + 1 + ix_accounts + 1 + data_len
}

fn weights_from(d: &[u8]) -> Weights {
    let mut q = [0i32; N_WEIGHTS];
    for (k, v) in q.iter_mut().enumerate() {
        *v = i32::from_le_bytes(d[k * 4..k * 4 + 4].try_into().unwrap());
    }
    Weights::from_flat(&q)
}

fn stats(v: &mut Vec<u64>) -> String {
    if v.is_empty() {
        return "none".into();
    }
    v.sort();
    let mean = v.iter().sum::<u64>() as f64 / v.len() as f64;
    format!("n {:>5}  min {:>5}  median {:>5}  mean {:>7.0}  p99 {:>5}  max {:>5}", v.len(), v[0], v[v.len() / 2], mean, v[v.len() * 99 / 100], v[v.len() - 1])
}

#[test]
fn step_in_the_vm_matches_js_and_costs() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../hunch-net/tests/vectors/v0");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("vectors")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "txt") && p.file_stem().is_some_and(|s| s != "seeds"))
        .collect();
    files.sort();

    let (mut full, mut think_only, mut feed_only) = (vec![], vec![], vec![]);
    let (mut baseline, mut reset_cu, mut step_size) = (0u64, 0u64, 0usize);
    let mut all_ok = true;
    for f in &files {
        let mut env = Env::new();
        let mut seed = vec![0u8];
        seed.extend_from_slice(&SEED.to_le_bytes());
        reset_cu = env.send(seed).0;
        baseline = env.send(vec![2, 1]).0;
        let (mut bars, mut p_same, mut thinks) = (0, 0, 0);
        let mut final_hash = String::new();
        for line in fs::read_to_string(f).unwrap().lines() {
            let tok: Vec<&str> = line.split_whitespace().collect();
            match tok.first().copied() {
                Some("b") => {
                    let n = |k: usize| tok[k].parse::<i64>().unwrap();
                    let (ts, r_raw, lam) = (n(2), n(3), n(4) as u64);
                    let (lk, tk, z2, p) = (n(14), n(20), n(29), n(30));
                    let mut data = vec![1u8];
                    data.extend_from_slice(&ts.to_le_bytes());
                    data.extend_from_slice(&r_raw.to_le_bytes());
                    data.extend_from_slice(&lam.to_le_bytes());
                    let (cu, size) = env.send(data);
                    step_size = size;
                    let (gp, gz2, _) = env.out();
                    bars += 1;
                    if tk == 1 {
                        thinks += 1;
                        if gp == p && gz2 == z2 {
                            p_same += 1;
                        }
                    } else if gp != -1 {
                        p_same = usize::MAX / 2; // a forward pass where JS had none: fail below
                    }
                    match (lk, tk) {
                        (1, 1) => full.push(cu),
                        (0, 1) => think_only.push(cu),
                        _ => feed_only.push(cu),
                    }
                }
                Some("finalhash") => final_hash = tok[1].to_string(),
                _ => {}
            }
        }
        let (_, _, d) = env.out();
        let w = weights_from(&d);
        let h: String = Sha256::digest(w.to_bytes_v0()).iter().map(|b| format!("{b:02x}")).collect();
        let ok = p_same == thinks && h == final_hash;
        all_ok &= ok;
        println!(
            "{:<9} bars {:>5}  VM forward passes equal to JS {:>5}/{:<5}  final weights {}",
            f.file_stem().unwrap().to_string_lossy(),
            bars,
            p_same,
            thinks,
            if h == final_hash { "bit-identical" } else { "DIFFERENT" }
        );
    }
    println!("compute units per transaction (one instruction; includes the account borrow and entrypoint):");
    println!("  feed + learn + think  {}", stats(&mut full));
    println!("  feed + think          {}", stats(&mut think_only));
    println!("  feed only (warm-up)   {}", stats(&mut feed_only));
    println!("  baseline (entrypoint + account checks, no model work): {baseline}");
    println!("  reset (seed weights): {reset_cu}");
    println!("step transaction size: {step_size} bytes (1 signature, 3 keys, 25 bytes of data); model account {} bytes", ACCOUNT_LEN);
    assert!(all_ok, "the VM differs from net.js");
}
