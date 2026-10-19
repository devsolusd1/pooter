//! Hunch's instructions, the curve phase and the pool phase.
//!
//! initialize, load_brain (upgrade authority only, before adoption); adopt_curve; tick;
//! buy_and_burn_curve; claim_curve_fees; read_call; grow_brain_book; and the event self-CPI.
//! Graduation: withdraw_surplus (DBC creator_withdraw_surplus into the budget); adopt_pool (the DAMM v2
//! pool DBC's migration made, and Hunch's position in it); tick on that pool; claim_pool_fees (DAMM v2
//! claim_position_fee by the budget as the NFT owner); buy_and_burn_pool (DAMM v2 swap2).
//! Every value movement is one of: rent paid by callers into accounts the program creates, the
//! creator-fee, surplus and position-fee claims into the budget's own two token accounts, sync_native, a
//! DBC or DAMM v2 swap from the budget's WSOL into the budget's HUNCH account, and a burn of the budget's
//! HUNCH (which also burns any HUNCH sent there, DBC's leftover included).

use {
    crate::{format::*, ids::*, layout::*, rules::*},
    hunch_net::{chapter_of, Bar, Model, Weights, N_WEIGHTS},
    pinocchio::{
        account::{Ref, RefMut},
        cpi::{invoke, invoke_signed, set_return_data, Seed, Signer},
        error::ProgramError,
        instruction::{InstructionAccount, InstructionView},
        sysvars::{clock::Clock, instructions::Instructions, rent::Rent, Sysvar},
        AccountView, Address, ProgramResult, Resize,
    },
};

type R<T> = Result<T, ProgramError>;

