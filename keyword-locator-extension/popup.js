const PRESETS = ['staging', 'ikshu-digital', 'ikshudigital', 'ikshu', 'theme', 'jhseo', 'sample'];

const $ = (s) => document.querySelector(s);
const els = {
  q: $('#q'), cs: $('#cs'), ww: $('#ww'), ol: $('#ol'), attrs: $('#attrs'),
  presets: $('#presets'), presetAll: $('#preset-all'), presetNone: $('#preset-none'),
  scanall: $('#scanall'),
  tabs: $('#tabs'), tabPage: $('#tab-page'), tabAll: $('#tab-all'),
  panelPage: $('#panel-page'), panelAll: $('#panel-all'),
  prev: $('#prev'), next: $('#next'), clear: $('#clear'),
  count: $('#count'), msg: $('#msg'), kwcounts: $('#kwcounts'),
  title: $('#sec-title'), list: $('#sections'),
  fill: $('#fill'), scantext: $('#scantext'), scannotes: $('#scannotes'),
  stop: $('#scan-stop'), rescan: $('#rescan'),
  results: $('#results'), summary: $('#summary'), pages: $('#pages'), csv: $('#csv')
};

let scanTimer = null;
let lastScan = null;
let renderedKey = '';

/* ---------- preset chips ---------- */

PRESETS.forEach((k) => {
  const label = document.createElement('label');
  label.className = 'chip';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = k;
  const sp = document.createElement('span');
  sp.textContent = k;
  label.append(cb, sp);
  els.presets.appendChild(label);
  cb.addEventListener('change', onKeywordsChanged);
});
const presetBoxes = () => [...els.presets.querySelectorAll('input')];

function setPresets(list) {
  const want = new Set(list.map((k) => k.toLowerCase()));
  presetBoxes().forEach((cb) => { cb.checked = want.has(cb.value.toLowerCase()); });
}

