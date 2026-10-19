//! Hunch's network, version one: the exact port of `hunch/site/core/net.js` (kill test K2).
//!
//! 10 inputs, 8 ReLU units, 8 more ReLU units, 1 sigmoid output: 169 weights in Q16.16 (`i32`,
//! 1.0 = 65536). Integers only, `no_std`, no allocation, no floats anywhere in feed, learn or think.
//!
//! Chapters (sealed, dated in hours from the launch hour; the caller passes the chapter in):
//! - chapter 0 (hours 0-167): inputs 9 and 10 are zero and their weights are zero and frozen, layer 2
//!   is a frozen identity. 81 numbers learn. This is exactly the 8-8-1 network the simulation ran:
//!   `mul_q(ONE, h) == h` and `relu(h) == h` for `h >= 0`, so the identity layer passes every hidden
//!   value through unchanged, and the backward signal through it is unchanged too.
//! - chapter 1 (from day 7): inputs 9 and 10 wake (their weights start at zero, so the call does not
//!   move at that moment). 97 numbers learn.
//! - chapter 2 (from day 14): layer 2 wakes from the identity. All 169 learn.
//! - chapter 3 (from day 21): learning rate 2^-8 instead of 2^-7.
//!
//! The feature tape works on what a program can measure each 10-minute bar ([`Bar`]): the bar's time,
//! its price return in Q16.16 and its outside quote volume in lamports, plus the two scoring inputs.
//! A bar whose tick was missed is fed by [`Model::feed`] with `fill = true`: it advances the tape
//! with the gap's average volume and no price move, has no inputs, never trains and never thinks.

#![no_std]

pub mod fixed;

use fixed::*;
pub use fixed::ONE;

/// Bars per hour, and the outcome horizon in bars.
pub const H: usize = 6;
/// One bar is 10 minutes.
pub const BAR_SECONDS: i64 = 600;
/// Learning rate 2^-7 (chapters 0-2).
pub const LR_SHIFT: u32 = 7;
/// Learning rate 2^-8 (chapter 3, from day 21).
pub const LR_SHIFT_SLOW: u32 = 8;
/// The canonical seed (net.js `SEED`).
pub const SEED: u32 = 12_346;
/// Inputs: the simulation's eight, then its last scored outcome and its recent hit rate.
pub const N_IN: usize = 10;
/// The eight inputs the network reads from chapter 0.
pub const N_BASE_IN: usize = 8;
pub const N_HID: usize = 8;
/// 80 + 8 + 64 + 8 + 8 + 1 = 169 (13 x 13).
pub const N_WEIGHTS: usize = N_HID * N_IN + N_HID + N_HID * N_HID + N_HID + N_HID + 1;
/// The numbers chapter 0 learns: W1's first 8 columns, b1, W3 and b3 (the 8-8-1 network).
pub const N_WEIGHTS_V0: usize = N_HID * N_BASE_IN + N_HID + N_HID + 1;
/// Every weight stays in [-8, 8].
pub const WEIGHT_CLIP: i64 = 8 * ONE;
/// Every input is clipped to [-4, 4].
pub const INPUT_CLIP: i64 = 4 * ONE;
/// Inputs exist from this bar on (two hours of history).
pub const FIRST_INPUT_BAR: i64 = 2 * H as i64;
/// Chapter boundaries in hours since the launch hour: day 7, day 14, day 21.
pub const CHAPTER_HOURS: [u32; 3] = [7 * 24, 14 * 24, 21 * 24];

/// The 10 inputs of one bar, Q16.16.
pub type Inputs = [i32; N_IN];

/// The chapter for a number of hours since the launch hour.
pub const fn chapter_of(hours_since_launch: u32) -> u8 {
    let mut c = 0;
    while c < CHAPTER_HOURS.len() && hours_since_launch >= CHAPTER_HOURS[c] {
        c += 1;
    }
    c as u8
}

/// The learning-rate shift of a chapter.
pub const fn lr_shift_of(chapter: u8) -> u32 {
    if chapter >= 3 {
        LR_SHIFT_SLOW
    } else {
        LR_SHIFT
    }
}

/// How many of the 169 numbers learn in a chapter: 81, 97, 169, 169.
pub const fn learning_count(chapter: u8) -> usize {
    match chapter {
        0 => N_WEIGHTS_V0,
        1 => N_WEIGHTS_V0 + 2 * N_HID,
        _ => N_WEIGHTS,
    }
}

