// Run: node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryFactor, chainFactor, growthFactor, leadingFactor, liquiditySpreadFactor, maturityFactor, rationale, shiftPct } from '../lib/explain.ts';
import type { Explainable } from '../lib/explain.ts';

const row = (over: Partial<Explainable['model']> = {}, rest: Partial<Explainable> = {}): Explainable => ({
  category: 'Lending',
  chains: ['Ethereum', 'Base', 'Arbitrum'],
  change_7d: 30,
  age_days: 400,
  model: { category_multiple: 0.8, growth_multiplier: 1.21, maturity_multiplier: 0.9, chain_multiplier: 1.08, concentration_multiplier: 1.05, liquidity_spread_multiplier: 1.045, ...over },
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

test('rationale is one deterministic, non-empty paragraph', () => {
  const r = rationale(row());
  assert.equal(r, rationale(row()));
  assert.ok(r.length > 80 && r.length < 600 && !r.includes('null') && !r.includes('undefined'));
});
