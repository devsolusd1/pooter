//! Hard-coded program ids, PDAs of other programs, discriminators, instruction tags and error codes.

use pinocchio::Address;

/// Meteora Dynamic Bonding Curve, `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`.
pub const DBC: Address = Address::new_from_array([
    9, 96, 12, 165, 36, 247, 177, 183, 214, 204, 177, 195, 151, 58, 160, 51, 13, 25, 3, 218, 96, 28, 201, 181, 222,
    227, 198, 98, 180, 202, 209, 73,
]);
/// DBC's pool authority PDA `["pool_authority"]`, `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`.
pub const DBC_POOL_AUTHORITY: Address = Address::new_from_array([
    218, 99, 104, 31, 114, 134, 188, 200, 6, 113, 158, 44, 43, 80, 162, 1, 87, 36, 59, 252, 150, 104, 177, 21, 32, 188,
    83, 132, 62, 220, 219, 8,
]);
/// DBC's event authority PDA `["__event_authority"]`, `8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF`.
pub const DBC_EVENT_AUTHORITY: Address = Address::new_from_array([
    108, 214, 204, 128, 199, 176, 11, 36, 194, 16, 32, 56, 67, 63, 72, 170, 15, 202, 142, 231, 232, 25, 3, 60, 15, 225,
    251, 167, 40, 223, 245, 12,
]);
/// SPL Token, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
pub const TOKEN: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145,
    58, 140, 245, 133, 126, 255, 0, 169,
]);
/// SPL Memo v2, `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`.
pub const MEMO: Address = Address::new_from_array([
    5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124, 124, 53, 181, 221, 188, 146, 187, 129, 228, 31,
    168, 64, 65, 5, 68, 141,
]);
/// Wrapped SOL, `So11111111111111111111111111111111111111112`.
pub const WSOL: Address = Address::new_from_array([
    6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196, 57, 220, 26, 235, 59, 85, 152,
    160, 240, 0, 0, 0, 0, 1,
]);
/// Associated Token Account program, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
pub const ATA: Address = Address::new_from_array([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142,
    123, 216, 219, 233, 248, 89,
]);
/// `ComputeBudget111111111111111111111111111111`: the only other program allowed beside a tick or a buy.
pub const COMPUTE_BUDGET: Address = Address::new_from_array([
    3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187, 197, 247, 18, 107, 44,
    67, 155, 58, 64, 0, 0, 0,
]);
/// The upgradeable BPF loader, `BPFLoaderUpgradeab1e11111111111111111111111` (its ProgramData names the upgrade authority).
pub const LOADER_V3: Address = Address::new_from_array([
    2, 168, 246, 145, 78, 136, 161, 176, 226, 16, 21, 62, 247, 99, 174, 43, 0, 194, 185, 61, 22, 193, 36, 210, 192, 83,
    122, 16, 4, 128, 0, 0,
]);
/// The instructions sysvar, `Sysvar1nstructions1111111111111111111111111`.
pub const INSTRUCTIONS_SYSVAR: Address = Address::new_from_array([
    6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192, 193, 36, 198, 143, 33, 86, 117, 165, 219,
    186, 203, 95, 8, 0, 0, 0,
]);
/// The system program.
pub const SYSTEM: Address = Address::new_from_array([0; 32]);

/// Meteora DAMM v2 (cp-amm), `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`: the pool after graduation.
pub const DAMM: Address = Address::new_from_array([
    9, 45, 33, 53, 101, 122, 21, 156, 43, 135, 212, 182, 106, 112, 219, 142, 151, 82, 56, 159, 247, 106, 175, 32, 108,
    237, 6, 58, 56, 249, 90, 237,
]);
/// DAMM v2's pool authority PDA `["pool_authority"]`, `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC`.
pub const DAMM_POOL_AUTHORITY: Address = Address::new_from_array([
    242, 204, 213, 53, 172, 165, 241, 115, 106, 200, 34, 221, 7, 115, 228, 217, 47, 189, 138, 89, 178, 148, 3, 80, 2,
    149, 169, 1, 28, 115, 169, 229,
]);
/// DAMM v2's event authority PDA `["__event_authority"]`, `3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet`.
pub const DAMM_EVENT_AUTHORITY: Address = Address::new_from_array([
    42, 118, 231, 179, 68, 100, 10, 28, 252, 89, 76, 139, 202, 208, 160, 145, 1, 28, 172, 125, 209, 86, 191, 131, 168,
    51, 251, 34, 8, 235, 119, 173,
]);
/// SPL Token-2022, `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (DAMM v2's position NFTs live there).
pub const TOKEN_2022: Address = Address::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254,
    189, 249, 40, 216, 161, 139, 252,
]);

/// Anchor discriminators from DBC 0.2.1's IDL (SDK 1.5.13): sha256("global:<name>")[..8].
pub const CLAIM_CREATOR_TRADING_FEE2: [u8; 8] = [238, 247, 213, 94, 110, 145, 88, 142];
pub const SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
/// Account discriminators: sha256("account:VirtualPool")[..8], sha256("account:PoolConfig")[..8].
pub const VIRTUAL_POOL_DISC: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
pub const POOL_CONFIG_DISC: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
/// DBC creator_withdraw_surplus: sha256("global:creator_withdraw_surplus")[..8].
pub const CREATOR_WITHDRAW_SURPLUS: [u8; 8] = [165, 3, 137, 7, 28, 134, 76, 80];

/// DAMM v2 (cp-amm 0.2.x source, checked against the mainnet bytecode in LiteSVM): instruction and
/// account discriminators. swap2 has the same discriminator as DBC's ("global:swap2").
pub const DAMM_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
pub const DAMM_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
pub const DAMM_POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const DAMM_POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
pub const DAMM_CONFIG_DISC: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];