/// One 10-minute bar, as integers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bar {
    /// Unix seconds of the bar's start.
    pub ts: i64,
    /// The bar's price return `close / previous close - 1` in Q16.16, before clipping.
    pub ret_q: i64,
    /// Outside quote volume of the bar in lamports (per 600 seconds).
    pub lam: u64,
    /// Input 9: the last scored outcome, +ONE hit, -ONE miss or forfeit, 0 none (0 in chapter 0).
    pub x9: i32,
    /// Input 10: the hit rate over the last 24 scored hours minus one half (0 in chapter 0).
    pub x10: i32,
}

/// The 169 weights. Flat order: `w1[j][i]` at `j*10 + i`, `b1` at 80, `w2[k][j]` at `88 + k*8 + j`,
/// `b2` at 152, `w3` at 160, `b3` at 168. `pad` keeps the struct 8-byte sized; it is never hashed.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Weights {
    pub w1: [[i32; N_IN]; N_HID],
    pub b1: [i32; N_HID],
    pub w2: [[i32; N_HID]; N_HID],
    pub b2: [i32; N_HID],
    pub w3: [i32; N_HID],
    pub b3: i32,
    pub pad: i32,
}

/// One forward pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Forward {
    /// First hidden layer pre-activations.
    pub z1: [i64; N_HID],
    pub h1: [i64; N_HID],
    /// Second hidden layer pre-activations (equal to `z1`'s positive part while it is the identity).
    pub z2: [i64; N_HID],
    pub h2: [i64; N_HID],
    /// Output pre-activation (the raw output).
    pub z3: i64,
    /// `sigmoid(z3)` in Q16.16: the lean toward busier.
    pub p: i64,
}

#[inline(always)]
fn upd(w: &mut i32, g: i64, lr: u32) {
    *w = clip(*w as i64 - rshr(g, lr), -WEIGHT_CLIP, WEIGHT_CLIP) as i32;
}

impl Weights {
    /// The starting weights for a seed: 64 `w1` (inputs 1-8) then 8 `w3` from the LCG, in net.js
    /// order; inputs 9-10 zero, every bias zero, layer 2 the identity.
    pub fn from_seed(seed: u32) -> Self {
        let mut r = Lcg(seed);
        let mut w = Weights::default();
        for row in w.w1.iter_mut() {
            for v in row.iter_mut().take(N_BASE_IN) {
                *v = start_weight(r.next());
            }
        }
        for v in w.w3.iter_mut() {
            *v = start_weight(r.next());
        }
        for k in 0..N_HID {
            w.w2[k][k] = ONE as i32;
        }
        w
    }

    /// True when the parts chapter 0 freezes still hold their launch values (inputs 9-10 zero,
    /// layer 2 the identity, b2 zero): what `load_brain` requires of a loaded brain.
    pub fn frozen_parts_at_launch(&self) -> bool {
        for j in 0..N_HID {
            if self.w1[j][8] != 0 || self.w1[j][9] != 0 || self.b2[j] != 0 {
                return false;
            }
            for k in 0..N_HID {
                if self.w2[j][k] != if j == k { ONE as i32 } else { 0 } {
                    return false;
                }
            }
        }
        true
    }

    pub fn forward(&self, x: &Inputs) -> Forward {
        let mut f = Forward::default();
        for j in 0..N_HID {
            let mut acc = self.b1[j] as i64;
            for i in 0..N_IN {
                acc += mul_q(self.w1[j][i] as i64, x[i] as i64);
            }
            f.z1[j] = acc;
            f.h1[j] = if acc > 0 { acc } else { 0 };
        }
        for k in 0..N_HID {
            let mut acc = self.b2[k] as i64;
            for j in 0..N_HID {
                acc += mul_q(self.w2[k][j] as i64, f.h1[j]);
            }
            f.z2[k] = acc;
            f.h2[k] = if acc > 0 { acc } else { 0 };
        }
        let mut z3 = self.b3 as i64;
        for k in 0..N_HID {
            z3 += mul_q(self.w3[k] as i64, f.h2[k]);
        }
        f.z3 = z3;
        f.p = sig_q(z3);
        f
    }

