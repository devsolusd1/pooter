//! Test harness: LiteSVM with Meteora DBC's mainnet bytecode, Metaplex Token Metadata, the compiled
//! Hunch program and the test-only CPI probe. Every key is a throwaway made in memory; nothing reads a
//! key file and nothing talks to a network. DBC's create_config / create_pool / transfer_pool_creator
//! instructions are built offline by `../tests/dbc-ixs.mjs` (the SDK 1.5.13) from public keys only.
//!
//! Paths: HUNCH_SO, PROBE_SO, DBC_SO, MPL_SO (defaults under ~/hunch-target).

use {
    base64::Engine,
    hunch::{
        ids::{self, tag},
        layout::{self, *},
    },
    litesvm::{types::FailedTransactionMetadata, LiteSVM},
    sha2::{Digest, Sha256},

    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_transaction::Transaction,
    solana_transaction_error::TransactionError,
    std::{process::Command, str::FromStr},
};

pub use litesvm::types::TransactionMetadata;

/// Hunch's program id in the tests (the stage-1 test id).
pub fn hunch_id() -> Address {
    Address::from_str("ATxJHU3jCbm9fM6UKhZigZ2phpKKaa1UcbQXGsyYMwyT").unwrap()
}
pub fn probe_id() -> Address {
    Address::from_str("J5rMHTxcFaQ3q9yzsn5DDiQGjCGnqt1pgwQUzTXqj5Kd").unwrap()
}
pub fn dbc() -> Address {
    Address::new_from_array(ids::DBC.to_bytes())
}
pub fn token_program() -> Address {
    Address::new_from_array(ids::TOKEN.to_bytes())
}
pub fn ata_program() -> Address {
    Address::new_from_array(ids::ATA.to_bytes())
}
pub fn wsol_mint() -> Address {
    Address::new_from_array(ids::WSOL.to_bytes())
}
pub fn memo_program() -> Address {
    Address::new_from_array(ids::MEMO.to_bytes())
}
pub fn system_program() -> Address {
    Address::new_from_array([0; 32])
}
pub fn ix_sysvar() -> Address {
    Address::new_from_array(ids::INSTRUCTIONS_SYSVAR.to_bytes())
}
pub fn loader_v3() -> Address {
    Address::new_from_array(ids::LOADER_V3.to_bytes())
}
pub fn compute_budget_program() -> Address {
    Address::new_from_array(ids::COMPUTE_BUDGET.to_bytes())
}
pub fn dbc_pool_authority() -> Address {
    Address::new_from_array(ids::DBC_POOL_AUTHORITY.to_bytes())
}
pub fn dbc_event_authority() -> Address {
    Address::new_from_array(ids::DBC_EVENT_AUTHORITY.to_bytes())
}

pub fn pda(seeds: &[&[u8]], program: &Address) -> (Address, u8) {
    Address::find_program_address(seeds, program)
}
pub fn ata_of(owner: &Address, mint: &Address) -> Address {
    pda(&[owner.as_ref(), token_program().as_ref(), mint.as_ref()], &ata_program()).0
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// `Custom(n)` of a failed transaction.
pub fn custom_code(e: &FailedTransactionMetadata) -> Option<u32> {
    match &e.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

/// The compute units the top-level Hunch instruction consumed (from its "consumed" log line).
pub fn hunch_cu(logs: &[String]) -> Option<u64> {
    let id = hunch_id().to_string();
    let mut stack: Vec<String> = vec![];
    let mut cu = None;
    for l in logs {
        let w: Vec<&str> = l.split_whitespace().collect();
        if w.len() >= 3 && w[0] == "Program" && w[2] == "invoke" {
            stack.push(w[1].to_string());
        } else if w.len() >= 4 && w[0] == "Program" && w[2] == "consumed" {
            if stack.len() == 1 && w[1] == id {
                cu = w[3].parse().ok();
            }
        } else if w.len() >= 3 && w[0] == "Program" && (w[2] == "success" || w[2] == "failed:") {
            stack.pop();
        }
    }
    cu
}

/// The memo lines a transaction wrote. SPL Memo logs `Memo (len N): "text"` (the mainnet build) or
/// `Memo (len N)` followed by the text on the next log line (v4).
pub fn memos(logs: &[String]) -> Vec<String> {
    let mut out = vec![];
    for (i, l) in logs.iter().enumerate() {
        let Some(at) = l.find("Memo (len ") else { continue };
        let rest = &l[at..];
        if let Some(q) = rest.find(": \"") {
            let s = &rest[q + 3..];
            out.push(s.strip_suffix('"').unwrap_or(s).to_string());
        } else if let Some(next) = logs.get(i + 1) {
            out.push(next.strip_prefix("Program log: ").unwrap_or(next).to_string());
        }
    }
    out
}

#[derive(Clone)]
pub struct PoolKeys {
    pub pool: Address,
    pub config: Address,
    pub mint: Address,
    pub base_vault: Address,
    pub quote_vault: Address,
}

// ------------------------------------------------------------------------------------------------ DAMM v2
pub fn damm() -> Address {
    Address::new_from_array(ids::DAMM.to_bytes())
}
pub fn damm_pool_authority() -> Address {
    Address::new_from_array(ids::DAMM_POOL_AUTHORITY.to_bytes())
}
pub fn damm_event_authority() -> Address {
    Address::new_from_array(ids::DAMM_EVENT_AUTHORITY.to_bytes())
}
pub fn token_2022() -> Address {
    Address::new_from_array(ids::TOKEN_2022.to_bytes())
}
/// The DAMM v2 config DBC's SDK 1.5.13 uses for a Customizable migration (cloned from mainnet).
pub fn damm_config_customizable() -> Address {
    Address::from_str("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck").unwrap()
}
pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;
fn hi_lo<'a>(a: &'a Address, b: &'a Address) -> (&'a Address, &'a Address) {
    if a.as_ref() > b.as_ref() {
        (a, b)
    } else {
        (b, a)
    }
}
/// DAMM v2's pool PDA for a config: ["pool", config, max(a, b), min(a, b)].
pub fn damm_pool_address(config: &Address, a: &Address, b: &Address) -> Address {
    let (hi, lo) = hi_lo(a, b);
    pda(&[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()], &damm()).0
}
/// DAMM v2's customizable pool PDA (no config): ["cpool", max(a, b), min(a, b)].
pub fn damm_cpool_address(a: &Address, b: &Address) -> Address {
    let (hi, lo) = hi_lo(a, b);
    pda(&[b"cpool", hi.as_ref(), lo.as_ref()], &damm()).0
}
pub fn damm_vault(mint: &Address, pool: &Address) -> Address {
    pda(&[b"token_vault", mint.as_ref(), pool.as_ref()], &damm()).0
}
pub fn damm_position(nft_mint: &Address) -> Address {
    pda(&[b"position", nft_mint.as_ref()], &damm()).0
}
pub fn damm_nft_account(nft_mint: &Address) -> Address {
    pda(&[b"position_nft_account", nft_mint.as_ref()], &damm()).0
}

/// A DAMM v2 pool and one position in it (the position Hunch adopts, or any other).
#[derive(Clone)]
pub struct DammKeys {
    pub pool: Address,
    pub config: Address,
    pub vault_a: Address,
    pub vault_b: Address,
    pub position: Address,
    pub nft: Address,
    pub nft_mint: Address,
}

fn disc(name: &str) -> [u8; 8] {
    let h = Sha256::digest(name.as_bytes());
    let mut d = [0u8; 8];
    d.copy_from_slice(&h[..8]);
    d
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub authority: Keypair,
    pub hunch: Address,
    pub state: Address,
    pub model: Address,
    pub tape: Address,
    pub signal: Address,
    pub diary: Address,
    pub book: Address,
    pub budget: Address,
    pub event_authority: Address,
    pub budget_wsol: Address,
    pub programdata: Address,
    pub bumps: [u8; 9],
    pub pool: Option<PoolKeys>,
    pub mint_kp: Keypair,
    /// The adopted DAMM v2 pool and Hunch's position, once there is one.
    pub damm: Option<DammKeys>,
}

pub fn so_path(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| format!("{}/hunch-target/{default}", std::env::var("HOME").unwrap()))
}

