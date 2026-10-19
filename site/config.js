// What the site has to know about the world outside it. One place for these.
// While programId, mint and pool are null the site stays in rehearsal (a real pool's data replayed
// through the real network); once all three are set it reads the coin's own accounts through /api/state.
// The browser never talks to a Solana node: api/state.js does, with RPC_URL from the environment.

export const CONFIG = {
  // The coin's name and ticker, used everywhere on the page and in its title. A rename is these two lines.
  name: "Pooter",
  ticker: "POOTER",
  // The program (it stays upgradeable: the developer can update it).
  programId: null,
  // The token, a plain SPL token with immutable metadata.
  mint: null,
  // Its Meteora Dynamic Bonding Curve pool.
  pool: null,
  // The developer's wallet, shown beside their stated intention (null: not shown).
  developer: null,
  // Where the reader answers, and how often the page asks it (it caches for about 10 seconds).
  api: "/api/state",
  refreshMs: 15_000,
};

export const isLive = (c = CONFIG) => !!(c && c.programId && c.mint && c.pool);
