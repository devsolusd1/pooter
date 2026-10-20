// What the site has to know about the world outside it. One place for these.
// While programId, mint and pool are null the site stays in rehearsal (a real pool's data replayed
// through the real network); once all three are set it reads the coin's own accounts through /api/state.
// The browser never talks to a Solana node: api/state.js does, with RPC_URL from the environment.

export const CONFIG = {
  // The coin's name and ticker, used everywhere on the page and in its title. A rename is these two lines.
  name: "Pooter",
  ticker: "POOTER",
  // The program (it stays upgradeable: the developer can update it).
  programId: "CCw2e4MgnZ3opEddVX4oJHkWJye81gARqEC1535hPaY1",
  // The token, a plain SPL token with immutable metadata.
  mint: "GWfA58i1zzcwgB4C5UCrRoSod35on5mrCPipqM8poot",
  // Its Meteora Dynamic Bonding Curve pool.
  pool: "2QwsNBQWj9rtCr2oMvoB8Jsrn1gPc5PERXi23Us2hYee",
  // The developer's wallet, shown beside their stated intention (null: not shown).
  developer: "G3gsMr4yEdxDjuCD4v7nJjKKrHig7Ytt6ubJ6LkC2bgm",
  // Where the reader answers, and how often the page asks it (it caches for about 10 seconds).
  api: "/api/state",
  refreshMs: 15_000,
};

export const isLive = (c = CONFIG) => !!(c && c.programId && c.mint && c.pool);
