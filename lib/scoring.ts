// Launch Radar scoring (radar-2.4): every number behind an implied value lives here and nowhere else.
//
//   catMultiple = median(mcap/tvl) of live-token peers in the same category (clamped), else fallback_multiple
//   growthMult  = 1 + clamp(change_7d, growth_floor, growth_cap) / 100 * growth_weight          (weight 0.7)
//   maturity    = maturity_floor + min(age_days, maturity_days) / maturity_days * maturity_range
//                 (unknown age uses unknown_age_days)
//   chainMult   = 1 + min(chains - 1, chain_cap) * chain_weight
//   concentrationMult = 1 + concentration_bonus (0.05) when chains.length >= concentration_min_chains (3), else 1
//   liquiditySpreadMult (new in radar-2.4) = 1 + min(0.08, (max(0, change_7d) || 0) / 100 * 0.15)
//   implied     = max(1, round(tvl_usd * catMultiple * growthMult * maturity * chainMult
//                              * concentrationMult * liquiditySpreadMult))
//
// liquiditySpreadMult is a small, one-sided bonus for protocols whose TVL is still growing: fresh deposits
// that keep arriving are the closest thing in a TVL-only snapshot to deep, tightening liquidity. Only
// positive 7d change counts (a shrinking protocol is not penalised twice, growthMult already does that),
// the raw change is used rather than the growth-clamped one, and the bonus saturates at +8% once the 7d
// change reaches about +53%. A missing change_7d counts as 0, so the multiplier is exactly 1.
//
// Live-token protocols are never mixed into the ranked board; their mcap/tvl only sets category comps.
// No protocol name is special-cased. dashboard/radar-view.js recomputes the same arithmetic from the
// constants in data.js, so a change here needs the matching change there.

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
  /** Weight on positive 7d change in liquiditySpreadMult. */
  liquidity_spread_weight: number;
  /** Largest bonus liquiditySpreadMult can add (0.08 = +8%). */
  liquidity_spread_cap: number;
  // Kept for dashboard formula display parity with older fields.
  base_multiple: number;
}

export const MODEL_VERSION = 'radar-2.4';

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
  liquidity_spread_weight: 0.15,
  liquidity_spread_cap: 0.08,
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

/** 1 + min(cap, max(0, change_7d) / 100 * weight): see the header for why only growth counts. */
export function liquiditySpreadMult(change7d: number | null, model: ModelConstants = MODEL): number {
  const up = Math.max(0, change7d ?? 0) || 0;
  return 1 + Math.min(model.liquidity_spread_cap, (up / 100) * model.liquidity_spread_weight);
}

export interface ScoreBreakdown {
  age: number | null;
  chainCount: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  categoryMult: number;
  chainMult: number;
  concentrationMult: number;
  liquiditySpreadMult: number;
}

/** Every multiplier that feeds implied value, unrounded. impliedValue() multiplies these with the TVL. */
export function scoreBreakdown(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiples: Record<string, number>,
): ScoreBreakdown {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const categoryMult = multiples[protocol.category ?? ''] ?? model.fallback_multiple;
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
    chainMult,
    concentrationMult,
    liquiditySpreadMult: liquiditySpreadMult(protocol.change_7d, model),
  };
}

export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiples: Record<string, number>,
): ScoreBreakdown & { implied: number } {
  const b = scoreBreakdown(protocol, asOf, model, multiples);
  const implied = Math.max(
    1,
    Math.round(
      protocol.tvl_usd * b.categoryMult * b.growthMult * b.maturityMult * b.chainMult * b.concentrationMult * b.liquiditySpreadMult,
    ),
  );
  return { ...b, implied };
}