    /// One online gradient step on `(x, y)`, `y` is 0 or ONE, with the chapter's frozen parts held.
    /// All backward signals are computed from the old weights first, then every learning weight moves
    /// (in chapter 0 this is exactly the 8-8-1 update of net.js and the simulation).
    pub fn train(&mut self, x: &Inputs, y: i64, chapter: u8) -> (Forward, i64) {
        let lr = lr_shift_of(chapter);
        let f = self.forward(x);
        let e = f.p - y;
        let mut d2 = [0i64; N_HID];
        for k in 0..N_HID {
            if f.z2[k] > 0 {
                d2[k] = mul_q(e, self.w3[k] as i64);
            }
        }
        let mut d1 = [0i64; N_HID];
        for j in 0..N_HID {
            if f.z1[j] > 0 {
                let mut acc = 0i64;
                for k in 0..N_HID {
                    acc += mul_q(d2[k], self.w2[k][j] as i64);
                }
                d1[j] = acc;
            }
        }
        for k in 0..N_HID {
            upd(&mut self.w3[k], mul_q(e, f.h2[k]), lr);
        }
        upd(&mut self.b3, e, lr);
        if chapter >= 2 {
            for k in 0..N_HID {
                if d2[k] != 0 {
                    for j in 0..N_HID {
                        upd(&mut self.w2[k][j], mul_q(d2[k], f.h1[j]), lr);
                    }
                    upd(&mut self.b2[k], d2[k], lr);
                }
            }
        }
        let n_in = if chapter >= 1 { N_IN } else { N_BASE_IN };
        for j in 0..N_HID {
            if d1[j] != 0 {
                for i in 0..n_in {
                    upd(&mut self.w1[j][i], mul_q(d1[j], x[i] as i64), lr);
                }
                upd(&mut self.b1[j], d1[j], lr);
            }
        }
        (f, e)
    }

    /// The 169 weights in canonical order.
    pub fn flat(&self) -> [i32; N_WEIGHTS] {
        let mut q = [0i32; N_WEIGHTS];
        let mut k = 0;
        let mut put = |v: i32| {
            q[k] = v;
            k += 1;
        };
        for row in self.w1.iter() {
            for v in row.iter() {
                put(*v);
            }
        }
        for v in self.b1.iter() {
            put(*v);
        }
        for row in self.w2.iter() {
            for v in row.iter() {
                put(*v);
            }
        }
        for v in self.b2.iter().chain(self.w3.iter()) {
            put(*v);
        }
        put(self.b3);
        q
    }

    /// Weights from the canonical order (the inverse of [`Weights::flat`]).
    pub fn from_flat(q: &[i32; N_WEIGHTS]) -> Self {
        let mut w = Weights::default();
        let mut k = 0;
        let mut next = || {
            let v = q[k];
            k += 1;
            v
        };
        for j in 0..N_HID {
            for i in 0..N_IN {
                w.w1[j][i] = next();
            }
        }
        for j in 0..N_HID {
            w.b1[j] = next();
        }
        for kk in 0..N_HID {
            for j in 0..N_HID {
                w.w2[kk][j] = next();
            }
        }
        for j in 0..N_HID {
            w.b2[j] = next();
        }
        for j in 0..N_HID {
            w.w3[j] = next();
        }
        w.b3 = next();
        w
    }