#[inline(never)]
fn fail(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(&tag::TICK) => tick(program_id, accounts),
        Some(&tag::BUY_AND_BURN_CURVE) => buy_and_burn_curve(program_id, accounts),
        Some(&tag::EVENT) => event(program_id, accounts),
        Some(&tag::READ_CALL) => read_call(program_id, accounts),
        Some(&tag::CLAIM_CURVE_FEES) => claim_curve_fees(program_id, accounts),
        Some(&tag::ADOPT_CURVE) => adopt_curve(program_id, accounts),
        Some(&tag::GROW_BRAIN_BOOK) => grow_brain_book(program_id, accounts),
        Some(&tag::BUY_AND_BURN_POOL) => buy_and_burn_pool(program_id, accounts),
        Some(&tag::CLAIM_POOL_FEES) => claim_pool_fees(program_id, accounts),
        Some(&tag::WITHDRAW_SURPLUS) => withdraw_surplus(program_id, accounts),
        Some(&tag::ADOPT_POOL) => adopt_pool(program_id, accounts),
        Some(&tag::INITIALIZE) => initialize(program_id, accounts, data),
        Some(&tag::LOAD_BRAIN) => load_brain(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

fn expect(acc: &AccountView, addr: &[u8; 32]) -> ProgramResult {
    if acc.address().as_ref() != addr {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    Ok(())
}

fn expect_id(acc: &AccountView, id: &Address) -> ProgramResult {
    if acc.address() != id {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    Ok(())
}

/// Hunch's own account: owned by the program, of this size, with this tag.
fn own<'a>(program_id: &Address, acc: &'a mut AccountView, len: usize, tag_: &[u8; 8]) -> R<RefMut<'a, [u8]>> {
    if !acc.owned_by(program_id) || acc.data_len() < len {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    let d = acc.try_borrow_mut()?;
    if &d[..8] != tag_ || d.as_ptr() as usize % 8 != 0 {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    Ok(d)
}

fn own_ro<'a>(program_id: &Address, acc: &'a AccountView, len: usize, tag_: &[u8; 8]) -> R<Ref<'a, [u8]>> {
    if !acc.owned_by(program_id) || acc.data_len() < len {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    let d = acc.try_borrow()?;
    if &d[..8] != tag_ || d.as_ptr() as usize % 8 != 0 {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    Ok(d)
}

/// SAFETY: length and 8-byte alignment were checked by `own`; State and Model are repr(C) integers,
/// so any bytes are a valid value.
fn as_state(d: &mut [u8]) -> &mut State {
    unsafe { &mut *(d.as_mut_ptr() as *mut State) }
}
fn as_state_ro(d: &[u8]) -> &State {
    unsafe { &*(d.as_ptr() as *const State) }
}
fn as_model(d: &mut [u8]) -> &mut Model {
    unsafe { &mut *(d[MODEL_OFFSET..].as_mut_ptr() as *mut Model) }
}

/// Refuses a call by CPI, and a transaction that holds any instruction other than this one and
/// ComputeBudget ones.
fn check_alone(program_id: &Address, sysvar: &AccountView) -> ProgramResult {
    let height = stack_height();
    if height != 1 {
        return Err(fail(err::CALLED_BY_CPI));
    }
    let instructions = Instructions::try_from(sysvar)?;
    let current = instructions.load_current_index() as usize;
    for i in 0..instructions.num_instructions() {
        let ix = instructions.load_instruction_at(i)?;
        let program = ix.get_program_id();
        if i == current {
            if program != program_id {
                return Err(fail(err::NOT_TOP_LEVEL));
            }
        } else if program != &COMPUTE_BUDGET {
            return Err(fail(err::NOT_ALONE));
        }
    }
    Ok(())
}

fn stack_height() -> u64 {
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_get_stack_height()
    }
    #[cfg(not(target_os = "solana"))]
    1
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    #[cfg(target_os = "solana")]
    unsafe {
        let slices: [&[u8]; 1] = [data];
        pinocchio::syscalls::sol_sha256(slices.as_ptr() as *const u8, 1, out.as_mut_ptr());
    }
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(data);
    out
}

/// SHA-256 of the 676 weight bytes in canonical order (the struct's first 676 bytes, little-endian).
fn weights_hash(m: &Model) -> [u8; 32] {
    // SAFETY: Weights is repr(C) i32s in canonical order; reading its bytes is always valid.
    let bytes = unsafe { core::slice::from_raw_parts(&m.weights as *const Weights as *const u8, N_WEIGHTS * 4) };
    sha256(bytes)
}

fn log(msg: &str) {
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_(msg.as_ptr(), msg.len() as u64);
    }
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(msg);
}

/// An SPL Token account of `mint` owned by `owner`: its amount.
fn token_amount(account: &AccountView, mint: &[u8], owner: &[u8]) -> R<u64> {
    if !account.owned_by(&TOKEN) || account.data_len() != TOKEN_ACCOUNT_LEN {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    let data = account.try_borrow()?;
    if &data[0..32] != mint || &data[32..64] != owner {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    Ok(rd_u64(&data, 64))
}

/// The DBC pool as it reads now; `None` when its layout is not the adopted one (blind).
#[derive(Clone, Copy, Default)]
struct PoolNow {
    sqrt_price: u128,
    fee_total: u64,
    creator_fee: u64,
    quote_reserve: u64,
}

fn read_pool(pool: &AccountView) -> R<Option<PoolNow>> {
    if !pool.owned_by(&DBC) || pool.data_len() != layout::pool::LEN {
        return Ok(None);
    }
    let d = pool.try_borrow()?;
    if d[..8] != VIRTUAL_POOL_DISC {
        return Ok(None);
    }
    Ok(Some(PoolNow {
        sqrt_price: rd_u128(&d, layout::pool::SQRT_PRICE),
        fee_total: rd_u64(&d, layout::pool::TOTAL_TRADING_QUOTE_FEE).saturating_add(rd_u64(&d, layout::pool::TOTAL_PROTOCOL_QUOTE_FEE)),
        creator_fee: rd_u64(&d, layout::pool::CREATOR_QUOTE_FEE),
        quote_reserve: rd_u64(&d, layout::pool::QUOTE_RESERVE),
    }))
}

use crate::layout;

fn live_fee(st: &State, now: i64) -> u64 {
    live_fee_numerator(st.cliff_fee, st.n_periods, st.period_frequency, st.reduction, st.activation_point, now)
}

/// The DAMM v2 pool as it reads now; `None` when its layout (owner, size, discriminator) or its fee mode
/// (fees in SOL only) is not the adopted one (blind).
#[derive(Clone, Copy, Default)]
struct DammNow {
    sqrt_price: u128,
    sqrt_max: u128,
    liquidity: u128,
    /// metrics.total_lp_b_fee + metrics.total_protocol_b_fee (every fee is in SOL in OnlyB mode)
    fee_total: u64,
    quote_reserve: u64,
    status: u8,
    fee: DammFee,
    fee_fp: u64,
}

fn read_damm(pool: &AccountView) -> R<Option<DammNow>> {
    use layout::damm as o;
    if !pool.owned_by(&DAMM) || pool.data_len() != o::LEN {
        return Ok(None);
    }
    let d = pool.try_borrow()?;
    if d[..8] != DAMM_POOL_DISC || d[o::COLLECT_FEE_MODE] != o::ONLY_B {
        return Ok(None);
    }
    let lp = rd_u128(&d, o::TOTAL_LP_B_FEE);
    let lp64 = if lp > u64::MAX as u128 { u64::MAX } else { lp as u64 };
    Ok(Some(DammNow {
        sqrt_price: rd_u128(&d, o::SQRT_PRICE),
        sqrt_max: rd_u128(&d, o::SQRT_MAX_PRICE),
        liquidity: rd_u128(&d, o::LIQUIDITY),
        fee_total: lp64.saturating_add(rd_u64(&d, o::TOTAL_PROTOCOL_B_FEE)),
        quote_reserve: rd_u64(&d, o::TOKEN_B_AMOUNT),
        status: d[o::POOL_STATUS],
        fee: damm_fee_of(&d),
        fee_fp: fee_fingerprint(&d),
    }))
}

/// The pool's fee configuration as 8 bytes: SHA-256 of the fee fields that only Meteora's operators can
/// change (base fee, protocol / referral / compounding split, the dynamic fee's switch and parameters,
/// [8..80]) and the collect mode, pool type and fee version [484..487]; the dynamic fee's moving state is
/// left out. Mirrors `feeFingerprint` in chain.js.
fn fee_fingerprint(d: &[u8]) -> u64 {
    let mut out = [0u8; 32];
    #[cfg(target_os = "solana")]
    unsafe {
        let slices: [&[u8]; 2] = [&d[8..80], &d[484..487]];
        pinocchio::syscalls::sol_sha256(slices.as_ptr() as *const u8, 2, out.as_mut_ptr());
    }
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(d);
    let mut b = [0u8; 8];
    b.copy_from_slice(&out[..8]);
    u64::from_le_bytes(b)
}

/// What a tick reads, from either pool.
#[derive(Clone, Copy, Default)]
struct Reading {
    sqrt_price: u128,
    fee_total: u64,
    /// the DBC pool's unclaimed creator fee (the curve phase; 0 on DAMM v2)
    creator_fee: u64,
    quote_reserve: u64,
    fee_num: u64,
    status: u8,
    liquidity: u128,
    fee_fp: u64,
    plain: bool,
}

fn read_any(st: &State, pool_a: &AccountView, now: i64) -> R<Option<Reading>> {
    if st.phase == phase::POOL {
        Ok(read_damm(pool_a)?.map(|p| Reading {
            sqrt_price: p.sqrt_price,
            fee_total: p.fee_total,
            creator_fee: 0,
            quote_reserve: p.quote_reserve,
            fee_num: p.fee.numerator(),
            status: p.status,
            liquidity: p.liquidity,
            fee_fp: p.fee_fp,
            plain: p.fee.plain(),
        }))
    } else {
        Ok(read_pool(pool_a)?.map(|p| Reading {
            sqrt_price: p.sqrt_price,
            fee_total: p.fee_total,
            creator_fee: p.creator_fee,
            quote_reserve: p.quote_reserve,
            fee_num: live_fee(st, now),
            status: 0,
            liquidity: 0,
            fee_fp: 0,
            plain: true,
        }))
    }
}

/// System program CPIs.
fn create_pda(payer: &AccountView, target: &AccountView, owner: &Address, space: usize, seeds: &[Seed]) -> ProgramResult {
    let rent = Rent::get()?.try_minimum_balance(space)?;
    let signer = [Signer::from(seeds)];
    let have = target.lamports();
    if have == 0 {
        let mut d = [0u8; 52];
        d[4..12].copy_from_slice(&rent.to_le_bytes());
        d[12..20].copy_from_slice(&(space as u64).to_le_bytes());
        d[20..52].copy_from_slice(owner.as_ref());
        let metas = [InstructionAccount::writable_signer(payer.address()), InstructionAccount::writable_signer(target.address())];
        return invoke_signed::<2, &AccountView>(&InstructionView { program_id: &SYSTEM, data: &d, accounts: &metas }, &[payer, target], &signer);
    }
    // someone sent lamports to the address first: top up, allocate and assign instead
    if have < rent {
        transfer(payer, target, rent - have)?;
    }
    let mut d = [0u8; 12];
    d[0] = 8;
    d[4..12].copy_from_slice(&(space as u64).to_le_bytes());
    let metas = [InstructionAccount::writable_signer(target.address())];
    invoke_signed::<1, &AccountView>(&InstructionView { program_id: &SYSTEM, data: &d, accounts: &metas }, &[target], &signer)?;
    let mut d = [0u8; 36];
    d[0] = 1;
    d[4..36].copy_from_slice(owner.as_ref());
    invoke_signed::<1, &AccountView>(&InstructionView { program_id: &SYSTEM, data: &d, accounts: &metas }, &[target], &signer)
}

fn transfer(from: &AccountView, to: &AccountView, lamports: u64) -> ProgramResult {
    let mut d = [0u8; 12];
    d[0] = 2;
    d[4..12].copy_from_slice(&lamports.to_le_bytes());
    let metas = [InstructionAccount::writable_signer(from.address()), InstructionAccount::writable(to.address())];
    invoke::<2, &AccountView>(&InstructionView { program_id: &SYSTEM, data: &d, accounts: &metas }, &[from, to])
}

/// The associated token account of `owner` for `mint`, created if missing (the caller pays).
fn create_ata(payer: &AccountView, ata: &AccountView, owner: &AccountView, mint: &AccountView, system: &AccountView, token: &AccountView) -> ProgramResult {
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(ata.address()),
        InstructionAccount::readonly(owner.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::readonly(system.address()),
        InstructionAccount::readonly(token.address()),
    ];
    invoke::<6, &AccountView>(&InstructionView { program_id: &ATA, data: &[1], accounts: &metas }, &[payer, ata, owner, mint, system, token])
}

/// The signer is the program's upgrade authority (named in its ProgramData account).
fn check_upgrade_authority(program_id: &Address, authority: &AccountView, programdata: &AccountView, bump: u8) -> ProgramResult {
    let expected = Address::create_program_address(&[program_id.as_ref(), &[bump]], &LOADER_V3).map_err(|_| ProgramError::InvalidSeeds)?;
    if programdata.address() != &expected || !programdata.owned_by(&LOADER_V3) || !authority.is_signer() {
        return Err(fail(err::NOT_AUTHORITY));
    }
    let d = programdata.try_borrow()?;
    // UpgradeableLoaderState::ProgramData: u32 tag 3, slot u64, Option<Pubkey> (tag at 12, key at 13..45)
    if d.len() < 45 || rd_u32(&d, 0) != 3 || d[12] != 1 || &d[13..45] != authority.address().as_ref() {
        return Err(fail(err::NOT_AUTHORITY));
    }
    Ok(())
}

/// An event: a self-CPI whose data is the payload, signed by the event authority PDA. The instructions
/// sysvar rides along so the event handler can check that Hunch itself is the caller.
fn emit(program_id: &Address, event_authority: &AccountView, sysvar: &AccountView, bump: u8, payload: &[u8]) -> ProgramResult {
    let bump_seed = [bump];
    let seeds = [Seed::from(seeds::EVENT_AUTHORITY), Seed::from(&bump_seed)];
    let signer = [Signer::from(&seeds)];
    let metas = [InstructionAccount::readonly_signer(event_authority.address()), InstructionAccount::readonly(sysvar.address())];
    invoke_signed::<2, &AccountView>(&InstructionView { program_id, data: payload, accounts: &metas }, &[event_authority, sysvar], &signer)
}

fn memo(memo_program: &AccountView, line: &[u8]) -> ProgramResult {
    let _ = memo_program;
    invoke::<0, &AccountView>(&InstructionView { program_id: &MEMO, data: line, accounts: &[] }, &[])
}

// ------------------------------------------------------------------------------------------------
// event (self-CPI only)
// ------------------------------------------------------------------------------------------------

/// Accepts an event only from Hunch itself: a signed authority, at stack height 2 under a top-level Hunch
/// instruction (at height 2 the caller is the top-level program, and Hunch invokes no program that could
/// call back). Without this, any program could CPI fake events into Hunch's inner instructions. Readers
/// still check the event authority's address.
fn event(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [authority, sysvar, ..] = &*accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !authority.is_signer() || stack_height() != 2 {
        return Err(fail(err::NOT_EVENT_AUTHORITY));
    }
    let instructions = Instructions::try_from(sysvar)?;
    let top = instructions.load_instruction_at(instructions.load_current_index() as usize)?;
    if top.get_program_id() != program_id {
        return Err(fail(err::NOT_EVENT_AUTHORITY));
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// initialize
// ------------------------------------------------------------------------------------------------

/// `initialize(mint, seed, bumps, ticker)`, once, by the upgrade authority.
/// Data: tag, mint [32], seed u32, bumps: programdata, state, model, tape, signal, diary, book, budget,
/// event authority [9], ticker length u8 (1 to 10), ticker (A-Z, 0-9) [length]; exactly 47 + length bytes.
/// Accounts: 0 authority (signer, writable, pays), 1 programdata, 2 state, 3 model, 4 tape, 5 signal,
/// 6 diary, 7 book (all writable), 8 budget, 9 budget WSOL account (writable), 10 WSOL mint,
/// 11 system program, 12 token program, 13 associated token program, 14 event authority.
fn initialize(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [authority, programdata, state_a, model_a, tape_a, signal_a, diary_a, book_a, budget, wsol_acc, wsol_mint, system, token, ata, event_a, ..] =
        &mut *accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() < 1 + 32 + 4 + 9 + 1 || data.len() != 47 + data[46] as usize {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut mint = [0u8; 32];
    mint.copy_from_slice(&data[1..33]);
    let seed = rd_u32(data, 33);
    let b = &data[37..46];
    let ticker = &data[47..];
    check_upgrade_authority(program_id, authority, programdata, b[0])?;
    if !ticker_ok(ticker) {
        return Err(fail(err::BAD_TICKER));
    }
    if !state_a.is_data_empty() || state_a.owned_by(program_id) {
        return Err(fail(err::ALREADY_INITIALIZED));
    }
    expect_id(wsol_mint, &WSOL)?;
    expect_id(system, &SYSTEM)?;
    expect_id(token, &TOKEN)?;
    expect_id(ata, &ATA)?;
    // canonical bumps only: with another bump the authority could initialize a second Hunch (state,
    // budget, diary...) at other addresses, and tick and the buys would accept its state too
    let pda = |seed_: &[u8], bump: u8| -> R<Address> {
        let (address, canonical) = Address::find_program_address(&[seed_], program_id);
        if bump != canonical {
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(address)
    };
    let list: [(&AccountView, &[u8], u8, usize); 6] = [
        (state_a, seeds::STATE, b[1], STATE_LEN),
        (model_a, seeds::MODEL, b[2], MODEL_LEN),
        (tape_a, seeds::TAPE, b[3], TAPE_LEN),
        (signal_a, seeds::SIGNAL, b[4], SIGNAL_LEN),
        (diary_a, seeds::DIARY, b[5], DIARY_LEN),
        (book_a, seeds::BOOK, b[6], BOOK_INITIAL_LEN),
    ];
    for (acc, s, bump, len) in list.iter() {
        if acc.address() != &pda(s, *bump)? {
            return Err(fail(err::WRONG_ACCOUNT));
        }
        let bump_seed = [*bump];
        let seeds_ = [Seed::from(*s), Seed::from(&bump_seed)];
        create_pda(authority, acc, program_id, *len, &seeds_)?;
    }
    if budget.address() != &pda(seeds::BUDGET, b[7])? || event_a.address() != &pda(seeds::EVENT_AUTHORITY, b[8])? {
        return Err(fail(err::WRONG_ACCOUNT));
    }
    // the budget's WSOL account (the associated token program checks its address)
    create_ata(authority, wsol_acc, budget, wsol_mint, system, token)?;

    {
        let mut md = model_a.try_borrow_mut()?;
        md[..8].copy_from_slice(&MODEL_TAG);
        let m = as_model(&mut md);
        m.reset(seed);
    }
    let brain_hash = {
        let md = model_a.try_borrow()?;
        sha256(&md[WEIGHTS_OFFSET..WEIGHTS_OFFSET + N_WEIGHTS * 4])
    };
    {
        let mut d = tape_a.try_borrow_mut()?;
        d[..8].copy_from_slice(&TAPE_TAG);
    }
    {
        let mut d = signal_a.try_borrow_mut()?;
        d[..8].copy_from_slice(&SIGNAL_TAG);
        d[sig::VERSION] = 1;
        d[sig::MULT] = 10;
    }
    {
        let mut d = diary_a.try_borrow_mut()?;
        d[..8].copy_from_slice(&DIARY_TAG);
    }
    {
        let mut d = book_a.try_borrow_mut()?;
        d[..8].copy_from_slice(&BOOK_TAG);
        wr_u32(&mut d, 12, BOOK_STEP as u32);
    }
    let mut sd = state_a.try_borrow_mut()?;
    let st = as_state(&mut sd);
    st.tag = STATE_TAG;
    st.version = 1;
    st.phase = phase::SETUP;
    st.budget_bump = b[7];
    st.event_bump = b[8];
    st.mint = mint;
    st.budget.copy_from_slice(budget.address().as_ref());
    st.budget_wsol.copy_from_slice(wsol_acc.address().as_ref());
    st.model.copy_from_slice(model_a.address().as_ref());
    st.tape.copy_from_slice(tape_a.address().as_ref());
    st.signal.copy_from_slice(signal_a.address().as_ref());
    st.diary.copy_from_slice(diary_a.address().as_ref());
    st.book.copy_from_slice(book_a.address().as_ref());
    st.event_authority.copy_from_slice(event_a.address().as_ref());
    st.seed = seed;
    st.brain_hash = brain_hash;
    st.own_ratio = Q32 as u64;
    st.ticker[..ticker.len()].copy_from_slice(ticker);
    Ok(())
}

/// `load_brain(weights[169])`: optional, by the upgrade authority, before adopt_curve. Only the 81
/// chapter-0 numbers may differ from the launch values (inputs 9-10 zero, layer 2 the identity).
/// Accounts: 0 authority (signer), 1 programdata, 2 state (w), 3 model (w). Data: tag, programdata bump, 676 bytes.
fn load_brain(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [authority, programdata, state_a, model_a, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != 2 + N_WEIGHTS * 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    check_upgrade_authority(program_id, authority, programdata, data[1])?;
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    if st.phase != phase::SETUP {
        return Err(fail(err::WRONG_PHASE));
    }
    expect(model_a, &st.model)?;
    let mut q = [0i32; N_WEIGHTS];
    for (k, v) in q.iter_mut().enumerate() {
        *v = rd_u32(data, 2 + 4 * k) as i32;
    }
    let w = Weights::from_flat(&q);
    if !w.frozen_parts_at_launch() || q.iter().any(|v| (*v as i64).abs() > 8 * 65_536) {
        return Err(fail(err::BAD_BRAIN));
    }
    let mut md = own(program_id, model_a, MODEL_LEN, &MODEL_TAG)?;
    as_model(&mut md).weights = w;
    st.brain_hash = sha256(&data[2..]);
    st.brain_source = 1;
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// adopt_curve
// ------------------------------------------------------------------------------------------------

/// `adopt_curve()`: anyone, once, while the curve is live. Checks the DBC pool and its config against
/// the compiled values, pins them (the fee schedule, the migration threshold and migration sqrt price), and
/// creates the budget's HUNCH account (the caller pays its rent).
/// Accounts: 0 payer (signer, w), 1 state (w), 2 signal (w), 3 book (w), 4 DBC pool, 5 DBC config,
/// 6 HUNCH mint, 7 budget, 8 budget HUNCH account (w), 9 system, 10 token, 11 associated token program.
fn adopt_curve(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, state_a, signal_a, book_a, pool_a, config_a, mint_a, budget, hunch_acc, system, token, ata, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    expect_id(system, &SYSTEM)?;
    expect_id(token, &TOKEN)?;
    expect_id(ata, &ATA)?;
    let now = Clock::get()?.unix_timestamp;
    let (budget_key, mint_key) = {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        let st = as_state_ro(&sd);
        if st.phase != phase::SETUP {
            return Err(fail(err::WRONG_PHASE));
        }
        expect(budget, &st.budget)?;
        expect(mint_a, &st.mint)?;
        expect(signal_a, &st.signal)?;
        expect(book_a, &st.book)?;
        (st.budget, st.mint)
    };
    // the pool: Meteora's, this mint, created by (or handed to) the budget PDA, not migrated
    if !pool_a.owned_by(&DBC) || pool_a.data_len() != layout::pool::LEN || !config_a.owned_by(&DBC) || config_a.data_len() != layout::config::LEN {
        return Err(fail(err::POOL_MISMATCH));
    }
    let (base_vault, quote_vault, activation) = {
        let p = pool_a.try_borrow()?;
        let ok = p[..8] == VIRTUAL_POOL_DISC
            && p[layout::pool::CONFIG..layout::pool::CONFIG + 32] == *config_a.address().as_ref()
            && p[layout::pool::CREATOR..layout::pool::CREATOR + 32] == budget_key
            && p[layout::pool::BASE_MINT..layout::pool::BASE_MINT + 32] == mint_key
            && p[layout::pool::POOL_TYPE] == 0
            && p[layout::pool::IS_MIGRATED] == 0;
        if !ok {
            return Err(fail(err::POOL_MISMATCH));
        }
        let mut bv = [0u8; 32];
        let mut qv = [0u8; 32];
        bv.copy_from_slice(&p[layout::pool::BASE_VAULT..layout::pool::BASE_VAULT + 32]);
        qv.copy_from_slice(&p[layout::pool::QUOTE_VAULT..layout::pool::QUOTE_VAULT + 32]);
        (bv, qv, rd_u64(&p, layout::pool::ACTIVATION_POINT))
    };
    let (threshold, migration_sqrt) = {
        let c = config_a.try_borrow()?;
        check_config(&c, &budget_key)?;
        (rd_u64(&c, layout::config::MIGRATION_QUOTE_THRESHOLD), rd_u128(&c, layout::config::MIGRATION_SQRT_PRICE))
    };
    if mint_a.owned_by(&TOKEN) == false {
        return Err(fail(err::POOL_MISMATCH));
    }
    create_ata(payer, hunch_acc, budget, mint_a, system, token)?;

    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    st.pool.copy_from_slice(pool_a.address().as_ref());
    st.config.copy_from_slice(config_a.address().as_ref());
    st.base_vault = base_vault;
    st.quote_vault = quote_vault;
    st.budget_hunch.copy_from_slice(hunch_acc.address().as_ref());
    st.activation_point = activation;
    st.cliff_fee = compiled::CLIFF_FEE_NUMERATOR;
    st.reduction = compiled::REDUCTION_FACTOR;
    st.period_frequency = compiled::PERIOD_FREQUENCY;
    st.n_periods = compiled::NUMBER_OF_PERIOD as u64;
    st.migration_quote_threshold = threshold;
    st.migration_sqrt_price = split_u128(migration_sqrt);
    st.launch_ts = now;
    st.launch_hour = (now / HOUR) as u32;
    st.phase = phase::CURVE;
    st.own_ratio = Q32 as u64;
    {
        let mut d = own(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
        d[sig::PHASE] = phase::CURVE;
    }
    let mut d = own(program_id, book_a, BOOK_HEADER, &BOOK_TAG)?;
    wr_u32(&mut d, 8, (now / DAY) as u32);
    Ok(())
}

/// The config equals the compiled values: the 5-second schedule ending at 375 bps, creator share 33,
/// QuoteToken fees, no dynamic fee, timestamp activation, DAMM v2 migration with a Customizable 375 bps
/// pool and no migration fee, LP 67/33 permanently locked, leftover to the budget PDA, immutable
/// metadata, a plain 6-decimal SPL token against WSOL, no vesting, no creation fee.
/// The first-swap-with-min-fee flag may be on or off: DBC (0.1.9 on, source and the 0.2.2 bytecode in
/// LiteSVM) gives the min fee (the schedule's 3.75% end) only to the pool's first swap, made top level, with
/// no referral, in the same transaction as, and after, the instruction that initialized the pool. Only the
/// pool's creator signs that transaction, so the developer's optional first buy can pay 3.75% there; no
/// outside trader can, and every later swap pays the opening schedule as usual.
fn check_config(c: &[u8], budget: &[u8; 32]) -> ProgramResult {
    use layout::config as o;
    let ok = c[..8] == POOL_CONFIG_DISC
        && c[o::QUOTE_MINT..o::QUOTE_MINT + 32] == *WSOL.as_ref()
        && c[o::LEFTOVER_RECEIVER..o::LEFTOVER_RECEIVER + 32] == *budget
        && rd_u64(c, o::CLIFF_FEE_NUMERATOR) == compiled::CLIFF_FEE_NUMERATOR
        && rd_u64(c, o::SECOND_FACTOR) == compiled::PERIOD_FREQUENCY
        && rd_u64(c, o::THIRD_FACTOR) == compiled::REDUCTION_FACTOR
        && rd_u16(c, o::FIRST_FACTOR) == compiled::NUMBER_OF_PERIOD
        && c[o::BASE_FEE_MODE] == compiled::BASE_FEE_MODE_LINEAR
        && c[o::DYNAMIC_FEE_INITIALIZED] == 0
        && c[o::PARTNER_VESTING_INITIALIZED] == 0
        && c[o::CREATOR_VESTING_INITIALIZED] == 0
        && c[o::COLLECT_FEE_MODE] == compiled::COLLECT_FEE_MODE_QUOTE
        && c[o::MIGRATION_OPTION] == compiled::MIGRATION_DAMM_V2
        && c[o::ACTIVATION_TYPE] == compiled::ACTIVATION_TIMESTAMP
        && c[o::TOKEN_DECIMAL] == compiled::TOKEN_DECIMALS
        && c[o::TOKEN_TYPE] == compiled::TOKEN_TYPE_SPL
        && c[o::QUOTE_TOKEN_FLAG] == 0
        && c[o::PARTNER_LOCKED_PCT] == compiled::PARTNER_LOCKED_PCT
        && c[o::PARTNER_LIQUIDITY_PCT] == 0
        && c[o::CREATOR_LOCKED_PCT] == compiled::CREATOR_LOCKED_PCT
        && c[o::CREATOR_LIQUIDITY_PCT] == 0
        && c[o::MIGRATION_FEE_OPTION] == compiled::MIGRATION_FEE_CUSTOMIZABLE
        && c[o::CREATOR_TRADING_FEE_PCT] == compiled::CREATOR_TRADING_FEE_PCT
        && c[o::TOKEN_UPDATE_AUTHORITY] == compiled::TOKEN_UPDATE_IMMUTABLE
        && c[o::MIGRATION_FEE_PCT] == 0
        && c[o::CREATOR_MIGRATION_FEE_PCT] == 0
        && rd_u64(c, o::VESTING_AMOUNT_PER_PERIOD) == 0
        && rd_u64(c, o::VESTING_CLIFF_UNLOCK) == 0
        && c[o::MIGRATED_COLLECT_FEE_MODE] == 0
        && c[o::MIGRATED_DYNAMIC_FEE] == 0
        && rd_u16(c, o::MIGRATED_POOL_FEE_BPS) == compiled::MIGRATED_POOL_FEE_BPS
        && c[o::MIGRATED_POOL_BASE_FEE_MODE] == 0
        && c[o::ENABLE_FIRST_SWAP_WITH_MIN_FEE] <= 1
        && rd_u16(c, o::MIGRATED_COMPOUNDING_FEE_BPS) == 0
        && rd_u64(c, o::POOL_CREATION_FEE) == 0;
    if ok {
        Ok(())
    } else {
        Err(fail(err::CONFIG_MISMATCH))
    }
}

// ------------------------------------------------------------------------------------------------
// tick
// ------------------------------------------------------------------------------------------------

/// What a tick has to emit after its account borrows end.
struct TickOut {
    line: Line,
    line_on: bool,
    chapter_line: &'static [u8],
    diary_ev: [u8; 2 + DIARY_ENTRY],
    diary_on: bool,
    bar_ev: [u8; 2 + TAPE_ENTRY + 32],
    weights_day: Option<u32>,
    event_bump: u8,
}

/// `tick()`: anyone, top level and alone, in the first 30 seconds of a 10-minute bar, once per bar.
/// Accounts: 0 state (w), 1 model (w), 2 tape (w), 3 signal (w), 4 diary (w), 5 book (w), 6 DBC pool (after adopt_pool: the DAMM v2 pool),
/// 7 budget WSOL account, 8 instructions sysvar, 9 memo program, 10 event authority, 11 Hunch program.
fn tick(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [state_a, model_a, tape_a, signal_a, diary_a, book_a, pool_a, wsol_a, sysvar, memo_a, event_a, prog, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_alone(program_id, sysvar)?;
    expect_id(memo_a, &MEMO)?;
    expect_id(prog, program_id)?;
    let clock = Clock::get()?;
    let mut out = tick_update(program_id, state_a, model_a, tape_a, signal_a, diary_a, book_a, pool_a, wsol_a, event_a, clock.unix_timestamp, clock.slot)?;

    out.bar_ev[0] = tag::EVENT;
    out.bar_ev[1] = event::BAR;
    emit(program_id, event_a, sysvar, out.event_bump, &out.bar_ev)?;
    if out.diary_on {
        out.diary_ev[0] = tag::EVENT;
        out.diary_ev[1] = event::DIARY;
        emit(program_id, event_a, sysvar, out.event_bump, &out.diary_ev)?;
    }
    if let Some(day) = out.weights_day {
        emit_weights(program_id, event_a, sysvar, out.event_bump, model_a, day)?;
    }
    if out.line_on {
        memo(memo_a, out.line.as_bytes())?;
    }
    if !out.chapter_line.is_empty() {
        memo(memo_a, out.chapter_line)?;
    }
    Ok(())
}

#[inline(never)]
fn emit_weights(program_id: &Address, event_a: &AccountView, sysvar: &AccountView, bump: u8, model_a: &AccountView, day: u32) -> ProgramResult {
    let mut buf = [0u8; 6 + N_WEIGHTS * 4];
    buf[0] = tag::EVENT;
    buf[1] = event::WEIGHTS;
    wr_u32(&mut buf, 2, day);
    {
        let md = model_a.try_borrow()?;
        buf[6..].copy_from_slice(&md[WEIGHTS_OFFSET..WEIGHTS_OFFSET + N_WEIGHTS * 4]);
    }
    emit(program_id, event_a, sysvar, bump, &buf)
}

/// The scoring of the hour(s) that ended at a boundary tick.
#[derive(Default)]
struct Scored {
    /// Hours since the last boundary tick (0 at the first one).
    k: u32,
    outcome: u8,
    flags: u16,
    detail: u8,
    came: u8,
    ended_call: u8,
    ended_lean: u16,
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn tick_update(
    program_id: &Address,
    state_a: &mut AccountView,
    model_a: &mut AccountView,
    tape_a: &mut AccountView,
    signal_a: &mut AccountView,
    diary_a: &mut AccountView,
    book_a: &mut AccountView,
    pool_a: &AccountView,
    wsol_a: &AccountView,
    event_a: &AccountView,
    now: i64,
    slot: u64,
) -> R<TickOut> {
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    expect(model_a, &st.model)?;
    expect(tape_a, &st.tape)?;
    expect(signal_a, &st.signal)?;
    expect(diary_a, &st.diary)?;
    expect(book_a, &st.book)?;
    // the DBC pool until adopt_pool, then the DAMM v2 pool
    expect(pool_a, if st.phase == phase::POOL { &st.damm_pool } else { &st.pool })?;
    expect(wsol_a, &st.budget_wsol)?;
    expect(event_a, &st.event_authority)?;
    if st.phase != phase::CURVE && st.phase != phase::GRADUATING && st.phase != phase::POOL {
        return Err(fail(err::WRONG_PHASE));
    }
    let sec = now.rem_euclid(BAR);
    let bar = (now / BAR) as u32;
    if sec >= WINDOW {
        return Err(fail(err::OUTSIDE_WINDOW));
    }
    if bar <= st.last_attempt_bar {
        return Err(fail(err::ALREADY_TICKED));
    }
    if now < st.activation_point as i64 + OPENING_SECONDS {
        return Err(fail(err::TOO_EARLY));
    }
    let mut out = TickOut {
        line: Line::default(),
        line_on: false,
        chapter_line: b"",
        diary_ev: [0; 2 + DIARY_ENTRY],
        diary_on: false,
        bar_ev: [0; 2 + TAPE_ENTRY + 32],
        weights_day: None,
        event_bump: st.event_bump,
    };
    let hh = (now / HOUR) as u32;
    let utc_hour = (now.rem_euclid(DAY) / HOUR) as u8;
    let boundary = bar % H as u32 == 0;
    let mut sgd = own(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
    let mut tp = own(program_id, tape_a, TAPE_LEN, &TAPE_TAG)?;

    let pool = match read_any(st, pool_a, now)? {
        Some(p) => p,
        None => {
            // blind: the pool's layout is not the adopted one. No reading, no learning, no call.
            st.blind = 1;
            st.last_attempt_bar = bar;
            let mut e = [0u8; TAPE_ENTRY];
            wr_u32(&mut e, 0, bar);
            e[4] = sec as u8;
            e[5] = utc_hour;
            wr_u16(&mut e, 6, tf::BLIND);
            wr_u64(&mut e, 24, st.cum);
            tape_push(&mut tp, &e);
            out.bar_ev[2..2 + TAPE_ENTRY].copy_from_slice(&e);
            sgd[sig::PHASE] = phase::BLIND;
            sgd[sig::FLAGS] |= sf::BLIND;
            if boundary {
                st.blind_until_hour = hh;
                let entry = Entry {
                    hour: (hh - 1).saturating_sub(st.launch_hour),
                    unix_hour: hh - 1,
                    slot,
                    outcome: outcome::NOT_SCORED,
                    n: st.n,
                    hits: st.hits,
                    rule_hits: st.rule_hits,
                    phase: phase::BLIND,
                    chapter: st.chapter,
                    flags: df::BLIND,
                    held: 0,
                    ..Entry::default()
                };
                let mut dd = own(program_id, diary_a, DIARY_LEN, &DIARY_TAG)?;
                diary_push(&mut dd, &entry);
                entry.write(&mut out.diary_ev[2..]);
                out.diary_on = true;
                out.line = diary_line(&entry, ticker_of(st));
                out.line_on = true;
                sgd[sig::CALL] = call::NONE;
                wr_u32(&mut sgd, sig::UNIX_HOUR, hh);
                // the blind hours are not owed a score: the next boundary starts afresh
                st.last_boundary_hour = hh;
                st.last_boundary_ts = now;
                st.last_boundary_cum = st.cum;
                st.ref_secs = 0;
            }
            return Ok(out);
        }
    };
    st.blind = 0;
    let fee_num = pool.fee_num;
    let fee_bps_now = fee_bps(fee_num);
    // on DAMM v2: what Meteora did since the last tick (a fee configuration that changed or that Hunch
    // cannot model, a pause now or at the last tick) marks the boundary interval being measured
    if st.phase == phase::POOL {
        if pool.fee_fp != st.last_fee_fp || !pool.plain {
            st.dist_cur |= dist::FEE;
        }
        if pool.status != 0 || st.last_status != 0 {
            st.dist_cur |= dist::PAUSE;
        }
    }
    let mut tflags: u16 = 0;
    let mut ret_q: i64 = 0;
    let day = (now / DAY) as u32;
    let day_due = day + 1 > st.last_record_day;
    let mut md = own(program_id, model_a, MODEL_LEN, &MODEL_TAG)?;
    let model = as_model(&mut md);
    let mut ev_lam: u64 = 0;
    let mut ev_p: i64 = -1;

    if st.ticks == 0 {
        // the baseline tick: it reads the pool and starts the tape; it feeds nothing
        st.start_hour = hh;
        tflags |= tf::BASELINE;
    } else {
        let elapsed = now - st.last_tick_ts;
        let missed = bar - st.last_tick_bar - 1;
        let fee_delta = pool.fee_total.saturating_sub(st.last_fee_total);
        let outside = fee_delta - if st.own_fee < fee_delta { st.own_fee } else { fee_delta };
        let vol = volume_of(outside, fee_num);
        let lam = per_bar(vol, elapsed);
        let ratio = outside_ratio(ratio_q32(pool.sqrt_price, u128_of(st.last_sp)), st.own_ratio);
        ret_q = ret_from_ratio(ratio);
        st.cum = st.cum.saturating_add(vol);
        if missed > 0 {
            tflags |= tf::GAP;
        }
        // a bar nobody ticked (blind ticks were attempts: the pool's layout, not a cranker, stopped them)
        if bar > st.last_attempt_bar + 1 {
            st.last_missed_bar = bar - 1;
        }
        let mut chapter_changed = false;
        let mut sc = Scored::default();
        if boundary {
            let c = chapter_of(hh.saturating_sub(st.launch_hour));
            if c > st.chapter {
                st.chapter = c;
                chapter_changed = true;
            }
            sc = score(st, &sgd, now, hh, fee_bps_now);
        }
        let (x9, x10) = if st.chapter >= 1 {
            let x9 = match st.last_outcome {
                outcome::HIT => ONE as i32,
                outcome::MISS | outcome::FORFEIT => -(ONE as i32),
                _ => 0,
            };
            (x9, hit_rate_input(st.recent_bits, st.recent_len))
        } else {
            (0, 0)
        };
        let fills = if missed < MAX_FILL { missed } else { MAX_FILL };
        for k in 0..fills {
            let ts = (bar - fills + k) as i64 * BAR;
            model.feed(&Bar { ts, ret_q: 0, lam, x9: 0, x10: 0 }, true);
        }
        let step = model.step(&Bar { ts: bar as i64 * BAR, ret_q, lam, x9, x10 }, st.chapter);
        if step.learned.is_some() {
            tflags |= tf::LEARNED;
        }
        if let Some(f) = step.thought {
            tflags |= tf::HAS_CALL;
            if f.p >= ONE / 2 {
                tflags |= tf::BUSIER;
            }
            ev_p = f.p;
        }
        ev_lam = lam;
        if boundary {
            tflags |= tf::BOUNDARY;
            let hash = weights_hash(model);
            // a call needs the whole hour before it: when a tick in the 5 bars before this boundary was
            // missed, no call is made and the hour is forfeited, so skipping ticks to steer it never helps
            let gap = st.last_missed_bar != 0 && bar - st.last_missed_bar < H as u32;
            let (call_, lean, rule) = match (step.thought, step.x) {
                (Some(f), Some(x)) if !gap => (
                    if f.p >= ONE / 2 { call::BUSIER } else { call::QUIETER },
                    lean_bps(f.p),
                    if x[3] < 0 { call::BUSIER } else { call::QUIETER },
                ),
                _ => (call::NONE, 0, call::NONE),
            };
            let mult = multiplier(call_, lean);
            let wsol_amount = token_amount(wsol_a, WSOL.as_ref(), &st.budget)?;
            let budget = wsol_amount.saturating_add(pool.creator_fee);
            // the buy clause of the hour that ended
            let (mut bought, mut burned, mut held, mut flags, mut detail) = (0u64, 0u64, budget, sc.flags, sc.detail);
            // the buy clause, unless the hour's opening tick was missed (a forfeit of more than one hour)
            if !(sc.outcome == outcome::FORFEIT && sc.k > 1) && flags & df::GRADUATING == 0 {
                if st.hs_hour == hh - 1 && st.hs_reason == skip::NONE && st.hs_bought > 0 {
                    bought = st.hs_bought;
                    burned = st.hs_burned;
                    held = st.hs_held;
                } else if st.hs_hour == hh - 1 && st.hs_reason != skip::NONE {
                    held = st.hs_held;
                    flags |= match st.hs_reason {
                        skip::BELOW_MIN => df::BELOW_MIN,
                        skip::GUARD => df::GUARD,
                        skip::STALE => df::STALE,
                        skip::DAY_CAP => df::DAY_CAP,
                        _ => df::VOLUME_CAP,
                    };
                    if st.hs_reason == skip::GUARD {
                        detail = st.hs_detail;
                    }
                } else {
                    flags |= df::NO_ATTEMPT;
                }
            }
            // the graduation line rides on the first boundary after adopt_pool (a chapter change goes first)
            let grad_now = !chapter_changed && st.grad_line != 0;
            if chapter_changed || grad_now {
                flags |= df::CHAPTER;
            }
            if day_due {
                flags |= df::DAY_RECORD;
            }
            // what Meteora did in the hour that ended (score() just moved it to dist_prev)
            flags |= dist_flags(st.dist_prev);
            let held_units = held / 10_000;
            let entry = Entry {
                hour: (hh - 1).saturating_sub(st.launch_hour),
                unix_hour: hh - 1,
                slot,
                call: sc.ended_call,
                outcome: sc.outcome,
                lean: sc.ended_lean,
                n: st.n,
                hits: st.hits,
                rule_hits: st.rule_hits,
                next_lean: lean,
                next_call: call_,
                phase: st.phase,
                chapter: st.chapter,
                detail,
                flags,
                bought,
                burned,
                brain: [hash[0], hash[1], hash[2], hash[3]],
                held: if held_units > u32::MAX as u64 { u32::MAX } else { held_units as u32 },
            };
            {
                let mut dd = own(program_id, diary_a, DIARY_LEN, &DIARY_TAG)?;
                diary_push(&mut dd, &entry);
            }
            entry.write(&mut out.diary_ev[2..]);
            out.diary_on = true;
            out.line = diary_line(&entry, ticker_of(st));
            out.line_on = true;
            if chapter_changed {
                out.chapter_line = chapter_line(st.chapter);
            } else if grad_now {
                out.chapter_line = GRADUATION_LINE;
                st.grad_line = 0;
            }
            // the open call
            let s = &mut sgd[..];
            s[sig::PHASE] = st.phase;
            s[sig::CALL] = call_;
            s[sig::CHAPTER] = st.chapter;
            wr_u16(s, sig::LEAN, lean);
            s[sig::LAST_OUTCOME] = sc.outcome;
            // FEE_CHANGED / PAUSED: this call's reference hour saw Meteora act, so the call will not be scored
            s[sig::FLAGS] = (if sc.flags & df::WARMUP != 0 { sf::WARMUP } else { 0 })
                | (if gap { sf::GAP } else { 0 })
                | (if st.dist_prev & dist::FEE != 0 { sf::FEE_CHANGED } else { 0 })
                | (if st.dist_prev & dist::PAUSE != 0 { sf::PAUSED } else { 0 });
            wr_u32(s, sig::HOURS, hh.saturating_sub(st.launch_hour));
            wr_u32(s, sig::UNIX_HOUR, hh);
            wr_u64(s, sig::MADE_SLOT, slot);
            wr_u32(s, sig::N, st.n);
            wr_u32(s, sig::HITS, st.hits);
            wr_u32(s, sig::RULE_HITS, st.rule_hits);
            wr_u32(s, sig::BUSIER_HOURS, st.busier_hours);
            wr_u32(s, sig::QUIETER_CALLS, st.quieter_calls);
            wr_u32(s, sig::QUIETER_HITS, st.quieter_hits);
            wr_u32(s, sig::FORFEITS, st.forfeits);
            wr_u16(s, sig::LUCK_BAND, luck_band_bps(st.n));
            s[sig::MULT] = mult;
            s[sig::BRAIN..sig::BRAIN + 8].copy_from_slice(&hash[..8]);
            wr_u64(s, sig::BUDGET, budget);
            wr_u64(s, sig::PLANNED_SLICE, planned_slice(budget, mult));
            wr_u64(s, sig::SPENT, st.spent);
            wr_u64(s, sig::BURNED, st.burned);
            wr_u32(s, sig::BUYS, st.buys);
            wr_u32(s, sig::SKIPS, st.skips);
            wr_u16(s, sig::POOL_FEE_BPS, fee_bps_now);
            s[sig::POOL_STATUS] = pool.status;
            s[sig::RULE] = rule;
            s[sig::CAME] = sc.came;
            wr_u32(s, sig::NOT_SCORED, st.not_scored);
            // the curve completes: graduating from here on (no buys, hours not scored)
            if st.phase == phase::CURVE && pool.quote_reserve >= st.migration_quote_threshold {
                st.phase = phase::GRADUATING;
            }
        }
    }

    // the first landed tick of each UTC day: the brain record (and the weights, as an event)
    if day_due {
        st.last_record_day = day + 1;
        tflags |= tf::DAY_RECORD;
        let hash = weights_hash(model);
        let mut bd = own(program_id, book_a, BOOK_HEADER, &BOOK_TAG)?;
        let launch_day = rd_u32(&bd, 8);
        let capacity = rd_u32(&bd, 12) as usize;
        let idx = day.saturating_sub(launch_day) as usize;
        if idx < capacity && BOOK_HEADER + (idx + 1) * BOOK_RECORD <= bd.len() {
            let r = &mut bd[BOOK_HEADER + idx * BOOK_RECORD..BOOK_HEADER + (idx + 1) * BOOK_RECORD];
            wr_u16(r, 0, idx as u16);
            r[2] = st.chapter;
            r[3] = st.phase;
            wr_u32(r, 4, hh.saturating_sub(st.launch_hour));
            wr_u64(r, 8, slot);
            wr_i64(r, 16, now);
            wr_u32(r, 24, st.n);
            wr_u32(r, 28, st.hits);
            r[32..64].copy_from_slice(&hash);
            let written = rd_u32(&bd, 16) + 1;
            wr_u32(&mut bd, 16, written);
        }
        out.weights_day = Some(day);
    }

    // the tape
    let mut e = [0u8; TAPE_ENTRY];
    wr_u32(&mut e, 0, bar);
    e[4] = sec as u8;
    e[5] = utc_hour;
    wr_u16(&mut e, 6, tflags);
    wr_u128(&mut e, 8, pool.sqrt_price);
    wr_u64(&mut e, 24, st.cum);
    let r32 = if ret_q > i32::MAX as i64 { i32::MAX } else if ret_q < i32::MIN as i64 { i32::MIN } else { ret_q as i32 };
    wr_u32(&mut e, 32, r32 as u32);
    wr_u16(&mut e, 36, fee_bps_now);
    e[38] = pool.status;
    wr_u64(&mut e, 40, st.own_lamports);
    tape_push(&mut tp, &e);
    out.bar_ev[2..2 + TAPE_ENTRY].copy_from_slice(&e);
    wr_u64(&mut out.bar_ev, 2 + TAPE_ENTRY, ev_lam);
    wr_i64(&mut out.bar_ev, 2 + TAPE_ENTRY + 8, ev_p);
    wr_u64(&mut out.bar_ev, 2 + TAPE_ENTRY + 16, model.version);
    wr_u64(&mut out.bar_ev, 2 + TAPE_ENTRY + 24, pool.fee_total);

    st.last_tick_bar = bar;
    st.last_attempt_bar = bar;
    st.last_tick_ts = now;
    st.last_sp = split_u128(pool.sqrt_price);
    st.last_fee_total = pool.fee_total;
    st.own_fee = 0;
    st.own_ratio = Q32 as u64;
    st.own_lamports = 0;
    st.ticks += 1;
    if st.phase == phase::POOL {
        st.last_fee_fp = pool.fee_fp;
        st.last_status = pool.status;
        st.last_liquidity = split_u128(pool.liquidity);
    }
    Ok(out)
}

/// Diary flags for what Meteora did (dist bits).
fn dist_flags(d: u8) -> u16 {
    (if d & dist::FEE != 0 { df::FEE_CHANGED } else { 0 }) | (if d & dist::PAUSE != 0 { df::PAUSED } else { 0 })
}

fn tape_push(tp: &mut [u8], e: &[u8; TAPE_ENTRY]) {
    let head = rd_u32(tp, 8) as usize % TAPE_ENTRIES;
    let count = rd_u32(tp, 12);
    tp[TAPE_HEADER + head * TAPE_ENTRY..TAPE_HEADER + (head + 1) * TAPE_ENTRY].copy_from_slice(e);
    wr_u32(tp, 8, ((head + 1) % TAPE_ENTRIES) as u32);
    wr_u32(tp, 12, if (count as usize) < TAPE_ENTRIES { count + 1 } else { count });
}

fn diary_push(dd: &mut [u8], e: &Entry) {
    let head = rd_u32(dd, 8) as usize % DIARY_ENTRIES;
    let count = rd_u32(dd, 12);
    e.write(&mut dd[DIARY_HEADER + head * DIARY_ENTRY..DIARY_HEADER + (head + 1) * DIARY_ENTRY]);
    wr_u32(dd, 8, ((head + 1) % DIARY_ENTRIES) as u32);
    wr_u32(dd, 12, if (count as usize) < DIARY_ENTRIES { count + 1 } else { count });
    let total = rd_u64(dd, 16) + 1;
    wr_u64(dd, 16, total);
}

/// Score the hour(s) that ended at this boundary (before the network sees the bar, so inputs 9 and 10
/// read the newest outcome). Mirrors `score` in chain.js.
fn score(st: &mut State, sig_: &[u8], now: i64, hh: u32, fee_bps_now: u16) -> Scored {
    let mut sc = Scored::default();
    // the pool phase starts its own warm-up at adoption (pool_warm_end is 0 on the curve)
    let warm_end = if st.pool_warm_end > st.start_hour + WARM_HOURS { st.pool_warm_end } else { st.start_hour + WARM_HOURS };
    // Meteora changed the fee or paused the pool in the hour measured or in the hour it is measured against
    let disturbed = st.dist_cur | st.dist_prev;
    let blind_until = st.blind_until_hour;
    let owed = |h: u32| h >= warm_end && h > blind_until;
    if st.last_boundary_hour == 0 {
        sc.flags |= df::WARMUP;
    } else {
        let l = st.last_boundary_hour;
        let k = hh - l;
        sc.k = k;
        let iv = st.cum - st.last_boundary_cum;
        let is = (now - st.last_boundary_ts) as u64;
        let sig_hour = rd_u32(sig_, sig::UNIX_HOUR);
        let sig_call = sig_[sig::CALL];
        let sig_rule = sig_[sig::RULE];
        if k == 1 && sig_hour == l {
            sc.ended_call = sig_call;
            sc.ended_lean = rd_u16(sig_, sig::LEAN);
        }
        if st.phase == phase::GRADUATING {
            sc.outcome = outcome::NOT_SCORED;
            sc.flags |= df::GRADUATING;
            st.not_scored += 1;
        } else if k == 1 {
            if sig_hour == l && sig_call != call::NONE && st.ref_secs > 0 && owed(l) {
                if disturbed != 0 {
                    sc.outcome = outcome::NOT_SCORED;
                    sc.flags |= dist_flags(disturbed);
                    if disturbed & dist::FEE != 0 {
                        let steps = fee_bps_now / 5;
                        sc.detail = if steps > 255 { 255 } else { steps as u8 };
                    }
                    st.not_scored += 1;
                } else if iv == 0 && st.ref_vol == 0 {
                    sc.outcome = outcome::NOT_SCORED;
                    sc.flags |= df::NO_OUTSIDE;
                    st.not_scored += 1;
                } else {
                    let a = iv as u128 * st.ref_secs as u128;
                    let b = st.ref_vol as u128 * is as u128;
                    if a == b {
                        sc.outcome = outcome::NOT_SCORED;
                        sc.flags |= df::TIE;
                        st.not_scored += 1;
                    } else {
                        let came = if a > b { call::BUSIER } else { call::QUIETER };
                        let hit = came == sig_call;
                        sc.came = came;
                        st.n += 1;
                        st.hits += hit as u32;
                        st.rule_hits += (sig_rule == came) as u32;
                        st.busier_hours += (came == call::BUSIER) as u32;
                        if sig_call == call::QUIETER {
                            st.quieter_calls += 1;
                            st.quieter_hits += hit as u32;
                        }
                        sc.outcome = if hit { outcome::HIT } else { outcome::MISS };
                        st.last_outcome = sc.outcome;
                        let (bits, len) = push_recent(st.recent_bits, st.recent_len, hit);
                        st.recent_bits = bits;
                        st.recent_len = len;
                    }
                }
            } else if owed(l) {
                forfeit(st, &mut sc, 1);
            } else if blind_until != 0 && l <= blind_until {
                sc.flags |= df::BLIND;
                sc.outcome = outcome::NOT_SCORED;
            } else {
                sc.flags |= df::WARMUP;
            }
        } else {
            let mut lo = if l > warm_end { l } else { warm_end };
            if blind_until != 0 && lo <= blind_until {
                lo = blind_until + 1;
            }
            let count = hh.saturating_sub(lo);
            if count > 0 {
                forfeit(st, &mut sc, count);
            } else {
                sc.flags |= df::WARMUP;
            }
        }
        st.ref_vol = iv;
        st.ref_secs = is;
        let hv = iv as u128 * 3_600 / is as u128;
        st.hour_vol_prev = if hv > u64::MAX as u128 { u64::MAX } else { hv as u64 };
    }
    st.last_boundary_hour = hh;
    st.last_boundary_ts = now;
    st.last_boundary_cum = st.cum;
    // the interval just measured becomes the next one's reference
    st.dist_prev = st.dist_cur;
    st.dist_cur = 0;
    sc
}

fn forfeit(st: &mut State, sc: &mut Scored, count: u32) {
    sc.outcome = outcome::FORFEIT;
    sc.flags |= df::FORFEIT;
    sc.detail = if count > 255 { 255 } else { count as u8 };
    st.forfeits += count;
    st.n += count;
    st.last_outcome = outcome::FORFEIT;
    for _ in 0..(if count < 24 { count } else { 24 }) {
        let (bits, len) = push_recent(st.recent_bits, st.recent_len, false);
        st.recent_bits = bits;
        st.recent_len = len;
    }
}

// ------------------------------------------------------------------------------------------------
// claims (shared by the buy)
// ------------------------------------------------------------------------------------------------

struct DbcAccounts<'a> {
    budget: &'a AccountView,
    wsol_acc: &'a AccountView,
    hunch_acc: &'a AccountView,
    mint: &'a AccountView,
    wsol_mint: &'a AccountView,
    pool: &'a AccountView,
    config: &'a AccountView,
    base_vault: &'a AccountView,
    quote_vault: &'a AccountView,
    pool_authority: &'a AccountView,
    event_authority: &'a AccountView,
    dbc: &'a AccountView,
    token: &'a AccountView,
}

fn sync_native(wsol_acc: &AccountView) -> ProgramResult {
    let metas = [InstructionAccount::writable(wsol_acc.address())];
    invoke::<1, &AccountView>(&InstructionView { program_id: &TOKEN, data: &[17], accounts: &metas }, &[wsol_acc])
}

fn claim(a: &DbcAccounts, signer: &[Signer]) -> ProgramResult {
    let mut data = [0u8; 28];
    data[..8].copy_from_slice(&CLAIM_CREATOR_TRADING_FEE2);
    data[8..16].copy_from_slice(&u64::MAX.to_le_bytes());
    data[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
    // data[24..28]: an empty Vec of hook slices
    let metas = [
        InstructionAccount::readonly(a.pool_authority.address()),
        InstructionAccount::writable(a.pool.address()),
        InstructionAccount::writable(a.hunch_acc.address()),
        InstructionAccount::writable(a.wsol_acc.address()),
        InstructionAccount::writable(a.base_vault.address()),
        InstructionAccount::writable(a.quote_vault.address()),
        InstructionAccount::readonly(a.mint.address()),
        InstructionAccount::readonly(a.wsol_mint.address()),
        InstructionAccount::readonly_signer(a.budget.address()),
        InstructionAccount::readonly(a.token.address()),
        InstructionAccount::readonly(a.token.address()),
        InstructionAccount::readonly(a.event_authority.address()),
        InstructionAccount::readonly(a.dbc.address()),
    ];
    invoke_signed::<13, &AccountView>(
        &InstructionView { program_id: &DBC, data: &data, accounts: &metas },
        &[a.pool_authority, a.pool, a.hunch_acc, a.wsol_acc, a.base_vault, a.quote_vault, a.mint, a.wsol_mint, a.budget, a.token, a.token, a.event_authority, a.dbc],
        signer,
    )
}

fn swap(a: &DbcAccounts, signer: &[Signer], amount_in: u64, min_out: u64, mode: u8) -> ProgramResult {
    let mut data = [0u8; 25];
    data[..8].copy_from_slice(&SWAP2);
    data[8..16].copy_from_slice(&amount_in.to_le_bytes());
    data[16..24].copy_from_slice(&min_out.to_le_bytes());
    data[24] = mode;
    let metas = [
        InstructionAccount::readonly(a.pool_authority.address()),
        InstructionAccount::readonly(a.config.address()),
        InstructionAccount::writable(a.pool.address()),
        InstructionAccount::writable(a.wsol_acc.address()),
        InstructionAccount::writable(a.hunch_acc.address()),
        InstructionAccount::writable(a.base_vault.address()),
        InstructionAccount::writable(a.quote_vault.address()),
        InstructionAccount::readonly(a.mint.address()),
        InstructionAccount::readonly(a.wsol_mint.address()),
        InstructionAccount::readonly_signer(a.budget.address()),
        InstructionAccount::readonly(a.token.address()),
        InstructionAccount::readonly(a.token.address()),
        // no referral: Anchor reads the program's own id in an optional slot as None
        InstructionAccount::readonly(a.dbc.address()),
        InstructionAccount::readonly(a.event_authority.address()),
        InstructionAccount::readonly(a.dbc.address()),
    ];
    invoke_signed::<15, &AccountView>(
        &InstructionView { program_id: &DBC, data: &data, accounts: &metas },
        &[
            a.pool_authority, a.config, a.pool, a.wsol_acc, a.hunch_acc, a.base_vault, a.quote_vault, a.mint, a.wsol_mint, a.budget, a.token, a.token,
            a.dbc, a.event_authority, a.dbc,
        ],
        signer,
    )
}

fn check_dbc_accounts(st: &State, a: &DbcAccounts) -> ProgramResult {
    expect(a.budget, &st.budget)?;
    expect(a.wsol_acc, &st.budget_wsol)?;
    expect(a.hunch_acc, &st.budget_hunch)?;
    expect(a.mint, &st.mint)?;
    expect_id(a.wsol_mint, &WSOL)?;
    expect(a.pool, &st.pool)?;
    expect(a.config, &st.config)?;
    expect(a.base_vault, &st.base_vault)?;
    expect(a.quote_vault, &st.quote_vault)?;
    expect_id(a.pool_authority, &DBC_POOL_AUTHORITY)?;
    expect_id(a.event_authority, &DBC_EVENT_AUTHORITY)?;
    expect_id(a.dbc, &DBC)?;
    expect_id(a.token, &TOKEN)
}

/// `claim_curve_fees()`: anyone, any time after adoption. sync_native and the creator-fee claim into the
/// budget's WSOL account, nothing else. Only what the claim paid counts as claimed (SOL sent straight to
/// the WSOL account joins the budget through sync_native, but it is not a fee).
/// Accounts: 0 state (w), 1 budget, 2 budget WSOL (w), 3 budget HUNCH (w), 4 HUNCH mint, 5 WSOL mint,
/// 6 DBC pool (w), 7 DBC config, 8 base vault (w), 9 quote vault (w), 10 DBC pool authority,
/// 11 DBC event authority, 12 DBC program, 13 token program.
fn claim_curve_fees(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [state_a, budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, config, base_vault, quote_vault, pool_authority, dbc_ev, dbc, token, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let a = DbcAccounts { budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, config, base_vault, quote_vault, pool_authority, event_authority: dbc_ev, dbc, token };
    let bump = {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        let st = as_state_ro(&sd);
        if st.phase == phase::SETUP {
            return Err(fail(err::WRONG_PHASE));
        }
        check_dbc_accounts(st, &a)?;
        st.budget_bump
    };
    let bump_seed = [bump];
    let seeds_ = [Seed::from(seeds::BUDGET), Seed::from(&bump_seed)];
    let signer = [Signer::from(&seeds_)];
    sync_native(a.wsol_acc)?;
    let before = token_amount(a.wsol_acc, WSOL.as_ref(), a.budget.address().as_ref())?;
    claim(&a, &signer)?;
    let after = token_amount(a.wsol_acc, WSOL.as_ref(), a.budget.address().as_ref())?;
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    st.claimed = st.claimed.saturating_add(after.saturating_sub(before));
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// buy_and_burn_curve, buy_and_burn_pool (and what they share)
// ------------------------------------------------------------------------------------------------

/// The rules that make either buy fail outright (rate limits), after its accounts were checked: the
/// phase, the open call is this hour's and not blind, no buy yet this UTC hour, 30 minutes since the
/// last one. Returns the budget's and the event authority's bumps.
fn buy_gate(program_id: &Address, state_a: &AccountView, signal_a: &AccountView, tape_a: &AccountView, event_a: &AccountView, want: u8, now: i64) -> R<(u8, u8)> {
    let hh = (now / HOUR) as u32;
    let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state_ro(&sd);
    expect(signal_a, &st.signal)?;
    expect(tape_a, &st.tape)?;
    expect(event_a, &st.event_authority)?;
    if st.phase != want {
        return Err(fail(err::WRONG_PHASE));
    }
    let sgd = own_ro(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
    if rd_u32(&sgd, sig::UNIX_HOUR) != hh || sgd[sig::PHASE] == phase::BLIND {
        return Err(fail(err::NO_BOUNDARY_THIS_HOUR));
    }
    if st.last_buy_hour == hh {
        return Err(fail(err::ALREADY_BOUGHT_THIS_HOUR));
    }
    if st.last_buy_ts != 0 && now - st.last_buy_ts < BUY_GAP {
        return Err(fail(err::TOO_SOON));
    }
    Ok((st.budget_bump, st.event_bump))
}

fn burn_hunch(hunch_acc: &AccountView, mint: &AccountView, budget: &AccountView, signer: &[Signer], amount: u64) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = 8;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    let metas = [InstructionAccount::writable(hunch_acc.address()), InstructionAccount::writable(mint.address()), InstructionAccount::readonly_signer(budget.address())];
    invoke_signed::<3, &AccountView>(&InstructionView { program_id: &TOKEN, data: &data, accounts: &metas }, &[hunch_acc, mint, budget], signer)
}

/// After a swap: Hunch's own fee and price move (taken out of the next tick), the hour's buy for the
/// diary, the totals, the open call's money fields.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn record_buy(
    program_id: &Address,
    state_a: &mut AccountView,
    signal_a: &mut AccountView,
    now: i64,
    held: u64,
    left: u64,
    units: u64,
    donated: u64,
    claimed: u64,
    own_fee: u64,
    sp1: u128,
    sp2: u128,
    budget_now: u64,
) -> ProgramResult {
    let hh = (now / HOUR) as u32;
    let spent = held.saturating_sub(left);
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    st.own_fee = st.own_fee.saturating_add(own_fee);
    st.own_ratio = compose_own_ratio(st.own_ratio, sp1, sp2);
    st.own_lamports = st.own_lamports.saturating_add(spent);
    st.last_buy_hour = hh;
    st.last_buy_ts = now;
    st.day_buys += 1;
    st.day_spent = st.day_spent.saturating_add(spent);
    st.hs_hour = hh;
    st.hs_reason = skip::NONE;
    st.hs_detail = 0;
    st.hs_bought = spent;
    st.hs_burned = units;
    st.hs_held = held;
    st.spent = st.spent.saturating_add(spent);
    st.bought_units = st.bought_units.saturating_add(units - donated);
    st.burned = st.burned.saturating_add(units);
    st.donated = st.donated.saturating_add(donated);
    st.buys += 1;
    add_claimed(st, claimed);
    let mut sgd = own(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
    wr_u64(&mut sgd, sig::BUDGET, budget_now);
    wr_u64(&mut sgd, sig::SPENT, st.spent);
    wr_u64(&mut sgd, sig::BURNED, st.burned);
    wr_u32(&mut sgd, sig::BUYS, st.buys);
    sgd[sig::FLAGS] &= !(sf::GUARD | sf::VOLUME_CAP);
    Ok(())
}

/// What a claim brought in: the creator fee on the curve, the position's fee on the pool.
fn add_claimed(st: &mut State, claimed: u64) {
    if st.phase == phase::POOL {
        st.pool_claimed = st.pool_claimed.saturating_add(claimed);
    } else {
        st.claimed = st.claimed.saturating_add(claimed);
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_buy(program_id: &Address, event_a: &AccountView, sysvar: &AccountView, bump: u8, held: u64, spent: u64, units: u64, donated: u64, own_fee: u64, min_out: u64, sp1: u128, sp2: u128) -> ProgramResult {
    let mut ev = [0u8; 2 + 8 * 6 + 32];
    ev[0] = tag::EVENT;
    ev[1] = event::BUY;
    wr_u64(&mut ev, 2, held);
    wr_u64(&mut ev, 10, spent);
    wr_u64(&mut ev, 18, units);
    wr_u64(&mut ev, 26, donated);
    wr_u64(&mut ev, 34, own_fee);
    wr_u64(&mut ev, 42, min_out);
    wr_u128(&mut ev, 50, sp1);
    wr_u128(&mut ev, 66, sp2);
    emit(program_id, event_a, sysvar, bump, &ev)
}

#[allow(clippy::too_many_arguments)]
fn skip_and_emit(program_id: &Address, state_a: &mut AccountView, signal_a: &mut AccountView, event_a: &AccountView, sysvar: &AccountView, bump: u8, now: i64, held: u64, claimed: u64, reason: u8, detail: u8) -> ProgramResult {
    let hh = (now / HOUR) as u32;
    record_skip(program_id, state_a, signal_a, hh, held, claimed, reason, detail)?;
    let mut ev = [0u8; 20];
    ev[0] = tag::EVENT;
    ev[1] = event::SKIP;
    ev[2] = reason;
    ev[3] = detail;
    wr_u64(&mut ev, 4, held);
    wr_u32(&mut ev, 12, hh);
    emit(program_id, event_a, sysvar, bump, &ev)
}

/// `buy_and_burn_curve()`: anyone, top level and alone, once per UTC hour, at least 30 minutes after
/// the previous buy, only after that hour's boundary tick landed, while the curve is live. A call that
/// waits records why (the hour's first wait only: after it, a call that would wait again fails with
/// ALREADY_WAITED_THIS_HOUR, and one that can buy still buys).
/// Accounts: 0 state (w), 1 signal (w), 2 tape, 3 budget, 4 budget WSOL (w), 5 budget HUNCH (w),
/// 6 HUNCH mint (w), 7 WSOL mint, 8 DBC pool (w), 9 DBC config, 10 base vault (w), 11 quote vault (w),
/// 12 DBC pool authority, 13 DBC event authority, 14 DBC program, 15 token program,
/// 16 instructions sysvar, 17 Hunch event authority, 18 Hunch program.
fn buy_and_burn_curve(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [state_a, signal_a, tape_a, budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, config, base_vault, quote_vault, pool_authority, dbc_ev, dbc, token, sysvar, event_a, prog, ..] =
        &mut *accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_alone(program_id, sysvar)?;
    expect_id(prog, program_id)?;
    let a = DbcAccounts { budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, config, base_vault, quote_vault, pool_authority, event_authority: dbc_ev, dbc, token };
    let now = Clock::get()?.unix_timestamp;

    // ---- the rules that make a call fail outright (rate limits) ----
    {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        check_dbc_accounts(as_state_ro(&sd), &a)?;
    }
    let (budget_bump, event_bump) = buy_gate(program_id, state_a, signal_a, tape_a, event_a, phase::CURVE, now)?;
    let p0 = read_pool(a.pool)?.ok_or(fail(err::BLIND))?;
    let threshold = {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        as_state_ro(&sd).migration_quote_threshold
    };
    if p0.quote_reserve >= threshold {
        return Err(fail(err::CURVE_COMPLETE));
    }

    // ---- sync_native and the claim: SOL sent to the WSOL account joins the budget, and only what the
    //      claim paid counts as claimed ----
    let bump_seed = [budget_bump];
    let seeds_ = [Seed::from(seeds::BUDGET), Seed::from(&bump_seed)];
    let signer = [Signer::from(&seeds_)];
    let budget_key = a.budget.address().as_ref();
    sync_native(a.wsol_acc)?;
    let before_claim = token_amount(a.wsol_acc, WSOL.as_ref(), budget_key)?;
    claim(&a, &signer)?;
    let held = token_amount(a.wsol_acc, WSOL.as_ref(), budget_key)?;
    let claimed = held.saturating_sub(before_claim);

    // ---- plan: slice, floor, guard, caps ----
    let p1 = read_pool(a.pool)?.ok_or(fail(err::BLIND))?;
    let plan = plan_curve(program_id, state_a, signal_a, tape_a, a.config, now, held, p1.sqrt_price, p1.quote_reserve)?;
    let (slice, min_out, mode) = match plan {
        Plan::Skip(reason, detail) => return skip_and_emit(program_id, state_a, signal_a, event_a, sysvar, event_bump, now, held, claimed, reason, detail),
        Plan::Buy { slice, min_out, mode } => (slice, min_out, mode),
    };

    // ---- swap, check, burn ----
    let donated = token_amount(a.hunch_acc, a.mint.address().as_ref(), budget_key)?;
    swap(&a, &signer, slice, min_out, mode)?;
    let p2 = read_pool(a.pool)?.ok_or(fail(err::BLIND))?;
    if p2.sqrt_price * POST_SWAP_DEN > p1.sqrt_price * POST_SWAP_NUM {
        return Err(fail(err::PRICE_MOVED_TOO_MUCH));
    }
    let left = token_amount(a.wsol_acc, WSOL.as_ref(), budget_key)?;
    let units = token_amount(a.hunch_acc, a.mint.address().as_ref(), budget_key)?;
    if units > 0 {
        burn_hunch(a.hunch_acc, a.mint, a.budget, &signer, units)?;
    }
    let own_fee = p2.fee_total.saturating_sub(p1.fee_total);
    record_buy(program_id, state_a, signal_a, now, held, left, units, donated, claimed, own_fee, p1.sqrt_price, p2.sqrt_price, left.saturating_add(p2.creator_fee))?;
    emit_buy(program_id, event_a, sysvar, event_bump, held, held.saturating_sub(left), units, donated, own_fee, min_out, p1.sqrt_price, p2.sqrt_price)
}

enum Plan {
    Skip(u8, u8),
    Buy { slice: u64, min_out: u64, mode: u8 },
}

/// The market a buy plans against: the DBC curve (its config's segments) or the DAMM v2 pool (one
/// full-range liquidity: the cap's, the smaller of the last tick's and the live one, and the live one for
/// the quote).
enum Market<'a> {
    Curve { curve: &'a [Point], sqrt_start: u128, migration_sqrt: u128 },
    Pool { l_cap: u128, l_live: u128, sqrt_max: u128, fee_num: u64 },
}

/// The curve's segments from the DBC config, then the plan.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn plan_curve(
    program_id: &Address,
    state_a: &mut AccountView,
    signal_a: &AccountView,
    tape_a: &AccountView,
    config_a: &AccountView,
    now: i64,
    held: u64,
    sp: u128,
    quote_reserve: u64,
) -> R<Plan> {
    let mut curve = [Point::default(); layout::config::CURVE_POINTS];
    let (sqrt_start, migration_sqrt) = {
        let c = config_a.try_borrow()?;
        for (k, p) in curve.iter_mut().enumerate() {
            let at = layout::config::CURVE + 32 * k;
            p.sqrt_price = rd_u128(&c, at);
            p.liquidity = rd_u128(&c, at + 16);
        }
        (rd_u128(&c, layout::config::SQRT_START_PRICE), rd_u128(&c, layout::config::MIGRATION_SQRT_PRICE))
    };
    plan_buy(program_id, state_a, signal_a, tape_a, now, held, sp, quote_reserve, &Market::Curve { curve: &curve, sqrt_start, migration_sqrt })
}

/// The slice, the floor, the guard and the three caps; mirrors `planBuy` in chain.js.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn plan_buy(
    program_id: &Address,
    state_a: &mut AccountView,
    signal_a: &AccountView,
    tape_a: &AccountView,
    now: i64,
    held: u64,
    sp: u128,
    quote_reserve: u64,
    market: &Market,
) -> R<Plan> {
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    let day = (now / DAY) as u32;
    if st.buy_day != day + 1 {
        st.buy_day = day + 1;
        st.day_buys = 0;
        st.day_spent = 0;
        let c = quote_reserve as u128 * DAY_CAP_BPS as u128 / 10_000;
        st.day_cap = if c < DAY_CAP_FLOOR as u128 { DAY_CAP_FLOOR } else { c as u64 };
    }
    if st.day_buys >= DAY_MAX_BUYS {
        return Ok(Plan::Skip(skip::DAY_CAP, 0));
    }
    if held < MIN_HELD {
        return Ok(Plan::Skip(skip::BELOW_MIN, 0));
    }
    let mult = {
        let sgd = own_ro(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
        sgd[sig::MULT]
    };
    let mut slice = planned_slice(held, mult);
    // the guard: the last 6 tape samples
    {
        let tp = own_ro(program_id, tape_a, TAPE_LEN, &TAPE_TAG)?;
        let head = rd_u32(&tp, 8) as usize;
        let count = rd_u32(&tp, 12) as usize;
        let n = if count < GUARD_SAMPLES { count } else { GUARD_SAMPLES };
        if n == 0 {
            return Ok(Plan::Skip(skip::STALE, 0));
        }
        let mut vals = [0u128; GUARD_SAMPLES];
        let mut newest_ts = 0i64;
        for i in 0..n {
            let idx = (head + TAPE_ENTRIES - 1 - i) % TAPE_ENTRIES;
            let e = &tp[TAPE_HEADER + idx * TAPE_ENTRY..TAPE_HEADER + (idx + 1) * TAPE_ENTRY];
            vals[i] = rd_u128(e, 8);
            if i == 0 {
                newest_ts = rd_u32(e, 0) as i64 * BAR + e[4] as i64;
            }
        }
        if now - newest_ts > GUARD_STALE {
            return Ok(Plan::Skip(skip::STALE, 0));
        }
        let med = median(&mut vals[..n]);
        if let Some(excess) = guard_excess(sp, med) {
            return Ok(Plan::Skip(skip::GUARD, excess));
        }
    }
    // the caps
    let impact = match market {
        Market::Curve { curve, sqrt_start, migration_sqrt } => impact_cap(sp, *sqrt_start, curve, *migration_sqrt),
        Market::Pool { l_cap, sqrt_max, .. } => pool_impact_cap(sp, *l_cap, *sqrt_max),
    };
    let vol_cap = st.hour_vol_prev / VOLUME_CAP_DIV;
    let day_left = st.day_cap.saturating_sub(st.day_spent);
    let (mut cap, mut binding) = (impact, skip::IMPACT_CAP);
    if vol_cap < cap {
        cap = vol_cap;
        binding = skip::VOLUME_CAP;
    }
    if day_left < cap {
        cap = day_left;
        binding = skip::DAY_CAP;
    }
    if slice > cap {
        slice = cap;
    }
    if slice < MIN_HELD {
        return Ok(Plan::Skip(binding, 0));
    }
    let q = match market {
        Market::Curve { curve, migration_sqrt, .. } => quote_buy(sp, curve, *migration_sqrt, live_fee(st, now), slice),
        Market::Pool { l_live, sqrt_max, fee_num, .. } => quote_pool_buy(sp, *l_live, *sqrt_max, *fee_num, slice),
    };
    let min_out = (q.out as u128 * MIN_OUT_BPS / 10_000) as u64;
    Ok(Plan::Buy { slice, min_out, mode: q.partial as u8 })
}

/// A wait: the hour's reason and what waits, for the diary. Only the hour's first wait is recorded: once
/// this hour has a wait, a call that would wait again fails and changes nothing (no claim, no counter),
/// so a second cranker on the same timing adds no wait; a call that can buy is still allowed, so nobody
/// can cancel the hour's buy by calling at a bad moment.
#[allow(clippy::too_many_arguments)]
fn record_skip(program_id: &Address, state_a: &mut AccountView, signal_a: &mut AccountView, hh: u32, held: u64, claimed: u64, reason: u8, detail: u8) -> ProgramResult {
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    if st.hs_hour == hh && st.hs_reason != skip::NONE {
        return Err(fail(err::ALREADY_WAITED_THIS_HOUR));
    }
    st.hs_hour = hh;
    st.hs_reason = reason;
    st.hs_detail = detail;
    st.hs_bought = 0;
    st.hs_burned = 0;
    st.hs_held = held;
    st.skips += 1;
    add_claimed(st, claimed);
    let mut sgd = own(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
    wr_u32(&mut sgd, sig::SKIPS, st.skips);
    let flag = match reason {
        skip::GUARD | skip::STALE => sf::GUARD,
        skip::VOLUME_CAP | skip::DAY_CAP | skip::IMPACT_CAP => sf::VOLUME_CAP,
        _ => 0,
    };
    sgd[sig::FLAGS] |= flag;
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// graduation: withdraw_surplus, adopt_pool
// ------------------------------------------------------------------------------------------------

/// `withdraw_surplus()`: anyone, once, after the curve completes (DBC enforces both). DBC's
/// creator_withdraw_surplus by CPI, signed by the budget PDA as the pool's creator, into the budget's
/// WSOL account; the next buy spends it like the rest of the budget.
/// Accounts: 0 state (w), 1 budget, 2 budget WSOL (w), 3 WSOL mint, 4 DBC pool (w), 5 DBC config,
/// 6 quote vault (w), 7 DBC pool authority, 8 DBC event authority, 9 DBC program, 10 token program.
fn withdraw_surplus(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [state_a, budget, wsol_acc, wsol_mint, pool, config, quote_vault, pool_authority, dbc_ev, dbc, token, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let bump = {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        let st = as_state_ro(&sd);
        if st.phase == phase::SETUP {
            return Err(fail(err::WRONG_PHASE));
        }
        expect(budget, &st.budget)?;
        expect(wsol_acc, &st.budget_wsol)?;
        expect(pool, &st.pool)?;
        expect(config, &st.config)?;
        expect(quote_vault, &st.quote_vault)?;
        st.budget_bump
    };
    expect_id(wsol_mint, &WSOL)?;
    expect_id(pool_authority, &DBC_POOL_AUTHORITY)?;
    expect_id(dbc_ev, &DBC_EVENT_AUTHORITY)?;
    expect_id(dbc, &DBC)?;
    expect_id(token, &TOKEN)?;
    let bump_seed = [bump];
    let seeds_ = [Seed::from(seeds::BUDGET), Seed::from(&bump_seed)];
    let signer = [Signer::from(&seeds_)];
    let before = token_amount(wsol_acc, WSOL.as_ref(), budget.address().as_ref())?;
    let metas = [
        InstructionAccount::readonly(pool_authority.address()),
        InstructionAccount::readonly(config.address()),
        InstructionAccount::writable(pool.address()),
        InstructionAccount::writable(wsol_acc.address()),
        InstructionAccount::writable(quote_vault.address()),
        InstructionAccount::readonly(wsol_mint.address()),
        InstructionAccount::readonly_signer(budget.address()),
        InstructionAccount::readonly(token.address()),
        InstructionAccount::readonly(dbc_ev.address()),
        InstructionAccount::readonly(dbc.address()),
    ];
    invoke_signed::<10, &AccountView>(
        &InstructionView { program_id: &DBC, data: &CREATOR_WITHDRAW_SURPLUS, accounts: &metas },
        &[pool_authority, config, pool, wsol_acc, quote_vault, wsol_mint, budget, token, dbc_ev, dbc],
        &signer,
    )?;
    let after = token_amount(wsol_acc, WSOL.as_ref(), budget.address().as_ref())?;
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    st.surplus = st.surplus.saturating_add(after.saturating_sub(before));
    Ok(())
}

/// `adopt_pool()`: anyone, once, after the DBC pool reports migrated. Accepts only the DAMM v2 pool that
/// DBC's migration made for this pool:
/// - its config is DAMM v2's and names DBC's pool authority as the only pool creator (DAMM v2 makes that
///   authority sign, and DBC signs as it only inside its migration);
/// - its address is the one DAMM v2 derives from that config and the two mints, HUNCH and WSOL, and its
///   creator field is DBC's pool authority; its fees are collected in SOL only (OnlyB);
/// - the DBC pool (the adopted one) is migrated and its migration progress is "created pool";
/// - the position is in that pool, its NFT (Token-2022) is held by the budget PDA, and it holds, locked for
///   good, at least 25% of the liquidity DBC's migration builds from the pinned threshold and migration
///   sqrt price (DBC gives the creator 33% of it). That figure is fixed before the pool exists: liquidity an
///   outsider adds or locks for good in the pool cannot push Hunch's position under the bar, and a dust
///   position handed to the budget stays far under it.
/// Records the fee configuration, status and liquidity at adoption, keeps the curve's record, starts the
/// pool's (2-hour warm-up, running levels reset), and the pool's counters become the next tick's baseline.
/// Accounts: 0 state (w), 1 open call (w), 2 DBC pool, 3 DAMM v2 pool, 4 DAMM v2 config, 5 position,
/// 6 position NFT account, 7 budget.
fn adopt_pool(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [state_a, signal_a, dbc_pool, pool_a, config_a, position_a, nft_a, budget, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let now = Clock::get()?.unix_timestamp;
    let hh = (now / HOUR) as u32;
    let (mint, threshold, migration_sqrt) = {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        let st = as_state_ro(&sd);
        if st.phase != phase::CURVE && st.phase != phase::GRADUATING {
            return Err(fail(err::WRONG_PHASE));
        }
        expect(signal_a, &st.signal)?;
        expect(dbc_pool, &st.pool)?;
        expect(budget, &st.budget)?;
        (st.mint, st.migration_quote_threshold, u128_of(st.migration_sqrt_price))
    };
    // the DBC pool has migrated
    {
        if !dbc_pool.owned_by(&DBC) || dbc_pool.data_len() != layout::pool::LEN {
            return Err(fail(err::WRONG_ACCOUNT));
        }
        let p = dbc_pool.try_borrow()?;
        if p[..8] != VIRTUAL_POOL_DISC || p[layout::pool::IS_MIGRATED] != 1 || p[layout::pool::MIGRATION_PROGRESS] != layout::pool::MIGRATION_CREATED_POOL {
            return Err(fail(err::NOT_MIGRATED));
        }
    }
    // the config: DAMM v2's, usable only by DBC's pool authority
    {
        if !config_a.owned_by(&DAMM) || config_a.data_len() != layout::damm_config::LEN {
            return Err(fail(err::OUTSIDE_POOL));
        }
        let c = config_a.try_borrow()?;
        let at = layout::damm_config::POOL_CREATOR_AUTHORITY;
        if c[..8] != DAMM_CONFIG_DISC || c[at..at + 32] != *DBC_POOL_AUTHORITY.as_ref() {
            return Err(fail(err::OUTSIDE_POOL));
        }
    }
    // the pool: at the address DAMM v2 derives from ["pool", config, max(mint, WSOL), min(mint, WSOL)]
    let wsol = WSOL.to_bytes();
    let (hi, lo) = if mint > wsol { (mint, wsol) } else { (wsol, mint) };
    let (expected, _) = Address::find_program_address(&[b"pool", config_a.address().as_ref(), &hi, &lo], &DAMM);
    if pool_a.address() != &expected {
        return Err(fail(err::OUTSIDE_POOL));
    }
    let (vault_a, vault_b) = {
        use layout::damm as o;
        if !pool_a.owned_by(&DAMM) || pool_a.data_len() != o::LEN {
            return Err(fail(err::OUTSIDE_POOL));
        }
        let d = pool_a.try_borrow()?;
        let ok = d[..8] == DAMM_POOL_DISC
            && d[o::TOKEN_A_MINT..o::TOKEN_A_MINT + 32] == mint
            && d[o::TOKEN_B_MINT..o::TOKEN_B_MINT + 32] == wsol
            && d[o::CREATOR..o::CREATOR + 32] == *DBC_POOL_AUTHORITY.as_ref()
            && d[o::COLLECT_FEE_MODE] == o::ONLY_B;
        if !ok {
            return Err(fail(err::OUTSIDE_POOL));
        }
        let mut va = [0u8; 32];
        let mut vb = [0u8; 32];
        va.copy_from_slice(&d[o::TOKEN_A_VAULT..o::TOKEN_A_VAULT + 32]);
        vb.copy_from_slice(&d[o::TOKEN_B_VAULT..o::TOKEN_B_VAULT + 32]);
        (va, vb)
    };
    let p = read_damm(pool_a)?.ok_or(fail(err::OUTSIDE_POOL))?;
    // the position and its NFT
    let nft_mint = {
        use layout::position as o;
        if !position_a.owned_by(&DAMM) || position_a.data_len() != o::LEN {
            return Err(fail(err::NOT_OUR_POSITION));
        }
        let d = position_a.try_borrow()?;
        let locked = rd_u128(&d, o::PERMANENT_LOCKED_LIQUIDITY);
        if d[..8] != DAMM_POSITION_DISC || d[o::POOL..o::POOL + 32] != *pool_a.address().as_ref() {
            return Err(fail(err::NOT_OUR_POSITION));
        }
        // measured against the liquidity DBC's migration builds from the pinned threshold and migration
        // price, not against the pool's own counters: an outsider can add liquidity to the pool and lock
        // it there for good (both permissionless), and nothing lowers a permanent lock, so a bar on the
        // pool's lock could be pushed over Hunch's position and block adoption for good
        if !position_share_ok(locked, threshold, migration_sqrt) {
            return Err(fail(err::NOT_OUR_POSITION));
        }
        let mut m = [0u8; 32];
        m.copy_from_slice(&d[o::NFT_MINT..o::NFT_MINT + 32]);
        m
    };
    {
        if !nft_a.owned_by(&TOKEN_2022) || nft_a.data_len() < TOKEN_ACCOUNT_LEN {
            return Err(fail(err::NOT_OUR_POSITION));
        }
        let d = nft_a.try_borrow()?;
        if d[0..32] != nft_mint || d[32..64] != *budget.address().as_ref() || rd_u64(&d, 64) != 1 {
            return Err(fail(err::NOT_OUR_POSITION));
        }
    }

    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    st.damm_pool.copy_from_slice(pool_a.address().as_ref());
    st.damm_config.copy_from_slice(config_a.address().as_ref());
    st.token_a_vault = vault_a;
    st.token_b_vault = vault_b;
    st.position.copy_from_slice(position_a.address().as_ref());
    st.position_nft.copy_from_slice(nft_a.address().as_ref());
    st.position_mint = nft_mint;
    st.adopt_fee_fp = p.fee_fp;
    st.last_fee_fp = p.fee_fp;
    st.adopt_fee_num = p.fee.numerator();
    st.last_status = p.status;
    st.last_liquidity = split_u128(p.liquidity);
    st.adopt_ts = now;
    st.adopt_hour = hh;
    st.pool_warm_end = hh + pool_phase::WARM_HOURS;
    // the curve's record is kept; the pool's starts from zero
    st.prev_n = st.n;
    st.prev_hits = st.hits;
    st.prev_rule_hits = st.rule_hits;
    st.prev_forfeits = st.forfeits;
    st.prev_not_scored = st.not_scored;
    st.n = 0;
    st.hits = 0;
    st.rule_hits = 0;
    st.busier_hours = 0;
    st.quieter_calls = 0;
    st.quieter_hits = 0;
    st.forfeits = 0;
    st.not_scored = 0;
    // the running levels restart on the new pool: the next boundary is a warm-up
    st.last_boundary_hour = 0;
    st.last_boundary_ts = 0;
    st.last_boundary_cum = st.cum;
    st.ref_vol = 0;
    st.ref_secs = 0;
    st.hour_vol_prev = 0;
    // the pool's counters are the next tick's baseline
    st.last_sp = split_u128(p.sqrt_price);
    st.last_fee_total = p.fee_total;
    st.last_tick_ts = now;
    st.own_fee = 0;
    st.own_ratio = Q32 as u64;
    st.own_lamports = 0;
    st.dist_cur = 0;
    st.dist_prev = 0;
    st.grad_line = 1;
    st.phase = phase::POOL;
    let mut sgd = own(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
    sgd[sig::PHASE] = phase::POOL;
    wr_u32(&mut sgd, sig::PREV_N, st.prev_n);
    wr_u32(&mut sgd, sig::PREV_HITS, st.prev_hits);
    wr_u32(&mut sgd, sig::PREV_RULE_HITS, st.prev_rule_hits);
    wr_u16(&mut sgd, sig::POOL_FEE_BPS, fee_bps(st.adopt_fee_num));
    sgd[sig::POOL_STATUS] = p.status;
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// the pool phase: claim_pool_fees, buy_and_burn_pool
// ------------------------------------------------------------------------------------------------

struct DammAccounts<'a> {
    budget: &'a AccountView,
    wsol_acc: &'a AccountView,
    hunch_acc: &'a AccountView,
    mint: &'a AccountView,
    wsol_mint: &'a AccountView,
    pool: &'a AccountView,
    pool_authority: &'a AccountView,
    vault_a: &'a AccountView,
    vault_b: &'a AccountView,
    position: &'a AccountView,
    nft: &'a AccountView,
    event_authority: &'a AccountView,
    damm: &'a AccountView,
    token: &'a AccountView,
}

/// The accounts against the state; with `adopted`, the position and its NFT must be the adopted ones
/// (a claim on its own may name any position in the pool whose NFT the budget holds: DAMM v2 checks
/// the owner, and the fees can only land in the budget's own two accounts).
fn check_damm_accounts(st: &State, a: &DammAccounts, adopted: bool) -> ProgramResult {
    expect(a.budget, &st.budget)?;
    expect(a.wsol_acc, &st.budget_wsol)?;
    expect(a.hunch_acc, &st.budget_hunch)?;
    expect(a.mint, &st.mint)?;
    expect_id(a.wsol_mint, &WSOL)?;
    expect(a.pool, &st.damm_pool)?;
    expect(a.vault_a, &st.token_a_vault)?;
    expect(a.vault_b, &st.token_b_vault)?;
    expect_id(a.pool_authority, &DAMM_POOL_AUTHORITY)?;
    expect_id(a.event_authority, &DAMM_EVENT_AUTHORITY)?;
    expect_id(a.damm, &DAMM)?;
    expect_id(a.token, &TOKEN)?;
    if adopted {
        expect(a.position, &st.position)?;
        expect(a.nft, &st.position_nft)?;
    }
    Ok(())
}

/// DAMM v2 claim_position_fee, signed by the budget PDA as the position NFT's owner: token A (HUNCH, none
/// in OnlyB mode) into the budget's HUNCH account, token B (SOL) into its WSOL account.
fn claim_position(a: &DammAccounts, signer: &[Signer]) -> ProgramResult {
    let metas = [
        InstructionAccount::readonly(a.pool_authority.address()),
        InstructionAccount::readonly(a.pool.address()),
        InstructionAccount::writable(a.position.address()),
        InstructionAccount::writable(a.hunch_acc.address()),
        InstructionAccount::writable(a.wsol_acc.address()),
        InstructionAccount::writable(a.vault_a.address()),
        InstructionAccount::writable(a.vault_b.address()),
        InstructionAccount::readonly(a.mint.address()),
        InstructionAccount::readonly(a.wsol_mint.address()),
        InstructionAccount::readonly(a.nft.address()),
        InstructionAccount::readonly_signer(a.budget.address()),
        InstructionAccount::readonly(a.token.address()),
        InstructionAccount::readonly(a.token.address()),
        InstructionAccount::readonly(a.event_authority.address()),
        InstructionAccount::readonly(a.damm.address()),
    ];
    invoke_signed::<15, &AccountView>(
        &InstructionView { program_id: &DAMM, data: &DAMM_CLAIM_POSITION_FEE, accounts: &metas },
        &[
            a.pool_authority, a.pool, a.position, a.hunch_acc, a.wsol_acc, a.vault_a, a.vault_b, a.mint, a.wsol_mint, a.nft, a.budget, a.token, a.token,
            a.event_authority, a.damm,
        ],
        signer,
    )
}

/// DAMM v2 swap2: SOL from the budget's WSOL account in, HUNCH into the budget's HUNCH account, with no
/// referral (the program's own id in the optional slot).
fn swap_damm(a: &DammAccounts, signer: &[Signer], amount_in: u64, min_out: u64, mode: u8) -> ProgramResult {
    let mut data = [0u8; 25];
    data[..8].copy_from_slice(&DAMM_SWAP2);
    data[8..16].copy_from_slice(&amount_in.to_le_bytes());
    data[16..24].copy_from_slice(&min_out.to_le_bytes());
    data[24] = mode;
    let metas = [
        InstructionAccount::readonly(a.pool_authority.address()),
        InstructionAccount::writable(a.pool.address()),
        InstructionAccount::writable(a.wsol_acc.address()),
        InstructionAccount::writable(a.hunch_acc.address()),
        InstructionAccount::writable(a.vault_a.address()),
        InstructionAccount::writable(a.vault_b.address()),
        InstructionAccount::readonly(a.mint.address()),
        InstructionAccount::readonly(a.wsol_mint.address()),
        InstructionAccount::readonly_signer(a.budget.address()),
        InstructionAccount::readonly(a.token.address()),
        InstructionAccount::readonly(a.token.address()),
        InstructionAccount::readonly(a.damm.address()),
        InstructionAccount::readonly(a.event_authority.address()),
        InstructionAccount::readonly(a.damm.address()),
    ];
    invoke_signed::<14, &AccountView>(
        &InstructionView { program_id: &DAMM, data: &data, accounts: &metas },
        &[
            a.pool_authority, a.pool, a.wsol_acc, a.hunch_acc, a.vault_a, a.vault_b, a.mint, a.wsol_mint, a.budget, a.token, a.token, a.damm,
            a.event_authority, a.damm,
        ],
        signer,
    )
}

/// `claim_pool_fees()`: anyone, any time in the pool phase. sync_native and claim_position_fee into the
/// budget's own accounts, nothing else. The position may be any in the adopted pool whose NFT the budget
/// holds. Only what the claim paid counts in pool_claimed.
/// Accounts: 0 state (w), 1 budget, 2 budget WSOL (w), 3 budget HUNCH (w), 4 HUNCH mint, 5 WSOL mint,
/// 6 DAMM v2 pool, 7 DAMM v2 pool authority, 8 token A vault (w), 9 token B vault (w), 10 position (w),
/// 11 position NFT account, 12 DAMM v2 event authority, 13 DAMM v2 program, 14 token program.
fn claim_pool_fees(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [state_a, budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, pool_authority, vault_a, vault_b, position, nft, damm_ev, damm, token, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let a = DammAccounts { budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, pool_authority, vault_a, vault_b, position, nft, event_authority: damm_ev, damm, token };
    let bump = {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        let st = as_state_ro(&sd);
        if st.phase != phase::POOL {
            return Err(fail(err::WRONG_PHASE));
        }
        check_damm_accounts(st, &a, false)?;
        st.budget_bump
    };
    let bump_seed = [bump];
    let seeds_ = [Seed::from(seeds::BUDGET), Seed::from(&bump_seed)];
    let signer = [Signer::from(&seeds_)];
    sync_native(a.wsol_acc)?;
    let before = token_amount(a.wsol_acc, WSOL.as_ref(), a.budget.address().as_ref())?;
    claim_position(&a, &signer)?;
    let after = token_amount(a.wsol_acc, WSOL.as_ref(), a.budget.address().as_ref())?;
    let mut sd = own(program_id, state_a, STATE_LEN, &STATE_TAG)?;
    let st = as_state(&mut sd);
    st.pool_claimed = st.pool_claimed.saturating_add(after.saturating_sub(before));
    Ok(())
}

/// `buy_and_burn_pool()`: the same rules as buy_and_burn_curve, on the adopted DAMM v2 pool, refused
/// while Meteora has it paused (POOL_PAUSED) and while its fee is above the fee at adoption or one Hunch
/// cannot model (FEE_RAISED). sync_native; claim_position_fee as the NFT owner; slice, floor, guard,
/// the caps (the impact cap on the smaller of the last tick's liquidity and the live one, so liquidity
/// added just before cannot raise it); swap2 with a min_out of 99% of its own quote; the post-swap price
/// check; the burn of the whole HUNCH balance (DBC's leftover and donations included).
/// Accounts: 0 state (w), 1 signal (w), 2 tape, 3 budget, 4 budget WSOL (w), 5 budget HUNCH (w),
/// 6 HUNCH mint (w), 7 WSOL mint, 8 DAMM v2 pool (w), 9 DAMM v2 pool authority, 10 token A vault (w),
/// 11 token B vault (w), 12 position (w), 13 position NFT account, 14 DAMM v2 event authority,
/// 15 DAMM v2 program, 16 token program, 17 instructions sysvar, 18 Hunch event authority, 19 Hunch program.
/// Not inlined: inside process_instruction its locals overflowed SBF's 4 KB stack frame (build-sbf warned).
#[inline(never)]
fn buy_and_burn_pool(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [state_a, signal_a, tape_a, budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, pool_authority, vault_a, vault_b, position, nft, damm_ev, damm, token, sysvar, event_a, prog, ..] =
        &mut *accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_alone(program_id, sysvar)?;
    expect_id(prog, program_id)?;
    let a = DammAccounts { budget, wsol_acc, hunch_acc, mint, wsol_mint, pool, pool_authority, vault_a, vault_b, position, nft, event_authority: damm_ev, damm, token };
    let now = Clock::get()?.unix_timestamp;
    let (l_last, adopt_fee_num) = {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        let st = as_state_ro(&sd);
        check_damm_accounts(st, &a, true)?;
        (u128_of(st.last_liquidity), st.adopt_fee_num)
    };
    let (budget_bump, event_bump) = buy_gate(program_id, state_a, signal_a, tape_a, event_a, phase::POOL, now)?;
    let p0 = read_damm(a.pool)?.ok_or(fail(err::BLIND))?;
    if p0.status != 0 {
        return Err(fail(err::POOL_PAUSED));
    }
    // a fee above the one at adoption, or one Hunch cannot model: no buy, nothing changes (the slice would
    // pay it to the LPs and Meteora); the budget waits for the fee to return
    if pool_fee_refused(&p0.fee, adopt_fee_num) {
        return Err(fail(err::FEE_RAISED));
    }

    // ---- sync_native and the position's fee (only what the claim paid counts as claimed) ----
    let bump_seed = [budget_bump];
    let seeds_ = [Seed::from(seeds::BUDGET), Seed::from(&bump_seed)];
    let signer = [Signer::from(&seeds_)];
    let budget_key = a.budget.address().as_ref();
    sync_native(a.wsol_acc)?;
    let before_claim = token_amount(a.wsol_acc, WSOL.as_ref(), budget_key)?;
    claim_position(&a, &signer)?;
    let held = token_amount(a.wsol_acc, WSOL.as_ref(), budget_key)?;
    let claimed = held.saturating_sub(before_claim);

    // ---- plan ----
    let p1 = read_damm(a.pool)?.ok_or(fail(err::BLIND))?;
    let l_cap = if l_last < p1.liquidity { l_last } else { p1.liquidity };
    let market = Market::Pool { l_cap, l_live: p1.liquidity, sqrt_max: p1.sqrt_max, fee_num: p1.fee.numerator() };
    let plan = plan_buy(program_id, state_a, signal_a, tape_a, now, held, p1.sqrt_price, p1.quote_reserve, &market)?;
    let (slice, min_out, mode) = match plan {
        Plan::Skip(reason, detail) => return skip_and_emit(program_id, state_a, signal_a, event_a, sysvar, event_bump, now, held, claimed, reason, detail),
        Plan::Buy { slice, min_out, mode } => (slice, min_out, mode),
    };

    // ---- swap, check, burn ----
    let donated = token_amount(a.hunch_acc, a.mint.address().as_ref(), budget_key)?;
    swap_damm(&a, &signer, slice, min_out, mode)?;
    let p2 = read_damm(a.pool)?.ok_or(fail(err::BLIND))?;
    if p2.sqrt_price * POST_SWAP_DEN > p1.sqrt_price * POST_SWAP_NUM {
        return Err(fail(err::PRICE_MOVED_TOO_MUCH));
    }
    let left = token_amount(a.wsol_acc, WSOL.as_ref(), budget_key)?;
    let units = token_amount(a.hunch_acc, a.mint.address().as_ref(), budget_key)?;
    if units > 0 {
        burn_hunch(a.hunch_acc, a.mint, a.budget, &signer, units)?;
    }
    let own_fee = p2.fee_total.saturating_sub(p1.fee_total);
    record_buy(program_id, state_a, signal_a, now, held, left, units, donated, claimed, own_fee, p1.sqrt_price, p2.sqrt_price, left)?;
    emit_buy(program_id, event_a, sysvar, event_bump, held, held.saturating_sub(left), units, donated, own_fee, min_out, p1.sqrt_price, p2.sqrt_price)
}

// ------------------------------------------------------------------------------------------------
// read_call, grow_brain_book
// ------------------------------------------------------------------------------------------------

/// `read_call()`: anyone, by CPI or top level. Returns the 160-byte open call as return data, and logs
/// the top-level program and the stack height (only at height 2 is the top-level program the caller).
/// Accounts: 0 open call, 1 instructions sysvar.
fn read_call(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [signal_a, sysvar, ..] = &*accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let d = own_ro(program_id, signal_a, SIGNAL_LEN, &SIGNAL_TAG)?;
    let instructions = Instructions::try_from(sysvar)?;
    let current = instructions.load_current_index() as usize;
    let top = instructions.load_instruction_at(current)?;
    log("read_call: top-level program, stack height");
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_pubkey(top.get_program_id().as_ref().as_ptr());
        pinocchio::syscalls::sol_log_64_(stack_height(), 0, 0, 0, 0);
    }
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(&top);
    set_return_data(&d[..SIGNAL_LEN]);
    Ok(())
}

/// `grow_brain_book()`: anyone (the caller pays the rent), when fewer than 30 free daily records remain.
/// Adds 92 records (5,888 bytes, under the 10,240-byte growth limit of one instruction).
/// Accounts: 0 payer (signer, w), 1 state, 2 book (w), 3 system program.
fn grow_brain_book(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, state_a, book_a, system, ..] = &mut *accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    expect_id(system, &SYSTEM)?;
    {
        let sd = own_ro(program_id, state_a, STATE_LEN, &STATE_TAG)?;
        expect(book_a, &as_state_ro(&sd).book)?;
    }
    let now = Clock::get()?.unix_timestamp;
    let (capacity, launch_day, len) = {
        let d = own_ro(program_id, book_a, BOOK_HEADER, &BOOK_TAG)?;
        (rd_u32(&d, 12) as usize, rd_u32(&d, 8), d.len())
    };
    let today = if launch_day == 0 { 0 } else { ((now / DAY) as u32).saturating_sub(launch_day) as usize };
    if capacity > today + BOOK_GROW_BELOW {
        return Err(fail(err::BOOK_HAS_ROOM));
    }
    let new_len = len + BOOK_STEP * BOOK_RECORD;
    let need = Rent::get()?.try_minimum_balance(new_len)?;
    let have = book_a.lamports();
    if need > have {
        transfer(payer, book_a, need - have)?;
    }
    book_a.resize(new_len)?;
    let mut d = own(program_id, book_a, BOOK_HEADER, &BOOK_TAG)?;
    wr_u32(&mut d, 12, (capacity + BOOK_STEP) as u32);
    Ok(())
}