function keywordsInUse() {
  const typed = els.q.value.split(',').map((s) => s.trim()).filter(Boolean);
  const checked = presetBoxes().filter((c) => c.checked).map((c) => c.value);
  const seen = new Set();
  return [...typed, ...checked].filter((k) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyKeywords(list) {
  const presetSet = new Set(PRESETS.map((p) => p.toLowerCase()));
  setPresets(list.filter((k) => presetSet.has(k.toLowerCase())));
  els.q.value = list.filter((k) => !presetSet.has(k.toLowerCase())).join(', ');
}

const getOpts = () => ({
  caseSensitive: els.cs.checked,
  wholeWord: els.ww.checked,
  outline: els.ol.checked,
  attrs: els.attrs.checked
});

function applyOpts(o) {
  if (!o) return;
  if ('caseSensitive' in o) els.cs.checked = !!o.caseSensitive;
  if ('wholeWord' in o) els.ww.checked = !!o.wholeWord;
  if ('outline' in o) els.ol.checked = o.outline !== false;
  if ('attrs' in o) els.attrs.checked = !!o.attrs;
}

/* ---------- messaging ---------- */

async function send(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url ? tab.url : '';
  if (!tab || !tab.id || /^(chrome|edge|about|chrome-extension|view-source):/.test(url) ||
      url.startsWith('https://chromewebstore.google.com') || url.startsWith('https://chrome.google.com/webstore')) {
    throw new Error('restricted');
  }
  const call = async () => {
    const res = await chrome.tabs.sendMessage(tab.id, message);
    if (res && res.error) throw new Error('page error: ' + res.error);
    return res;
  };
  try {
    return await call();
  } catch (err) {
    // Only inject when nothing is listening yet; any other error is a real failure
    if (!/Receiving end does not exist|Could not establish connection/i.test((err && err.message) || '')) throw err;
    // Content script isn't injected yet (tab was opened before the extension) — inject it
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return await call();
  }
}

function showError(err) {
  const m = (err && err.message) || String(err);
  let text;
  if (m === 'restricted') {
    text = 'The extension can\'t run on this page (chrome:// pages and the Web Store are blocked). Open a regular website.';
  } else if (/Cannot access|must request permission|cannot be scripted|blocked/i.test(m)) {
    text = 'Chrome didn\'t give the extension access to this tab. Click the extension icon on this tab again (or press Ctrl+Shift+K). If it still fails, reload the page.';
  } else if (/message port closed|Receiving end|context invalidated/i.test(m)) {
    text = 'This page is still running an old copy of the extension. Refresh the page (F5) and try again.';
  } else {
    text = `Couldn't run on this page (${m}). Refresh it and try again. For file:// pages, enable "Allow access to file URLs" in the extension settings.`;
  }
  els.msg.className = 'msg error';
  els.msg.textContent = text;
  els.count.textContent = '—';
  els.list.replaceChildren();
  els.title.hidden = true;
  els.kwcounts.replaceChildren();
}

/* ---------- tabs ---------- */

function showTab(which) {
  const all = which === 'all';
  els.panelPage.hidden = all;
  els.panelAll.hidden = !all;
  els.tabPage.setAttribute('aria-selected', String(!all));
  els.tabAll.setAttribute('aria-selected', String(all));
}
els.tabPage.addEventListener('click', () => showTab('page'));
els.tabAll.addEventListener('click', () => showTab('all'));

/* ---------- this page ---------- */

function renderState(st) {
  els.msg.className = 'msg';
  els.msg.textContent = '';
  els.kwcounts.replaceChildren();

  if (!st || !st.active) {
    els.count.textContent = '—';
    els.prev.disabled = els.next.disabled = true;
    els.list.replaceChildren();
    els.title.hidden = true;
    return;
  }

  els.prev.disabled = els.next.disabled = st.total === 0;
  els.count.textContent = st.total ? `${st.current} / ${st.total}` : '0 matches';

  st.keywords.forEach((k) => {
    const n = (st.counts && st.counts[k]) || 0;
    const s = document.createElement('span');
    s.className = 'kc' + (n ? '' : ' zero');
    s.textContent = `${k} ${n}`;
    els.kwcounts.appendChild(s);
  });

  const notes = [];
  if (st.total === 0) notes.push('No visible matches found on this page.');
  if (st.hidden > 0) notes.push(`${st.hidden} hidden match(es) (inside menus, popups or tabs) are not counted in the list.`);
  if (st.capped) notes.push('Too many matches — only the first 3000 are shown.');
  els.msg.textContent = notes.join(' ');

  els.list.replaceChildren();
  els.title.hidden = st.sections.length === 0;
  st.sections.forEach((s) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    if (s.index === st.currentSection) li.classList.add('active');

    const label = document.createElement('div');
    label.className = 'sec-label';
    const name = document.createElement('div');
    name.className = 'sec-name';
    name.textContent = s.label;
    name.title = s.label;
    const kind = document.createElement('div');
    kind.className = 'sec-kind';
    kind.textContent = s.landmark;
    label.append(name, kind);

    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = s.count;

    li.append(label, pill);
    const go = () => send({ type: 'goto-section', index: s.index }).then(renderState).catch(showError);
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    els.list.appendChild(li);
  });
}

let timer;
async function run() {
  const kws = keywordsInUse();
  chrome.storage.local.set({ opts: { ...getOpts(), presets: presetBoxes().filter((c) => c.checked).map((c) => c.value) } });
  try {
    if (!kws.length) return renderState(await send({ type: 'clear' }));
    renderState(await send({ type: 'search', keywords: kws, opts: getOpts() }));
  } catch (err) { showError(err); }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 250); };

function onKeywordsChanged() {
  schedule();
  if (lastScan && !lastScan.running) renderScanText(lastScan);
}

/* ---------- all pages ---------- */

const keyOf = (list) => list.map((k) => k.toLowerCase()).sort().join('|');

function renderScanText(s) {
  const notes = [];
  if (!s.running) {
    if (s.source === 'sitemap') notes.push('Pages found via the sitemap.');
    else notes.push('No sitemap found — pages found by following links.');
    if (s.capped) notes.push('Stopped at 300 pages.');
    if (s.foreignOrigin) notes.push(`The sitemap lists URLs on ${s.foreignOrigin}; the same paths were scanned on this site.`);
    if (s.errors) notes.push(`${s.errors} page(s) couldn't be loaded.`);
    if (s.error) notes.push(`Error: ${s.error}`);
    if (keyOf(s.keywords || []) !== keyOf(keywordsInUse())) notes.push('Keywords changed since this scan — press Rescan.');
  }
  els.scannotes.textContent = notes.join(' ');
}

