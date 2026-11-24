// Token radar model radar-2.2: implied value from snapshot figures only.
//
//   catMultiple = median(mcap/tvl) of live-token peers in the same category (clamped), else FALLBACK
//   growthMult  = 1 + clamp(change_7d, GROWTH_FLOOR, GROWTH_CAP) / 100 * GROWTH_WEIGHT        (weight 0.7)
//   maturity    = MATURITY_FLOOR + min(age_days, MATURITY_DAYS) / MATURITY_DAYS * MATURITY_RANGE
//                 (unknown age uses UNKNOWN_AGE_DAYS)
//   chainMult   = 1 + min(chains - 1, CHAIN_CAP) * CHAIN_WEIGHT
//   concentrationMult = 1 + CONCENTRATION_BONUS (0.05) when chains.length >= CONCENTRATION_MIN_CHAINS (3), else 1
//   implied     = max(1, round(tvl_usd * catMultiple * growthMult * maturity * chainMult * concentrationMult))
//
// Live-token protocols are never mixed into the ranked board; their mcap/tvl only sets category comps.
// No protocol name is special-cased. radar-2.2 adds the concentration factor, raises growth weight to 0.7,
// widens the early radar to 180 rows and shows 40 live comps.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  fallback_multiple: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_weight: number;
  chain_cap: number;
  concentration_bonus: number;
  concentration_min_chains: number;
  // Kept for dashboard formula display parity with older fields.
  base_multiple: number;
}

export const MODEL: ModelConstants = {
  fallback_multiple: 0.45,
  multiple_floor: 0.12,
  multiple_cap: 2.5,
  growth_weight: 0.7,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.55,
  maturity_range: 0.55,
  maturity_days: 1460,
  unknown_age_days: 270,
  chain_weight: 0.04,
  chain_cap: 6,
  concentration_bonus: 0.05,
  concentration_min_chains: 3,
  base_multiple: 0.45,
};

export const MODEL_VERSION = 'radar-2.2';
export const EARLY_ROWS = 180;
export const LIVE_ROWS = 40;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

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
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    concentration_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

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
  category_multiple: number;
  chain_multiplier: number;
  concentration_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

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
  category_multiples: Record<string, number>;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Live-token mcap/tvl medians by category (at least two comps); CEX ignored. */
export function categoryMultiples(protocols: SnapshotProtocol[], model: ModelConstants = MODEL): Record<string, number> {
  const buckets = new Map<string, number[]>();
  for (const p of protocols) {
    if (isPreToken(p) || p.category === 'CEX' || p.category === null) continue;
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const list = buckets.get(p.category) ?? [];
    list.push(ratio);
    buckets.set(p.category, list);
  }
  const out: Record<string, number> = {};
  for (const [cat, ratios] of buckets) {
    if (ratios.length < 2) continue;
    const m = median(ratios);
    if (m === null) continue;
    out[cat] = clamp(m, model.multiple_floor, model.multiple_cap);
  }
  return out;
}

export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiples: Record<string, number>,
): {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  concentrationMult: number;
  categoryMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const categoryMult = multiples[protocol.category ?? ''] ?? model.fallback_multiple;
  const extraChains = Math.max(0, protocol.chains.length - 1);
  const chainMult = 1 + Math.min(extraChains, model.chain_cap) * model.chain_weight;
  const concentrationMult = protocol.chains.length >= model.concentration_min_chains ? 1 + model.concentration_bonus : 1;
  const implied = Math.max(
    1,
    Math.round(protocol.tvl_usd * categoryMult * growthMult * maturityMult * chainMult * concentrationMult),
  );
  return { implied, growthPct, growthMult, maturityMult, chainMult, concentrationMult, categoryMult, age };
}

export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const multiples = categoryMultiples(snapshot.protocols, model);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || cmp(a.slug, b.slug))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, model, multiples) }));
  scored.sort((a, b) => b.implied - a.implied || cmp(a.p.slug, b.p.slug));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.fallback_multiple,
      category_multiple: round4(s.categoryMult),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      concentration_multiplier: round4(s.concentrationMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** radar-2.2 capital tiers by TVL (USD to deploy). */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 125;
  if (p.tvl_usd >= 50_000_000) return 75;
  return 50;
}