    /// 676 bytes, little-endian i32 in canonical order: what the brain hash (SHA-256) is taken over.
    pub fn to_bytes(&self) -> [u8; N_WEIGHTS * 4] {
        let mut out = [0u8; N_WEIGHTS * 4];
        for (k, v) in self.flat().iter().enumerate() {
            out[k * 4..k * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        out
    }

    /// The chapter-0 view: the 81 numbers of the 8-8-1 network in its old flat order
    /// (`w1[j][i]` for i < 8 at `j*8 + i`, `b1` at 64, `w3` at 72, `b3` at 80).
    pub fn flat_v0(&self) -> [i32; N_WEIGHTS_V0] {
        let mut q = [0i32; N_WEIGHTS_V0];
        let mut k = 0;
        for row in self.w1.iter() {
            for v in row.iter().take(N_BASE_IN) {
                q[k] = *v;
                k += 1;
            }
        }
        for v in self.b1.iter().chain(self.w3.iter()) {
            q[k] = *v;
            k += 1;
        }
        q[k] = self.b3;
        q
    }

    /// 324 bytes of the chapter-0 view (the old 8-8-1 brain hash).
    pub fn to_bytes_v0(&self) -> [u8; N_WEIGHTS_V0 * 4] {
        let mut out = [0u8; N_WEIGHTS_V0 * 4];
        for (k, v) in self.flat_v0().iter().enumerate() {
            out[k * 4..k * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        out
    }
}

/// A fixed ring of the last `K` values (oldest first), the integer twin of net.js's `push`/`shift` arrays.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ring<T: Copy, const K: usize> {
    buf: [T; K],
    /// Index of the oldest value.
    head: u32,
    len: u32,
}

impl<T: Copy + Default, const K: usize> Default for Ring<T, K> {
    fn default() -> Self {
        Ring { buf: [T::default(); K], head: 0, len: 0 }
    }
}

impl<T: Copy, const K: usize> Ring<T, K> {
    #[inline]
    pub fn push(&mut self, v: T) {
        if (self.len as usize) < K {
            self.buf[(self.head as usize + self.len as usize) % K] = v;
            self.len += 1;
        } else {
            self.buf[self.head as usize] = v;
            self.head = ((self.head as usize + 1) % K) as u32;
        }
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.len as usize
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    /// The k-th oldest value (0 = oldest).
    #[inline]
    pub fn get(&self, k: usize) -> T {
        self.buf[(self.head as usize + k) % K]
    }
    #[inline]
    pub fn last(&self) -> T {
        self.get(self.len as usize - 1)
    }
}

/// A bar's inputs, or none (the first two hours, and every filled bar).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputSlot {
    pub has: u32,
    pub x: Inputs,
}

/// The network and its feature tape. `repr(C)` and integers only, so a program keeps it in an
/// account and uses it in place.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Model {
    pub weights: Weights,
    /// Training steps so far.
    pub version: u64,
    /// Index of the last bar fed (filled bars included); -1 before the first.
    pub t: i64,
    /// Unix seconds of the last bar fed.
    pub ts: i64,
    /// Running average size of a bar's move, Q16.16.
    pub s: i64,
    /// Running level of log2 bar volume, Q16.16.
    pub ema_lv: i64,
    /// Running level of log2 hour volume, Q16.16.
    pub ema_lvh: i64,
    /// 1 once the running levels are set (first bar).
    pub started: u32,
    /// The chapter of the last training step (for display; the caller decides the chapter).
    pub chapter: u32,
    /// Last 6 clipped returns.
    pub r_hist: Ring<i32, H>,
    /// Last 6 bar volumes in lamports (the hour volume).
    pub lam_hist: Ring<u64, H>,
    /// Last 12 bar volumes in lamports (the outcome label).
    pub vol_hist: Ring<u64, { 2 * H }>,
    /// Last 7 log2 hour volumes (to reach t - 6).
    pub lvh_hist: Ring<i32, { H + 1 }>,
    /// Last 7 bars' inputs (to reach t - 6): the pending samples.
    pub x_hist: Ring<InputSlot, { H + 1 }>,
}

/// The sample whose outcome became known with the last bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pending {
    /// Bar index of the sample (t - 6).
    pub t: i64,
    pub x: Option<Inputs>,
    /// 1 busier, 0 quieter, None on an exact tie.
    pub y: Option<u8>,
    pub next_vol: u64,
    pub last_vol: u64,
}

/// One training step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Learned {
    pub sample: i64,
    pub y: u8,
    /// The forward pass the step used (before the update).
    pub f: Forward,
    /// `p - y`.
    pub e: i64,
}

/// What [`Model::step`] did on one bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub t: i64,
    pub x: Option<Inputs>,
    pub learned: Option<Learned>,
    /// The forward pass on this bar's inputs, after learning.
    pub thought: Option<Forward>,
}

/// `busy` when p >= 0.5.
#[inline]
pub const fn call_of(p: i64) -> u8 {
    (p >= ONE / 2) as u8
}

impl Model {
    pub fn new(seed: u32) -> Self {
        let mut m = Model::default();
        m.reset(seed);
        m
    }

    /// Start over with the seed's weights and an empty tape (in place, for an account).
    pub fn reset(&mut self, seed: u32) {
        *self = Model::default();
        self.weights = Weights::from_seed(seed);
        self.t = -1;
    }

