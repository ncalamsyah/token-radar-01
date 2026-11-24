// Launch Radar view helpers (radar-3.0): formatting, the board and live tables, the model panel and the
// detail dialog. A classic script (no modules, no network): it publishes window.RadarView for app.js.
// The score arithmetic below recomputes lib/scoring.ts from the constants and category fits in data.js, so
// the detail dialog can show that its number matches board.json. A change to scoring.ts needs the same change here.
(function () {
  'use strict';

  var MULTI_CHAIN_MIN = 3;
  var KIND_LABEL = { lend: 'Lending upkeep', dex: 'DEX upkeep' };
  var VERDICT_LABEL = { farm: 'farm', thin: 'thin', skip: 'skip' };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return (Math.round(n * 1e4) / 1e4).toString(); }
  function fmtOdds(n) { return Math.round(n * 100) + '%'; }
  function fmtNum(n, d) { return n === null || n === undefined || !isFinite(n) ? 'n/a' : n.toFixed(d === undefined ? 2 : d); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function none(v) { return v === null || v === undefined; }
  function chainCount(row) { return (row.chains || []).length; }
  function isMultiChain(row) { return chainCount(row) >= MULTI_CHAIN_MIN; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---- score arithmetic (mirrors lib/scoring.ts)
  function tokenOdds(age, m) {
    if (none(age)) return m.odds_unknown;
    return clamp(m.odds_floor + (m.odds_young - m.odds_floor) * Math.exp(-age / m.odds_half_life_days), m.odds_floor, m.odds_young);
  }
  function scoreBreakdown(row, model, fits) {
    var growthPct = clamp(none(row.change_7d) ? 0 : row.change_7d, model.growth_floor, model.growth_cap);
    var growthMult = 1 + (growthPct / 100) * model.growth_weight;
    var ageUsed = none(row.age_days) ? model.unknown_age_days : row.age_days;
    var maturityMult = model.maturity_floor + (clamp(ageUsed, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
    var fit = fits && row.category ? fits[row.category] : null;
    var categoryMult = fit ? clamp(fit.a + fit.b * Math.log10(Math.max(1, row.tvl_usd)), model.multiple_floor, model.multiple_cap) : model.fallback_multiple;
    var n = chainCount(row);
    var chainMult = 1 + Math.min(Math.max(n - 1, 0), model.chain_cap) * model.chain_weight;
    var concentrationMult = n >= model.concentration_min_chains ? 1 + model.concentration_bonus : 1;
    var up = Math.max(0, none(row.change_7d) ? 0 : row.change_7d) || 0;
    var liquidityMult = 1 + Math.min(model.liquidity_spread_cap, (up / 100) * model.liquidity_spread_weight);
    return {
      chainCount: n, growthPct: growthPct, ageUsed: ageUsed, ageKnown: !none(row.age_days), fit: fit || null,
      categoryMult: categoryMult, growthMult: growthMult, maturityMult: maturityMult,
      chainMult: chainMult, concentrationMult: concentrationMult, liquidityMult: liquidityMult,
      odds: tokenOdds(row.age_days, model)
    };
  }
  // Same multiplication order as lib/scoring.ts impliedValue(): launch first, then odds.
  function valueOf(row, model, fits) {
    var b = scoreBreakdown(row, model, fits);
    var launch = Math.round(row.tvl_usd * b.categoryMult * b.growthMult * b.maturityMult * b.chainMult * b.concentrationMult * b.liquidityMult);
    return { b: b, launch: launch, implied: Math.max(1, Math.round(launch * b.odds)) };
  }
  // Absolute expected-value bands (lib/farm.ts verdictFor), read from the model constants in data.js.
  function verdictOf(implied, model) {
    return implied >= model.farm_ev_min ? 'farm' : implied >= model.thin_ev_min ? 'thin' : 'skip';
  }

  // ---- small pieces
  function where(r) {
    return (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain');
  }
  function multiChainBadge(r) {
    return isMultiChain(r) ? el('span', { class: 'badge-multi', title: chainCount(r) + ' chains', text: 'multi-chain' }) : null;
  }
  function verdictBadge(v) {
    return el('span', { class: 'verdict v-' + v, text: VERDICT_LABEL[v] || v });
  }

  // ---- tables. ctx = { sort, dir, selected, onSort(key), onOpen(slug), onClear() }
  function sortHeader(ctx, key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { ctx.onSort(key); } },
        label,
        ctx.sort === key ? el('span', { 'aria-hidden': 'true', text: ctx.dir < 0 ? ' ↓' : ' ↑' }) : null
      )
    );
  }

  function boardTable(list, ctx) {
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: ctx.onClear })
      ));
    }
    var max = list.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 1);
    var tbody = el('tbody');
    list.forEach(function (r) {
      tbody.appendChild(el('tr', {
        'data-selected': ctx.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { ctx.onOpen(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onOpen(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', null, r.name, multiChainBadge(r)), el('span', { class: 'sub', text: where(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: String(chainCount(r)) }),
        el('td', { class: 'num ' + (none(r.change_7d) ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtOdds(r.token_odds) }),
        el('td', { class: 'num', text: fmtUsd(r.launch_value_usd) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, verdictBadge(r.farm_verdict))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token board · ranked by EV = launch value × token odds · click a row for the equation, fit note and farm plan' }),
          el('thead', null, el('tr', null,
            sortHeader(ctx, 'implied', 'Rank'),
            sortHeader(ctx, 'name', 'Protocol'),
            sortHeader(ctx, 'tvl', 'TVL'),
            sortHeader(ctx, 'chains', 'Chains'),
            sortHeader(ctx, 'growth', '7d'),
            sortHeader(ctx, 'age', 'Age'),
            sortHeader(ctx, 'odds', 'Odds'),
            sortHeader(ctx, 'launch', 'Launch value'),
            sortHeader(ctx, 'implied', 'EV (implied)'),
            sortHeader(ctx, 'verdict', 'Verdict')
          )),
          tbody
        )
      )
    );
  }

  function liveTable(live) {
    var tbody = el('tbody');
    live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: where(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (!none(r.change_7d) && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Live token · market cap is a fact, not a model · held apart from the pre-token ranking (and used only as category comps)' }),
          el('thead', null, el('tr', null, ['Status', 'Protocol', 'TVL', '7d', 'Market cap', 'Token'].map(function (t) { return el('th', { scope: 'col', text: t }); }))),
          tbody
        )
      )
    );
  }

  function modelPanel(data) {
    var m = data.model;
    var d = data.fit_diagnostics;
    var t = data.farm_verdict_thresholds;
    var kept = d.loo_spearman > 0
      ? 'The size curve is kept because its leave-one-out Spearman is above zero (' + fmtNum(d.loo_spearman) + ').'
      : 'The size curve\'s leave-one-out Spearman is ' + fmtNum(d.loo_spearman) + ', not above zero, so treat its values with extra caution.';
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How the expected value is computed' }),
      el('p', { text: 'Size-fit: for every DefiLlama category with at least ' + m.fit_min_peers + ' live-token peers, a straight line is fitted (least squares) through market cap ÷ TVL against log10 of TVL, so a bigger protocol is not assumed to be worth the same multiple of TVL as a small one. The multiple is kept between ' + m.multiple_floor + ' and ' + m.multiple_cap + '. Categories with ' + m.median_min_peers + ' or 3 peers use their median; fewer fall back to ' + m.fallback_multiple + '.' }),
      el('p', { text: 'Token odds: the chance a token ever lists falls with age without one, from ' + fmtOdds(m.odds_young) + ' for a brand-new protocol toward ' + fmtOdds(m.odds_floor) + ' for an old one (half-life ' + m.odds_half_life_days + ' days); unknown age gets ' + fmtOdds(m.odds_unknown) + '. Names are never used.' }),
      el('p', { text: 'Expected value: launch value × odds. Launch value is TVL × size-fit multiple × growth × age × chain breadth × concentration × liquidity spread. The board ranks by expected value. Farm verdict is an absolute band on that value: farm at ' + fmtUsd(t.farm_ev_min) + ' or more, thin at ' + fmtUsd(t.thin_ev_min) + ' or more, skip below.' }),
      el('div', { class: 'formula' },
        'launch = round( tvl × clamp(a + b·log10(tvl)) × (1 + clamp(Δ7d,' + m.growth_floor + ',' + m.growth_cap + ')/100 × ' + m.growth_weight + ') × (' + m.maturity_floor + ' + min(age,' + m.maturity_days + ')/' + m.maturity_days + ' × ' + m.maturity_range + ') × (1 + min(chains-1,' + m.chain_cap + ') × ' + m.chain_weight + ') × conc × liq )\n' +
        'odds = ' + m.odds_floor + ' + (' + m.odds_young + ' - ' + m.odds_floor + ') × exp(-age/' + m.odds_half_life_days + ')    EV = max(1, round(launch × odds))'
      ),
      el('p', { class: 'sub', text: 'conc = ' + (1 + m.concentration_bonus) + ' on ' + m.concentration_min_chains + '+ chains; liq = 1 + min(' + m.liquidity_spread_cap + ', max(0, Δ7d)/100 × ' + m.liquidity_spread_weight + '). Unknown age counts as ' + m.unknown_age_days + ' days for the age multiplier.' }),
      el('p', { class: 'sub', text: 'Held-out test of the fit (' + d.peers_fitted + ' peers, ' + d.categories_fitted + ' categories): leave-one-out error ' + fmtNum(d.loo_male) + ' (mean absolute log error), rank correlation ' + fmtNum(d.loo_spearman) + '; walk-forward (fit on the smaller half, score the larger) error ' + fmtNum(d.wf_male) + ', rank correlation ' + fmtNum(d.wf_spearman) + '. ' + kept + ' These are modest: treat values as order-of-magnitude estimates, not prices.' })
    );
  }

  // ---- detail dialog: fills `dialog` for `row`; onClose() is wired to the Close button.
  function farmItem(row, text, i, last) {
    var at = text.indexOf(' Cost: ');
    var extra = row.farm_extra === i;
    return el('li', { class: extra ? 'step-extra' : last ? 'step-verdict' : '' },
      extra ? el('span', { class: 'tag-extra', text: KIND_LABEL[row.farm_kind] || 'Category step' }) : null,
      last ? el('span', { class: 'tag-extra', text: 'Verdict' }) : null,
      el('b', { text: at >= 0 ? text.slice(0, at) : text }),
      el('span', { class: 'cost', text: at >= 0 ? text.slice(at + 1) : '' })
    );
  }

  function fitNote(b, row) {
    if (b.fit && b.fit.kind === 'fit') {
      return 'Size-fit on ' + b.fit.n + ' live ' + row.category + ' peers: multiple = ' + fmtNum(b.fit.a, 3) + ' + ' + fmtNum(b.fit.b, 3) + ' × log10(TVL) = ' + fmtMult(b.categoryMult) + ' at ' + fmtUsd(row.tvl_usd) + ' (clamped to the model\'s floor and cap).';
    }
    if (b.fit) return 'Only ' + b.fit.n + ' live ' + row.category + ' peers, so no size curve: their median multiple ' + fmtMult(b.categoryMult) + ' is used.';
    return 'No live-token peers to fit for ' + (row.category || 'this category') + ', so the default multiple ' + fmtMult(b.categoryMult) + ' is used.';
  }

  function fillDetail(dialog, row, data, onClose) {
    var v = valueOf(row, data.model, data.category_fits);
    var b = v.b;
    var capital = row.farm_capital_usd;
    var t = data.farm_verdict_thresholds;
    var verdict = verdictOf(v.implied, data.model);
    var evOk = v.implied === row.implied_value_usd;
    var launchOk = v.launch === row.launch_value_usd;
    var verdictOk = verdict === row.farm_verdict;
    var steps = row.farm_steps || [];
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + data.board_size }),
        el('h2', { id: 'detail-title' }, row.name, multiChainBadge(row)),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: onClose })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'The claim' }),
      el('div', { class: 'eqline', text: row.equation }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Token odds (age ' + fmtAge(row.age_days) + ')' }), el('b', { class: 'num', text: fmtOdds(row.token_odds) })),
        el('div', null, el('span', { text: 'Launch value (if a token lists)' }), el('b', { class: 'num', text: fmtUsd(row.launch_value_usd) })),
        el('div', { class: 'hot' }, el('span', { text: 'Expected value (launch × odds)' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'check ' + (evOk && launchOk ? 'ok' : 'bad'), text: 'Recomputed from data.js constants: launch ' + fmtUsd(v.launch) + ' and EV ' + fmtUsd(v.implied) + (evOk && launchOk ? ' match board.json exactly.' : ' MISMATCH with board.json (' + fmtUsd(row.launch_value_usd) + ' / ' + fmtUsd(row.implied_value_usd) + ').') + ' Estimate only, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Fit note' }),
      el('p', { text: fitNote(b, row) }),
      el('p', { class: 'sub', text: 'Held-out check on the whole fit: leave-one-out rank correlation ' + fmtNum(data.fit_diagnostics.loo_spearman) + ', walk-forward ' + fmtNum(data.fit_diagnostics.wf_spearman) + '.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Why this value' }),
      el('p', { class: 'rationale', text: row.rationale || 'No rationale on record for this row.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Score breakdown' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Chains listed' }), el('b', { class: 'num', text: String(b.chainCount) })),
        el('div', null, el('span', { text: 'Seven-day growth (clamped)' }), el('b', { class: 'num', text: fmtPct(b.growthPct) + (none(row.change_7d) ? ' (none on record)' : '') })),
        el('div', null, el('span', { text: 'Age used by the model' }), el('b', { class: 'num', text: fmtAge(b.ageUsed) + (b.ageKnown ? '' : ' (unknown, default)') })),
        el('div', null, el('span', { text: 'Size-fit category multiple' }), el('b', { class: 'num', text: fmtMult(b.categoryMult) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: fmtMult(b.growthMult) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: fmtMult(b.maturityMult) })),
        el('div', null, el('span', { text: 'Chain multiplier' }), el('b', { class: 'num', text: fmtMult(b.chainMult) })),
        el('div', null, el('span', { text: 'Concentration multiplier' }), el('b', { class: 'num', text: fmtMult(b.concentrationMult) })),
        el('div', null, el('span', { text: 'Liquidity spread multiplier' }), el('b', { class: 'num', text: fmtMult(b.liquidityMult) })),
        el('div', null, el('span', { text: 'Token odds' }), el('b', { class: 'num', text: fmtMult(b.odds) }))
      )
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan · ' + steps.length + ' steps' }),
      el('p', { class: 'verdict-line' },
        verdictBadge(row.farm_verdict),
        ' EV ' + fmtUsd(row.implied_value_usd) + ' (farm at ' + fmtUsd(t.farm_ev_min) + ', thin at ' + fmtUsd(t.thin_ev_min) + ') with $' + capital + ' deployed' + (verdictOk ? '; verdict recomputed, matches.' : '; verdict MISMATCH.')
      ),
      el('ol', { class: 'steps' }, steps.map(function (s, i) { return farmItem(row, s, i, i === steps.length - 1); }))
    ));
  }

  window.RadarView = {
    MULTI_CHAIN_MIN: MULTI_CHAIN_MIN,
    el: el, none: none, chainCount: chainCount, isMultiChain: isMultiChain,
    fmtUsd: fmtUsd, fmtPct: fmtPct, fmtAge: fmtAge, fmtMult: fmtMult, fmtNum: fmtNum,
    scoreBreakdown: scoreBreakdown, valueOf: valueOf, verdictOf: verdictOf,
    boardTable: boardTable, liveTable: liveTable, modelPanel: modelPanel, fillDetail: fillDetail
  };
})();
