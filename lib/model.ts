// Token radar model radar-3.0, the orchestrator: parse the snapshot, pick the rows, score them with
// lib/scoring.ts, attach the farm plans (lib/farm.ts) and rationales (lib/explain.ts), and check the board against the gate.
// The arithmetic lives in scoring.ts and the farm tables in farm.ts; nothing in this file multiplies or
// words a step. Live-token protocols are never mixed into the ranked board (see scoring.ts).

import { rationale } from './explain.ts';
import { farmPlan, STEP_MAX_CHARS, STEP_MIN_CHARS, stepText } from './farm.ts';
import type { FarmKind, FarmVerdict } from './farm.ts';
import { MODEL, MODEL_VERSION, categoryFits, fitDiagnostics, impliedValue, isPreToken, round4 } from './scoring.ts';
import type { CategoryFit, FitDiagnostics, ModelConstants, SnapshotProtocol } from './scoring.ts';

export { MODEL, MODEL_VERSION };
export type { CategoryFit, FitDiagnostics, ModelConstants, SnapshotProtocol };

export const EARLY_ROWS = 220;
export const LIVE_ROWS = 40;

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
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
  /** Expected value: launch_value_usd x token_odds. The board ranks by it. */
  implied_value_usd: number;
  launch_value_usd: number;
  token_odds: number;
  /** TVL x every multiplier x odds -> value, as one line. */
  equation: string;
  model: {
    base_multiple: number;
    category_multiple: number;
    fit_kind: 'fit' | 'median' | 'fallback';
    fit_peers: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    concentration_multiplier: number;
    liquidity_spread_multiplier: number;
    token_odds: number;
    age_days: number | null;
  };
  farm_steps: string[];
  /** Index in farm_steps of the lend/dex-only step, or null. */
  farm_extra: number | null;
  farm_kind: FarmKind | null;
  farm_verdict: FarmVerdict;
  farm_capital_usd: number;
  /** Plain-English account of the multipliers (lib/explain.ts). */
  rationale: string;
}

/** One row of data.js: what the dashboard needs, with the farm plan already worded. */
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
  launch_value_usd: number;
  token_odds: number;
  equation: string;
  growth_multiplier: number;
  maturity_multiplier: number;
  category_multiple: number;
  fit_kind: 'fit' | 'median' | 'fallback';
  fit_peers: number;
  chain_multiplier: number;
  concentration_multiplier: number;
  liquidity_spread_multiplier: number;
  farm_steps: string[];
  farm_extra: number | null;
  farm_kind: FarmKind | null;
  farm_verdict: FarmVerdict;
  farm_capital_usd: number;
  rationale: string;
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

/** Where every one of the snapshot's protocols went, and the board's verdict mix. */
export interface Integrity {
  protocols_total: number;
  pre_token_count: number;
  live_count: number;
  /** Neither a clean pre-token nor a live token (CEX rows with no token). */
  other_count: number;
  watchlist_size: number;
  watchlist_covered: number;
  board_size: number;
  farm_farm: number;
  farm_thin: number;
  farm_skip: number;
}

/** The expected-value bands (USD) behind the farm / thin / skip verdicts. */
export interface FarmVerdictThresholds {
  farm_ev_min: number;
  thin_ev_min: number;
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
  category_fits: Record<string, CategoryFit>;
  fit_diagnostics: FitDiagnostics;
  farm_verdict_thresholds: FarmVerdictThresholds;
  integrity: Integrity;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pre-token, not a CEX, and not a numbered re-deployment ("Foo V2") of another listing. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, fits?: Record<string, CategoryFit>): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const catFits = fits ?? categoryFits(snapshot.protocols, model);
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

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, model, catFits) }));
  scored.sort((a, b) => b.implied - a.implied || cmp(a.p.slug, b.p.slug));
  return scored.map((s, i) => {
    const plan = farmPlan(s.p, s.age, s.implied, model);
    const row = {
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
      launch_value_usd: s.launch,
      token_odds: round4(s.tokenOdds),
      equation: s.equation,
      model: {
        base_multiple: model.fallback_multiple,
        category_multiple: round4(s.categoryMult),
        fit_kind: s.fitKind,
        fit_peers: s.fitPeers,
        growth_pct: s.growthPct,
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        chain_multiplier: round4(s.chainMult),
        concentration_multiplier: round4(s.concentrationMult),
        liquidity_spread_multiplier: round4(s.liquiditySpreadMult),
        token_odds: round4(s.tokenOdds),
        age_days: s.age,
      },
      farm_steps: plan.steps.map(stepText),
      farm_extra: plan.extra,
      farm_kind: plan.kind,
      farm_verdict: plan.verdict,
      farm_capital_usd: plan.capital,
    };
    return { ...row, rationale: rationale(row) };
  });
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
    launch_value_usd: row.launch_value_usd,
    token_odds: row.token_odds,
    equation: row.equation,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    category_multiple: row.model.category_multiple,
    fit_kind: row.model.fit_kind,
    fit_peers: row.model.fit_peers,
    chain_multiplier: row.model.chain_multiplier,
    concentration_multiplier: row.model.concentration_multiplier,
    liquidity_spread_multiplier: row.model.liquidity_spread_multiplier,
    farm_steps: row.farm_steps,
    farm_extra: row.farm_extra,
    farm_kind: row.farm_kind,
    farm_verdict: row.farm_verdict,
    farm_capital_usd: row.farm_capital_usd,
    rationale: row.rationale,
  };
}

/** Counts that prove every protocol is accounted for and the watchlist is whole. */
export function integrityOf(snapshot: Snapshot, board: BoardRow[]): Integrity {
  const total = snapshot.protocols.length;
  const live = snapshot.protocols.filter((p) => !isPreToken(p)).length;
  const pre = snapshot.protocols.filter((p) => isPreToken(p) && p.category !== 'CEX').length;
  const slugs = new Set(board.map((r) => r.slug));
  const count = (v: FarmVerdict): number => board.filter((r) => r.farm_verdict === v).length;
  return {
    protocols_total: total,
    pre_token_count: pre,
    live_count: live,
    other_count: total - pre - live,
    watchlist_size: snapshot.watchlist.length,
    watchlist_covered: snapshot.watchlist.filter((s) => slugs.has(s)).length,
    board_size: board.length,
    farm_farm: count('farm'),
    farm_thin: count('thin'),
    farm_skip: count('skip'),
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const fits = categoryFits(snapshot.protocols, model);
  const board = buildBoard(snapshot, model, fits);
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
    category_fits: fits,
    fit_diagnostics: fitDiagnostics(snapshot.protocols, model),
    farm_verdict_thresholds: { farm_ev_min: model.farm_ev_min, thin_ev_min: model.thin_ev_min },
    integrity: integrityOf(snapshot, board),
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

/** The gate's board checks (watchlist covered, ranks 1..N, value never rising, 3 to 12 steps of 20 to 600 characters, 100+ rows). */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  if (board.length < 100) return `the board has ${board.length} rows, the gate needs at least 100`;
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
    for (const s of steps) {
      if (s.length < STEP_MIN_CHARS || s.length > STEP_MAX_CHARS) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
