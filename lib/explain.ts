// Launch Radar rationales (radar-2.5): a scored board row in plain English, from its multipliers only.
//
// Every function here is pure (same row in, same text out), takes numbers already on the row, and never
// recomputes the score: the multipliers come from lib/scoring.ts via the row's `model` block. Each factor
// helper returns one short sentence, or null when that factor did nothing worth saying. rationale()
// joins them and names the factor that moved the value most. No network, no clock, no randomness.

import { MODEL } from './scoring.ts';

/** The slice of a board row the explainers read; BoardRow satisfies it structurally. */
export interface Explainable {
  category: string | null;
  chains: string[];
  change_7d: number | null;
  age_days: number | null;
  model: {
    category_multiple: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    concentration_multiplier: number;
    liquidity_spread_multiplier: number;
  };
}

/** A multiplier as "x1.05". */
export const times = (m: number): string => `x${Math.round(m * 1e4) / 1e4}`;

/** How far a multiplier sits from neutral, as a signed percent: 1.05 is "+5%", 0.82 is "-18%". */
export function shiftPct(m: number): string {
  const p = Math.round((m - 1) * 100);
  return `${p > 0 ? '+' : ''}${p}%`;
}

/** Age in the words a reader uses: "45 days", "14 months", "3.2 years". */
export function ageWords(days: number): string {
  if (days >= 730) return `${(days / 365).toFixed(1)} years`;
  if (days >= 120) return `${Math.round(days / 30)} months`;
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** What the category's live-token comps say a dollar of TVL is worth. */
export function categoryFactor(category: string | null, multiple: number, fallback: number = MODEL.fallback_multiple): string {
  const label = category ?? 'its category';
  if (Math.abs(multiple - fallback) < 1e-4) return `Few live-token peers in ${label}, so TVL is valued at the default ${times(multiple)}.`;
  return `Live ${label} tokens trade at about ${times(multiple)} their TVL, which sets the base value.`;
}

/** The seven-day TVL change and what it did to the value. */
export function growthFactor(change7d: number | null, mult: number): string | null {
  if (change7d === null) return 'No seven-day TVL change on record, so growth is neutral.';
  const size = `${Math.abs(change7d).toFixed(1)}%`;
  if (Math.abs(mult - 1) < 0.005) return `TVL is flat over seven days (${change7d.toFixed(1)}%), so growth changes nothing.`;
  return mult > 1 ? `TVL grew ${size} over seven days, a ${shiftPct(mult)} lift.` : `TVL fell ${size} over seven days, a ${shiftPct(mult)} drag.`;
}

/** Age without a token: young protocols are discounted, established ones get a premium. */
export function maturityFactor(ageDays: number | null, mult: number, unknownDays: number = MODEL.unknown_age_days): string {
  if (ageDays === null) return `Listing date unknown, so it is treated as ${ageWords(unknownDays)} old (${times(mult)}).`;
  const tone = mult < 1 ? 'a young-protocol discount' : mult > 1 ? 'a premium for staying tokenless this long' : 'neutral';
  return `Listed ${ageWords(ageDays)} ago without a token: ${times(mult)}, ${tone}.`;
}

/** Chain breadth: more chains means a wider user base. */
export function chainFactor(chainCount: number, mult: number): string | null {
  if (chainCount <= 1) return chainCount === 1 ? 'Single-chain, so no breadth bonus.' : null;
  return `Live on ${chainCount} chains, ${shiftPct(mult)} for breadth.`;
}

/** The extra bonus for sitting on enough chains to count as multi-chain. */
export function concentrationFactor(mult: number): string | null {
  return mult > 1 ? `Multi-chain presence adds a further ${shiftPct(mult)}.` : null;
}

/** The small bonus for TVL still growing; silent when it is exactly neutral. */
export function liquiditySpreadFactor(mult: number): string | null {
  if (mult <= 1) return null;
  const capped = Math.abs(mult - (1 + MODEL.liquidity_spread_cap)) < 1e-4;
  return `Rising TVL signals deepening liquidity: ${shiftPct(mult)}${capped ? ' (the cap)' : ''}.`;
}

/** The factor that moved the value furthest from neutral, with its direction. Category is the base, so it is not a candidate. */
export function leadingFactor(row: Explainable): string | null {
  const m = row.model;
  const candidates: Array<[string, number]> = [
    ['growth', m.growth_multiplier],
    ['age', m.maturity_multiplier],
    ['chain breadth', m.chain_multiplier],
    ['multi-chain concentration', m.concentration_multiplier],
    ['liquidity spread', m.liquidity_spread_multiplier],
  ];
  let best: [string, number] | null = null;
  for (const c of candidates) if (best === null || Math.abs(c[1] - 1) > Math.abs(best[1] - 1)) best = c;
  if (best === null || Math.abs(best[1] - 1) < 0.005) return null;
  return `Biggest adjustment: ${best[0]} (${shiftPct(best[1])}).`;
}

/** The whole rationale: the base value, each factor that did something, then the biggest adjustment. */
export function rationale(row: Explainable): string {
  const m = row.model;
  const parts = [
    categoryFactor(row.category, m.category_multiple),
    growthFactor(row.change_7d, m.growth_multiplier),
    maturityFactor(row.age_days, m.maturity_multiplier),
    chainFactor(row.chains.length, m.chain_multiplier),
    concentrationFactor(m.concentration_multiplier),
    liquiditySpreadFactor(m.liquidity_spread_multiplier),
    leadingFactor(row),
  ];
  return parts.filter((p): p is string => p !== null).join(' ');
}
