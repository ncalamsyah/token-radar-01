// Launch Radar view helpers (radar-2.5): formatting, the board and live tables, the model panel and the
// detail dialog. A classic script (no modules, no network): it publishes window.RadarView for app.js.
// The score arithmetic below recomputes lib/scoring.ts from the constants in data.js, so the detail
// dialog can show that its number matches board.json. A change to scoring.ts needs the same change here.
(function () {
  'use strict';

  var MULTI_CHAIN_MIN = 3;
  var KIND_LABEL = { lend: 'Lending upkeep', dex: 'DEX upkeep' };

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
  function scoreBreakdown(row, model, multiples) {
    var growthPct = clamp(none(row.change_7d) ? 0 : row.change_7d, model.growth_floor, model.growth_cap);
    var growthMult = 1 + (growthPct / 100) * model.growth_weight;
    var ageUsed = none(row.age_days) ? model.unknown_age_days : row.age_days;
    var maturityMult = model.maturity_floor + (clamp(ageUsed, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
    var categoryMult = (multiples && row.category && multiples[row.category]) || model.fallback_multiple;
    var n = chainCount(row);
    var chainMult = 1 + Math.min(Math.max(n - 1, 0), model.chain_cap) * model.chain_weight;
    var concentrationMult = n >= model.concentration_min_chains ? 1 + model.concentration_bonus : 1;
    var up = Math.max(0, none(row.change_7d) ? 0 : row.change_7d) || 0;
    var liquidityMult = 1 + Math.min(model.liquidity_spread_cap, (up / 100) * model.liquidity_spread_weight);
    return {
      chainCount: n, growthPct: growthPct, ageUsed: ageUsed, ageKnown: !none(row.age_days),
      categoryMult: categoryMult, growthMult: growthMult, maturityMult: maturityMult,
      chainMult: chainMult, concentrationMult: concentrationMult, liquidityMult: liquidityMult
    };
  }
  function impliedOf(row, model, multiples) {
    var b = scoreBreakdown(row, model, multiples);
    return Math.max(1, Math.round(row.tvl_usd * b.categoryMult * b.growthMult * b.maturityMult * b.chainMult * b.concentrationMult * b.liquidityMult));
  }

  // ---- small pieces
  function where(r) {
    return (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain');
  }
  function multiChainBadge(r) {
    return isMultiChain(r) ? el('span', { class: 'badge-multi', title: chainCount(r) + ' chains', text: 'multi-chain' }) : null;
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
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token board · strongest implied value first · click a row for model inputs and farm plan' }),
          el('thead', null, el('tr', null,
            sortHeader(ctx, 'implied', 'Rank'),
            sortHeader(ctx, 'name', 'Protocol'),
            sortHeader(ctx, 'tvl', 'TVL'),
            sortHeader(ctx, 'chains', 'Chains'),
            sortHeader(ctx, 'growth', '7d'),
            sortHeader(ctx, 'age', 'Age'),
            sortHeader(ctx, 'implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
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

  function modelPanel(m) {
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function (scoreBreakdown) returns every multiplier and one more multiplies them with TVL. Category multiples are medians of live-token mcap/TVL in the same DefiLlama category (clamped). No protocol name is special-cased.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl × catMultiple × (1 + clamp(Δ7d,' + m.growth_floor + ',' + m.growth_cap + ')/100 × ' + m.growth_weight + ') × (' + m.maturity_floor + ' + min(age,' + m.maturity_days + ')/' + m.maturity_days + ' × ' + m.maturity_range + ') × (1 + min(chains-1,' + m.chain_cap + ') × ' + m.chain_weight + ') × concentrationMult × liquiditySpreadMult )'
      ),
      el('p', { class: 'sub', text: 'concentrationMult = ' + (1 + m.concentration_bonus) + ' when a protocol lists ' + m.concentration_min_chains + ' or more chains, else 1. liquiditySpreadMult = 1 + min(' + m.liquidity_spread_cap + ', max(0, Δ7d)/100 × ' + m.liquidity_spread_weight + '): a small bonus for TVL still growing, never a penalty. Fallback catMultiple ' + m.fallback_multiple + ' when a category has fewer than two live comps. Unknown age uses ' + m.unknown_age_days + ' days. Live-token protocols stay on their own tab with market caps.' })
    );
  }

  // ---- detail dialog: fills `dialog` for `row`; onClose() is wired to the Close button.
  function farmItem(row, text, i) {
    var at = text.indexOf(' Cost: ');
    var extra = row.farm_extra === i;
    return el('li', { class: extra ? 'step-extra' : '' },
      extra ? el('span', { class: 'tag-extra', text: KIND_LABEL[row.farm_kind] || 'Category step' }) : null,
      el('b', { text: at >= 0 ? text.slice(0, at) : text }),
      el('span', { class: 'cost', text: at >= 0 ? text.slice(at + 1) : '' })
    );
  }

  function fillDetail(dialog, row, data, onClose) {
    var recomputed = impliedOf(row, data.model, data.category_multiples);
    var b = scoreBreakdown(row, data.model, data.category_multiples);
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
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + data.model_version + ' recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', matching board.json.' : ', which differs from the board.') + ' Estimate only.' })
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
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: fmtMult(b.categoryMult) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: fmtMult(b.growthMult) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: fmtMult(b.maturityMult) })),
        el('div', null, el('span', { text: 'Chain multiplier' }), el('b', { class: 'num', text: fmtMult(b.chainMult) })),
        el('div', null, el('span', { text: 'Concentration multiplier' }), el('b', { class: 'num', text: fmtMult(b.concentrationMult) })),
        el('div', null, el('span', { text: 'Liquidity spread multiplier' }), el('b', { class: 'num', text: fmtMult(b.liquidityMult) }))
      )
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan · ' + steps.length + ' steps' }),
      el('ol', { class: 'steps' }, steps.map(function (s, i) { return farmItem(row, s, i); }))
    ));
  }

  window.RadarView = {
    MULTI_CHAIN_MIN: MULTI_CHAIN_MIN,
    el: el, none: none, chainCount: chainCount, isMultiChain: isMultiChain,
    fmtUsd: fmtUsd, fmtPct: fmtPct, fmtAge: fmtAge, fmtMult: fmtMult,
    scoreBreakdown: scoreBreakdown, impliedOf: impliedOf,
    boardTable: boardTable, liveTable: liveTable, modelPanel: modelPanel, fillDetail: fillDetail
  };
})();