/// PDA seeds of Hunch's own accounts.
pub mod seeds {
    pub const STATE: &[u8] = b"state";
    pub const MODEL: &[u8] = b"model";
    pub const TAPE: &[u8] = b"tape";
    pub const SIGNAL: &[u8] = b"signal";
    pub const DIARY: &[u8] = b"diary";
    pub const BOOK: &[u8] = b"brains";
    pub const BUDGET: &[u8] = b"budget";
    pub const EVENT_AUTHORITY: &[u8] = b"__event_authority";
}

/// First byte of the instruction data.
pub mod tag {
    pub const INITIALIZE: u8 = 0;
    pub const LOAD_BRAIN: u8 = 1;
    pub const ADOPT_CURVE: u8 = 2;
    pub const TICK: u8 = 3;
    pub const BUY_AND_BURN_CURVE: u8 = 4;
    pub const CLAIM_CURVE_FEES: u8 = 5;
    pub const READ_CALL: u8 = 6;
    pub const GROW_BRAIN_BOOK: u8 = 7;
    pub const WITHDRAW_SURPLUS: u8 = 8;
    pub const ADOPT_POOL: u8 = 9;
    pub const BUY_AND_BURN_POOL: u8 = 10;
    pub const CLAIM_POOL_FEES: u8 = 11;
    /// Self-CPI that carries an event (signed by the event authority PDA); never top level.
    pub const EVENT: u8 = 0xE4;
}

/// Event kinds (second byte of an event's data).
pub mod event {
    pub const BAR: u8 = 1;
    pub const DIARY: u8 = 2;
    pub const WEIGHTS: u8 = 3;
    pub const BUY: u8 = 4;
    pub const SKIP: u8 = 5;
}

/// Custom error codes (`ProgramError::Custom`).
pub mod err {
    /// Called by another program (stack height above 1).
    pub const CALLED_BY_CPI: u32 = 1;
    /// The transaction holds another instruction that is not ComputeBudget.
    pub const NOT_ALONE: u32 = 2;
    /// The top-level instruction being executed is not this program's.
    pub const NOT_TOP_LEVEL: u32 = 3;
    /// An account is not the one expected (address, owner, size or tag).
    pub const WRONG_ACCOUNT: u32 = 4;
    /// The signer is not the program's upgrade authority.
    pub const NOT_AUTHORITY: u32 = 6;
    /// initialize already ran.
    pub const ALREADY_INITIALIZED: u32 = 7;
    /// Not allowed in the current phase (before adoption, after it, while graduating...).
    pub const WRONG_PHASE: u32 = 8;
    /// adopt_curve: the pool is not Hunch's (mint, creator, migrated flag, layout).
    pub const POOL_MISMATCH: u32 = 9;
    /// adopt_curve: the config differs from the compiled values.
    pub const CONFIG_MISMATCH: u32 = 10;
    /// tick: outside the first 30 seconds of the bar.
    pub const OUTSIDE_WINDOW: u32 = 11;
    /// tick: this bar already has its tick.
    pub const ALREADY_TICKED: u32 = 12;
    /// tick: the 5-second opening schedule is not over.
    pub const TOO_EARLY: u32 = 13;
    /// buy: this hour's boundary tick has not landed.
    pub const NO_BOUNDARY_THIS_HOUR: u32 = 14;
    /// buy: there was already a buy this UTC hour.
    pub const ALREADY_BOUGHT_THIS_HOUR: u32 = 15;
    /// buy: less than 30 minutes since the previous buy.
    pub const TOO_SOON: u32 = 16;
    /// buy: the curve is complete (graduation is next).
    pub const CURVE_COMPLETE: u32 = 17;
    /// buy: the swap moved sqrt_price by more than 1.0101x; the whole instruction reverts.
    pub const PRICE_MOVED_TOO_MUCH: u32 = 18;
    /// load_brain: a frozen part differs from its launch value.
    pub const BAD_BRAIN: u32 = 19;
    /// grow_brain_book: the book still has room for a month.
    pub const BOOK_HAS_ROOM: u32 = 20;
    /// buy: the pool's layout is not the one adopted (blind).
    pub const BLIND: u32 = 21;
    /// Arithmetic out of range.
    pub const MATH: u32 = 22;
    /// event: not signed by Hunch's event authority.
    pub const NOT_EVENT_AUTHORITY: u32 = 23;
    /// adopt_pool: the DBC pool has not migrated yet.
    pub const NOT_MIGRATED: u32 = 24;
    /// adopt_pool: the DAMM v2 pool is not the one DBC's migration made for this pool (config authority,
    /// address, mints, creator, fee mode).
    pub const OUTSIDE_POOL: u32 = 25;
    /// adopt_pool: the position is not Hunch's (pool, NFT owner, amount, or less than 25% of the migration's
    /// liquidity locked for good).
    pub const NOT_OUR_POSITION: u32 = 26;
    /// buy_and_burn_pool: Meteora has the pool paused.
    pub const POOL_PAUSED: u32 = 27;
    /// buy: this UTC hour already recorded a wait, and this call would wait again (it changes nothing; a
    /// later call in the hour that can buy is still allowed).
    pub const ALREADY_WAITED_THIS_HOUR: u32 = 28;
    /// initialize: the ticker is not 1 to 10 characters of A-Z and 0-9.
    pub const BAD_TICKER: u32 = 29;
    /// buy_and_burn_pool: the pool's fee is above the fee at adoption, or one Hunch cannot model (a dynamic
    /// fee, a fee schedule); nothing changes and the budget waits for the fee to return.
    pub const FEE_RAISED: u32 = 30;
}
