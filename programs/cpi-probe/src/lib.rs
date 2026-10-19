//! Test-only. Forwards its instruction data and accounts 1.. to the program in account 0, by CPI.
//! Used to show that Hunch's buy_and_burn refuses to be called by another program.

#![cfg_attr(target_os = "solana", no_std)]

#[cfg(target_os = "solana")]
mod entrypoint {
    use pinocchio::{
        cpi::invoke_with_bounds,
        error::ProgramError,
        instruction::{InstructionAccount, InstructionView},
        AccountView, Address, ProgramResult,
    };

    pinocchio::program_entrypoint!(forward);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();

    const MAX: usize = 24;

    fn forward(_program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
        let (target, rest) = accounts.split_first().ok_or(ProgramError::NotEnoughAccountKeys)?;
        if rest.len() > MAX {
            return Err(ProgramError::InvalidArgument);
        }
        let mut metas: [InstructionAccount; MAX] = core::array::from_fn(|_| InstructionAccount::readonly(target.address()));
        for (meta, account) in metas.iter_mut().zip(rest.iter()) {
            *meta = InstructionAccount::new(account.address(), account.is_writable(), account.is_signer());
        }
        let ix = InstructionView { program_id: target.address(), data, accounts: &metas[..rest.len()] };
        invoke_with_bounds::<MAX, AccountView>(&ix, rest)
    }
}
