#!/bin/bash
# Runs the crank on this Windows PC, inside WSL, and starts it again if it ever stops.
#   wsl -e bash -lc 'bash /mnt/c/Users/John/RafinhaProject/hunch/crank/run-pc.sh send'   sends (SEND=1)
#   wsl -e bash -lc 'bash /mnt/c/Users/John/RafinhaProject/hunch/crank/run-pc.sh'        dry: plans only
# The Windows task "Pooter crank" (launch/RUNBOOK.md, 3.3) runs the first line at logon, with no window.
# Settings come from the environment or hunch/crank/.env, which the user writes (RPC_URL, CRANK_KEYPAIR,
# PROGRAM_ID); crank.mjs never prints the node's address or a key path. Only one copy runs per PC.
# Log: ~/pooter-crank/crank.log in WSL (moved to crank.log.1 past 20 MB).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
logs="$HOME/pooter-crank"
mkdir -p "$logs"
exec 9>"$logs/.lock"
flock -n 9 || { echo "a crank is already running on this PC"; exit 0; }
cd "$here"
while true; do
  if [ -f "$logs/crank.log" ] && [ "$(stat -c %s "$logs/crank.log")" -gt 20000000 ]; then mv "$logs/crank.log" "$logs/crank.log.1"; fi
  if [ "${1:-}" = "send" ]; then SEND=1 node crank.mjs >> "$logs/crank.log" 2>&1; else node crank.mjs --dry >> "$logs/crank.log" 2>&1; fi
  echo "$(date -u +%FT%TZ) the crank stopped (exit $?); starting it again in 10 s" >> "$logs/crank.log"
  sleep 10
done