impl Env {
    /// LiteSVM with DBC, Metaplex, Hunch (upgradeable, with `authority` as its upgrade authority) and the probe.
    pub fn new(start_ts: i64) -> Self {
        Self::new_with(start_ts, &so_path("HUNCH_SO", "deploy/hunch.so"))
    }
    /// The same with another Hunch binary (the test-only wide-cap build).
    pub fn new_with(start_ts: i64, hunch_so: &str) -> Self {
        let mut svm = LiteSVM::new().with_transaction_history(0).with_log_bytes_limit(None);
        let hunch = hunch_id();
        svm.add_program_from_file(dbc(), so_path("DBC_SO", "mainnet-programs/dbc.so")).expect("dbc.so (run test.sh once to dump it)");
        svm.add_program_from_file(Address::from_str("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").unwrap(), so_path("MPL_SO", "mainnet-programs/mpl_token_metadata.so"))
            .expect("mpl_token_metadata.so");
        svm.add_program_from_file(hunch, hunch_so).expect("hunch.so (run build.sh)");
        svm.add_program_from_file(probe_id(), so_path("PROBE_SO", "deploy/hunch_cpi_probe.so")).expect("hunch_cpi_probe.so");
        // SPL Memo as deployed on mainnet (LiteSVM ships v4, which costs far less compute per byte)
        svm.add_program_from_file(memo_program(), so_path("MEMO_SO", "mainnet-programs/memo.so")).expect("memo.so (dumped from mainnet)");
        // the native mint (LiteSVM starts without it): no authority, 9 decimals, initialized
        let mut mint = vec![0u8; 82];
        mint[44] = 9;
        mint[45] = 1;
        let lamports = svm.minimum_balance_for_rent_exemption(82);
        svm.set_account(wsol_mint(), solana_account::Account { lamports, data: mint, owner: token_program(), executable: false, rent_epoch: 0 })
            .unwrap();
        let payer = Keypair::new();
        let authority = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000_000).unwrap();
        svm.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();
        // the upgrade authority (LiteSVM loads programs with none): ProgramData's Option<Pubkey> at 12..45
        let (programdata, pd_bump) = pda(&[hunch.as_ref()], &loader_v3());
        let mut pd = svm.get_account(&programdata).unwrap();
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(authority.pubkey().as_ref());
        svm.set_account(programdata, pd).unwrap();
        let p = |s: &[u8]| pda(&[s], &hunch);
        let (state, b1) = p(b"state");
        let (model, b2) = p(b"model");
        let (tape, b3) = p(b"tape");
        let (signal, b4) = p(b"signal");
        let (diary, b5) = p(b"diary");
        let (book, b6) = p(b"brains");
        let (budget, b7) = p(b"budget");
        let (event_authority, b8) = p(b"__event_authority");
        let budget_wsol = ata_of(&budget, &wsol_mint());
        let mut env = Env {
            svm,
            payer,
            authority,
            hunch,
            state,
            model,
            tape,
            signal,
            diary,
            book,
            budget,
            event_authority,
            budget_wsol,
            programdata,
            bumps: [pd_bump, b1, b2, b3, b4, b5, b6, b7, b8],
            pool: None,
            mint_kp: Keypair::new(),
            damm: None,
        };
        env.set_clock(start_ts, 1_000);
        env
    }

    pub fn set_clock(&mut self, ts: i64, slot: u64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = ts;
        c.slot = slot;
        self.svm.set_sysvar(&c);
    }
    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let msg = Message::new(ixs, Some(&signers[0].pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
    }
    pub fn send_payer(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.payer.insecure_clone();
        self.send(ixs, &[&payer])
    }

    pub fn data(&self, a: &Address) -> Vec<u8> {
        self.svm.get_account(a).map(|a| a.data).unwrap_or_default()
    }
    pub fn state(&self) -> State {
        let d = self.data(&self.state);
        assert_eq!(d.len(), STATE_LEN);
        unsafe { std::ptr::read_unaligned(d.as_ptr() as *const State) }
    }
    pub fn weights_bytes(&self) -> Vec<u8> {
        self.data(&self.model)[WEIGHTS_OFFSET..WEIGHTS_OFFSET + hunch_net::N_WEIGHTS * 4].to_vec()
    }
    pub fn token_amount(&self, a: &Address) -> u64 {
        self.svm.get_account(a).map(|acc| rd_u64(&acc.data, 64)).unwrap_or(0)
    }

    // ---------------------------------------------------------------- DBC
    /// Creates a DBC config and a pool for a fresh mint, with the pool's creator handed to the budget PDA
    /// in the same transaction (unless `transfer` is false). The clock is the pool's activation point.
    pub fn create_pool(&mut self, variant: &str, transfer: bool) -> PoolKeys {
        let (keys, pool_ixs, transfer_ix) = self.prepare_pool(variant);
        let mut ixs: Vec<Instruction> = vec![cu_limit(1_000_000)];
        ixs.extend(pool_ixs);
        if transfer {
            ixs.push(transfer_ix);
        }
        let payer = self.payer.insecure_clone();
        let mint_kp = self.mint_kp.insecure_clone();
        self.send(&ixs, &[&payer, &mint_kp]).unwrap_or_else(|e| panic!("create pool: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        keys
    }

    /// Sends the DBC config of `variant` (the payer its fee claimer, the budget PDA its leftover receiver)
    /// and returns the pool-creating instructions for a fresh mint (`self.mint_kp`, which signs with the
    /// payer) and transfer_pool_creator to the budget PDA, both unsent.
    pub fn prepare_pool(&mut self, variant: &str) -> (PoolKeys, Vec<Instruction>, Instruction) {
        let config_kp = Keypair::new();
        let mint_kp = Keypair::new();
        let script = format!("{}/../tests/dbc-ixs.mjs", env!("CARGO_MANIFEST_DIR"));
        let out = Command::new("node")
            .args([
                script.as_str(),
                &self.payer.pubkey().to_string(),
                &config_kp.pubkey().to_string(),
                &mint_kp.pubkey().to_string(),
                &self.budget.to_string(),
                variant,
            ])
            .output()
            .expect("node");
        assert!(out.status.success(), "dbc-ixs.mjs failed: {}", String::from_utf8_lossy(&out.stderr));
        let j: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let ix_of = |v: &serde_json::Value| Instruction {
            program_id: Address::from_str(v["programId"].as_str().unwrap()).unwrap(),
            accounts: v["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| {
                    let a = Address::from_str(k["pubkey"].as_str().unwrap()).unwrap();
                    if k["isWritable"].as_bool().unwrap() {
                        AccountMeta::new(a, k["isSigner"].as_bool().unwrap())
                    } else {
                        AccountMeta::new_readonly(a, k["isSigner"].as_bool().unwrap())
                    }
                })
                .collect(),
            data: base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap()).unwrap(),
        };
        let mut cfg: Vec<Instruction> = vec![cu_limit(1_000_000)];
        cfg.extend(j["ixs"]["config"].as_array().unwrap().iter().map(ix_of));
        let payer = self.payer.insecure_clone();
        self.send(&cfg, &[&payer, &config_kp]).unwrap_or_else(|e| panic!("create_config: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        let pool_ixs: Vec<Instruction> = j["ixs"]["pool"].as_array().unwrap().iter().map(ix_of).collect();
        let transfer_ix = ix_of(&j["ixs"]["transfer"]);
        let keys = PoolKeys {
            pool: Address::from_str(j["pool"].as_str().unwrap()).unwrap(),
            config: config_kp.pubkey(),
            mint: mint_kp.pubkey(),
            base_vault: Address::from_str(j["baseVault"].as_str().unwrap()).unwrap(),
            quote_vault: Address::from_str(j["quoteVault"].as_str().unwrap()).unwrap(),
        };
        self.mint_kp = mint_kp;
        (keys, pool_ixs, transfer_ix)
    }

    pub fn pool(&self) -> &PoolKeys {
        self.pool.as_ref().expect("no pool adopted")
    }
    pub fn budget_hunch(&self) -> Address {
        ata_of(&self.budget, &self.pool().mint)
    }

    /// Overwrites pool fields (the replay writes the pool's readings per bar).
    pub fn write_pool(&mut self, sqrt_price: u128, trading: u64, protocol: u64, creator: u64, quote_reserve: u64) {
        let pool = self.pool().pool;
        let mut a = self.svm.get_account(&pool).unwrap();
        wr_u128(&mut a.data, layout::pool::SQRT_PRICE, sqrt_price);
        wr_u64(&mut a.data, layout::pool::TOTAL_TRADING_QUOTE_FEE, trading);
        wr_u64(&mut a.data, layout::pool::TOTAL_PROTOCOL_QUOTE_FEE, protocol);
        wr_u64(&mut a.data, layout::pool::CREATOR_QUOTE_FEE, creator);
        wr_u64(&mut a.data, layout::pool::QUOTE_RESERVE, quote_reserve);
        self.svm.set_account(pool, a).unwrap();
    }
    pub fn pool_sqrt_price(&self) -> u128 {
        rd_u128(&self.data(&self.pool().pool), layout::pool::SQRT_PRICE)
    }
    pub fn pool_fee_total(&self) -> u64 {
        let d = self.data(&self.pool().pool);
        rd_u64(&d, layout::pool::TOTAL_TRADING_QUOTE_FEE) + rd_u64(&d, layout::pool::TOTAL_PROTOCOL_QUOTE_FEE)
    }

    /// A trader with WSOL and HUNCH token accounts and `sol` wrapped.
    pub fn trader(&mut self, sol: u64) -> Keypair {
        let t = Keypair::new();
        self.svm.airdrop(&t.pubkey(), sol + 1_000_000_000).unwrap();
        let mint = self.pool().mint;
        let wsol = ata_of(&t.pubkey(), &wsol_mint());
        let ixs = vec![
            create_ata_ix(&t.pubkey(), &t.pubkey(), &wsol_mint()),
            create_ata_ix(&t.pubkey(), &t.pubkey(), &mint),
            system_transfer(&t.pubkey(), &wsol, sol),
            sync_native_ix(&wsol),
        ];
        self.send(&ixs, &[&t]).unwrap();
        t
    }
    /// A DBC swap2 by a trader: a buy spends `amount` lamports of WSOL, a sell `amount` HUNCH units.
    pub fn trade(&mut self, t: &Keypair, buy: bool, amount: u64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.swap_ix(&t.pubkey(), buy, amount, 0);
        self.send(&[cu_limit(400_000), ix], &[t])
    }
    /// A buy that stops at the end of the curve (DBC PartialFill).
    pub fn trade_partial(&mut self, t: &Keypair, amount: u64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let mut ix = self.swap_ix(&t.pubkey(), true, amount, 0);
        *ix.data.last_mut().unwrap() = 1;
        self.send(&[cu_limit(400_000), ix], &[t])
    }
    pub fn swap_ix(&self, owner: &Address, buy: bool, amount: u64, min_out: u64) -> Instruction {
        dbc_swap_ix(self.pool(), owner, buy, amount, min_out)
    }
}

/// A DBC swap2 on `p` by `owner` from its own associated token accounts: a buy spends `amount` lamports of
/// WSOL, a sale `amount` HUNCH units. No referral (DBC's own id in the optional slot).
pub fn dbc_swap_ix(p: &PoolKeys, owner: &Address, buy: bool, amount: u64, min_out: u64) -> Instruction {
    let wsol = ata_of(owner, &wsol_mint());
    let hunch_acc = ata_of(owner, &p.mint);
    let (input, output) = if buy { (wsol, hunch_acc) } else { (hunch_acc, wsol) };
    let mut data = ids::SWAP2.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.push(0);
    Instruction {
        program_id: dbc(),
        accounts: vec![
            AccountMeta::new_readonly(dbc_pool_authority(), false),
            AccountMeta::new_readonly(p.config, false),
            AccountMeta::new(p.pool, false),
            AccountMeta::new(input, false),
            AccountMeta::new(output, false),
            AccountMeta::new(p.base_vault, false),
            AccountMeta::new(p.quote_vault, false),
            AccountMeta::new_readonly(p.mint, false),
            AccountMeta::new_readonly(wsol_mint(), false),
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new_readonly(token_program(), false),
            AccountMeta::new_readonly(token_program(), false),
            AccountMeta::new_readonly(dbc(), false),
            AccountMeta::new_readonly(dbc_event_authority(), false),
            AccountMeta::new_readonly(dbc(), false),
        ],
        data,
    }
}

impl Env {
    // ---------------------------------------------------------------- Hunch instructions
    /// initialize with the tests' ticker, HUNCH (the vectors' memo lines name it).
    pub fn initialize_ix(&self, signer: &Address, mint: &Address, seed: u32) -> Instruction {
        self.initialize_ix_ticker(signer, mint, seed, b"HUNCH")
    }
    /// initialize with any ticker bytes: a length byte, then the bytes.
    pub fn initialize_ix_ticker(&self, signer: &Address, mint: &Address, seed: u32, ticker: &[u8]) -> Instruction {
        let mut data = vec![tag::INITIALIZE];
        data.extend_from_slice(mint.as_ref());
        data.extend_from_slice(&seed.to_le_bytes());
        data.extend_from_slice(&self.bumps);
        data.push(ticker.len() as u8);
        data.extend_from_slice(ticker);
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(*signer, true),
                AccountMeta::new_readonly(self.programdata, false),
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.model, false),
                AccountMeta::new(self.tape, false),
                AccountMeta::new(self.signal, false),
                AccountMeta::new(self.diary, false),
                AccountMeta::new(self.book, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new(self.budget_wsol, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new_readonly(system_program(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(ata_program(), false),
                AccountMeta::new_readonly(self.event_authority, false),
            ],
            data,
        }
    }
    pub fn initialize(&mut self, mint: &Address, seed: u32) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.initialize_ticker(mint, seed, b"HUNCH")
    }
    pub fn initialize_ticker(&mut self, mint: &Address, seed: u32, ticker: &[u8]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let auth = self.authority.insecure_clone();
        let ix = self.initialize_ix_ticker(&auth.pubkey(), mint, seed, ticker);
        self.send(&[cu_limit(400_000), ix], &[&auth])
    }
    pub fn load_brain_ix(&self, signer: &Address, weights: &[i32]) -> Instruction {
        let mut data = vec![tag::LOAD_BRAIN, self.bumps[0]];
        for w in weights {
            data.extend_from_slice(&w.to_le_bytes());
        }
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new_readonly(*signer, true),
                AccountMeta::new_readonly(self.programdata, false),
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.model, false),
            ],
            data,
        }
    }
    pub fn adopt_ix(&self, keys: &PoolKeys) -> Instruction {
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.signal, false),
                AccountMeta::new(self.book, false),
                AccountMeta::new_readonly(keys.pool, false),
                AccountMeta::new_readonly(keys.config, false),
                AccountMeta::new_readonly(keys.mint, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new(ata_of(&self.budget, &keys.mint), false),
                AccountMeta::new_readonly(system_program(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(ata_program(), false),
            ],
            data: vec![tag::ADOPT_CURVE],
        }
    }
    pub fn adopt(&mut self, keys: PoolKeys) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.adopt_ix(&keys);
        let r = self.send_payer(&[ix]);
        if r.is_ok() {
            self.pool = Some(keys);
        }
        r
    }
    /// Pool, initialize (seed 12346) and adopt, at `t_activation` and `t_adopt`.
    pub fn launch(&mut self, variant: &str, t_activation: i64, t_adopt: i64) {
        self.launch_ticker(variant, t_activation, t_adopt, b"HUNCH");
    }
    /// The same with another ticker.
    pub fn launch_ticker(&mut self, variant: &str, t_activation: i64, t_adopt: i64, ticker: &[u8]) {
        self.set_clock(t_activation, 2_000);
        let keys = self.create_pool(variant, true);
        self.initialize_ticker(&keys.mint, hunch_net::SEED, ticker).unwrap_or_else(|e| panic!("initialize: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.set_clock(t_adopt, 2_100);
        self.adopt(keys).unwrap_or_else(|e| panic!("adopt: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    }
    pub fn tick_ix(&self) -> Instruction {
        // the DBC pool, or the DAMM v2 pool once one is adopted
        let pool = self.damm.as_ref().map(|d| d.pool).unwrap_or_else(|| self.pool().pool);
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.model, false),
                AccountMeta::new(self.tape, false),
                AccountMeta::new(self.signal, false),
                AccountMeta::new(self.diary, false),
                AccountMeta::new(self.book, false),
                AccountMeta::new_readonly(pool, false),
                AccountMeta::new_readonly(self.budget_wsol, false),
                AccountMeta::new_readonly(ix_sysvar(), false),
                AccountMeta::new_readonly(memo_program(), false),
                AccountMeta::new_readonly(self.event_authority, false),
                AccountMeta::new_readonly(self.hunch, false),
            ],
            data: vec![tag::TICK],
        }
    }
    pub fn tick(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.tick_ix();
        self.send_payer(&[cu_limit(400_000), ix])
    }
    pub fn tick_at(&mut self, ts: i64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.set_clock(ts, (ts - 1_700_000_000) as u64);
        self.tick()
    }
    pub fn buy_ix(&self) -> Instruction {
        let p = self.pool();
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.signal, false),
                AccountMeta::new_readonly(self.tape, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new(self.budget_wsol, false),
                AccountMeta::new(self.budget_hunch(), false),
                AccountMeta::new(p.mint, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new(p.pool, false),
                AccountMeta::new_readonly(p.config, false),
                AccountMeta::new(p.base_vault, false),
                AccountMeta::new(p.quote_vault, false),
                AccountMeta::new_readonly(dbc_pool_authority(), false),
                AccountMeta::new_readonly(dbc_event_authority(), false),
                AccountMeta::new_readonly(dbc(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(ix_sysvar(), false),
                AccountMeta::new_readonly(self.event_authority, false),
                AccountMeta::new_readonly(self.hunch, false),
            ],
            data: vec![tag::BUY_AND_BURN_CURVE],
        }
    }
    pub fn buy(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.buy_ix();
        self.send_payer(&[cu_limit(400_000), ix])
    }
    pub fn claim_ix(&self) -> Instruction {
        let p = self.pool();
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new(self.budget_wsol, false),
                AccountMeta::new(self.budget_hunch(), false),
                AccountMeta::new_readonly(p.mint, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new(p.pool, false),
                AccountMeta::new_readonly(p.config, false),
                AccountMeta::new(p.base_vault, false),
                AccountMeta::new(p.quote_vault, false),
                AccountMeta::new_readonly(dbc_pool_authority(), false),
                AccountMeta::new_readonly(dbc_event_authority(), false),
                AccountMeta::new_readonly(dbc(), false),
                AccountMeta::new_readonly(token_program(), false),
            ],
            data: vec![tag::CLAIM_CURVE_FEES],
        }
    }
    pub fn read_call_ix(&self) -> Instruction {
        Instruction {
            program_id: self.hunch,
            accounts: vec![AccountMeta::new_readonly(self.signal, false), AccountMeta::new_readonly(ix_sysvar(), false)],
            data: vec![tag::READ_CALL],
        }
    }
    pub fn grow_ix(&self) -> Instruction {
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(self.state, false),
                AccountMeta::new(self.book, false),
                AccountMeta::new_readonly(system_program(), false),
            ],
            data: vec![tag::GROW_BRAIN_BOOK],
        }
    }
    /// The same instruction, made by the probe program through CPI.
    pub fn via_probe(&self, ix: &Instruction) -> Instruction {
        let mut accounts = vec![AccountMeta::new_readonly(ix.program_id, false)];
        accounts.extend(ix.accounts.iter().cloned());
        Instruction { program_id: probe_id(), accounts, data: ix.data.clone() }
    }

    // ---------------------------------------------------------------- graduation (DAMM v2)
    /// Loads Meteora DAMM v2 and SPL Token-2022 as deployed on mainnet, and the DAMM v2 config DBC's
    /// Customizable migration uses (cloned from mainnet, read-only public RPC, by test-v1.sh).
    pub fn load_damm(&mut self) {
        self.svm.add_program_from_file(damm(), so_path("DAMM_SO", "mainnet-programs/damm_v2.so")).expect("damm_v2.so (dumped from mainnet)");
        self.svm.add_program_from_file(token_2022(), so_path("TOKEN_2022_SO", "mainnet-programs/token_2022.so")).expect("token_2022.so (dumped from mainnet)");
        // the config, and DBC's pool authority with its mainnet balance (DBC's migration borrows the new
        // accounts' rent from it and repays it from the payer: "flash rent")
        for name in ["damm_config_customizable.json", "dbc_pool_authority.json"] {
            let path = so_path("MAINNET_ACCOUNTS", "mainnet-accounts");
            let text = std::fs::read_to_string(format!("{path}/{name}")).unwrap_or_else(|_| panic!("{name} (cloned from mainnet by test-v1.sh)"));
            let j: serde_json::Value = serde_json::from_str(&text).unwrap();
            let a = &j["account"];
            let data = base64::engine::general_purpose::STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap();
            let acc = solana_account::Account {
                lamports: a["lamports"].as_u64().unwrap(),
                data,
                owner: Address::from_str(a["owner"].as_str().unwrap()).unwrap(),
                executable: false,
                rent_epoch: 0,
            };
            self.svm.set_account(Address::from_str(j["pubkey"].as_str().unwrap()).unwrap(), acc).unwrap();
        }
    }

    /// DBC's migration_damm_v2 (permissionless), as the SDK 1.5.13 builds it: the first position (the
    /// larger LP share, the partner's 67%) and the second (the creator's 33%, the budget PDA's).
    /// Returns (partner's position, the budget's position) and the transaction.
    pub fn migrate(&mut self) -> (DammKeys, DammKeys, Result<TransactionMetadata, FailedTransactionMetadata>) {
        let p = self.pool();
        let config = damm_config_customizable();
        let pool = damm_pool_address(&config, &p.mint, &wsol_mint());
        let (first, second) = (Keypair::new(), Keypair::new());
        let keys = |m: &Keypair| DammKeys {
            pool,
            config,
            vault_a: damm_vault(&p.mint, &pool),
            vault_b: damm_vault(&wsol_mint(), &pool),
            position: damm_position(&m.pubkey()),
            nft: damm_nft_account(&m.pubkey()),
            nft_mint: m.pubkey(),
        };
        let (k1, k2) = (keys(&first), keys(&second));
        let ix = Instruction {
            program_id: dbc(),
            accounts: vec![
                AccountMeta::new(p.pool, false),
                AccountMeta::new_readonly(system_program(), false), // migration_metadata: deprecated, unchecked
                AccountMeta::new_readonly(p.config, false),
                AccountMeta::new(dbc_pool_authority(), false),
                AccountMeta::new(pool, false),
                AccountMeta::new(k1.nft_mint, true),
                AccountMeta::new(k1.nft, false),
                AccountMeta::new(k1.position, false),
                AccountMeta::new(k2.nft_mint, true),
                AccountMeta::new(k2.nft, false),
                AccountMeta::new(k2.position, false),
                AccountMeta::new_readonly(damm_pool_authority(), false),
                AccountMeta::new_readonly(damm(), false),
                AccountMeta::new(p.mint, false),
                AccountMeta::new(wsol_mint(), false),
                AccountMeta::new(k1.vault_a, false),
                AccountMeta::new(k1.vault_b, false),
                AccountMeta::new(p.base_vault, false),
                AccountMeta::new(p.quote_vault, false),
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(token_2022(), false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(system_program(), false),
                AccountMeta::new_readonly(config, false),
            ],
            data: disc("global:migration_damm_v2").to_vec(),
        };
        let payer = self.payer.insecure_clone();
        let r = self.send(&[cu_limit(1_400_000), ix], &[&payer, &first, &second]);
        (k1, k2, r)
    }

    /// DBC's withdraw_leftover (permissionless): the leftover HUNCH to the leftover receiver's (the budget's) ATA.
    pub fn withdraw_leftover_ix(&self) -> Instruction {
        let p = self.pool();
        Instruction {
            program_id: dbc(),
            accounts: vec![
                AccountMeta::new_readonly(dbc_pool_authority(), false),
                AccountMeta::new_readonly(p.config, false),
                AccountMeta::new(p.pool, false),
                AccountMeta::new(self.budget_hunch(), false),
                AccountMeta::new(p.base_vault, false),
                AccountMeta::new_readonly(p.mint, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(dbc_event_authority(), false),
                AccountMeta::new_readonly(dbc(), false),
            ],
            data: disc("global:withdraw_leftover").to_vec(),
        }
    }

    pub fn withdraw_surplus_ix(&self) -> Instruction {
        let p = self.pool();
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new(self.budget_wsol, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new(p.pool, false),
                AccountMeta::new_readonly(p.config, false),
                AccountMeta::new(p.quote_vault, false),
                AccountMeta::new_readonly(dbc_pool_authority(), false),
                AccountMeta::new_readonly(dbc_event_authority(), false),
                AccountMeta::new_readonly(dbc(), false),
                AccountMeta::new_readonly(token_program(), false),
            ],
            data: vec![tag::WITHDRAW_SURPLUS],
        }
    }

    pub fn adopt_pool_ix(&self, k: &DammKeys) -> Instruction {
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.signal, false),
                AccountMeta::new_readonly(self.pool().pool, false),
                AccountMeta::new_readonly(k.pool, false),
                AccountMeta::new_readonly(k.config, false),
                AccountMeta::new_readonly(k.position, false),
                AccountMeta::new_readonly(k.nft, false),
                AccountMeta::new_readonly(self.budget, false),
            ],
            data: vec![tag::ADOPT_POOL],
        }
    }
    pub fn adopt_pool(&mut self, k: DammKeys) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.adopt_pool_ix(&k);
        let r = self.send_payer(&[cu_limit(400_000), ix]);
        if r.is_ok() {
            self.damm = Some(k);
        }
        r
    }
    pub fn damm_keys(&self) -> &DammKeys {
        self.damm.as_ref().expect("no DAMM v2 pool adopted")
    }

    /// claim_pool_fees for a position (the adopted one, or any other).
    pub fn claim_pool_ix_for(&self, position: &Address, nft: &Address) -> Instruction {
        let k = self.damm_keys();
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new(self.budget_wsol, false),
                AccountMeta::new(self.budget_hunch(), false),
                AccountMeta::new_readonly(self.pool().mint, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new_readonly(k.pool, false),
                AccountMeta::new_readonly(damm_pool_authority(), false),
                AccountMeta::new(k.vault_a, false),
                AccountMeta::new(k.vault_b, false),
                AccountMeta::new(*position, false),
                AccountMeta::new_readonly(*nft, false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
                AccountMeta::new_readonly(token_program(), false),
            ],
            data: vec![tag::CLAIM_POOL_FEES],
        }
    }
    pub fn claim_pool_ix(&self) -> Instruction {
        let k = self.damm_keys();
        self.claim_pool_ix_for(&k.position, &k.nft)
    }

    pub fn buy_pool_ix(&self) -> Instruction {
        let k = self.damm_keys();
        Instruction {
            program_id: self.hunch,
            accounts: vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.signal, false),
                AccountMeta::new_readonly(self.tape, false),
                AccountMeta::new_readonly(self.budget, false),
                AccountMeta::new(self.budget_wsol, false),
                AccountMeta::new(self.budget_hunch(), false),
                AccountMeta::new(self.pool().mint, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new(k.pool, false),
                AccountMeta::new_readonly(damm_pool_authority(), false),
                AccountMeta::new(k.vault_a, false),
                AccountMeta::new(k.vault_b, false),
                AccountMeta::new(k.position, false),
                AccountMeta::new_readonly(k.nft, false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(ix_sysvar(), false),
                AccountMeta::new_readonly(self.event_authority, false),
                AccountMeta::new_readonly(self.hunch, false),
            ],
            data: vec![tag::BUY_AND_BURN_POOL],
        }
    }
    pub fn buy_pool(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.buy_pool_ix();
        self.send_payer(&[cu_limit(400_000), ix])
    }

    // ---------------------------------------------------------------- withdraw_budget (the developer's withdrawal)
    /// The upgrade authority's WSOL account (its associated token account), where withdrawals go.
    pub fn dev_wsol(&self) -> Address {
        ata_of(&self.authority.pubkey(), &wsol_mint())
    }
    /// withdraw_budget with `signer` in the authority's place and `dest` as the WSOL account to receive, for
    /// the phase this world is in: the adopted DAMM v2 pool's accounts once there is one, else the DBC curve's.
    pub fn withdraw_ix(&self, signer: &Address, dest: &Address, amount: u64) -> Instruction {
        let mut data = vec![tag::WITHDRAW_BUDGET, self.bumps[0]];
        data.extend_from_slice(&amount.to_le_bytes());
        let mut accounts = vec![
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new_readonly(self.programdata, false),
            AccountMeta::new(self.state, false),
            AccountMeta::new(self.signal, false),
            AccountMeta::new_readonly(self.budget, false),
            AccountMeta::new(self.budget_wsol, false),
            AccountMeta::new(self.budget_hunch(), false),
            AccountMeta::new_readonly(self.pool().mint, false),
            AccountMeta::new_readonly(wsol_mint(), false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(token_program(), false),
            AccountMeta::new_readonly(ix_sysvar(), false),
            AccountMeta::new_readonly(memo_program(), false),
            AccountMeta::new_readonly(self.event_authority, false),
            AccountMeta::new_readonly(self.hunch, false),
        ];
        if let Some(k) = &self.damm {
            accounts.extend([
                AccountMeta::new_readonly(k.pool, false),
                AccountMeta::new_readonly(damm_pool_authority(), false),
                AccountMeta::new(k.vault_a, false),
                AccountMeta::new(k.vault_b, false),
                AccountMeta::new(k.position, false),
                AccountMeta::new_readonly(k.nft, false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
            ]);
        } else {
            let p = self.pool();
            accounts.extend([
                AccountMeta::new(p.pool, false),
                AccountMeta::new_readonly(p.config, false),
                AccountMeta::new(p.base_vault, false),
                AccountMeta::new(p.quote_vault, false),
                AccountMeta::new_readonly(dbc_pool_authority(), false),
                AccountMeta::new_readonly(dbc_event_authority(), false),
                AccountMeta::new_readonly(dbc(), false),
            ]);
        }
        Instruction { program_id: self.hunch, accounts, data }
    }
    /// The transaction scripts/withdraw-budget.mjs sends: the authority's WSOL account created if missing
    /// (idempotent), withdraw_budget into it, then that account closed into the authority's wallet, so the
    /// SOL arrives as plain SOL. The authority signs and pays.
    pub fn withdraw_ixs(&self, amount: u64) -> Vec<Instruction> {
        let auth = self.authority.pubkey();
        vec![
            cu_limit(400_000),
            create_ata_ix(&auth, &auth, &wsol_mint()),
            self.withdraw_ix(&auth, &self.dev_wsol(), amount),
            close_account_ix(&self.dev_wsol(), &auth, &auth),
        ]
    }
    pub fn withdraw(&mut self, amount: u64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let auth = self.authority.insecure_clone();
        let ixs = self.withdraw_ixs(amount);
        self.send(&ixs, &[&auth])
    }
    /// The withdrawal event (6) of a transaction made of `ixs`, paid by `payer`.
    pub fn withdraw_event_of(&self, meta: &TransactionMetadata, ixs: &[Instruction], payer: &Address) -> Option<WithdrawEvent> {
        let keys = self.message_keys(ixs, payer);
        self.events(meta, &keys).into_iter().find(|(k, _)| *k == ids::event::WITHDRAW).map(|(_, d)| WithdrawEvent {
            amount: rd_u64(&d, 0),
            held: rd_u64(&d, 8),
            claimed: rd_u64(&d, 16),
            left: rd_u64(&d, 24),
            total: rd_u64(&d, 32),
            count: rd_u32(&d, 40),
            signer: Address::new_from_array(d[44..76].try_into().unwrap()),
        })
    }
    /// The withdrawal event of a `withdraw(..)` transaction.
    pub fn withdraw_event(&self, meta: &TransactionMetadata) -> Option<WithdrawEvent> {
        self.withdraw_event_of(meta, &self.withdraw_ixs(0), &self.authority.pubkey())
    }

    /// A copy of this world (accounts, clock, keys), optionally with another Hunch binary loaded at the same
    /// program id (its upgrade authority kept). With the deployed build (`old_so()`) it shows what the
    /// program on mainnet would do from the very same accounts.
    pub fn twin(&self, hunch_so: Option<&str>) -> Env {
        let mut svm = self.svm.clone();
        if let Some(so) = hunch_so {
            svm.add_program_from_file(self.hunch, so).expect("hunch binary for the twin");
            let mut pd = svm.get_account(&self.programdata).unwrap();
            pd.data[12] = 1;
            pd.data[13..45].copy_from_slice(self.authority.pubkey().as_ref());
            svm.set_account(self.programdata, pd).unwrap();
        }
        Env {
            svm,
            payer: self.payer.insecure_clone(),
            authority: self.authority.insecure_clone(),
            hunch: self.hunch,
            state: self.state,
            model: self.model,
            tape: self.tape,
            signal: self.signal,
            diary: self.diary,
            book: self.book,
            budget: self.budget,
            event_authority: self.event_authority,
            budget_wsol: self.budget_wsol,
            programdata: self.programdata,
            bumps: self.bumps,
            pool: self.pool.clone(),
            mint_kp: self.mint_kp.insecure_clone(),
            damm: self.damm.clone(),
        }
    }
    /// The LIVE mainnet accounts cloned by programs/tests/clone-live.mjs (read-only, public RPC) in `dir`, with
    /// `hunch_so` loaded at the live program id. The ProgramData's upgrade authority is set to a throwaway
    /// key, a stand-in for the developer's wallet (whose key the tests never have): `env.authority`. The
    /// clock is the chain's at the clone. Returns None when there is no clone in `dir`.
    pub fn from_live(dir: &str, hunch_so: &str) -> Option<(Env, serde_json::Value)> {
        let index: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/index.json")).ok()?).ok()?;
        let program = Address::from_str(index["program"].as_str()?).ok()?;
        let mut svm = LiteSVM::new().with_transaction_history(0).with_log_bytes_limit(None);
        svm.add_program_from_file(dbc(), so_path("DBC_SO", "mainnet-programs/dbc-0.2.2.so")).expect("dbc-0.2.2.so");
        svm.add_program_from_file(memo_program(), so_path("MEMO_SO", "mainnet-programs/memo.so")).expect("memo.so");
        svm.add_program_from_file(program, hunch_so).expect("hunch binary");
        svm.add_program_from_file(probe_id(), so_path("PROBE_SO", "deploy/hunch_cpi_probe.so")).expect("hunch_cpi_probe.so");
        let mut mint = vec![0u8; 82];
        mint[44] = 9;
        mint[45] = 1;
        let lamports = svm.minimum_balance_for_rent_exemption(82);
        svm.set_account(wsol_mint(), solana_account::Account { lamports, data: mint, owner: token_program(), executable: false, rent_epoch: 0 }).unwrap();
        let roles = index["accounts"].as_object()?;
        for (role, key) in roles {
            if key.is_null() || role == "programdata" || role == "clock" {
                continue;
            }
            let text = std::fs::read_to_string(format!("{dir}/{role}.json")).ok()?;
            let j: serde_json::Value = serde_json::from_str(&text).ok()?;
            let a = &j["account"];
            let data = base64::engine::general_purpose::STANDARD.decode(a["data"][0].as_str()?).ok()?;
            let acc = solana_account::Account { lamports: a["lamports"].as_u64()?, data, owner: Address::from_str(a["owner"].as_str()?).ok()?, executable: false, rent_epoch: 0 };
            svm.set_account(Address::from_str(j["pubkey"].as_str()?).ok()?, acc).unwrap();
        }
        let payer = Keypair::new();
        let authority = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        svm.airdrop(&authority.pubkey(), 1_000_000_000).unwrap();
        let (programdata, pd_bump) = pda(&[program.as_ref()], &loader_v3());
        let mut pd = svm.get_account(&programdata).unwrap();
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(authority.pubkey().as_ref());
        svm.set_account(programdata, pd).unwrap();
        let p = |s: &[u8]| pda(&[s], &program);
        let (state, b1) = p(b"state");
        let (model, b2) = p(b"model");
        let (tape, b3) = p(b"tape");
        let (signal, b4) = p(b"signal");
        let (diary, b5) = p(b"diary");
        let (book, b6) = p(b"brains");
        let (budget, b7) = p(b"budget");
        let (event_authority, b8) = p(b"__event_authority");
        let key = |r: &str| Address::from_str(roles.get(r).and_then(|v| v.as_str()).unwrap_or("11111111111111111111111111111111")).unwrap();
        let pool = PoolKeys { pool: key("pool"), config: key("config"), mint: key("mint"), base_vault: key("base_vault"), quote_vault: key("quote_vault") };
        let mut env = Env {
            svm,
            payer,
            authority,
            hunch: program,
            state,
            model,
            tape,
            signal,
            diary,
            book,
            budget,
            event_authority,
            budget_wsol: ata_of(&budget, &wsol_mint()),
            programdata,
            bumps: [pd_bump, b1, b2, b3, b4, b5, b6, b7, b8],
            pool: Some(pool),
            mint_kp: Keypair::new(),
            damm: None,
        };
        let ts = index["unix_timestamp"].as_i64()?;
        env.set_clock(ts, index["slot"].as_u64()?);
        Some((env, index))
    }

    /// Every account a buy or a tick can touch, for comparing two worlds byte for byte.
    pub fn watched(&self) -> Vec<Address> {
        let mut v = vec![self.state, self.model, self.tape, self.signal, self.diary, self.book, self.budget_wsol, self.budget_hunch(), self.authority.pubkey()];
        let p = self.pool();
        v.extend([p.pool, p.config, p.mint, p.base_vault, p.quote_vault]);
        if let Some(k) = &self.damm {
            v.extend([k.pool, k.vault_a, k.vault_b, k.position, k.nft]);
        }
        v
    }
    /// The accounts in `keys` whose lamports, owner or data differ between two worlds.
    pub fn differences(&self, other: &Env, keys: &[Address]) -> Vec<Address> {
        keys.iter()
            .filter(|k| {
                let (a, b) = (self.svm.get_account(k), other.svm.get_account(k));
                match (a, b) {
                    (Some(a), Some(b)) => a.lamports != b.lamports || a.owner != b.owner || a.data != b.data,
                    (None, None) => false,
                    _ => true,
                }
            })
            .copied()
            .collect()
    }

    /// A DAMM v2 swap2 by a trader on the adopted pool: a buy spends `amount` lamports of WSOL, a sale
    /// `amount` HUNCH units.
    pub fn damm_swap_ix(&self, owner: &Address, buy: bool, amount: u64, min_out: u64) -> Instruction {
        let k = self.damm_keys();
        let mint = self.pool().mint;
        let wsol = ata_of(owner, &wsol_mint());
        let hunch_acc = ata_of(owner, &mint);
        let (input, output) = if buy { (wsol, hunch_acc) } else { (hunch_acc, wsol) };
        let mut data = disc("global:swap2").to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        data.push(0);
        Instruction {
            program_id: damm(),
            accounts: vec![
                AccountMeta::new_readonly(damm_pool_authority(), false),
                AccountMeta::new(k.pool, false),
                AccountMeta::new(input, false),
                AccountMeta::new(output, false),
                AccountMeta::new(k.vault_a, false),
                AccountMeta::new(k.vault_b, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new_readonly(*owner, true),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(damm(), false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
            ],
            data,
        }
    }
    pub fn trade_pool(&mut self, t: &Keypair, buy: bool, amount: u64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.damm_swap_ix(&t.pubkey(), buy, amount, 0);
        self.send(&[cu_limit(400_000), ix], &[t])
    }
    /// A round trip on DAMM v2: buy `lamports` of HUNCH, then sell all of it.
    pub fn churn_pool(&mut self, t: &Keypair, lamports: u64) {
        let acc = ata_of(&t.pubkey(), &self.pool().mint);
        let before = self.token_amount(&acc);
        self.trade_pool(t, true, lamports).unwrap_or_else(|e| panic!("pool buy: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        let units = self.token_amount(&acc) - before;
        self.trade_pool(t, false, units).unwrap_or_else(|e| panic!("pool sell: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    }

    /// DAMM v2 create_position (permissionless) for `owner` in the adopted pool; the payer pays.
    pub fn create_position(&mut self, owner: &Address) -> (Address, Address, Address, Result<TransactionMetadata, FailedTransactionMetadata>) {
        let k = self.damm_keys().clone();
        let m = Keypair::new();
        let (position, nft) = (damm_position(&m.pubkey()), damm_nft_account(&m.pubkey()));
        let ix = Instruction {
            program_id: damm(),
            accounts: vec![
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new(m.pubkey(), true),
                AccountMeta::new(nft, false),
                AccountMeta::new(k.pool, false),
                AccountMeta::new(position, false),
                AccountMeta::new_readonly(damm_pool_authority(), false),
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(token_2022(), false),
                AccountMeta::new_readonly(system_program(), false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
            ],
            data: disc("global:create_position").to_vec(),
        };
        let payer = self.payer.insecure_clone();
        let r = self.send(&[cu_limit(400_000), ix], &[&payer, &m]);
        (position, nft, m.pubkey(), r)
    }
    /// DAMM v2 add_liquidity by the position's owner `t` from its own WSOL and HUNCH accounts.
    pub fn add_liquidity_ix(&self, t: &Address, position: &Address, nft: &Address, liquidity: u128) -> Instruction {
        let k = self.damm_keys();
        let mint = self.pool().mint;
        let mut data = disc("global:add_liquidity").to_vec();
        data.extend_from_slice(&liquidity.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        Instruction {
            program_id: damm(),
            accounts: vec![
                AccountMeta::new(k.pool, false),
                AccountMeta::new(*position, false),
                AccountMeta::new(ata_of(t, &mint), false),
                AccountMeta::new(ata_of(t, &wsol_mint()), false),
                AccountMeta::new(k.vault_a, false),
                AccountMeta::new(k.vault_b, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new_readonly(*nft, false),
                AccountMeta::new_readonly(*t, true),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
            ],
            data,
        }
    }

    /// DAMM v2 permanent_lock_position (permissionless for the position's owner `owner`) in the pool of
    /// env.damm: `liquidity` of the position's unlocked liquidity locked for good, which raises the pool's
    /// permanent_lock_liquidity (nothing can lower it again).
    pub fn permanent_lock_ix(&self, owner: &Address, position: &Address, nft: &Address, liquidity: u128) -> Instruction {
        let mut data = disc("global:permanent_lock_position").to_vec();
        data.extend_from_slice(&liquidity.to_le_bytes());
        Instruction {
            program_id: damm(),
            accounts: vec![
                AccountMeta::new(self.damm_keys().pool, false),
                AccountMeta::new(*position, false),
                AccountMeta::new_readonly(*nft, false),
                AccountMeta::new_readonly(*owner, true),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
            ],
            data,
        }
    }

    /// DAMM v2 initialize_customizable_pool by `t` (permissionless): an outside HUNCH/SOL pool, not made by
    /// DBC's migration, at `sqrt_price`, 3.75% fee in SOL, with `liquidity` from `t`'s accounts.
    pub fn outside_pool(&mut self, t: &Keypair, sqrt_price: u128, liquidity: u128) -> (DammKeys, Result<TransactionMetadata, FailedTransactionMetadata>) {
        let mint = self.pool().mint;
        let pool = damm_cpool_address(&mint, &wsol_mint());
        let m = Keypair::new();
        let k = DammKeys {
            pool,
            config: damm_config_customizable(),
            vault_a: damm_vault(&mint, &pool),
            vault_b: damm_vault(&wsol_mint(), &pool),
            position: damm_position(&m.pubkey()),
            nft: damm_nft_account(&m.pubkey()),
            nft_mint: m.pubkey(),
        };
        let mut data = disc("global:initialize_customizable_pool").to_vec();
        // pool_fees: base fee (Borsh time scheduler: cliff u64, periods u16, frequency u64, reduction u64,
        // mode u8), compounding_fee_bps u16, padding u8, dynamic fee None
        data.extend_from_slice(&37_500_000u64.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.push(0);
        data.extend_from_slice(&0u16.to_le_bytes());
        data.push(0);
        data.push(0);
        data.extend_from_slice(&MIN_SQRT_PRICE.to_le_bytes());
        data.extend_from_slice(&MAX_SQRT_PRICE.to_le_bytes());
        data.push(0); // has_alpha_vault
        data.extend_from_slice(&liquidity.to_le_bytes());
        data.extend_from_slice(&sqrt_price.to_le_bytes());
        data.push(1); // activation_type: timestamp
        data.push(1); // collect_fee_mode: OnlyB
        data.push(0); // activation_point: None
        let ix = Instruction {
            program_id: damm(),
            accounts: vec![
                AccountMeta::new_readonly(t.pubkey(), false),
                AccountMeta::new(m.pubkey(), true),
                AccountMeta::new(k.nft, false),
                AccountMeta::new(t.pubkey(), true),
                AccountMeta::new_readonly(damm_pool_authority(), false),
                AccountMeta::new(pool, false),
                AccountMeta::new(k.position, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(wsol_mint(), false),
                AccountMeta::new(k.vault_a, false),
                AccountMeta::new(k.vault_b, false),
                AccountMeta::new(ata_of(&t.pubkey(), &mint), false),
                AccountMeta::new(ata_of(&t.pubkey(), &wsol_mint()), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(token_program(), false),
                AccountMeta::new_readonly(token_2022(), false),
                AccountMeta::new_readonly(system_program(), false),
                AccountMeta::new_readonly(damm_event_authority(), false),
                AccountMeta::new_readonly(damm(), false),
            ],
            data,
        };
        let r = self.send(&[cu_limit(600_000), ix], &[t, &m]);
        (k, r)
    }

    /// Changes the program's state in place (tests of the daily caps start from a given count).
    pub fn set_state(&mut self, f: impl FnOnce(&mut State)) {
        let mut a = self.svm.get_account(&self.state).unwrap();
        let mut st: State = unsafe { std::ptr::read_unaligned(a.data.as_ptr() as *const State) };
        f(&mut st);
        unsafe { std::ptr::write_unaligned(a.data.as_mut_ptr() as *mut State, st) };
        self.svm.set_account(self.state, a).unwrap();
    }
    /// Changes one byte of the open call (tests of the multiplier).
    pub fn set_signal_byte(&mut self, at: usize, v: u8) {
        let mut a = self.svm.get_account(&self.signal).unwrap();
        a.data[at] = v;
        self.svm.set_account(self.signal, a).unwrap();
    }
    /// SOL sent straight to the budget's WSOL account (sync_native makes it count).
    pub fn donate(&mut self, lamports: u64) {
        let payer = self.payer.pubkey();
        let to = self.budget_wsol;
        self.send_payer(&[system_transfer(&payer, &to, lamports)]).unwrap();
    }
    /// A round trip by a trader: buy `lamports` of HUNCH, then sell all of it. Volume without much move.
    pub fn churn(&mut self, t: &Keypair, lamports: u64) {
        let acc = ata_of(&t.pubkey(), &self.pool().mint);
        let before = self.token_amount(&acc);
        self.trade(t, true, lamports).unwrap_or_else(|e| panic!("buy: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        let units = self.token_amount(&acc) - before;
        self.trade(t, false, units).unwrap_or_else(|e| panic!("sell: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    }
    pub fn mint_supply(&self) -> u64 {
        rd_u64(&self.data(&self.pool().mint), 36)
    }

    /// The last tape entry.
    pub fn last_tape(&self) -> Vec<u8> {
        let d = self.data(&self.tape);
        let head = rd_u32(&d, 8) as usize;
        let i = (head + TAPE_ENTRIES - 1) % TAPE_ENTRIES;
        d[TAPE_HEADER + i * TAPE_ENTRY..TAPE_HEADER + (i + 1) * TAPE_ENTRY].to_vec()
    }
    /// The last diary entry.
    pub fn last_diary(&self) -> Vec<u8> {
        let d = self.data(&self.diary);
        let head = rd_u32(&d, 8) as usize;
        let i = (head + DIARY_ENTRIES - 1) % DIARY_ENTRIES;
        d[DIARY_HEADER + i * DIARY_ENTRY..DIARY_HEADER + (i + 1) * DIARY_ENTRY].to_vec()
    }
    pub fn diary_total(&self) -> u64 {
        rd_u64(&self.data(&self.diary), 16)
    }
    pub fn record(&self, day: usize) -> Vec<u8> {
        let d = self.data(&self.book);
        d[BOOK_HEADER + day * BOOK_RECORD..BOOK_HEADER + (day + 1) * BOOK_RECORD].to_vec()
    }
    pub fn signal_bytes(&self) -> Vec<u8> {
        self.data(&self.signal)
    }

    /// Hunch's events in a transaction: (kind, payload after the kind byte).
    pub fn events(&self, meta: &TransactionMetadata, ixs_keys: &[Address]) -> Vec<(u8, Vec<u8>)> {
        let mut out = vec![];
        for list in &meta.inner_instructions {
            for ii in list {
                let pid = ixs_keys.get(ii.instruction.program_id_index as usize);
                if pid == Some(&self.hunch) && ii.instruction.data.first() == Some(&tag::EVENT) && ii.instruction.data.len() > 1 {
                    out.push((ii.instruction.data[1], ii.instruction.data[2..].to_vec()));
                }
            }
        }
        out
    }
    /// The account keys of a message built like `send` builds it.
    pub fn message_keys(&self, ixs: &[Instruction], payer: &Address) -> Vec<Address> {
        Message::new(ixs, Some(payer)).account_keys
    }
}

/// Legacy wire size of a transaction with these instructions and one signer (the fee payer).
pub fn wire_size(ixs: &[Instruction], payer: &Address) -> usize {
    let msg = Message::new(ixs, Some(payer));
    let ix_bytes: usize = msg.instructions.iter().map(|i| 1 + 1 + i.accounts.len() + 1 + i.data.len()).sum();
    1 + 64 + 3 + 1 + 32 * msg.account_keys.len() + 32 + 1 + ix_bytes
}

/// SPL Memo with any text (no signers).
pub fn memo_ix(text: &str) -> Instruction {
    Instruction { program_id: memo_program(), accounts: vec![], data: text.as_bytes().to_vec() }
}
/// ComputeBudget SetComputeUnitPrice.
pub fn cu_price(micro_lamports: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction { program_id: compute_budget_program(), accounts: vec![], data }
}

pub fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: compute_budget_program(), accounts: vec![], data }
}
pub fn system_transfer(from: &Address, to: &Address, lamports: u64) -> Instruction {
    let mut data = vec![2u8, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction { program_id: system_program(), accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)], data }
}
pub fn create_ata_ix(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: ata_program(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata_of(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program(), false),
            AccountMeta::new_readonly(token_program(), false),
        ],
        data: vec![1],
    }
}
pub fn sync_native_ix(account: &Address) -> Instruction {
    Instruction { program_id: token_program(), accounts: vec![AccountMeta::new(*account, false)], data: vec![17] }
}
/// The associated Token-2022 account of `owner` for `mint` (a position NFT), and its creation.
pub fn ata_2022_of(owner: &Address, mint: &Address) -> Address {
    pda(&[owner.as_ref(), token_2022().as_ref(), mint.as_ref()], &ata_program()).0
}
pub fn create_ata_2022_ix(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: ata_program(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata_2022_of(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program(), false),
            AccountMeta::new_readonly(token_2022(), false),
        ],
        data: vec![1],
    }
}
/// Token-2022 transfer_checked (instruction 12): hands a position NFT (0 decimals) to another account.
pub fn token_2022_transfer_checked_ix(from: &Address, mint: &Address, to: &Address, owner: &Address, amount: u64, decimals: u8) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: token_2022(),
        accounts: vec![AccountMeta::new(*from, false), AccountMeta::new_readonly(*mint, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*owner, true)],
        data,
    }
}
/// SPL Token transfer (instruction 3).
pub fn token_transfer_ix(from: &Address, to: &Address, owner: &Address, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: token_program(),
        accounts: vec![AccountMeta::new(*from, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*owner, true)],
        data,
    }
}

pub use hunch::ids::err as errors;

/// SPL Token close_account (instruction 9): the account's lamports to `to` (a WSOL account's whole
/// balance, unwrapped).
pub fn close_account_ix(account: &Address, to: &Address, owner: &Address) -> Instruction {
    Instruction {
        program_id: token_program(),
        accounts: vec![AccountMeta::new(*account, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*owner, true)],
        data: vec![9],
    }
}

/// What one withdraw_budget reported (event 6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WithdrawEvent {
    pub amount: u64,
    /// the budget's WSOL after sync_native and the claim
    pub held: u64,
    pub claimed: u64,
    /// what stayed in the budget's WSOL account
    pub left: u64,
    /// the lifetime total and count after this one
    pub total: u64,
    pub count: u32,
    pub signer: Address,
}

/// The deployed build (the binary on mainnet since 2026-10-20, sha256 face57dd...): OLD_HUNCH_SO, by
/// default ~/hunch-target/final/hunch.so.
pub fn old_so() -> String {
    so_path("OLD_HUNCH_SO", "final/hunch.so")
}

/// DBC VirtualPool fee counters a withdrawal must never take: the partner's (the config's fee claimer, the
/// developer) and the protocol's, both in SOL (DBC 0.2.x `state/virtual_pool.rs`: protocol_base_fee 248,
/// protocol_quote_fee 256, partner_base_fee 264, partner_quote_fee 272).
pub const POOL_PROTOCOL_QUOTE_FEE: usize = 256;
pub const POOL_PARTNER_QUOTE_FEE: usize = 272;
