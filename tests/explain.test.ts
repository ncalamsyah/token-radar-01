// Run: node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryFactor, chainFactor, formatAgePhrase, formatPct, growthFactor, leadingFactor, liquiditySpreadFactor, maturityFactor, oddsFactor, rationale, shiftPct, sizeFitFactor, summarizeBoard, verdictFactor } from '../lib/explain.ts';
import type { Explainable } from '../lib/explain.ts';

const row = (over: Partial<Explainable['model']> = {}, rest: Partial<Explainable> = {}): Explainable => ({
  category: 'Lending',
  chains: ['Ethereum', 'Base', 'Arbitrum'],
  change_7d: 30,
  age_days: 400,
  launch_value_usd: 9_000_000,
  implied_value_usd: 3_000_000,
  farm_verdict: 'thin',
  farm_capital_usd: 75,
  model: {
    category_multiple: 0.8,
    fit_kind: 'fit',
    fit_peers: 12,
    growth_multiplier: 1.21,
    maturity_multiplier: 0.9,
    chain_multiplier: 1.08,
    concentration_multiplier: 1.05,
    liquidity_spread_multiplier: 1.045,
    token_odds: 0.33,
    ...over,
  },
  ...rest,
});

test('shiftPct is signed and rounded', () => {
  assert.equal(shiftPct(1.05), '+5%');
  assert.equal(shiftPct(0.82), '-18%');
  assert.equal(shiftPct(1), '0%');
});

test('categoryFactor says so when only the default applies', () => {
  assert.match(categoryFactor('DEX', 0.45, 0.45), /Few live-token peers/);
  assert.match(categoryFactor('DEX', 0.9, 0.45), /about x0\.9 their TVL/);
});

test('sizeFitFactor names the fit, the median or the default', () => {
  assert.match(sizeFitFactor('Lending', 0.8, 'fit', 12), /Size-fit on 12 live Lending peers.*x0\.8/);
  assert.match(sizeFitFactor('CDP', 0.17, 'median', 3), /Only 3 live CDP peers.*no size curve/);
  assert.match(sizeFitFactor(null, 0.45, 'fallback', 0), /Too few.*default x0\.45/);
});

test('oddsFactor and verdictFactor speak in percent and dollars', () => {
  assert.match(oddsFactor(0.33, 400), /33%.*13 months/);
  assert.match(oddsFactor(0.35, null), /35%.*age is unknown/);
  assert.match(verdictFactor('farm', 6_200_000, 75), /Worth farming: expected value \$6\.2M is at or above the \$5\.0M farm band, for \$75/);
  assert.match(verdictFactor('thin', 3_000_000, 100), /thin farm: expected value \$3\.0M is in the \$1\.0M to \$5\.0M band/);
  assert.match(verdictFactor('skip', 400_000, 100), /Skip for now: expected value \$400K is under the \$1\.0M thin band/);
});

test('growthFactor handles missing, flat, up and down', () => {
  assert.match(growthFactor(null, 1)!, /No seven-day/);
  assert.match(growthFactor(0.1, 1.001)!, /flat/);
  assert.match(growthFactor(20, 1.14)!, /grew 20\.0%.*\+14% lift/);
  assert.match(growthFactor(-10, 0.93)!, /fell 10\.0%.*-7% drag/);
});

test('maturityFactor handles unknown age and the discount', () => {
  assert.match(maturityFactor(null, 0.8, 270), /unknown.*9 months/);
  assert.match(maturityFactor(30, 0.6), /30 days.*discount/);
});

test('chain, concentration and liquidity factors stay quiet when neutral', () => {
  assert.equal(chainFactor(0, 1), null);
  assert.match(chainFactor(1, 1)!, /Single-chain/);
  assert.equal(liquiditySpreadFactor(1), null);
  assert.match(liquiditySpreadFactor(1.08)!, /\(the cap\)/);
});

test('leadingFactor picks the biggest move, or nothing when all neutral', () => {
  assert.match(leadingFactor(row())!, /growth \(\+21%\)/);
  const flat = row({ growth_multiplier: 1, maturity_multiplier: 1, chain_multiplier: 1, concentration_multiplier: 1, liquidity_spread_multiplier: 1 });
  assert.equal(leadingFactor(flat), null);
});

test('rationale is one deterministic, non-empty paragraph that covers fit, odds and verdict', () => {
  const r = rationale(row());
  assert.equal(r, rationale(row()));
  assert.ok(r.length > 200 && r.length < 1200 && !r.includes('null') && !r.includes('undefined'));
  assert.match(r, /Size-fit on 12/);
  assert.match(r, /Odds of a token ever listing are 33%/);
  assert.match(r, /A thin farm/);
});

test('formatPct and formatAgePhrase cover null, small and large inputs', () => {
  assert.equal(formatPct(null), 'n/a');
  assert.equal(formatPct(5.55, true), '+5.5%');
  assert.equal(formatPct(-2), '-2.0%');
  assert.equal(formatAgePhrase(null), 'of unknown age');
  assert.equal(formatAgePhrase(10), 'under a month old');
  assert.equal(formatAgePhrase(400), '13 months old');
});

test('summarizeBoard counts each bucket once per row, including the verdict mix', () => {
  type R = Parameters<typeof summarizeBoard>[0][number];
  const r = (chains: number, change: number | null, age: number | null, kind: 'lend' | 'dex' | null, v: R['farm_verdict']): R => ({
    chains: Array(chains).fill('c'), change_7d: change, age_days: age, farm_kind: kind, farm_verdict: v,
  });
  const s = summarizeBoard([r(3, 5, 100, 'lend', 'farm'), r(1, -1, null, null, 'skip'), r(4, null, 50, 'dex', 'thin'), r(2, 0, 9, null, 'farm')]);
  assert.deepEqual(s, { total: 4, multiChain: 2, lendDex: 2, positiveGrowth: 1, unknownAge: 1, farm: 2, thin: 1, skip: 1 });
  assert.deepEqual(summarizeBoard([]), { total: 0, multiChain: 0, lendDex: 0, positiveGrowth: 0, unknownAge: 0, farm: 0, thin: 0, skip: 0 });
});
