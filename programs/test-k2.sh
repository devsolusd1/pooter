#!/bin/bash
# Kill test K2: the Rust network against net.js, then the same network inside the Solana VM (LiteSVM).
# Run it from WSL or Linux:  bash hunch/programs/test-k2.sh        (add "net" to skip the VM part)
# The vectors come from Node:  node hunch/scripts/export-vectors.mjs (run again after any net.js change)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Cargo is slow on a Windows drive mounted in WSL, so build somewhere native.
target="${HUNCH_K2_TARGET:-$HOME/hunch-target/k2}"

if [ ! -f hunch-net/tests/vectors/v0/replay.txt ]; then
  (cd .. && node scripts/export-vectors.mjs)
fi

(cd hunch-net && CARGO_TARGET_DIR="$target/net" cargo test --release -- --nocapture)
[ "${1:-}" = "net" ] && exit 0

export HUNCH_BENCH_SO="$target/bench/deploy/hunch_net_bench.so"
(cd hunch-net-bench && CARGO_TARGET_DIR="$target/bench" cargo build-sbf --sbf-out-dir "$target/bench/deploy")
(cd hunch-net-bench-tests && CARGO_TARGET_DIR="$target/bench-tests" cargo test --release -- --nocapture)
echo "binary: $(stat -c %s "$HUNCH_BENCH_SO") bytes at $HUNCH_BENCH_SO"
