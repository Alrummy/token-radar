// The token radar's model: one sealed snapshot in, one ranked board out.
//
// The watchlist is a coverage floor, never a ceiling. Every watchlist protocol is retained; the early
// radar may add pre-token protocols below that floor. A protocol is pre-token only when the index has no
// market cap, CoinGecko id, or symbol for it. Live-token protocols are listed separately at market value.
//
// Implied value uses only snapshot figures:
//   base       = tvl_usd x BASE_MULTIPLE
//   growth     = clamp(change_7d, -60, 120) percent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4 (unknown age: 365)
//   breadth    = min(1.25, 1 + 0.04 x ln(1 + chain_count))
//   implied    = max(1, round(base x growthMult x maturity x breadth))
//
// The dashboard and sandbox expose the same constants. No protocol name is special-cased.

/** A protocol record from the sealed snapshot. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The input document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Model settings displayed by the dashboard and editable in its sandbox. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_breadth_weight: number;
  chain_breadth_cap: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_breadth_weight: 0.04,
  chain_breadth_cap: 1.25,
};

/** The dashboard's model label. */
export const MODEL_VERSION = 'radar-1';
/** Maximum number of additional below-floor pre-token protocols. */
export const EARLY_ROWS = 160;
/** Maximum number of live-token rows. */
export const LIVE_ROWS = 24;

/** One farm-plan step before it is rendered as a string. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A complete row written to board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** Compact row consumed by the dashboard. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_breadth_multiplier: number;
  farm_steps: string[];
}

/** A protocol with a live token; its own market cap is shown without model scoring. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Dashboard payload assembled from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Input that cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Use a finite numeric value, or the supplied fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from listing to the snapshot date, floored at zero; unavailable for invalid dates. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Calculate the value and its factors for a single protocol. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor
    + Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days * model.maturity_range;
  const breadthMult = Math.min(
    model.chain_breadth_cap,
    1 + model.chain_breadth_weight * Math.log1p(protocol.chains.length),
  );
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** DefiLlama marks version pools by a release suffix in their names. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** True only when the index records no token fields. */
export function isPreToken(protocol: SnapshotProtocol): boolean {
  return protocol.mcap_usd === null && protocol.gecko_id === null && protocol.symbol === null;
}

/** A pre-token protocol that is not an exchange or a versioned pool. */
export function isRankable(protocol: SnapshotProtocol): boolean {
  return isPreToken(protocol) && protocol.category !== 'CEX' && !VERSIONED.test(protocol.name);
}

/** Index snapshot records by their unique slugs. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((protocol) => [protocol.slug, protocol]));
}

/** Counts used in the dashboard's headline. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Select, score and rank watchlist and early-radar rows. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();

  // Keep every available watchlist member, regardless of its other metadata.
  for (const slug of snapshot.watchlist) {
    const protocol = index.get(slug);
    if (protocol !== undefined) chosen.set(slug, protocol);
  }

  // Below-floor discoveries extend the watchlist but never displace one of its rows.
  const early = snapshot.protocols
    .filter((protocol) => !chosen.has(protocol.slug)
      && isRankable(protocol)
      && protocol.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || compareText(a.slug, b.slug))
    .slice(0, EARLY_ROWS);
  for (const protocol of early) chosen.set(protocol.slug, protocol);

  const scored = [...chosen.values()].map((protocol) => ({
    protocol,
    ...impliedValue(protocol, snapshot.as_of, model),
  }));
  scored.sort((a, b) => b.implied - a.implied || compareText(a.protocol.slug, b.protocol.slug));
  return scored.map((score, i) => ({
    rank: i + 1,
    slug: score.protocol.slug,
    name: score.protocol.name,
    category: score.protocol.category,
    chains: score.protocol.chains,
    tvl_usd: score.protocol.tvl_usd,
    change_7d: score.protocol.change_7d,
    mcap_usd: score.protocol.mcap_usd,
    listed_at: score.protocol.listed_at,
    gecko_id: score.protocol.gecko_id,
    symbol: score.protocol.symbol,
    token_status: 'pre-token',
    age_days: score.age,
    implied_value_usd: score.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: score.growthPct,
      growth_multiplier: round4(score.growthMult),
      maturity_multiplier: round4(score.maturityMult),
      chain_breadth_multiplier: round4(score.breadthMult),
      age_days: score.age,
    },
    farm_steps: farmSteps(score.protocol, score.age).map(stepText),
  }));
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;

/** Add the cost and time to a step and enforce the gate's text length bounds. */
export function stepText(step: FarmStep): string {
  let text = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (text.length > 600) text = `${text.slice(0, 596)}...`;
  if (text.length < 20) text += ' Hold the position and check the protocol\'s own page.';
  return text;
}

/** The first named chain, with a neutral fallback. */
function chainOf(protocol: SnapshotProtocol): string {
  return protocol.chains.length > 0 ? protocol.chains[0]! : 'its main chain';
}

