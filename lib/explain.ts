// Launch Radar rationales (radar-3.0): a scored board row in plain English, from its multipliers only.
//
// Every function here is pure (same row in, same text out), takes numbers already on the row, and never
// recomputes the score: the multipliers come from lib/scoring.ts via the row's `model` block. Each factor
// helper returns one short sentence, or null when that factor did nothing worth saying. rationale()
// joins them: size-fit base, adjustments, token odds, the farm verdict. No network, no clock, no randomness.

import { MODEL, fmtMoney } from './scoring.ts';

/** The slice of a board row the explainers read; BoardRow satisfies it structurally. */
export interface Explainable {
  category: string | null;
  chains: string[];
  change_7d: number | null;
  age_days: number | null;
  launch_value_usd: number;
  implied_value_usd: number;
  farm_verdict: 'farm' | 'thin' | 'skip';
  farm_capital_usd: number;
  model: {
    category_multiple: number;
    fit_kind: 'fit' | 'median' | 'fallback';
    fit_peers: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    concentration_multiplier: number;
    liquidity_spread_multiplier: number;
    token_odds: number;
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

/** A percentage with one decimal: "5.6%", or "+5.6%" when `signed` and positive. Null or non-finite is "n/a". */
export function formatPct(n: number | null, signed = false): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  return `${signed && n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** An age as an adjective phrase: "of unknown age", "under a month old", "18 months old". */
export function formatAgePhrase(days: number | null): string {
  if (days === null) return 'of unknown age';
  if (days < 30) return 'under a month old';
  return `${ageWords(days)} old`;
}

/** What the category's live-token comps say a dollar of TVL is worth. */
export function categoryFactor(category: string | null, multiple: number, fallback: number = MODEL.fallback_multiple): string {
  const label = category ?? 'its category';
  if (Math.abs(multiple - fallback) < 1e-4) return `Few live-token peers in ${label}, so TVL is valued at the default ${times(multiple)}.`;
  return `Live ${label} tokens trade at about ${times(multiple)} their TVL, which sets the base value.`;
}

/** The base value and how it was made: a size curve fitted on peers, a peer median, or the default. */
export function sizeFitFactor(category: string | null, multiple: number, kind: 'fit' | 'median' | 'fallback', peers: number): string {
  const label = category ?? 'its category';
  if (kind === 'fit') return `Size-fit on ${peers} live ${label} peers puts a protocol of this TVL at ${times(multiple)} its TVL, the base value.`;
  if (kind === 'median') return `Only ${peers} live ${label} peers, so TVL is valued at their median-based ${times(multiple)}, with no size curve.`;
  return `Too few live-token peers in ${label} for any fit, so TVL is valued at the default ${times(multiple)}.`;
}

/** The seven-day TVL change and what it did to the value. */
export function growthFactor(change7d: number | null, mult: number): string | null {
  if (change7d === null) return 'No seven-day TVL change on record, so growth is neutral.';
  const size = formatPct(Math.abs(change7d));
  if (Math.abs(mult - 1) < 0.005) return `TVL is flat over seven days (${formatPct(change7d, true)}), so growth changes nothing.`;
  return mult > 1 ? `TVL grew ${size} over seven days, a ${shiftPct(mult)} lift.` : `TVL fell ${size} over seven days, a ${shiftPct(mult)} drag.`;
}

/** Age without a token: young protocols are discounted, established ones get a premium. */
export function maturityFactor(ageDays: number | null, mult: number, unknownDays: number = MODEL.unknown_age_days): string {
  if (ageDays === null) return `Listing date unknown, so it is treated as ${ageWords(unknownDays)} old (${times(mult)}).`;
  const tone = mult < 1 ? 'a young-protocol discount' : mult > 1 ? 'a premium for staying tokenless this long' : 'neutral';
  return `Tokenless and ${formatAgePhrase(ageDays)}: ${times(mult)}, ${tone}.`;
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

/** How likely a token ever lists, from age alone, and what that does to the launch value. */
export function oddsFactor(odds: number, ageDays: number | null): string {
  const pct = `${Math.round(odds * 100)}%`;
  const why = ageDays === null ? 'age is unknown' : `it has gone ${ageWords(ageDays)} without one`;
  return `Odds of a token ever listing are ${pct} because ${why}; expected value is the launch value times those odds.`;
}

/** The farm verdict in words and dollars: which expected-value band the row sits in. */
export function verdictFactor(verdict: 'farm' | 'thin' | 'skip', implied: number, capital: number): string {
  const ev = fmtMoney(implied);
  if (verdict === 'farm') return `Worth farming: expected value ${ev} is at or above the ${fmtMoney(MODEL.farm_ev_min)} farm band, for $${capital} deployed.`;
  if (verdict === 'thin') return `A thin farm: expected value ${ev} is in the ${fmtMoney(MODEL.thin_ev_min)} to ${fmtMoney(MODEL.farm_ev_min)} band, so deploy only the $${capital} minimum.`;
  return `Skip for now: expected value ${ev} is under the ${fmtMoney(MODEL.thin_ev_min)} thin band, not worth $${capital} yet.`;
}

/** The factor that moved the value furthest from neutral, with its direction. Category and odds are bases, not candidates. */
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

/** The whole rationale: size-fit base, each factor that did something, the biggest adjustment, odds, verdict. */
export function rationale(row: Explainable): string {
  const m = row.model;
  const parts = [
    sizeFitFactor(row.category, m.category_multiple, m.fit_kind, m.fit_peers),
    growthFactor(row.change_7d, m.growth_multiplier),
    maturityFactor(row.age_days, m.maturity_multiplier),
    chainFactor(row.chains.length, m.chain_multiplier),
    concentrationFactor(m.concentration_multiplier),
    liquiditySpreadFactor(m.liquidity_spread_multiplier),
    leadingFactor(row),
    oddsFactor(m.token_odds, row.age_days),
    verdictFactor(row.farm_verdict, row.implied_value_usd, row.farm_capital_usd),
  ];
  return parts.filter((p): p is string => p !== null).join(' ');
}

/** The slice of a board row summarizeBoard counts; BoardRow satisfies it structurally. */
export interface Summarizable {
  chains: string[];
  change_7d: number | null;
  age_days: number | null;
  farm_kind: 'lend' | 'dex' | null;
  farm_verdict: 'farm' | 'thin' | 'skip';
}

export interface BoardSummary {
  total: number;
  multiChain: number;
  lendDex: number;
  positiveGrowth: number;
  unknownAge: number;
  farm: number;
  thin: number;
  skip: number;
}

/** Counts across a board: multi-chain rows, lend/dex rows, rows with TVL up over seven days, rows with no listing date, and the verdict mix. */
export function summarizeBoard(rows: readonly Summarizable[]): BoardSummary {
  const s: BoardSummary = { total: rows.length, multiChain: 0, lendDex: 0, positiveGrowth: 0, unknownAge: 0, farm: 0, thin: 0, skip: 0 };
  for (const r of rows) {
    if (r.chains.length >= MODEL.concentration_min_chains) s.multiChain++;
    if (r.farm_kind !== null) s.lendDex++;
    if (r.change_7d !== null && r.change_7d > 0) s.positiveGrowth++;
    if (r.age_days === null) s.unknownAge++;
    s[r.farm_verdict]++;
  }
  return s;
}