    /// Append one bar to the tape. A landed bar builds its inputs (from bar 12 on); a filled bar
    /// (`fill`, its tick was missed) moves nothing, and gets no inputs.
    pub fn feed(&mut self, bar: &Bar, fill: bool) -> Option<Inputs> {
        self.t += 1;
        let t = self.t;
        self.ts = bar.ts;
        let r = if t > 0 && !fill { clip(bar.ret_q, -ONE, INPUT_CLIP) } else { 0 };
        self.r_hist.push(r as i32);
        self.vol_hist.push(bar.lam);
        self.lam_hist.push(bar.lam);
        let lv = log2q(bar.lam.saturating_add(1));
        let mut hsum: u64 = 0;
        for k in 0..self.lam_hist.len() {
            hsum = hsum.saturating_add(self.lam_hist.get(k));
        }
        let lvh = log2q(hsum.saturating_add(1));
        self.lvh_hist.push(lvh as i32);
        let ar = r.abs();
        if self.started == 0 {
            self.s = if ar > 64 { ar } else { 64 };
            self.ema_lv = lv;
            self.ema_lvh = lvh;
            self.started = 1;
        } else {
            self.s += shr(ar - self.s, 5);
            self.ema_lv += shr(lv - self.ema_lv, 4);
            self.ema_lvh += shr(lvh - self.ema_lvh, 6);
        }
        let sc = if self.s > 16 { self.s } else { 16 };
        let mut slot = InputSlot::default();
        if t >= FIRST_INPUT_BAR && !fill {
            let (mut r6, mut a6) = (0i64, 0i64);
            for k in 0..self.r_hist.len() {
                let v = self.r_hist.get(k) as i64;
                r6 += v;
                a6 += v.abs();
            }
            let hour = (bar.ts.rem_euclid(86_400) / 3_600) as usize;
            let lvh_prev = self.lvh_hist.get(0) as i64; // lvh at t - 6
            let c = |v: i64| clip(v, -INPUT_CLIP, INPUT_CLIP) as i32;
            slot.has = 1;
            slot.x = [
                c(div_q(r, sc)),
                c(div_q(r6, sc * 3)),
                c(shr(lv - self.ema_lv, 2)),
                c(shr(lvh - self.ema_lvh, 1)),
                c(shr(lvh - lvh_prev, 1)),
                c(div_q(a6, sc * 6) - ONE),
                SIN[hour],
                COS[hour],
                c(bar.x9 as i64),
                c(bar.x10 as i64),
            ];
        }
        self.x_hist.push(slot);
        if slot.has != 0 {
            Some(slot.x)
        } else {
            None
        }
    }

    /// The sample 6 bars back (u = t - 6): were the 6 bars after u busier than the 6 ending at u?
    /// Labels are sums of lamports.
    pub fn pending(&self) -> Option<Pending> {
        let t = self.t;
        let u = t - H as i64;
        if u - H as i64 + 1 < 0 {
            return None;
        }
        let x = if self.x_hist.len() == H + 1 {
            let s = self.x_hist.get(0);
            if s.has != 0 {
                Some(s.x)
            } else {
                None
            }
        } else {
            None
        };
        // the ring holds bars t-11 .. t: the oldest 6 end at u, the newest 6 follow it
        let (mut last, mut next) = (0u64, 0u64);
        for k in 0..H {
            last = last.saturating_add(self.vol_hist.get(k));
            next = next.saturating_add(self.vol_hist.get(H + k));
        }
        let y = if next == last { None } else { Some((next > last) as u8) };
        Some(Pending { t: u, x, y, next_vol: next, last_vol: last })
    }

    /// Train on the pending sample if its tick landed (it has inputs) and its outcome is not a tie.
    pub fn learn(&mut self, chapter: u8) -> Option<Learned> {
        let s = self.pending()?;
        let x = s.x?;
        let y = s.y?;
        let (f, e) = self.weights.train(&x, if y == 1 { ONE } else { 0 }, chapter);
        self.version += 1;
        self.chapter = chapter as u32;
        Some(Learned { sample: s.t, y, f, e })
    }

    /// Forward pass on the current bar's inputs with the current weights.
    pub fn think(&self) -> Option<Forward> {
        if self.x_hist.is_empty() {
            return None;
        }
        let s = self.x_hist.last();
        if s.has == 0 {
            return None;
        }
        Some(self.weights.forward(&s.x))
    }

    /// Feed a landed bar, learn, think: the order net.js and the simulation use.
    pub fn step(&mut self, bar: &Bar, chapter: u8) -> Step {
        let x = self.feed(bar, false);
        let learned = self.learn(chapter);
        let thought = self.think();
        Step { t: self.t, x, learned, thought }
    }
}
