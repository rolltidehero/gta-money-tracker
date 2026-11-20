/* Shared matrix UI for the Glitch and Money Trackers. */
(function () {
  'use strict';

  var T = window.TRACKER;
  var isMoney = T.meta.repo === 'rolltidehero/gta-money-tracker';
  var csvFilename = isMoney ? 'gta6_money_tracker.csv' : 'gta6_glitch_tracker.csv';
  var entries = T.entries.map(function (e, i) { e._i = i; return e; });

  var CATEGORY_ORDER = ['Money exploit', 'Built-in cheat', 'Duplication claim', 'Hoax or scam', 'Vehicle launch', 'Flying anomaly', 'Map clipping', 'Other physics'];
  var REPRO_ORDER = ['Repeatable', 'Recurring', 'Isolated', 'Unverified claim'];
  var STATUS_ORDER = ['Unpatched', 'Partially patched', 'Patched', 'Disputed', 'Not a bug', 'Unverified', 'Not real'];
  var PLATFORM_ORDER = ['Reported', 'Unspecified', 'Not affected', 'Not released'];

  var TONES = {
    Repeatable: 'pos', Recurring: 'warn', Isolated: '', 'Unverified claim': 'outline',
    Unpatched: 'warn', 'Partially patched': 'warn', Patched: 'pos', Disputed: '', 'Not a bug': 'pos', Unverified: 'outline', 'Not real': 'neg',
    Reported: 'pos', Unspecified: 'outline', 'Not affected': '', 'Not released': '',
  };

  function rank(list) {
    return function (v) { var i = list.indexOf(v); return i === -1 ? list.length : i; };
  }

  var COLUMNS = [
    { key: 'id', label: 'ID', sort: function (e) { return e._i; } },
    { key: 'name', label: isMoney ? 'Report' : 'Glitch', sort: function (e) { return e.name.replace(/^[^A-Za-z0-9]+/, '').toLowerCase(); } },
    { key: 'category', label: 'Category', sort: function (e) { return rank(CATEGORY_ORDER)(e.category); } },
    { key: 'money', label: 'Money potential', sort: function (e) { return e.moneyRank; } },
    { key: 'ps5', label: 'PS5', sort: function (e) { return rank(PLATFORM_ORDER)(e.ps5); } },
    { key: 'xbox', label: 'Xbox', sort: function (e) { return rank(PLATFORM_ORDER)(e.xbox); } },
    { key: 'pc', label: 'PC', sort: function (e) { return rank(PLATFORM_ORDER)(e.pc); } },
    { key: 'repro', label: 'Reproducibility', sort: function (e) { return rank(REPRO_ORDER)(e.repro); } },
    { key: 'status', label: 'Patch status', sort: function (e) { return rank(STATUS_ORDER)(e.status); } },
    { key: 'sp', label: 'Single-player', sort: function (e) { return e.sp; } },
    { key: 'online', label: 'Online', sort: function (e) { return e.online; } },
  ];
  var COL = {};
  COLUMNS.forEach(function (c) { COL[c.key] = c; });

  var defaultSort = isMoney ? 'money' : 'id';
  var state = { q: '', category: '', repro: '', status: '', sortKey: defaultSort, sortDir: 1, open: {} };
  var lastCount = 0;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    rows: $('rows'), head: $('head-row'), count: $('count'), empty: $('empty'),
    q: $('q'), category: $('f-category'), repro: $('f-repro'), status: $('f-status'),
    sort: $('f-sort'),
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function svg(pathD, cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', cls);
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', pathD);
    s.appendChild(p);
    return s;
  }

  function badge(value, toneOverride) {
    var tone = toneOverride !== undefined ? toneOverride : (TONES[value] || '');
    return el('span', { class: 'badge' + (tone ? ' ' + tone : ''), text: value });
  }

  function sourceLink(key) {
    var s = T.sources[key];
    return el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.name });
  }

  /* ---------- Static pieces ---------- */
  function renderFacts() {
    var withSteps = entries.filter(function (e) { return e.steps.length > 0; });
    var multi = entries.filter(function (e) { return e.category === 'Money exploit' && e.repro === 'Repeatable'; });
    /* A car duplication entry counts once it is repeatable and not just a claim. */
    var dupes = entries.filter(function (e) { return e.carDupe && e.repro === 'Repeatable' && e.status !== 'Unverified' && e.status !== 'Not real'; });
    var patched = entries.filter(function (e) { return e.status === 'Patched' || e.status === 'Partially patched'; });
    var facts = isMoney ? [
      ['Entries tracked', String(entries.length), 'Exploits, cheats, duplication claims and scams'],
      ['Money methods with published steps', String(withSteps.length), multi.length + (multi.length === 1 ? ' exploit' : ' exploits') + ' backed by several outlets'],
      ['Verified car duplication methods', String(dupes.length), dupes.length ? dupes.map(function (e) { return e.id; }).join(', ') + ' in the matrix' : 'Claims only so far'],
    ] : [
      ['Entries tracked', String(entries.length), 'Physics and map reports'],
      ['Vehicle and flight anomalies', String(entries.filter(function (e) { return e.category === 'Vehicle launch' || e.category === 'Flying anomaly'; }).length), 'Launching and flying reports'],
      ['Map clipping', String(entries.filter(function (e) { return e.category === 'Map clipping'; }).length), 'World and collision issues'],
    ];
    facts = facts.concat([
      ['Fixed by Rockstar', String(patched.length), T.meta.patchNote || ''],
      ['Latest build', T.meta.build, T.meta.buildNote || ''],
      ['Platforms', T.meta.platformsLive, T.meta.platformsNote || ''],
    ]);
    var wrap = $('facts');
    facts.forEach(function (f) {
      var dd = el('dd', { text: f[1] });
      dd.appendChild(el('small', { text: f[2] }));
      wrap.appendChild(el('div', { class: 'fact' }, [el('dt', { text: f[0] }), dd]));
    });
    $('asof-date').textContent = T.meta.asOf;
    $('asof-build').textContent = T.meta.build;
  }

  /* Turns "[[sourceKey|label]]" inside a text into real links. */
  function richText(text) {
    var frag = document.createDocumentFragment();
    var re = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var s = T.sources[m[1]];
      if (s) frag.appendChild(el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: m[2] }));
      else frag.appendChild(document.createTextNode(m[2]));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function renderFindings() {
    var wrap = $('findings');
    (T.findings || []).forEach(function (f) {
      var card = el('article', { class: 'finding' }, [el('h3', { text: f.title })]);
      f.paragraphs.forEach(function (p) { card.appendChild(el('p', null, [richText(p)])); });
      wrap.appendChild(card);
    });
  }

  /* Footer: git version of this app. Read live from GitHub so the page never has to be
     rebuilt (a hash written into the files would change on every commit). */
  function renderVersion() {
    var el = $('version');
    var repo = T.meta.repo;
    if (!el || !repo) return;
    var base = 'https://github.com/' + repo;
    function fallback() {
      el.textContent = '';
      el.appendChild(document.createTextNode('Git version: not available right now. '));
      var l = document.createElement('a');
      l.href = base + '/commits'; l.target = '_blank'; l.rel = 'noopener noreferrer';
      l.textContent = 'See the commit history';
      el.appendChild(l);
    }
    fetch('https://api.github.com/repos/' + repo + '/commits?per_page=1')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var link = r.headers.get('Link') || '';
        var m = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
        return r.json().then(function (list) { return { c: list[0], count: m ? m[1] : '1' }; });
      })
      .then(function (res) {
        var sha = res.c.sha;
        var when = new Date(res.c.commit.committer.date);
        var stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(when) + ' CT';
        el.textContent = '';
        el.appendChild(document.createTextNode('Git version: '));
        var a = document.createElement('a');
        a.href = base + '/commit/' + sha; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.className = 'hash'; a.textContent = sha.slice(0, 7);
        el.appendChild(a);
        el.appendChild(document.createTextNode(' (commit #' + res.count + ') \u00b7 updated ' + stamp));
      })
      .catch(fallback);
  }

  function renderFootnotes() {
    var wrap = $('footnotes');
    (T.footnotes || []).forEach(function (p) { wrap.appendChild(el('p', null, [richText(p)])); });
  }

  function sourceLine(keys) {
    var list = el('ul', { class: 'source-list' });
    keys.forEach(function (k) { list.appendChild(el('li', null, [sourceLink(k)])); });
    return list;
  }

  function renderPlan() {
    var wrap = $('plan');
    var byId = {};
    entries.forEach(function (e) { byId[e.id] = e; });
    (T.plan || []).forEach(function (step) {
      var todo = el('ul');
      step.do.forEach(function (d) { todo.appendChild(el('li', { text: d })); });

      var chips = el('div', { class: 'chips' });
      step.exploits.forEach(function (id) {
        var e = byId[id];
        if (!e) return;
        var chip = el('button', { type: 'button', class: 'chip', 'data-entry': id, title: 'Show ' + id + ' in the matrix' }, [
          el('span', { class: 'chip-id', text: id }),
          el('span', { text: e.name }),
          badge(e.repro),
        ]);
        chip.addEventListener('click', function () { showEntry(id); });
        chips.appendChild(chip);
      });
      if (!step.exploits.length) chips.appendChild(el('p', { class: 'plan-none', text: 'None needed. The legitimate method pays more.' }));

      wrap.appendChild(el('li', { class: 'plan-step' }, [
        el('div', { class: 'plan-stage' }, [
          el('p', { class: 'plan-when', text: step.stage }),
          el('h3', { text: step.title }),
        ]),
        el('div', { class: 'plan-block plan-do' }, [el('h4', { text: 'What to do' }), todo]),
        el('div', { class: 'plan-block plan-side' }, [
          el('h4', { text: 'Expect' }),
          el('p', { class: 'plan-expect', text: step.expect }),
          el('h4', { text: 'Watch out' }),
          el('p', { text: step.watch }),
          el('h4', { text: 'Related tracker entries' }),
          chips,
          el('h4', { text: 'Sources' }),
          sourceLine(step.sources),
        ]),
      ]));
    });
  }

  /* Opens one entry in the matrix and scrolls to it. Clears filters if they hide it. */
  function showEntry(id) {
    var shown = visible().some(function (e) { return e.id === id; });
    if (!shown) {
      state.q = ''; state.category = ''; state.repro = ''; state.status = '';
      els.q.value = ''; els.category.value = ''; els.repro.value = ''; els.status.value = '';
    }
    state.open[id] = true;
    render();
    var row = els.rows.querySelector('tr[data-id="' + id + '"]');
    if (!row) return;
    row.scrollIntoView({ block: 'start', behavior: 'auto' });
    var btn = row.querySelector('.name-btn');
    if (btn) btn.focus({ preventScroll: true });
  }

  function renderLadder() {
    var body = $('ladder');
    T.ladder.forEach(function (r) {
      var src = el('td');
      r.sources.forEach(function (k, i) {
        if (i) src.appendChild(document.createTextNode(', '));
        src.appendChild(sourceLink(k));
      });
      src.setAttribute('data-label', 'Sources');
      body.appendChild(el('tr', null, [
        el('td', { class: 'when', 'data-label': 'When', text: r.stage }),
        el('td', { class: 'method', 'data-label': 'Method', text: r.method }),
        el('td', { class: 'num', 'data-label': 'Reported payout', text: r.payout }),
        el('td', { 'data-label': 'Notes', text: r.note }),
        src,
      ]));
    });
  }

  function fillSelect(select, allLabel, values) {
    select.appendChild(el('option', { value: '', text: allLabel }));
    values.forEach(function (v) { select.appendChild(el('option', { value: v, text: v })); });
  }

  function renderControls() {
    var present = function (key) {
      return function (v) { return entries.some(function (e) { return e[key] === v; }); };
    };
    fillSelect(els.category, 'All categories', CATEGORY_ORDER.filter(present('category')));
    fillSelect(els.repro, 'All tiers', REPRO_ORDER.filter(present('repro')));
    fillSelect(els.status, 'All statuses', STATUS_ORDER.filter(present('status')));
    [['money', 'Money potential'], ['repro', 'Reproducibility'], ['status', 'Patch status'], ['category', 'Category'], ['name', 'Name'], ['id', 'ID']].forEach(function (o) {
      els.sort.appendChild(el('option', { value: o[0], text: o[1] }));
    });

    COLUMNS.forEach(function (c) {
      var btn = el('button', { type: 'button', class: 'sort-btn', 'data-key': c.key }, [
        el('span', { text: c.label }),
        svg('M8 12V4M4.5 7.5 8 4l3.5 3.5', 'arrow'),
      ]);
      btn.addEventListener('click', function () {
        if (state.sortKey === c.key) state.sortDir = -state.sortDir;
        else { state.sortKey = c.key; state.sortDir = 1; }
        render();
      });
      els.head.appendChild(el('th', { scope: 'col', 'data-key': c.key }, [btn]));
    });
  }

  /* ---------- Filtering and sorting ---------- */
  function haystack(e) {
    if (!e._hay) {
      e._hay = [e.id, e.name, e.category, e.money, e.repro, e.status, e.summary, e.steps.join(' '), e.payout, e.tips, e.caveats, e.reportedBy].join(' ').toLowerCase();
    }
    return e._hay;
  }

  function visible() {
    var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    var list = entries.filter(function (e) {
      if (state.category && e.category !== state.category) return false;
      if (state.repro && e.repro !== state.repro) return false;
      if (state.status && e.status !== state.status) return false;
      var hay = haystack(e);
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
    var get = COL[state.sortKey].sort;
    list.sort(function (a, b) {
      var x = get(a), y = get(b);
      if (x < y) return -state.sortDir;
      if (x > y) return state.sortDir;
      return a._i - b._i;
    });
    return list;
  }

  /* ---------- Rows ---------- */
  function block(title, node) {
    return el('div', { class: 'detail-block' }, [el('h4', { text: title }), node]);
  }

  function detailRow(e) {
    var left = el('div');
    if (e.steps.length) {
      var ol = el('ol');
      e.steps.forEach(function (s) { ol.appendChild(el('li', { text: s })); });
      left.appendChild(block(e.steps.length > 1 ? 'Steps' : 'Trigger', ol));
    } else {
      left.appendChild(block('Steps', el('p', { text: 'No steps or reliable trigger published.' })));
    }
    left.appendChild(block('Payout', el('p', { text: e.payout })));
    if (e.tips) left.appendChild(block('Tips', el('p', { text: e.tips })));

    var right = el('div');
    right.appendChild(block('Caveats', el('p', { text: e.caveats })));
    if (e.reportedBy) right.appendChild(block('Reported by', el('p', { text: e.reportedBy })));
    var list = el('ul', { class: 'source-list' });
    e.sources.forEach(function (k) { list.appendChild(el('li', null, [sourceLink(k)])); });
    right.appendChild(block('Sources', list));

    var grid = el('div', { class: 'detail-grid' }, [el('p', { class: 'lede', text: e.summary }), left, right]);
    var td = el('td', { colspan: String(COLUMNS.length) }, [grid]);
    return el('tr', { class: 'detail', id: 'detail-' + e.id }, [td]);
  }

  function mainRow(e) {
    var open = !!state.open[e.id];
    var btn = el('button', { type: 'button', class: 'name-btn', 'aria-expanded': String(open), 'aria-controls': 'detail-' + e.id }, [
      svg('M6 3.5 10.5 8 6 12.5', 'chev'),
      el('span', { text: e.name }),
    ]);
    var isNone = /^None|^Unproven|^Not stated/.test(e.money);
    var tr = el('tr', { class: 'row' + (open ? ' open' : ''), 'data-id': e.id }, [
      el('td', { class: 'cell-id', text: e.id }),
      el('td', { class: 'cell-name' }, [btn]),
      el('td', { class: 'cell-cat', 'data-label': 'Category', text: e.category }),
      el('td', { class: 'cell-money' + (isNone ? ' none' : ''), 'data-label': 'Money potential', text: e.money }),
      el('td', { 'data-label': 'PS5' }, [badge(e.ps5)]),
      el('td', { 'data-label': 'Xbox' }, [badge(e.xbox)]),
      el('td', { 'data-label': 'PC' }, [badge(e.pc)]),
      el('td', { 'data-label': 'Reproducibility' }, [badge(e.repro)]),
      el('td', { 'data-label': 'Patch status' }, [badge(e.status)]),
      el('td', { 'data-label': 'Single-player', text: e.sp }),
      el('td', { class: 'cell-cat', 'data-label': 'Online', text: e.online }),
    ]);
    tr.addEventListener('click', function (ev) {
      if (ev.target.closest('a')) return;
      if (window.getSelection && String(window.getSelection())) return;
      state.open[e.id] = !state.open[e.id];
      render();
      var again = els.rows.querySelector('tr[data-id="' + e.id + '"] .name-btn');
      if (again && ev.target.closest('.name-btn')) again.focus();
    });
    return tr;
  }

  function render() {
    var list = visible();
    var frag = document.createDocumentFragment();
    list.forEach(function (e) {
      frag.appendChild(mainRow(e));
      if (state.open[e.id]) frag.appendChild(detailRow(e));
    });
    els.rows.textContent = '';
    els.rows.appendChild(frag);
    els.empty.hidden = list.length > 0;
    els.count.textContent = 'Showing ' + list.length + ' of ' + entries.length + ' entries';
    lastCount = list.length;

    Array.prototype.forEach.call(els.head.children, function (th) {
      if (th.getAttribute('data-key') === state.sortKey) {
        th.setAttribute('aria-sort', state.sortDir === 1 ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    });
    if (els.sort.querySelector('option[value="' + state.sortKey + '"]')) els.sort.value = state.sortKey;
    return list;
  }

  /* ---------- Events ---------- */
  function reset() {
    state.q = ''; state.category = ''; state.repro = ''; state.status = '';
    state.sortKey = defaultSort; state.sortDir = 1;
    els.q.value = ''; els.category.value = ''; els.repro.value = ''; els.status.value = '';
    render();
  }

  function download(csv, filename) {
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportCsv() { download(T.toCsv(visible()), csvFilename); }

  /* Search button and Enter key: apply the search box, then bring the results into view. */
  function runSearch() {
    state.q = els.q.value;
    render();
    var target = $('matrix');
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    target.focus({ preventScroll: true });
    els.count.textContent = (state.q.trim() ? 'Search for "' + state.q.trim() + '": ' : '') + 'showing ' + lastCount + ' of ' + entries.length + ' entries';
  }

  function bind() {
    els.q.addEventListener('input', function () { state.q = els.q.value; render(); });
    els.category.addEventListener('change', function () { state.category = els.category.value; render(); });
    els.repro.addEventListener('change', function () { state.repro = els.repro.value; render(); });
    els.status.addEventListener('change', function () { state.status = els.status.value; render(); });
    els.sort.addEventListener('change', function () { state.sortKey = els.sort.value; state.sortDir = 1; render(); });
    $('toolbar').addEventListener('submit', function (ev) { ev.preventDefault(); runSearch(); });
    $('reset').addEventListener('click', reset);
    $('reset-empty').addEventListener('click', reset);
    $('export').addEventListener('click', exportCsv);
    /* In-page jump links scroll without touching the address bar. */
    Array.prototype.forEach.call(document.querySelectorAll('[data-jump]'), function (link) {
      link.addEventListener('click', function (ev) {
        ev.preventDefault();
        var target = $(link.getAttribute('data-jump'));
        if (!target) return;
        target.scrollIntoView({ block: 'start', behavior: 'auto' });
        target.focus({ preventScroll: true });
      });
    });
  }

  renderFacts();
  if (isMoney) { renderFindings(); renderPlan(); renderLadder(); }
  renderFootnotes();
  renderVersion();
  renderControls();
  bind();
  if (entries.length) state.open[entries[0].id] = true;
  render();
})();
