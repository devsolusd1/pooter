//! Q16.16 integer arithmetic, exactly as `net.js` does it with JavaScript numbers.
//!
//! Every helper here reproduces the JS expression bit for bit on the ranges the network uses
//! (all products stay far below 2^53, where JS numbers are exact integers):
//! `mulQ` floors, `divQ` truncates, `shr` floors, `rshr` rounds half up.

/// 1.0 in Q16.16.
pub const ONE: i64 = 65_536;

/// `mulQ(a, b) = floor(a * b / ONE)`: an arithmetic shift of the 64-bit product.
#[inline(always)]
pub const fn mul_q(a: i64, b: i64) -> i64 {
    (a * b) >> 16
}

/// `divQ(a, b) = trunc(a * ONE / b)`: Rust's integer division truncates toward zero, like `Math.trunc`.
#[inline(always)]
pub const fn div_q(a: i64, b: i64) -> i64 {
    (a * ONE) / b
}

/// `shr(v, s) = floor(v / 2^s)`: an arithmetic right shift.
#[inline(always)]
pub const fn shr(v: i64, s: u32) -> i64 {
    v >> s
}

/// `rshr(v, s) = floor((v + 2^(s-1)) / 2^s)`: right shift rounding half up.
#[inline(always)]
pub const fn rshr(v: i64, s: u32) -> i64 {
    (v + (1 << (s - 1))) >> s
}

#[inline(always)]
pub const fn clip(v: i64, lo: i64, hi: i64) -> i64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// `log2q(u)`: integer log2 with a linear mantissa, `msb + (u - 2^msb) / 2^msb`, in Q16.16,
/// floored; 0 for u < 1. `(u - 2^msb) * 2^16 / 2^msb` is a plain shift either way, so no
/// 128-bit product is needed for any u64.
#[inline]
pub const fn log2q(u: u64) -> i64 {
    if u < 1 {
        return 0;
    }
    let msb = 63 - u.leading_zeros();
    let rest = u - (1u64 << msb);
    let frac = if msb >= 16 { rest >> (msb - 16) } else { rest << (16 - msb) };
    (msb as i64) * ONE + frac as i64
}

/// sin(2 pi h / 24) for each UTC hour, Q16.16 (sealed: the values `Math.sin` gives in sim.mjs).
pub const SIN: [i32; 24] = [
    0, 16962, 32768, 46341, 56756, 63303, 65536, 63303, 56756, 46341, 32768, 16962, 0, -16962, -32768, -46341,
    -56756, -63303, -65536, -63303, -56756, -46341, -32768, -16962,
];
/// cos(2 pi h / 24) for each UTC hour, Q16.16.
pub const COS: [i32; 24] = [
    65536, 63303, 56756, 46341, 32768, 16962, 0, -16962, -32768, -46341, -56756, -63303, -65536, -63303, -56756,
    -46341, -32768, -16962, 0, 16962, 32768, 46341, 56756, 63303,
];
/// Sigmoid over [-8, 8] in steps of 0.5, Q16.16; linear interpolation between entries.
pub const SIG: [i64; 33] = [
    22, 36, 60, 98, 162, 267, 439, 720, 1179, 1921, 3108, 4971, 7812, 11955, 17625, 24743, 32768, 40793, 47911,
    53581, 57724, 60565, 62428, 63615, 64357, 64816, 65097, 65269, 65374, 65438, 65476, 65500, 65514,
];

/// `sigQ(z)`: the table sigmoid. z is Q16.16, the result is in (0, ONE).
#[inline]
pub const fn sig_q(z: i64) -> i64 {
    if z <= -8 * ONE {
        return SIG[0];
    }
    if z >= 8 * ONE {
        return SIG[32];
    }
    let pos = z + 8 * ONE; // 0 .. 16 * ONE
    let k = (pos / (ONE / 2)) as usize; // pos > 0, so division floors
    let t = pos - (k as i64) * (ONE / 2);
    // the table rises, so the product is >= 0 and the division floors like Math.floor
    SIG[k] + ((SIG[k + 1] - SIG[k]) * t) / (ONE / 2)
}

/// The starting-weight generator of `net.js`: `s = s * 1664525 + 1013904223 (mod 2^32)`.
#[derive(Clone, Copy)]
pub struct Lcg(pub u32);

impl Lcg {
    #[inline]
    pub fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0
    }
}

/// The double nearest 0.35 (the start scale `sc` in net.js) is exactly `SC_MANTISSA / 2^54`.
pub const SC_MANTISSA: u128 = 6_305_039_478_318_694;

/// One starting weight from one LCG output `s`, computed with integers only but bit-identical to
/// `Math.round(((s / 2^32) * 2 - 1) * 0.35 * 65536)` in JavaScript:
/// - `(s / 2^32) * 2 - 1 = (s - 2^31) / 2^31` is exact in a double;
/// - the product with the double 0.35 is `(s - 2^31) * SC_MANTISSA / 2^85`, rounded to 53 significant
///   bits, ties to even (IEEE 754), which is reproduced below;
/// - `* 65536` is exact, and `Math.round(v) = floor(v + 1/2)`.
pub const fn start_weight(s: u32) -> i32 {
    let a = s as i64 - (1i64 << 31);
    if a == 0 {
        return 0;
    }
    let mag = (a.unsigned_abs() as u128) * SC_MANTISSA; // < 2^84
    let bits = 128 - mag.leading_zeros();
    let rounded = if bits > 53 {
        let sh = bits - 53;
        let q = mag >> sh;
        let rem = mag & ((1u128 << sh) - 1);
        let half = 1u128 << (sh - 1);
        let q = if rem > half || (rem == half && q & 1 == 1) { q + 1 } else { q };
        q << sh
    } else {
        mag
    };
    let v = if a < 0 { -(rounded as i128) } else { rounded as i128 }; // value * 2^69
    ((v + (1i128 << 68)) >> 69) as i32
}
