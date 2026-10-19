#!/bin/bash
# Builds the Hunch program (version one, curve phase) and the test-only CPI probe. Run it from Linux or WSL.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Cargo is slow on a Windows drive mounted in WSL, so build somewhere native.
target="${HUNCH_TARGET:-$HOME/hunch-target}"
offline="${CARGO_OFFLINE:---offline}"
(cd hunch && CARGO_TARGET_DIR="$target/hunch" cargo build-sbf $offline --sbf-out-dir "$target/deploy")
(cd cpi-probe && CARGO_TARGET_DIR="$target/cpi-probe" cargo build-sbf $offline --sbf-out-dir "$target/deploy")
# test-only: the same program with a 3% impact cap, so a test can reach the post-swap revert (never deployed)
(cd hunch && CARGO_TARGET_DIR="$target/hunch-wide" cargo build-sbf $offline --sbf-out-dir "$target/deploy-wide" -- --features test-wide-impact-cap)
for so in "$target/deploy/hunch.so" "$target/deploy/hunch_cpi_probe.so"; do
  echo "binary: $(stat -c %s "$so") bytes at $so"
done
