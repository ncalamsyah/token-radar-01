// Run: node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verdictFor } from '../lib/farm.ts';
import { MODEL, categoryFits, fitDiagnostics, fitLine, impliedValue, predictMultiple, spearman, tokenOdds } from '../lib/scoring.ts';
import type { SnapshotProtocol } from '../lib/scoring.ts';

const live = (slug: string, category: string, tvl: number, mcap: number): SnapshotProtocol => ({
  slug, name: slug, category, chains: ['Ethereum'], tvl_usd: tvl, change_7d: 0, mcap_usd: mcap, listed_at: '2024-01-01', gecko_id: slug, symbol: slug.toUpperCase(),
});

test('fitLine recovers an exact line and survives no x spread', () => {
  const f = fitLine([1, 2, 3, 4], [3, 5, 7, 9]);
  assert.ok(Math.abs(f.a - 1) < 1e-9 && Math.abs(f.b - 2) < 1e-9);
  assert.deepEqual(fitLine([2, 2, 2], [1, 2, 3]), { a: 2, b: 0 });
});

test('spearman is 1, -1, handles ties and tiny inputs', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), 0);
  assert.equal(spearman([1, 2], [1, 2]), 0);
});

test('tokenOdds falls with age, is bounded, and has its own unknown value', () => {
  assert.equal(tokenOdds(null), MODEL.odds_unknown);
  assert.ok(Math.abs(tokenOdds(0) - MODEL.odds_young) < 1e-9);
  assert.ok(tokenOdds(100) > tokenOdds(500) && tokenOdds(500) > tokenOdds(3000));
  assert.ok(tokenOdds(100000) >= MODEL.odds_floor);
});

test('categoryFits: line at 4 peers, median at 2, nothing at 1', () => {
  const four = [1, 2, 3, 4].map((i) => live(`d${i}`, 'Dexs', 10 ** (6 + i), 10 ** (6 + i) * (0.1 * i)));
  const fits = categoryFits([...four, live('c1', 'CDP', 1e8, 5e7), live('c2', 'CDP', 2e8, 2e8), live('s1', 'Solo', 1e8, 1e8)]);
  assert.equal(fits['Dexs']!.kind, 'fit');
  assert.equal(fits['Dexs']!.n, 4);
  assert.equal(fits['CDP']!.kind, 'median');
  assert.equal(fits['CDP']!.b, 0);
  assert.equal(fits['Solo'], undefined);
});

test('predictMultiple is clamped to the floor and the cap', () => {
  assert.equal(predictMultiple({ a: 0, b: 1 }, 1e30), MODEL.multiple_cap);
  assert.equal(predictMultiple({ a: -9, b: 0 }, 1e6), MODEL.multiple_floor);
  assert.equal(predictMultiple({ a: 1, b: 0 }, 1e6), 1);
});

test('fitDiagnostics is exact on a noiseless curve and counts what it fitted', () => {
  const peers = [1, 2, 3, 4, 5, 6].map((i) => live(`p${i}`, 'Dexs', 1e7 * 10 ** (i / 4), 1e7 * 10 ** (i / 4) * (0.2 + 0.1 * Math.log10(10 ** (i / 4)))));
  const d = fitDiagnostics(peers);
  assert.equal(d.peers_fitted, 6);
  assert.equal(d.categories_fitted, 1);
  assert.ok(d.loo_male < 0.05 && d.loo_spearman > 0.9 && d.wf_spearman > 0.9);
});

test('impliedValue: EV is the rounded launch value times odds, and the equation names it', () => {
  const p: SnapshotProtocol = { ...live('x', 'Dexs', 1e8, 0), mcap_usd: null, gecko_id: null, symbol: null, listed_at: '2026-01-01', chains: ['A', 'B', 'C'], change_7d: 10 };
  const v = impliedValue(p, '2026-11-14', MODEL, {});
  assert.equal(v.implied, Math.max(1, Math.round(v.launch * v.tokenOdds)));
  assert.equal(v.fitKind, 'fallback');
  assert.match(v.equation, /^TVL \$100\.0M × cat 0\.45 .* × odds \d\.\d+ → \$/);
});

test('verdictFor uses absolute EV bands: farm at $5M, thin at $1M, else skip', () => {
  assert.equal(MODEL.farm_ev_min, 5_000_000);
  assert.equal(MODEL.thin_ev_min, 1_000_000);
  assert.equal(verdictFor(5_000_000), 'farm');
  assert.equal(verdictFor(4_999_999), 'thin');
  assert.equal(verdictFor(1_000_000), 'thin');
  assert.equal(verdictFor(999_999), 'skip');
  assert.equal(verdictFor(1), 'skip');
});
