//! The diary line: ASCII, hand-written integer formatting (no `format!`, no allocation). A pure
//! function of the diary entry and the coin's ticker (set at initialize), identical to `diaryLine` in
//! `hunch/site/core/chain.js`.

use crate::{
    layout::Entry,
    rules::{call, df, luck_band_bps, outcome},
};

pub const LINE_MAX: usize = 240;

/// The diary flags the buy clause sets when the hour's opening tick landed.
const BUY_FLAGS: u16 = df::GUARD | df::STALE | df::BELOW_MIN | df::VOLUME_CAP | df::DAY_CAP | df::NO_ATTEMPT;

pub struct Line {
    pub buf: [u8; LINE_MAX],
    pub len: usize,
}

impl Default for Line {
    fn default() -> Self {
        Line { buf: [0; LINE_MAX], len: 0 }
    }
}

impl Line {
    pub fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len]
    }
    pub fn text(&mut self, s: &[u8]) {
        for &b in s {
            if self.len < LINE_MAX {
                self.buf[self.len] = b;
                self.len += 1;
            }
        }
    }
    pub fn int(&mut self, mut v: u64) {
        let mut digits = [0u8; 20];
        let mut n = 0;
        loop {
            digits[n] = b'0' + (v % 10) as u8;
            n += 1;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        while n > 0 {
            n -= 1;
            self.text(&[digits[n]]);
        }
    }
    /// `v` with `width` digits, zero padded.
    fn padded(&mut self, v: u64, width: usize) {
        let mut digits = [b'0'; 20];
        let mut x = v;
        for i in 0..width {
            digits[width - 1 - i] = b'0' + (x % 10) as u8;
            x /= 10;
        }
        self.text(&digits[..width]);
    }
    /// lamports as SOL with 3 decimals, truncated: "0.083".
    pub fn sol3(&mut self, lamports: u64) {
        self.int(lamports / 1_000_000_000);
        self.text(b".");
        self.padded((lamports % 1_000_000_000) / 1_000_000, 3);
    }
    /// base units (6 decimals) as "1.20M", "350.12K", "12".
    pub fn tokens(&mut self, units: u64) {
        let t = units / 1_000_000;
        let two = |l: &mut Line, unit: u64, suffix: &[u8]| {
            l.int(t / unit);
            l.text(b".");
            l.padded(((t % unit) as u128 * 100 / unit as u128) as u64, 2);
            l.text(suffix);
        };
        if t >= 1_000_000_000 {
            two(self, 1_000_000_000, b"B");
        } else if t >= 1_000_000 {
            two(self, 1_000_000, b"M");
        } else if t >= 1_000 {
            two(self, 1_000, b"K");
        } else {
            self.int(t);
        }
    }
    fn side(&mut self, c: u8) {
        self.text(if c == call::BUSIER { b"busier" } else { b"quieter" });
    }
    /// "58/42": the lean toward the called side first.
    fn lean_pair(&mut self, c: u8, lean: u16) {
        let busier = (lean as u64 + 50) / 100;
        let (a, b) = if c == call::BUSIER { (busier, 100 - busier) } else { (100 - busier, busier) };
        self.int(a);
        self.text(b"/");
        self.int(b);
    }
    fn hex4(&mut self, b: &[u8; 4]) {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for &x in b {
            self.text(&[HEX[(x >> 4) as usize], HEX[(x & 15) as usize]]);
        }
    }
}

