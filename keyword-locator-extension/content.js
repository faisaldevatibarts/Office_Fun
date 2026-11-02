(() => {
  // A fresh injection replaces any earlier one (e.g. a copy left behind when the extension was reloaded)
  const token = (window.__kwhToken = {});
  const stale = document.getElementById('kwh-host');
  if (stale) stale.remove();
  document.querySelectorAll('span.kwh-mark').forEach((m) => {
    if (m.parentNode) m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
  });
  document.querySelectorAll('.kwh-box, .kwh-flash').forEach((e) => e.classList.remove('kwh-box', 'kwh-flash'));

  const MARK = 'kwh-mark';
  const MAX_MARKS = 3000;
  const SCAN_MAX_PAGES = 300;
  const SCAN_CONCURRENCY = 5;
  const TOP_LABEL = 'Top of page (before first heading)';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IFRAME', 'CANVAS', 'SVG', 'TEMPLATE']);
  const BOX_SELECTOR = 'section, article, header, footer, nav, aside, .elementor-top-section, .e-con.e-parent, .et_pb_section, .wp-block-group';
  const ATTRS = ['href', 'src', 'srcset', 'data-src', 'data-srcset', 'action', 'alt', 'title', 'content', 'aria-label', 'placeholder', 'value'];
  const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|rar|7z|mp[34]|mov|avi|css|js|json|xml|txt|docx?|xlsx?|pptx?|woff2?|ttf|eot)$/i;
  const SKIP_PATH = /\/(wp-admin|wp-login\.php|wp-json|wp-includes|wp-content|xmlrpc\.php|feed|logout|customer-logout)(\/|$)/i;

  const LANDMARKS = [
    { name: 'Header',     tags: ['HEADER'], roles: ['banner'],        tokens: ['header', 'site-header', 'masthead', 'main-header', 'elementor-location-header'] },
    { name: 'Menu / Nav', tags: ['NAV'],    roles: ['navigation'],    tokens: ['nav', 'navbar', 'menu', 'main-menu', 'main-navigation', 'navigation'] },
    { name: 'Footer',     tags: ['FOOTER'], roles: ['contentinfo'],   tokens: ['footer', 'site-footer', 'elementor-location-footer'] },
    { name: 'Sidebar',    tags: ['ASIDE'],  roles: ['complementary'], tokens: ['sidebar', 'widget-area'] }
  ];

  let marks = [];          // visible highlight spans (document order)
  let markSection = [];    // marks[i] -> sections index
  let markBox = [];        // marks[i] -> container element
  let sections = [];
  let current = -1;
  let hiddenCount = 0;
  let capped = false;
  let kws = [];            // keywords currently highlighted
  let counts = {};
  let opts = {};
  let host = null;         // shadow DOM host (rail + floating bar)
  let bar = null;
  let flashEl = null;
  let flashTimer = null;
  let scan = null;         // all-pages scan state

  /* ---------- helpers ---------- */

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canon = (s, o) => { s = s.replace(/\s+/g, ' '); return o.caseSensitive ? s : s.toLowerCase(); };

  // One regex for all keywords; longest keyword first so "ikshu-digital" wins over "ikshu"
  function buildRegex(list, o) {
    const body = [...list]
      .sort((a, b) => b.length - a.length)
      .map((k) => escapeRegExp(k.trim()).replace(/\s+/g, '\\s+'))
      .join('|');
    const src = o.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body;
    return new RegExp(src, 'gu' + (o.caseSensitive ? '' : 'i'));
  }

  function landmarkFrom(start) {
    const doc = start && start.ownerDocument ? start.ownerDocument : document;
    for (let n = start; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
      const tag = n.tagName;
      const role = n.getAttribute('role');
      const toks = new Set([...n.classList, n.id].filter(Boolean).map((t) => t.toLowerCase()));
      for (const lm of LANDMARKS) {
        let hit = (role && lm.roles.includes(role)) || lm.tokens.some((t) => toks.has(t));
        if (!hit && lm.tags.includes(tag)) {
          // <header>/<footer> inside an article or section isn't the page header/footer
          hit = lm.name === 'Menu / Nav' || !(n.parentElement && n.parentElement.closest('article, section, main, aside'));
        }
        if (hit) return { name: lm.name, el: n };
      }
    }
    return { name: 'Main content', el: doc.body };
  }
  const landmarkOf = (mark) => landmarkFrom(mark.parentElement);

  function boxOf(mark) {
    let b = mark.closest(BOX_SELECTOR);
    if (!b || b === document.body) b = mark.closest('div, p, li, td, ul, ol, table');
    if (!b || b === document.body || b === document.documentElement) return null;
    return b;
  }

  /* ---------- clear ---------- */

  function clearMarks() {
    const parents = new Set();
    document.querySelectorAll('span.' + MARK).forEach((m) => {
      const p = m.parentNode;
      if (!p) return;
      p.replaceChild(document.createTextNode(m.textContent), m);
      parents.add(p);
    });
    parents.forEach((p) => p.normalize());
    document.querySelectorAll('.kwh-box, .kwh-flash').forEach((e) => e.classList.remove('kwh-box', 'kwh-flash'));
    marks = []; markSection = []; markBox = []; sections = [];
    current = -1; hiddenCount = 0; capped = false; kws = []; counts = {};
    removeUI();
  }

  /* ---------- search (current page) ---------- */

  function search(keywords, o) {
    clearMarks();
    kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
    opts = { caseSensitive: !!o.caseSensitive, wholeWord: !!o.wholeWord, outline: o.outline !== false, attrs: !!o.attrs };
    if (!kws.length) return state();

    let re;
    try { re = buildRegex(kws, opts); } catch (_) { kws = []; return state(); }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const created = [];
    for (const node of nodes) {
      if (created.length >= MAX_MARKS) { capped = true; break; }
      const text = node.nodeValue;
      re.lastIndex = 0;
      let m, last = 0, frag = null;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        frag = frag || document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = document.createElement('span');
        span.className = MARK;
        span.textContent = m[0];
        frag.appendChild(span);
        created.push(span);
        last = m.index + m[0].length;
        if (created.length >= MAX_MARKS) { capped = true; break; }
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }

    // Visible vs hidden (display:none menus, tabs, modals, etc.)
    marks = created.filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    const visible = new Set(marks);
    created.forEach((el) => { if (!visible.has(el)) el.classList.add('kwh-hidden'); });
    hiddenCount = created.length - marks.length;

    // Per-keyword counts
    const kwMap = new Map(kws.map((k) => [canon(k, opts), k]));
    counts = {};
    kws.forEach((k) => { counts[k] = 0; });
    marks.forEach((m) => {
      const k = kwMap.get(canon(m.textContent, opts));
      if (k !== undefined) counts[k]++;
    });

    buildSections();
    if (marks.length) {
      renderUI();
      setCurrent(0, true);
    }
    return state();
  }

  function buildSections() {
    const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];
    const map = new Map();
    let p = -1;
    sections = []; markSection = []; markBox = [];

    marks.forEach((mark, i) => {
      // Nearest heading before this match
      while (p + 1 < heads.length && (heads[p + 1].compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING)) p++;

      const lm = landmarkOf(mark);
      let hi = p;
      // Don't attach a footer/header/sidebar match to a heading from the main content
      if (hi >= 0 && lm.name !== 'Main content' && !lm.el.contains(heads[hi])) hi = -1;

      const headText = hi >= 0 ? clean(heads[hi].textContent) : '';
      const key = (hi >= 0 ? 'h' + hi : 'l') + '|' + lm.name;
      const box = boxOf(mark);

      let s = map.get(key);
      if (!s) {
        s = { index: sections.length, label: headText || (lm.name === 'Main content' ? TOP_LABEL : lm.name), landmark: lm.name, count: 0, first: i };
        map.set(key, s);
        sections.push(s);
      }
      s.count++;
      markSection[i] = s.index;
      markBox[i] = box;
      if (box && opts.outline) box.classList.add('kwh-box');
    });
  }

  /* ---------- navigation ---------- */

  function flash(el) {
    if (!el) return;
    if (flashEl) flashEl.classList.remove('kwh-flash');
    void el.offsetWidth; // restart animation
    el.classList.add('kwh-flash');
    flashEl = el;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('kwh-flash'), 1900);
  }

  function setCurrent(i, scroll) {
    if (!marks.length) return;
    i = ((i % marks.length) + marks.length) % marks.length;
    if (marks[current]) marks[current].classList.remove('kwh-current');
    current = i;
    const el = marks[i];
    el.classList.add('kwh-current');
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    flash(markBox[i]);
    updateBar();
  }

  /* ---------- on-page UI (Shadow DOM — keeps the site CSS out) ---------- */

  const UI_CSS = `
    :host { all: initial; }
    .rail { position: fixed; top: 0; right: 0; width: 12px; height: 100vh; pointer-events: none; z-index: 2147483646; }
    .tick { position: absolute; right: 1px; width: 10px; height: 4px; border-radius: 2px; background: #ff9800;
            box-shadow: 0 0 0 1px rgba(0,0,0,.4); pointer-events: auto; cursor: pointer; }
    .tick.cur { right: 0; width: 12px; height: 7px; background: #e53935; z-index: 2; }
    .bar { position: fixed; right: 24px; bottom: 18px; z-index: 2147483647; display: flex; align-items: center; gap: 10px;
           max-width: min(600px, calc(100vw - 48px)); padding: 8px 8px 8px 14px; background: #1b2430; color: #fff;
           border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
           font: 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .q { font-weight: 700; background: #ffe14d; color: #000; padding: 1px 6px; border-radius: 4px; max-width: 150px;
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pos { font-variant-numeric: tabular-nums; font-weight: 700; white-space: nowrap; }
    .sec { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cfd6df; }
    button { all: unset; box-sizing: border-box; width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer;
             border-radius: 6px; color: #fff; background: rgba(255,255,255,.12); font-size: 12px; }
    button:hover { background: rgba(255,255,255,.25); }
    button:focus-visible { outline: 2px solid #7aa7ff; }
  `;

  function applyStyles(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(UI_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      const style = document.createElement('style');
      style.textContent = UI_CSS;
      root.prepend(style);
    }
  }

  function renderUI() {
    removeUI();
    host = document.createElement('div');
    host.id = 'kwh-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });

    const rail = document.createElement('div');
    rail.className = 'rail';

    bar = document.createElement('div');
    bar.className = 'bar';
    ['q', 'pos', 'sec'].forEach((c) => {
      const s = document.createElement('span');
      s.className = c;
      bar.appendChild(s);
    });
    [['prev', '▲', 'Previous (Shift+Enter)'], ['next', '▼', 'Next (Enter)'], ['close', '✕', 'Close']].forEach(([a, label, title]) => {
      const b = document.createElement('button');
      b.setAttribute('data-a', a);
      b.title = title;
      b.textContent = label;
      bar.appendChild(b);
    });
    bar.querySelector('.q').textContent = kws.join(', ');
    bar.addEventListener('click', (e) => {
      const a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
      if (a === 'next') setCurrent(current + 1, true);
      else if (a === 'prev') setCurrent(current - 1, true);
      else if (a === 'close') clearMarks();
    });

    root.append(rail, bar);
    applyStyles(root);
    document.documentElement.appendChild(host);
    renderRail();
  }

  function renderRail() {
    if (!host) return;
    const rail = host.shadowRoot.querySelector('.rail');
    rail.replaceChildren();
    const docH = Math.max(document.documentElement.scrollHeight, 1);
    marks.forEach((m, i) => {
      const y = m.getBoundingClientRect().top + window.scrollY;
      const t = document.createElement('div');
      t.className = 'tick' + (i === current ? ' cur' : '');
      t.style.top = Math.min(99.5, (y / docH) * 100) + '%';
      t.dataset.i = i;
      t.title = sections[markSection[i]].label;
      t.addEventListener('click', () => setCurrent(i, true));
      rail.appendChild(t);
    });
  }

  function updateBar() {
    if (!host || !bar) return;
    bar.querySelector('.pos').textContent = `${current + 1}/${marks.length}`;
    const s = sections[markSection[current]];
    let text = s ? `📍 ${s.label}${s.landmark !== 'Main content' && s.label !== s.landmark ? ' · ' + s.landmark : ''}` : '';
    if (hiddenCount) text += `  (+${hiddenCount} hidden)`;
    bar.querySelector('.sec').textContent = text;
    bar.querySelector('.sec').title = text;
    host.shadowRoot.querySelectorAll('.tick').forEach((t) => t.classList.toggle('cur', Number(t.dataset.i) === current));
  }

  function removeUI() {
    if (host) host.remove();
    host = null; bar = null;
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderRail, 200);
  });

  /* ---------- all-pages scan ---------- */

  function normUrl(href, base) {
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol) || u.origin !== location.origin) return null;
      u.hash = '';
      if (!/^\?(p|page_id|cat|product_cat|tag)=\d+$/.test(u.search)) u.search = '';
      if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
      return u.href;
    } catch (_) { return null; }
  }

  async function loadSitemaps(signal) {
    const urls = [];
    let foreign = null;
    const seenMaps = new Set();
    const toPath = (loc) => {
      try {
        const u = new URL(loc, location.origin);
        if (u.origin !== location.origin) foreign = foreign || u.origin;
        return u.pathname + u.search;
      } catch (_) { return null; }
    };
    const candidates = ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml', '/sitemap-index.xml'];
    try {
      const r = await fetch('/robots.txt', { credentials: 'same-origin', signal });
      if (r.ok) {
        (await r.text()).split(/\r?\n/).forEach((l) => {
          const m = l.match(/^\s*sitemap:\s*(\S+)/i);
          if (m) { const p = toPath(m[1]); if (p) candidates.push(p); }
        });
      }
    } catch (_) { /* no robots.txt */ }

    async function walk(path) {
      if (!path || seenMaps.has(path) || seenMaps.size >= 40 || urls.length >= SCAN_MAX_PAGES) return;
      seenMaps.add(path);
      let txt;
      try {
        const r = await fetch(path, { credentials: 'same-origin', signal });
        if (!r.ok) return;
        txt = await r.text();
      } catch (_) { return; }
      const xml = new DOMParser().parseFromString(txt, 'text/xml');
      if (xml.querySelector('parsererror')) return;
      const locs = [...xml.getElementsByTagName('loc')].map((n) => n.textContent.trim()).filter(Boolean);
      if (xml.documentElement.localName === 'sitemapindex') {
        for (const l of locs) await walk(toPath(l));
      } else {
        locs.forEach((l) => {
          const p = toPath(l);
          if (p && urls.length < SCAN_MAX_PAGES) urls.push(location.origin + p);
        });
      }
    }
    for (const c of candidates) await walk(c);
    return { urls, foreign };
  }

  function scanDoc(doc, rx, kwMap, o) {
    const found = {}, secMap = new Map(), lmCache = new Map();
    let total = 0;

    const bump = (text, label, landmark) => {
      const k = kwMap.get(canon(text, o));
      if (k === undefined) return;
      found[k] = (found[k] || 0) + 1;
      total++;
      const key = label + '|' + landmark;
      let s = secMap.get(key);
      if (!s) { s = { label, landmark, count: 0 }; secMap.set(key, s); }
      s.count++;
    };

    if (doc.title) for (const m of doc.title.matchAll(rx)) bump(m[0], 'Page title', 'Head');

    if (doc.body) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (SKIP_TAGS.has(n.tagName.toUpperCase()) || n.hasAttribute('hidden') ||
                /display\s*:\s*none/i.test(n.getAttribute('style') || '')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let head = null;
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.nodeType === 1) {
          if (/^H[1-6]$/.test(n.tagName) || n.getAttribute('role') === 'heading') {
            head = { text: clean(n.textContent), el: landmarkFrom(n).el };
          }
          continue;
        }
        const el = n.parentElement;
        if (!el) continue;
        let lm = lmCache.get(el);
        if (!lm) { lm = landmarkFrom(el); lmCache.set(el, lm); }
        for (const m of n.nodeValue.matchAll(rx)) {
          const label = head && head.text && head.el === lm.el ? head.text : (lm.name === 'Main content' ? TOP_LABEL : lm.name);
          bump(m[0], label, lm.name);
        }
      }
    }

    let attrTotal = 0;
    const attrCounts = {}, attrHits = [];
    if (o.attrs) {
      doc.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(',')).forEach((el) => {
        for (const a of ATTRS) {
          const v = el.getAttribute(a);
          if (!v) continue;
          for (const m of v.matchAll(rx)) {
            const k = kwMap.get(canon(m[0], o));
            if (k === undefined) continue;
            attrCounts[k] = (attrCounts[k] || 0) + 1;
            attrTotal++;
            const hit = `${a}="${v.length > 90 ? v.slice(0, 90) + '…' : v}"`;
            if (attrHits.length < 5 && !attrHits.includes(hit)) attrHits.push(hit);
          }
        }
      });
    }

    const secs = [...secMap.values()].sort((a, b) => b.count - a.count).slice(0, 8);
    return { total, counts: found, sections: secs, attrTotal, attrCounts, attrHits };
  }

  function snapshot() {
    if (!scan) return null;
    const { ctl, ...rest } = scan;
    return rest;
  }

  async function runScan(keywords, o) {
    if (scan && scan.running) { scan.cancelled = true; scan.ctl.abort(); }
    const ctl = new AbortController();
    const mine = scan = {
      ctl, running: true, cancelled: false, startedAt: Date.now(), finishedAt: 0,
      done: 0, total: 0, errors: 0, capped: false, foreignOrigin: null, source: 'links', error: '',
      keywords, opts: o, pages: []
    };
    try {
      const rx = buildRegex(keywords, o);
      const kwMap = new Map(keywords.map((k) => [canon(k, o), k]));
      const queue = [];
      const seen = new Set();
      const add = (href, base) => {
        const u = normUrl(href, base || location.href);
        if (!u || seen.has(u)) return;
        if (seen.size >= SCAN_MAX_PAGES) { mine.capped = true; return; }
        seen.add(u); queue.push(u); mine.total = seen.size;
      };

      add(location.origin + '/');
      add(location.href);
      const sm = await loadSitemaps(ctl.signal);
      sm.urls.forEach((u) => add(u));
      mine.foreignOrigin = sm.foreign;
      if (sm.urls.length) mine.source = 'sitemap';
      document.querySelectorAll('a[href]').forEach((a) => add(a.getAttribute('href')));

      const scanOne = async (url) => {
        let res;
        try { res = await fetch(url, { credentials: 'same-origin', signal: ctl.signal }); }
        catch (e) { if (!mine.cancelled) mine.errors++; return; }
        if (!res.ok) { mine.errors++; return; }
        let finalUrl;
        try { finalUrl = new URL(res.url); } catch (_) { return; }
        if (finalUrl.origin !== location.origin) return;
        if (!(res.headers.get('content-type') || '').includes('text/html')) return;
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const fu = normUrl(res.url);
        if (fu) seen.add(fu);
        doc.querySelectorAll('a[href]').forEach((a) => add(a.getAttribute('href'), res.url));

        const r = scanDoc(doc, rx, kwMap, o);
        if (r.total > 0 || r.attrTotal > 0) {
          mine.pages.push({
            url: res.url,
            path: decodeURIComponent(finalUrl.pathname) + finalUrl.search,
            title: clean(doc.title),
            ...r
          });
        }
      };

      let active = 0;
      const worker = async () => {
        while (!mine.cancelled) {
          const url = queue.shift();
          if (!url) { if (active === 0) return; await sleep(60); continue; }
          active++;
          try { await scanOne(url); } catch (_) { mine.errors++; } finally { active--; mine.done++; }
        }
      };
      await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    } catch (e) {
      mine.error = String(e && e.message ? e.message : e);
    } finally {
      mine.running = false;
      mine.finishedAt = Date.now();
      try { chrome.storage.local.set({ ['scan:' + location.origin]: (({ ctl: _c, ...r }) => r)(mine) }); } catch (_) { /* extension reloaded */ }
    }
  }

  /* ---------- state + messaging ---------- */

  function state(withScan) {
    const st = {
      active: kws.length > 0,
      keywords: kws,
      counts,
      opts,
      total: marks.length,
      hidden: hiddenCount,
      capped,
      current: current + 1,
      currentSection: current >= 0 ? markSection[current] : -1,
      sections: sections.map((s) => ({ index: s.index, label: s.label, landmark: s.landmark, count: s.count }))
    };
    if (withScan) st.scan = snapshot();
    return st;
  }

  function handle(msg) {
    switch (msg.type) {
      case 'search': return search(msg.keywords, msg.opts || {});
      case 'next': setCurrent(current + 1, true); return state();
      case 'prev': setCurrent(current - 1, true); return state();
      case 'goto-section': {
        const s = sections[msg.index];
        if (s) setCurrent(s.first, true);
        return state();
      }
      case 'clear': clearMarks(); return state();
      case 'status': return state(true);
      case 'scan-start': {
        const list = (msg.keywords || []).map((k) => String(k).trim()).filter(Boolean);
        if (list.length) runScan(list, msg.opts || {});
        return snapshot();
      }
      case 'scan-status': return snapshot();
      case 'scan-stop':
        if (scan && scan.running) { scan.cancelled = true; scan.ctl.abort(); }
        return snapshot();
      default: return null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (window.__kwhToken !== token) return false;   // a newer injection owns this page
    try {
      sendResponse(handle(msg));
    } catch (e) {
      try { clearMarks(); } catch (_) { /* ignore */ }
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return false;
  });
})();
