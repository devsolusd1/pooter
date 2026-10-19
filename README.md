# Pooter

Pooter ($POOTER) is a Solana coin with a tiny neural network inside its own program. Every ten minutes the
program reads the coin's pool; each UTC hour it calls the next hour's trading busier or quieter, is scored
in public next to a coin flip and a one-line rule, writes one diary line on chain, and spends a slice of
every trade's fee buying POOTER from its own pool and burning it. It calls activity, not price, and its
call is not a signal to trade.

- Fee: 3.75% per trade. Meteora keeps 0.75%, the program's budget gets 0.99% (it can only buy and burn),
  the developer gets 2.01%. An opening fee of 50% falls to 3.75% over the first 5 seconds.
- The program is upgradeable: the developer can update it. It has not had an outside audit.
- Inside the code the program is still called `hunch` (folders, crates, scripts, account tags).

## What is here

| Folder | What |
|---|---|
| `site/` | the website (static, no build step): rehearsal before launch, live after; `site/config.js` holds the name, ticker and addresses |
| `api/` | `api/state.js`, the Vercel function that reads the program's accounts (needs `RPC_URL` in the environment) |
| `programs/hunch` | the on-chain program (Pinocchio), `programs/hunch-net` the Q16.16 network, `programs/hunch-tests` the LiteSVM suite |
| `site/core/` | the JavaScript reference kept in lockstep with the program (`chain.js`, `net.js`) |
| `launch/` | the launch tool (dry by default, sends only with `SEND=1` and a `STEP`), token settings, metadata and image, `RUNBOOK.md` (in Portuguese) |
| `crank/` | the crank that ticks the program every ten minutes and runs the hourly buy |
| `scripts/` | deploy and initialize scripts, the local site server, checks |
| `sim/` | the simulation and pool data the network was designed on |
| `design/layout-final.md` | the program's account layout, instructions and errors |

## Run the site locally

```
node scripts/site.mjs --port 4600
```

The site stays in rehearsal while `programId`, `mint` and `pool` in `site/config.js` are null.

## Tests

Built and tested in WSL Ubuntu (solana-cli 3.1.14, cargo build-sbf, node 20) against Meteora's mainnet
bytecode:

```
bash programs/test-v1.sh
node scripts/check.mjs
node crank/test/unit.mjs
node launch/test/unit.mjs
```
