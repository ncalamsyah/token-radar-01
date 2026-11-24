// Launch Radar scoring (radar-3.0): every number behind an implied value lives here and nowhere else.
//
//   sizeCatMultiple = clamp(a + b * log10(tvl_usd), multiple_floor, multiple_cap)
//       (a, b) = least-squares line through the live-token peers of the category: x = log10(tvl), y = mcap/tvl.
//       A category needs >= fit_min_peers (4) peers for a line; 2 or 3 peers keep their median (b = 0);
//       fewer than 2 use fallback_multiple.
//   growthMult  = 1 + clamp(change_7d, growth_floor, growth_cap) / 100 * growth_weight
//   maturity    = maturity_floor + min(age_days, maturity_days) / maturity_days * maturity_range
//   chainMult   = 1 + min(chains - 1, chain_cap) * chain_weight
//   concentrationMult = 1 + concentration_bonus when chains >= concentration_min_chains, else 1
//   liquiditySpreadMult = 1 + min(liquidity_spread_cap, max(0, change_7d) / 100 * liquidity_spread_weight)
//   launch_value = round(tvl * sizeCatMultiple * growth * maturity * chain * concentration * liquiditySpread)
//   token_odds  = clamp(odds_floor + (odds_young - odds_floor) * exp(-age / odds_half_life_days), floor, young)
//                 (unknown age: odds_unknown). Age without a token is the only input: no names.
//   implied (EV) = max(1, round(launch_value * token_odds)); the board ranks by it.
//   farm verdict = 'farm' when EV >= farm_ev_min, 'thin' when EV >= thin_ev_min, else 'skip' (absolute dollars).
//
// The fit is tested on itself: leave-one-out over every fitted peer, and a walk-forward split (fit on the
// lower-TVL half of a category, score the upper half). See fitDiagnostics().
// Live-token protocols are never mixed into the ranked board; their mcap/tvl only sets category comps.
// No protocol name is special-cased. dashboard/radar-view.js recomputes the same arithmetic from the
// constants and fits in data.js, so a change here needs the matching change there.

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

export interface ModelConstants {
  fallback_multiple: number;
  multiple_floor: number;
  multiple_cap: number;
  /** Peers a category needs for a fitted size curve. */
  fit_min_peers: number;
  /** Peers a category needs for a median-only multiple. */
  median_min_peers: number;
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
  liquidity_spread_weight: number;
  liquidity_spread_cap: number;
  /** Odds a token eventually lists: unknown age, youngest, oldest, and the decay half-life in days. */
  odds_unknown: number;
  odds_young: number;
  odds_floor: number;
  odds_half_life_days: number;
  /** Farm verdict bands on expected value in USD: at or above farm_ev_min is farm, at or above thin_ev_min is thin. */
  farm_ev_min: number;
  thin_ev_min: number;
  // Kept for dashboard formula display parity with older fields.
  base_multiple: number;
}

export const MODEL_VERSION = 'radar-3.0';

export const MODEL: ModelConstants = {
  fallback_multiple: 0.45,
  multiple_floor: 0.12,
  multiple_cap: 2.5,
  fit_min_peers: 4,
  median_min_peers: 2,
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
  liquidity_spread_weight: 0.15,
  liquidity_spread_cap: 0.08,
  odds_unknown: 0.35,
  odds_young: 0.7,
  odds_floor: 0.05,
  odds_half_life_days: 540,
  farm_ev_min: 5_000_000,
  thin_ev_min: 1_000_000,
  base_multiple: 0.45,
};

const DAY_MS = 86_400_000;