/** Younger protocols need a longer hold before activity looks organic. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 120) return 90;
  if (age < 270) return 60;
  if (age < 540) return 45;
  return 30;
}

// Category keyword -> concrete first action. {cap}, {name}, {chain} are filled in per protocol.
// The dashboard carries the same table; keep both in step.
const ACTIONS: Array<[string[], string]> = [
  [['lend', 'cdp', 'collateral'], 'Supply ${cap} of USDC as collateral on {name} ({chain}), borrow under 40% LTV, and leave both legs open.'],
  [['dex', 'amm'], "Add ${cap} of balanced liquidity to {name}'s deepest pool on {chain} and leave the LP position open."],
  [['yield', 'leveraged farm', 'aggregator'], "Deposit ${cap} into {name}'s primary vault on {chain} and keep the shares staked only if the vault itself scores points."],
  [['curator', 'allocator', 'risk'], 'Deposit ${cap} into a {name}-curated vault on {chain} and keep the receipt tokens in the same wallet.'],
  [['perp', 'derivative', 'basis'], 'Deposit ${cap} USDC margin on {name} ({chain}), open a tiny hedge under 2x, and keep funding paid.'],
  [['prediction'], 'Fund ${cap} on {name}, place one market under 5% of bankroll, and hold until settlement or the farm window ends.'],
  [['stable'], "Mint or deposit ${cap} of the stable asset through {name} on {chain} and hold it in the protocol's own wallet view."],
  [['rwa'], "Mint ${cap} of {name}'s yield-bearing RWA receipt on {chain} and keep it unbridged for the hold window."],
  [['insurance'], 'Buy ${cap} of cover from {name} on {chain} against a core DeFi risk and keep the policy active.'],
  [['bridge'], 'Bridge ${cap} of USDC to {chain} through {name}, then spend at least half inside its own app so the route is not a pass-through.'],
  [['staking', 'restak'], "Stake ${cap} of the chain's staking asset through {name} on {chain} and keep the liquid receipt in-wallet."],
];
const DEFAULT_ACTION = "Deposit ${cap} of USDC into {name}'s primary product on {chain} and leave the position open through the hold window.";

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const hit = ACTIONS.find(([keys]) => keys.some((k) => c.includes(k)));
  return (hit ? hit[1] : DEFAULT_ACTION)
    .replace('${cap}', () => `$${capital}`)
    .replace('{name}', () => p.name)
    .replace('{chain}', () => chain);
}

export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gasSetup = capital >= 150 ? 12 : capital >= 75 ? 7 : 4;
  return [
    {
      text: `Create a fresh farming wallet, fund it only with the $${capital} you will deploy plus gas, and store the seed offline.`,
      cost: `under $3 of gas to receive funds on ${chain}`,
      time: '10 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about $${gasSetup} of gas`,
      time: '20 minutes to set up',
    },
    {
      text: `Once a week, do one on-chain action on ${p.name} (deposit, withdraw dust, borrow/repay, swap, or vote) from the same wallet.`,
      cost: 'about $2 to $5 of gas each week',
      time: '15 minutes a week',
    },
    {
      text: `Keep the core position funded for at least ${hold} days so activity spans multiple protocol snapshots.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before claiming anything, open only the points or rewards UI that ${p.name} publishes itself; never pay a stranger to "claim" for you.`,
      cost: 'no fee to check; claim gas only from the official UI',
      time: '15 minutes',
    },
    {
      text: `Log wallet address, open date, tx hashes, and exit date in a farm notebook so you can unwind or repeat without guessing.`,
      cost: 'nothing but the notebook',
      time: '5 minutes after each change',
    },
  ];
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

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
    category_multiple: row.model.category_multiple,
    chain_multiplier: row.model.chain_multiplier,
    concentration_multiplier: row.model.concentration_multiplier,
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    category_multiples: categoryMultiples(snapshot.protocols, model),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