function renderScan(s) {
  lastScan = s;
  if (!s) { els.results.hidden = true; return; }
  els.results.hidden = false;

  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  els.fill.style.width = (s.running ? pct : 100) + '%';
  els.scantext.textContent = s.running
    ? `Scanning ${Math.min(s.done + 1, Math.max(s.total, 1))} of ${s.total} pages…`
    : `${s.cancelled ? 'Stopped' : 'Done'} — ${s.done} pages scanned, ${s.pages.length} with matches`;
  els.stop.hidden = !s.running;
  els.rescan.hidden = s.running;
  renderScanText(s);
  renderPages(s);
}

function pill(text, cls) {
  const el = document.createElement('span');
  el.className = 'kc' + (cls ? ' ' + cls : '');
  el.textContent = text;
  return el;
}

function renderPages(s) {
  const key = [s.pages.length, s.running, s.finishedAt || 0].join('|');
  if (key === renderedKey) return;
  renderedKey = key;

  // Totals per keyword
  const tot = {};
  s.pages.forEach((p) => {
    Object.entries(p.counts || {}).forEach(([k, n]) => { const t = tot[k] || (tot[k] = { n: 0, p: 0, a: 0 }); t.n += n; t.p++; });
    Object.entries(p.attrCounts || {}).forEach(([k, n]) => { const t = tot[k] || (tot[k] = { n: 0, p: 0, a: 0 }); t.a += n; });
  });
  els.summary.replaceChildren();
  (s.keywords || []).forEach((k) => {
    const t = tot[k];
    if (!t) { els.summary.appendChild(pill(`${k}: none`, 'zero')); return; }
    const parts = [];
    if (t.n) parts.push(`${t.n} on ${t.p} page${t.p === 1 ? '' : 's'}`);
    if (t.a) parts.push(`${t.a} in URLs/attributes`);
    els.summary.appendChild(pill(`${k}: ${parts.join(' · ')}`));
  });

  els.pages.replaceChildren();
  if (!s.pages.length) {
    if (!s.running) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matches found on the scanned pages.';
      els.pages.appendChild(li);
    }
    return;
  }

  [...s.pages]
    .sort((a, b) => (b.total + b.attrTotal) - (a.total + a.attrTotal) || a.path.localeCompare(b.path))
    .forEach((p) => {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.title = p.url;

      const title = document.createElement('div');
      title.className = 'pg-title';
      title.textContent = p.title || p.path;
      const path = document.createElement('div');
      path.className = 'pg-path';
      path.textContent = p.path;

      const hits = document.createElement('div');
      hits.className = 'pg-hits';
      Object.entries(p.counts || {}).forEach(([k, n]) => hits.appendChild(pill(`${k} ×${n}`)));
      Object.entries(p.attrCounts || {}).forEach(([k, n]) => hits.appendChild(pill(`${k} ×${n} in URLs/attrs`, 'attr')));
      li.append(title, path, hits);

      if (p.sections && p.sections.length) {
        const secs = document.createElement('div');
        secs.className = 'pg-secs';
        const b = document.createElement('b');
        b.textContent = 'Sections: ';
        secs.append(b, p.sections.map((x) => `${x.label} ×${x.count}`).join(' · '));
        li.appendChild(secs);
      }
      if (p.attrHits && p.attrHits.length) {
        const a = document.createElement('div');
        a.className = 'pg-secs';
        const b = document.createElement('b');
        b.textContent = 'Found in: ';
        a.append(b, p.attrHits.slice(0, 2).join(' · '));
        li.appendChild(a);
      }

      const open = () => openPage(p.url);
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      els.pages.appendChild(li);
    });
}

const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch (_) { return u; } };

async function openPage(url) {
  await chrome.storage.local.set({ pending: { url: normUrl(url), keywords: keywordsInUse(), opts: getOpts() } });
  chrome.tabs.create({ url });
}