export function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol that records no token at all (no market cap, no gecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** "$12.4M" style money for equations and plans. */
export function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---- size-aware category fit

/** One live-token comp: category, TVL, market cap. */
export interface Peer {
  category: string;
  slug: string;
  tvl: number;
  mcap: number;
}

export interface CategoryFit {
  /** Intercept (a) and slope (b) of multiple = a + b * log10(tvl). A median-only category has b = 0. */
  a: number;
  b: number;
  n: number;
  median: number;
  kind: 'fit' | 'median';
}

/** Live-token comps (mcap and TVL > 0, not CEX, with a category). */
export function livePeers(protocols: SnapshotProtocol[]): Peer[] {
  const out: Peer[] = [];
  for (const p of protocols) {
    if (isPreToken(p) || p.category === 'CEX' || p.category === null) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    out.push({ category: p.category, slug: p.slug, tvl: p.tvl_usd, mcap: p.mcap_usd });
  }
  return out;
}

/** Ordinary least squares y = a + b x. No x spread: slope 0 and the mean. */
export function fitLine(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx < 1e-12) return { a: my, b: 0 };
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** The category's multiple for a protocol of this TVL, clamped to [floor, cap]. */
export function predictMultiple(fit: { a: number; b: number }, tvl: number, model: ModelConstants = MODEL): number {
  return clamp(fit.a + fit.b * Math.log10(Math.max(1, tvl)), model.multiple_floor, model.multiple_cap);
}

const xOf = (p: Peer): number => Math.log10(p.tvl);
const yOf = (p: Peer): number => p.mcap / p.tvl;

/** Per-category fits: a line from fit_min_peers peers up, the median from median_min_peers, else nothing. */
export function categoryFits(protocols: SnapshotProtocol[], model: ModelConstants = MODEL): Record<string, CategoryFit> {
  const buckets = new Map<string, Peer[]>();
  for (const p of livePeers(protocols)) {
    const list = buckets.get(p.category) ?? [];
    list.push(p);
    buckets.set(p.category, list);
  }
  const out: Record<string, CategoryFit> = {};
  for (const [cat, peers] of buckets) {
    if (peers.length < model.median_min_peers) continue;
    const med = median(peers.map(yOf))!;
    const line = peers.length >= model.fit_min_peers ? fitLine(peers.map(xOf), peers.map(yOf)) : null;
    out[cat] =
      line !== null && line.b !== 0
        ? { a: line.a, b: line.b, n: peers.length, median: med, kind: 'fit' }
        : { a: med, b: 0, n: peers.length, median: med, kind: 'median' };
  }
  return out;
}

// ---- held-out self-test

export interface FitDiagnostics {
  loo_male: number;
  loo_spearman: number;
  wf_male: number;
  wf_spearman: number;
  peers_fitted: number;
  categories_fitted: number;
}

function avgRanks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(v.length).fill(0);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation (average ranks for ties); 0 when it is undefined. */
export function spearman(x: number[], y: number[]): number {
  if (x.length < 3) return 0;
  const rx = avgRanks(x);
  const ry = avgRanks(y);
  const n = x.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i]! - mx) * (ry[i]! - my);
    sxx += (rx[i]! - mx) ** 2;
    syy += (ry[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

interface Scored {
  pred: number;
  actual: number;
}

function scoreSet(set: Scored[]): { male: number; rho: number } {
  if (set.length === 0) return { male: 0, rho: 0 };
  const male = set.reduce((s, e) => s + Math.abs(Math.log(e.pred / e.actual)), 0) / set.length;
  return { male, rho: spearman(set.map((e) => e.pred), set.map((e) => e.actual)) };
}

/**
 * Leave-one-out over every peer of a fitted category (refit on the rest, predict the one left out), and a
 * walk-forward split per category (fit on the lower-TVL half, score the upper half). Error is the mean
 * absolute log error of predicted vs actual mcap; rank is Spearman over predicted vs actual mcap, pooled.
 */
export function fitDiagnostics(protocols: SnapshotProtocol[], model: ModelConstants = MODEL): FitDiagnostics {
  const buckets = new Map<string, Peer[]>();
  for (const p of livePeers(protocols)) buckets.set(p.category, [...(buckets.get(p.category) ?? []), p]);
  const loo: Scored[] = [];
  const wf: Scored[] = [];
  let peersFitted = 0;
  let categoriesFitted = 0;
  for (const peers of buckets.values()) {
    if (peers.length < model.fit_min_peers) continue;
    categoriesFitted++;
    peersFitted += peers.length;
    peers.forEach((held, i) => {
      const rest = peers.filter((_, j) => j !== i);
      const line = fitLine(rest.map(xOf), rest.map(yOf));
      loo.push({ pred: held.tvl * predictMultiple(line, held.tvl, model), actual: held.mcap });
    });
    const sorted = [...peers].sort((a, b) => a.tvl - b.tvl || (a.slug < b.slug ? -1 : 1));
    const cut = Math.floor(sorted.length / 2);
    const lower = sorted.slice(0, cut);
    const line = fitLine(lower.map(xOf), lower.map(yOf));
    for (const p of sorted.slice(cut)) wf.push({ pred: p.tvl * predictMultiple(line, p.tvl, model), actual: p.mcap });
  }
  const l = scoreSet(loo);
  const w = scoreSet(wf);
  return {
    loo_male: round4(l.male),
    loo_spearman: round4(l.rho),
    wf_male: round4(w.male),
    wf_spearman: round4(w.rho),
    peers_fitted: peersFitted,
    categories_fitted: categoriesFitted,
  };
}

// ---- the other multipliers (unchanged from radar-2.5)

/** 1 + min(cap, max(0, change_7d) / 100 * weight): only TVL growth counts, never a penalty. */
export function liquiditySpreadMult(change7d: number | null, model: ModelConstants = MODEL): number {
  const up = Math.max(0, change7d ?? 0) || 0;
  return 1 + Math.min(model.liquidity_spread_cap, (up / 100) * model.liquidity_spread_weight);
}

/** Odds a token eventually lists, from age without a token alone: younger is likelier. */
export function tokenOdds(age: number | null, model: ModelConstants = MODEL): number {
  if (age === null) return model.odds_unknown;
  const odds = model.odds_floor + (model.odds_young - model.odds_floor) * Math.exp(-age / model.odds_half_life_days);
  return clamp(odds, model.odds_floor, model.odds_young);
}

export interface ScoreBreakdown {
  age: number | null;
  chainCount: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  categoryMult: number;
  /** How the category multiple was made: a fitted size curve, a median, or the fallback. */
  fitKind: 'fit' | 'median' | 'fallback';
  fitPeers: number;
  chainMult: number;
  concentrationMult: number;
  liquiditySpreadMult: number;
  tokenOdds: number;
}

/** Every multiplier that feeds implied value, unrounded. impliedValue() multiplies these with the TVL. */
export function scoreBreakdown(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fits: Record<string, CategoryFit>,
): ScoreBreakdown {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const fit = fits[protocol.category ?? ''];
  const categoryMult = fit === undefined ? model.fallback_multiple : predictMultiple(fit, protocol.tvl_usd, model);
  const chainCount = protocol.chains.length;
  const chainMult = 1 + Math.min(Math.max(0, chainCount - 1), model.chain_cap) * model.chain_weight;
  const concentrationMult = chainCount >= model.concentration_min_chains ? 1 + model.concentration_bonus : 1;
  return {
    age,
    chainCount,
    growthPct,
    growthMult,
    maturityMult,
    categoryMult,
    fitKind: fit === undefined ? 'fallback' : fit.kind,
    fitPeers: fit === undefined ? 0 : fit.n,
    chainMult,
    concentrationMult,
    liquiditySpreadMult: liquiditySpreadMult(protocol.change_7d, model),
    tokenOdds: tokenOdds(age, model),
  };
}

const f2 = (n: number): string => (Math.round(n * 100) / 100).toString();

/** The claim in one line, with each factor rounded to two decimals. */
export function equationText(tvl: number, b: ScoreBreakdown, implied: number): string {
  return (
    `TVL ${fmtMoney(tvl)} × cat ${f2(b.categoryMult)} × growth ${f2(b.growthMult)} × age ${f2(b.maturityMult)}` +
    ` × chains ${f2(b.chainMult)} × conc ${f2(b.concentrationMult)} × liq ${f2(b.liquiditySpreadMult)}` +
    ` × odds ${f2(b.tokenOdds)} → ${fmtMoney(implied)}`
  );
}

export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fits: Record<string, CategoryFit>,
): ScoreBreakdown & { launch: number; implied: number; equation: string } {
  const b = scoreBreakdown(protocol, asOf, model, fits);
  const launch = Math.round(
    protocol.tvl_usd * b.categoryMult * b.growthMult * b.maturityMult * b.chainMult * b.concentrationMult * b.liquiditySpreadMult,
  );
  const implied = Math.max(1, Math.round(launch * b.tokenOdds));
  return { ...b, launch, implied, equation: equationText(protocol.tvl_usd, b, implied) };
}
