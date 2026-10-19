//! Bench only (kill test K2, compute): one `hunch_net::Model::step` per instruction (chapter 0), in the Solana VM.
//!
//! Account 0 (writable, owned by this program) holds the model in place, followed by 16 bytes where
//! each step writes its forward pass (p, z2) so the optimiser cannot drop it.
//! Data: `[0, seed u32]` resets the model; `[1, ts i64, ret_q i64, lam u64]` runs one bar;
//! `[2, nonce..]` only borrows the account (the baseline cost to subtract).

#![cfg_attr(target_os = "solana", no_std)]

use {
    hunch_net::{Bar, Model},
    pinocchio::{error::ProgramError, AccountView, Address, ProgramResult},
};

pub const MODEL_LEN: usize = core::mem::size_of::<Model>();
pub const ACCOUNT_LEN: usize = MODEL_LEN + 16;

#[cfg(target_os = "solana")]
mod entrypoint {
    pinocchio::program_entrypoint!(crate::process_instruction);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}

fn le8(d: &[u8], at: usize) -> Result<[u8; 8], ProgramError> {
    d.get(at..at + 8).and_then(|s| s.try_into().ok()).ok_or(ProgramError::InvalidInstructionData)
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (kind, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let account = accounts.first_mut().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !account.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let mut bytes = account.try_borrow_mut()?;
    if bytes.len() != ACCOUNT_LEN || bytes.as_ptr() as usize % core::mem::align_of::<Model>() != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    let (model_bytes, out) = bytes.split_at_mut(MODEL_LEN);
    // SAFETY: length and alignment checked above, the borrow is exclusive, and `Model` is repr(C)
    // integers only, so any bytes are a valid value.
    let model = unsafe { &mut *(model_bytes.as_mut_ptr() as *mut Model) };
    match kind {
        0 => {
            let seed = u32::from_le_bytes(rest.get(..4).and_then(|s| s.try_into().ok()).ok_or(ProgramError::InvalidInstructionData)?);
            model.reset(seed);
        }
        1 => {
            let bar = Bar {
                ts: i64::from_le_bytes(le8(rest, 0)?),
                ret_q: i64::from_le_bytes(le8(rest, 8)?),
                lam: u64::from_le_bytes(le8(rest, 16)?),
                x9: 0,
                x10: 0,
            };
            let step = model.step(&bar, 0);
            let (p, z2) = step.thought.map(|f| (f.p, f.z3)).unwrap_or((-1, 0));
            out[..8].copy_from_slice(&p.to_le_bytes());
            out[8..16].copy_from_slice(&z2.to_le_bytes());
        }
        2 => {}
        _ => return Err(ProgramError::InvalidInstructionData),
    }
    Ok(())
}
