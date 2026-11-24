// Launch Radar bootloader (radar-2.4): state, filters, URL hash and the page shell.
// Needs window.RADAR (../data.js) and window.RadarView (radar-view.js), both loaded first. No network.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var V = window.RadarView;
  if (!DATA || !V) return;
  var el = V.el;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

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
      else if (key === 'chains') { av = V.chainCount(a); bv = V.chainCount(b); }
      else if (key === 'growth') { av = V.none(a.change_7d) ? -Infinity : a.change_7d; bv = V.none(b.change_7d) ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = V.none(a.age_days) ? Infinity : a.age_days; bv = V.none(b.age_days) ? Infinity : b.age_days; }
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
        el('span', { text: DATA.model_version + ' · category comps + chain breadth + liquidity spread' })
      )
    );
  }

  function lede() {
    var multi = DATA.rows.filter(V.isMultiChain).length;
    var deep = DATA.rows.filter(function (r) { return r.farm_extra !== null && r.farm_extra !== undefined; }).length;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Pre-token protocols, ranked by what a launch could be worth' }),
        el('p', { text: 'Watchlist floor: every protocol with ≥ $' + Math.round(DATA.floor_usd / 1e6) + 'M TVL and no token on record (' + DATA.watchlist_size + '). Early radar adds ' + DATA.early_size + ' smaller pre-token names. Implied value uses live-token category mcap/TVL comps × growth × age without a token × chain breadth × a 5% concentration bonus for three or more chains × up to +8% for TVL still growing (liquidity spread). An estimate, not a price.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early below floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Multi-chain rows (' + V.MULTI_CHAIN_MIN + '+)' }), el('b', { text: String(multi) })),
        el('div', { class: 'fact' }, el('span', { text: 'Lend/DEX 7-step plans' }), el('b', { text: String(deep) })),
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
    return el('div', { class: 'field' + (id === 'chain' ? ' chain-filter' : '') }, el('label', { for: id, text: label }), select);
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

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    V.fillDetail(dialog, row, DATA, function () { dialog.close(); });
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  var tableCtx = {
    get sort() { return state.sort; },
    get dir() { return state.dir; },
    get selected() { return state.selected; },
    onSort: function (key) { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); },
    onOpen: openDetail,
    onClear: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); }
  };

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? V.boardTable(sortedRows(rows()), tableCtx) : V.liveTable(DATA.live));
    if (state.tab === 'pre-token') shell.appendChild(V.modelPanel(DATA.model));
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
