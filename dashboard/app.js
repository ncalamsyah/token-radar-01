// Launch Radar dashboard (radar-2.2). Reads window.RADAR from ../data.js. No network.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

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
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function none(v) { return v === null || v === undefined; }

  // Same arithmetic as lib/model.ts impliedValue (radar-2.2), including concentrationMult.
  function impliedOf(row, model) {
    var growth = clamp(none(row.change_7d) ? 0 : row.change_7d, model.growth_floor, model.growth_cap);
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = none(row.age_days) ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (clamp(age, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
    var cat = (DATA.category_multiples && row.category && DATA.category_multiples[row.category]) || model.fallback_multiple;
    var n = (row.chains || []).length;
    var chainMult = 1 + Math.min(Math.max(n - 1, 0), model.chain_cap) * model.chain_weight;
    var concentrationMult = n >= model.concentration_min_chains ? 1 + model.concentration_bonus : 1;
    return Math.max(1, Math.round(row.tvl_usd * cat * growthMult * maturity * chainMult * concentrationMult));
  }

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

  // Farm plan: mirrors farmSteps in lib/model.ts (radar-2.2).
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 300;
    if (p.tvl_usd >= 1e9) return 200;
    if (p.tvl_usd >= 2.5e8) return 125;
    if (p.tvl_usd >= 5e7) return 75;
    return 50;
  }
  function holdDaysFor(age) {
    if (none(age)) return 60;
    if (age < 120) return 90;
    if (age < 270) return 60;
    if (age < 540) return 45;
    return 30;
  }
  var ACTIONS = [
    [['lend', 'cdp', 'collateral'], 'Supply ${cap} of USDC as collateral on {name} ({chain}), borrow under 40% LTV, and leave both legs open.'],
    [['dex', 'amm'], "Add ${cap} of balanced liquidity to {name}'s deepest pool on {chain} and leave the LP position open."],
    [['yield', 'leveraged farm', 'aggregator'], "Deposit ${cap} into {name}'s primary vault on {chain} and keep the shares staked only if the vault itself scores points."],
    [['curator', 'allocator', 'risk'], 'Deposit ${cap} into a {name}-curated vault on {chain} and keep the receipt tokens in the same wallet.'],
    [['perp', 'derivative', 'basis'], 'Deposit ${cap} USDC margin on {name} ({chain}), open a tiny hedge under 2x, and keep funding paid.'],
    [['prediction'], 'Fund ${cap} on {name}, place one market under 5% of bankroll, and hold until settlement or the farm window ends.'],
    [['stable'], "Mint or deposit ${cap} of the stable asset through {name} on {chain} and hold it in the protocol's own wallet view."],
    [['rwa'], "Mint ${cap} of {name}'s yield-bearing RWA receipt on {chain} and keep it unbridged for the hold window."],
    [['insurance'], 'Buy ${cap} of cover from {name} on {chain} against a core DeFi risk and keep the policy active.'],
    [['bridge'], 'Bridge ${cap} of USDC to {chain} through {name}, then spend at least half inside its own app so the route is not a pass-through.'],
    [['staking', 'restak'], "Stake ${cap} of the chain's staking asset through {name} on {chain} and keep the liquid receipt in-wallet."]
  ];
  var DEFAULT_ACTION = "Deposit ${cap} of USDC into {name}'s primary product on {chain} and leave the position open through the hold window.";
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var tpl = DEFAULT_ACTION;
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i][0].some(function (k) { return c.indexOf(k) >= 0; })) { tpl = ACTIONS[i][1]; break; }
    }
    return tpl
      .replace('${cap}', function () { return '$' + capital; })
      .replace('{name}', function () { return p.name; })
      .replace('{chain}', function () { return chain; });
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gasSetup = capital >= 150 ? 12 : capital >= 75 ? 7 : 4;
    return [
      { text: 'Create a fresh farming wallet, fund it only with the $' + capital + ' you will deploy plus gas, and store the seed offline.', cost: 'under $3 of gas to receive funds on ' + chain, time: '10 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital plus about $' + gasSetup + ' of gas', time: '20 minutes to set up' },
      { text: 'Once a week, do one on-chain action on ' + p.name + ' (deposit, withdraw dust, borrow/repay, swap, or vote) from the same wallet.', cost: 'about $2 to $5 of gas each week', time: '15 minutes a week' },
      { text: 'Keep the core position funded for at least ' + hold + ' days so activity spans multiple protocol snapshots.', cost: 'the $' + capital + ' stays locked in the position', time: hold + ' days' },
      { text: 'Before claiming anything, open only the points or rewards UI that ' + p.name + ' publishes itself; never pay a stranger to "claim" for you.', cost: 'no fee to check; claim gas only from the official UI', time: '15 minutes' },
      { text: 'Log wallet address, open date, tx hashes, and exit date in a farm notebook so you can unwind or repeat without guessing.', cost: 'nothing but the notebook', time: '5 minutes after each change' }
    ].map(stepText);
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = none(a.change_7d) ? -Infinity : a.change_7d; bv = none(b.change_7d) ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = none(a.age_days) ? Infinity : a.age_days; bv = none(b.age_days) ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama sealed index' }),
        el('span', { text: DATA.model_version + ' · category comps + chain breadth' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Pre-token protocols, ranked by what a launch could be worth' }),
        el('p', { text: 'Watchlist floor: every protocol with ≥ $' + Math.round(DATA.floor_usd / 1e6) + 'M TVL and no token on record (' + DATA.watchlist_size + '). Early radar adds ' + DATA.early_size + ' smaller pre-token names. Implied value uses live-token category mcap/TVL comps × growth × age without a token × chain breadth × a 5% bonus for three or more chains. An estimate, not a price.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early below floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function selectField(id, label, allText, values, current, onChange) {
    var select = el('select', { id: id, 'aria-label': 'Filter by ' + label.toLowerCase() },
      el('option', { value: 'all', text: allText }),
      values.map(function (v) { return el('option', { value: v, text: v, selected: v === current ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { onChange(select.value); writeHash(); render(); });
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), select);
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    // Chains ordered by how many board rows touch them, then by name.
    var counts = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { counts[c] = (counts[c] || 0) + 1; }); });
    var chains = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      selectField('category', 'Category', 'All categories', categories, state.category, function (v) { state.category = v; }),
      selectField('chain', 'Chain', 'All chains', chains, state.chain, function (v) { state.chain = v; }),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null
      )
    );
  }

  function where(r) {
    return (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain');
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 1);
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: where(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (none(r.change_7d) ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token board · strongest implied value first · click a row for model inputs and farm plan' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
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

  function modelPanel() {
    var m = DATA.model;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function scores every pre-token row. Category multiples are medians of live-token mcap/TVL in the same DefiLlama category (clamped). No protocol name is special-cased.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl × catMultiple × (1 + clamp(Δ7d,' + m.growth_floor + ',' + m.growth_cap + ')/100 × ' + m.growth_weight + ') × (' + m.maturity_floor + ' + min(age,' + m.maturity_days + ')/' + m.maturity_days + ' × ' + m.maturity_range + ') × (1 + min(chains-1,' + m.chain_cap + ') × ' + m.chain_weight + ') × concentrationMult )'
      ),
      el('p', { class: 'sub', text: 'concentrationMult = ' + (1 + m.concentration_bonus) + ' when a protocol lists ' + m.concentration_min_chains + ' or more chains, else 1. Fallback catMultiple ' + m.fallback_multiple + ' when a category has fewer than two live comps. Unknown age uses ' + m.unknown_age_days + ' days. Live-token protocols stay on their own tab with market caps.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = impliedOf(row, DATA.model);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: String(row.category_multiple) })),
        el('div', null, el('span', { text: 'Growth × maturity × chains × concentration' }), el('b', { class: 'num', text: row.growth_multiplier + ' × ' + row.maturity_multiplier + ' × ' + row.chain_multiplier + ' × ' + row.concentration_multiplier })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ' recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', matching board.json.' : ', which differs from the board.') + ' Estimate only.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, farmSteps(row).map(function (s) {
        var at = s.indexOf(' Cost: ');
        return el('li', null, el('b', { text: at >= 0 ? s.slice(0, at) : s }), el('span', { class: 'cost', text: at >= 0 ? s.slice(at + 1) : '' }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