function downloadCsv() {
  if (!lastScan) return;
  const rows = [['Page URL', 'Page title', 'Keyword', 'Found in', 'Count', 'Details']];
  lastScan.pages.forEach((p) => {
    const secs = (p.sections || []).map((x) => `${x.label} (${x.count})`).join('; ');
    Object.entries(p.counts || {}).forEach(([k, n]) => rows.push([p.url, p.title, k, 'Visible text', n, secs]));
    Object.entries(p.attrCounts || {}).forEach(([k, n]) => rows.push([p.url, p.title, k, 'URLs/attributes', n, (p.attrHits || []).join('; ')]));
  });
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'keyword-scan.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function poll() {
  clearInterval(scanTimer);
  scanTimer = setInterval(async () => {
    try {
      const s = await send({ type: 'scan-status' });
      renderScan(s);
      if (!s || !s.running) clearInterval(scanTimer);
    } catch (_) { clearInterval(scanTimer); }
  }, 500);
}

async function startScan() {
  if (!keywordsInUse().length) setPresets(PRESETS);   // nothing selected → check all presets
  const kws = keywordsInUse();
  renderedKey = '';
  try {
    await run();                                      // highlight on the current page too
    renderScan(await send({ type: 'scan-start', keywords: kws, opts: getOpts() }));
    poll();
  } catch (err) { showError(err); }
}

els.scanall.addEventListener('change', async () => {
  if (els.scanall.checked) {
    els.tabs.hidden = false;
    showTab('all');
    startScan();
  } else {
    clearInterval(scanTimer);
    try { await send({ type: 'scan-stop' }); } catch (_) { /* ignore */ }
    els.tabs.hidden = true;
    showTab('page');
  }
});
els.rescan.addEventListener('click', startScan);
els.stop.addEventListener('click', async () => {
  try { renderScan(await send({ type: 'scan-stop' })); poll(); } catch (err) { showError(err); }
});
els.attrs.addEventListener('change', () => { if (lastScan && !lastScan.running) renderScanText(lastScan); chrome.storage.local.set({ opts: getOpts() }); });
els.csv.addEventListener('click', downloadCsv);

/* ---------- inputs ---------- */

els.q.addEventListener('input', onKeywordsChanged);
[els.cs, els.ww, els.ol].forEach((c) => c.addEventListener('change', run));
els.presetAll.addEventListener('click', () => { setPresets(PRESETS); onKeywordsChanged(); });
els.presetNone.addEventListener('click', () => { setPresets([]); onKeywordsChanged(); });

els.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    send({ type: e.shiftKey ? 'prev' : 'next' }).then(renderState).catch(showError);
  }
});
els.next.addEventListener('click', () => send({ type: 'next' }).then(renderState).catch(showError));
els.prev.addEventListener('click', () => send({ type: 'prev' }).then(renderState).catch(showError));
els.clear.addEventListener('click', async () => {
  els.q.value = '';
  setPresets([]);
  els.q.focus();
  try { renderState(await send({ type: 'clear' })); } catch (err) { showError(err); }
  if (lastScan && !lastScan.running) renderScanText(lastScan);
});

/* ---------- init ---------- */

(async function init() {
  els.prev.disabled = els.next.disabled = true;
  const saved = await chrome.storage.local.get(['opts', 'pending']);
  applyOpts(saved.opts);
  if (saved.opts && Array.isArray(saved.opts.presets)) setPresets(saved.opts.presets);

  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (_) { /* ignore */ }

  try {
    let st = await send({ type: 'status' });

    // Opened from the "All pages" list → highlight automatically
    const pend = saved.pending;
    if (pend && tab && normUrl(pend.url) === normUrl(tab.url) && !(st && st.active)) {
      await chrome.storage.local.remove('pending');
      applyKeywords(pend.keywords);
      applyOpts(pend.opts);
      st = await send({ type: 'search', keywords: pend.keywords, opts: pend.opts });
    }

    if (st && st.active) {
      applyKeywords(st.keywords);
      applyOpts(st.opts);
      renderState(st);
    }

    let scan = st && st.scan;
    if (!scan && tab && tab.url) {
      try {
        const key = 'scan:' + new URL(tab.url).origin;
        scan = (await chrome.storage.local.get(key))[key] || null;
      } catch (_) { /* ignore */ }
    }
    if (scan) {
      els.scanall.checked = true;
      els.tabs.hidden = false;
      renderScan(scan);
      if (scan.running) { showTab('all'); poll(); }
    }
  } catch (err) { showError(err); }

  els.q.focus();
}());
