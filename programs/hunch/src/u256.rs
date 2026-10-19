//! The few 256-bit operations DBC's curve math needs (Meteora uses `ruint::U256`); four u64 limbs,
//! little-endian. Floor division only, like `BigInt` in chain.js and like DBC's `Rounding::Down`.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0; 4]);

    pub const fn from_u128(v: u128) -> Self {
        U256([v as u64, (v >> 64) as u64, 0, 0])
    }

    /// a * b, exact.
    pub fn mul(a: u128, b: u128) -> Self {
        let (a0, a1) = (a as u64 as u128, (a >> 64) as u64 as u128);
        let (b0, b1) = (b as u64 as u128, (b >> 64) as u64 as u128);
        let p00 = a0 * b0;
        let p01 = a0 * b1;
        let p10 = a1 * b0;
        let p11 = a1 * b1;
        let mut r = [0u64; 4];
        r[0] = p00 as u64;
        let mid = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
        r[1] = mid as u64;
        let hi = (mid >> 64) + (p01 >> 64) + (p10 >> 64) + (p11 as u64 as u128);
        r[2] = hi as u64;
        r[3] = ((hi >> 64) + (p11 >> 64)) as u64;
        U256(r)
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0; 4]
    }

    pub fn bits(&self) -> u32 {
        for i in (0..4).rev() {
            if self.0[i] != 0 {
                return 64 * i as u32 + 64 - self.0[i].leading_zeros();
            }
        }
        0
    }

    pub fn cmp(&self, o: &U256) -> core::cmp::Ordering {
        for i in (0..4).rev() {
            if self.0[i] != o.0[i] {
                return self.0[i].cmp(&o.0[i]);
            }
        }
        core::cmp::Ordering::Equal
    }

    pub fn add(&self, o: &U256) -> U256 {
        let mut r = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let s = self.0[i] as u128 + o.0[i] as u128 + carry;
            r[i] = s as u64;
            carry = s >> 64;
        }
        U256(r)
    }

    /// self - o, self >= o.
    pub fn sub(&self, o: &U256) -> U256 {
        let mut r = [0u64; 4];
        let mut borrow = 0i128;
        for i in 0..4 {
            let d = self.0[i] as i128 - o.0[i] as i128 - borrow;
            if d < 0 {
                r[i] = (d + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                r[i] = d as u64;
                borrow = 0;
            }
        }
        U256(r)
    }

    pub fn shl(&self, n: u32) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let (w, b) = ((n / 64) as usize, n % 64);
        let mut r = [0u64; 4];
        for i in (w..4).rev() {
            let mut v = self.0[i - w] << b;
            if b > 0 && i - w > 0 {
                v |= self.0[i - w - 1] >> (64 - b);
            }
            r[i] = v;
        }
        U256(r)
    }

    pub fn shr(&self, n: u32) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let (w, b) = ((n / 64) as usize, n % 64);
        let mut r = [0u64; 4];
        for i in 0..4 - w {
            let mut v = self.0[i + w] >> b;
            if b > 0 && i + w + 1 < 4 {
                v |= self.0[i + w + 1] << (64 - b);
            }
            r[i] = v;
        }
        U256(r)
    }

    /// The low 128 bits, or None when the value does not fit.
    pub fn to_u128(&self) -> Option<u128> {
        if self.0[2] != 0 || self.0[3] != 0 {
            None
        } else {
            Some(self.0[0] as u128 | (self.0[1] as u128) << 64)
        }
    }

    /// floor(self / d), d > 0: shift-and-subtract over the quotient's bits only.
    pub fn div(&self, d: &U256) -> U256 {
        if d.is_zero() {
            return U256([u64::MAX; 4]);
        }
        if self.cmp(d) == core::cmp::Ordering::Less {
            return U256::ZERO;
        }
        let shift = self.bits() - d.bits();
        let mut dd = d.shl(shift);
        let mut rem = *self;
        let mut q = U256::ZERO;
        let mut i = shift as i32;
        while i >= 0 {
            if rem.cmp(&dd) != core::cmp::Ordering::Less {
                rem = rem.sub(&dd);
                q.0[(i / 64) as usize] |= 1u64 << (i % 64);
            }
            dd = dd.shr(1);
            i -= 1;
        }
        q
    }
}