/// The diary line of an entry; `ticker` is the coin's (State.ticker, "HUNCH" in the vectors).
pub fn diary_line(e: &Entry, ticker: &[u8]) -> Line {
    let mut l = Line::default();
    let f = e.flags;
    l.text(b"hour ");
    l.int(e.hour as u64);
    l.text(b": ");
    if f & df::BLIND != 0 {
        l.text(b"blind: the pool layout changed, no calls, no buys.");
        return l;
    }
    if e.outcome == outcome::FORFEIT {
        // a one-hour forfeit whose opening tick landed carries the buy clause; its detail may be the guard's
        if e.detail > 1 && f & df::GUARD == 0 {
            l.text(b"forfeit x");
            l.int(e.detail as u64);
            l.text(b", a tick was missed.");
        } else {
            l.text(b"forfeit, a tick was missed.");
        }
    } else if f & df::GRADUATING != 0 {
        l.text(b"graduating, not scored.");
    } else if e.call == call::NONE {
        l.text(b"watching, no call yet.");
    } else {
        l.text(b"leaned ");
        l.side(e.call);
        l.text(b" ");
        l.lean_pair(e.call, e.lean);
        l.text(b", ");
        if e.outcome == outcome::HIT || e.outcome == outcome::MISS {
            let came = if e.outcome == outcome::HIT {
                e.call
            } else if e.call == call::BUSIER {
                call::QUIETER
            } else {
                call::BUSIER
            };
            l.text(b"came ");
            l.side(came);
            l.text(if e.outcome == outcome::HIT { b", hit." } else { b", miss." });
        } else if f & df::PAUSED != 0 {
            l.text(b"not scored, Meteora paused the pool.");
        } else if f & df::FEE_CHANGED != 0 {
            l.text(b"not scored, Meteora changed the pool fee");
            // the detail holds the live fee in steps of 5 bps, unless the guard's excess took it
            if e.detail > 0 && f & df::GUARD == 0 {
                let bps = e.detail as u64 * 5;
                l.text(b" to ");
                l.int(bps / 100);
                l.text(b".");
                l.padded(bps % 100, 2);
                l.text(b"%");
            }
            l.text(b".");
        } else if f & df::NO_OUTSIDE != 0 {
            l.text(b"not scored, no outside trades.");
        } else if f & df::TIE != 0 {
            l.text(b"came level, not scored.");
        } else {
            l.text(b"not scored, warm-up.");
        }
    }
    if e.n > 0 {
        l.text(b" net ");
        l.int(e.hits as u64);
        l.text(b"/");
        l.int(e.n as u64);
        l.text(b", rule ");
        l.int(e.rule_hits as u64);
        l.text(b"/");
        l.int(e.n as u64);
        l.text(b", flip 50+-");
        let band = luck_band_bps(e.n) as u64;
        l.int(band / 100);
        l.text(b".");
        l.int((band % 100) / 10);
        l.text(b".");
    }
    let held = e.held as u64 * 10_000;
    let waits = |l: &mut Line| {
        l.text(b", ");
        l.sol3(held);
        l.text(b" SOL waits.");
    };
    if e.bought > 0 {
        l.text(b" bought ");
        l.sol3(e.bought);
        l.text(b" SOL, burned ");
        l.tokens(e.burned);
        l.text(b" ");
        l.text(ticker);
        l.text(b".");
    } else if e.outcome == outcome::FORFEIT && f & BUY_FLAGS == 0 {
        l.text(b" no buy: the opening tick was missed.");
    } else if f & df::GRADUATING != 0 {
        l.text(b" no buy: the curve is complete.");
    } else if f & df::GUARD != 0 {
        l.text(b" no buy: price ");
        l.int(e.detail as u64 / 10);
        l.text(b".");
        l.int(e.detail as u64 % 10);
        l.text(b"% over its hour median");
        waits(&mut l);
    } else if f & df::STALE != 0 {
        l.text(b" no buy: the tape is stale");
        waits(&mut l);
    } else if f & df::BELOW_MIN != 0 {
        l.text(b" no buy: below 0.01 SOL");
        waits(&mut l);
    } else if f & df::VOLUME_CAP != 0 {
        l.text(b" no buy: outside volume cap");
        waits(&mut l);
    } else if f & df::DAY_CAP != 0 {
        l.text(b" no buy: daily cap");
        waits(&mut l);
    } else if f & df::PAUSED != 0 {
        l.text(b" no buy: Meteora paused the pool");
        waits(&mut l);
    } else {
        l.text(b" no buy: nobody called it");
        waits(&mut l);
    }
    if e.next_call == call::NONE {
        l.text(b" next: no call.");
    } else {
        l.text(b" next: ");
        l.side(e.next_call);
        l.text(b" ");
        l.lean_pair(e.next_call, e.next_lean);
        l.text(b".");
    }
    l.text(b" brain ");
    l.hex4(&e.brain);
    l
}