/** Working capital scales with the protocol's snapshot TVL. */
function capitalFor(protocol: SnapshotProtocol): number {
  if (protocol.tvl_usd >= 5_000_000_000) return 250;
  if (protocol.tvl_usd >= 1_000_000_000) return 150;
  if (protocol.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Younger protocols get a longer suggested monitoring window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Generate the category-specific position action. */
function actionFor(protocol: SnapshotProtocol, capital: number, chain: string): string {
  const category = (protocol.category ?? '').toLowerCase();
  const name = protocol.name;
  if (category.includes('lend') || category.includes('cdp') || category.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  }
  if (category.includes('dex') || category.includes('yield') || category.includes('leveraged farm')) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  }
  if (category.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (category.includes('staking') || category.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  }
  if (category.includes('perpetual') || category.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  }
  if (category.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (category.includes('curator') || category.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (category.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (category.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (category.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Six evidence-based farm steps from category, chain, TVL and age; no protocol names are curated. */
export function farmSteps(protocol: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(protocol);
  const capital = capitalFor(protocol);
  const hold = holdDaysFor(age);
  const action = actionFor(protocol, capital, chain);
  const category = protocol.category ?? 'uncategorized';
  const name = protocol.name;
  const txCost = capital >= 150 ? 8 : 4;
  return [
    {
      text: `Open ${name}'s official app from a verified project source on ${chain}; connect a fresh wallet and confirm the displayed network is ${chain} before signing.`,
      cost: 'about $0–$3 for a connection or first on-chain approval; never pay an access fee',
      time: '5–10 minutes',
    },
    {
      text: `${action} Check the asset, pool or vault is actually listed in ${name}'s interface and review its withdrawal terms before confirming.`,
      cost: `$${capital} working capital plus about $${txCost} in estimated transaction fees; fees vary by ${chain} congestion`,
      time: '10–20 minutes to inspect and submit',
    },
    {
      text: `For ${name}'s ${category} activity, return once a week to review the open position and use one relevant app action (for example adjust liquidity for a DEX or check collateral for lending); do not trade solely to manufacture volume.`,
      cost: `about $1–$4 per on-chain action on ${chain}; no extra capital assumed`,
      time: '5–10 minutes weekly',
    },
    {
      text: `Keep the ${name} position only while its risk and terms remain acceptable, and review it for at least ${hold} days; this is a monitoring window, not a claim that points or an airdrop exist.`,
      cost: `$${capital} remains exposed to the position's market and smart-contract risks`,
      time: `${hold} days, with a 5-minute weekly review`,
    },
    {
      text: `Before exiting ${name}, check its official ${chain} app for published rewards or points terms; the snapshot does not establish an incentive. If no terms exist, skip this step and do not sign a third-party claim message.`,
      cost: 'no cost to read terms; any claim transaction fee must be shown by the app before signing',
      time: '5–10 minutes',
    },
    {
      text: `Record the ${name} wallet address, ${chain}, entry date, transaction IDs, capital and fee receipts; when the review window ends, use ${name}'s own withdraw or close control and verify the returned balance.`,
      cost: `about $${txCost} estimated to close or withdraw, plus any fee the ${chain} wallet displays`,
      time: '10–20 minutes to unwind and reconcile',
    },
  ];
}

/** Live-token protocols ordered by market cap for the dashboard's separate view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((protocol) => !isPreToken(protocol) && protocol.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((protocol) => ({
      slug: protocol.slug,
      name: protocol.name,
      category: protocol.category,
      chains: protocol.chains,
      tvl_usd: protocol.tvl_usd,
      mcap_usd: protocol.mcap_usd,
      change_7d: protocol.change_7d,
    }));
}

/** Omit the full model breakdown when producing a compact dashboard row. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_breadth_multiplier: row.model.chain_breadth_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Build both the full board and the browser payload from one snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((row) => !snapshot.watchlist.includes(row.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Parse and validate the JSON input shape used by this model. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const object = raw as Record<string, unknown>;
  if (typeof object.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(object.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof object.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof object.floor_usd !== 'number' || !Number.isSafeInteger(object.floor_usd) || object.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(object.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(object.watchlist) || object.watchlist.some((slug) => typeof slug !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }

  const protocols = object.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const protocol = entry as Record<string, unknown>;
    if (typeof protocol.slug !== 'string' || typeof protocol.name !== 'string'
      || typeof protocol.tvl_usd !== 'number' || !Number.isFinite(protocol.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: protocol.slug,
      name: protocol.name,
      category: typeof protocol.category === 'string' ? protocol.category : null,
      chains: Array.isArray(protocol.chains)
        ? protocol.chains.filter((chain): chain is string => typeof chain === 'string')
        : [],
      tvl_usd: protocol.tvl_usd,
      change_7d: typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : null,
      mcap_usd: typeof protocol.mcap_usd === 'number' && Number.isFinite(protocol.mcap_usd) ? protocol.mcap_usd : null,
      listed_at: typeof protocol.listed_at === 'string' ? protocol.listed_at : null,
      gecko_id: typeof protocol.gecko_id === 'string' ? protocol.gecko_id : null,
      symbol: typeof protocol.symbol === 'string' ? protocol.symbol : null,
    };
  });
  return {
    as_of: object.as_of,
    source: object.source,
    floor_usd: object.floor_usd,
    protocols,
    watchlist: object.watchlist as string[],
  };
}

/** Return the first reason this board would fail the coverage, ranking, value or farm-step checks. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((row) => row.slug));
  const missing = snapshot.watchlist.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((row) => row.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** Serialize the browser payload as an inline script, avoiding any fetch at runtime. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
