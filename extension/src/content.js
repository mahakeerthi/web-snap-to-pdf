// PageSnap PDF - content script.
// Injected on demand. Provides page preparation (lazy-load, hide fixed/sticky, isolate an
// element or the article), an element picker for "select element" / "remove elements",
// and full restoration of every temporary change.
//
// Scope notes:
// - Frames: background.js injects this file with chrome.scripting.executeScript without
//   `allFrames`, so it only runs in the top frame. Iframes are printed as Chrome renders them;
//   their fixed bars / inner scroll panes are not touched, and the picker can only select the
//   <iframe> element itself, not elements inside it.
// - Shadow DOM: the picker drills into *open* shadow roots and isolation walks the flat tree
//   (shadow hosts, slots). The page-wide scans (fixed/sticky, scroll containers, article
//   detection) only look at the light DOM of the document (or of the isolated root's own tree)
//   and do not descend into shadow roots. Closed shadow roots are opaque.
(() => {
  if (window.__pagesnapContent) return;
  window.__pagesnapContent = true;

  const UI_ATTR = 'data-pagesnap-ui';
  const ROOT_ATTR = 'data-pagesnap-root'; // marks the isolated element while the page is prepared
  // Upper bound for the page-wide scans. The scans read everything first and write afterwards
  // (no layout thrash), so ~30k elements take tens of milliseconds; the cap only guards against
  // pathological DOMs. (A 25k cap used to skip cookie banners and chat widgets, which are
  // appended at the end of <body>, on long pages.)
  const MAX_SCAN = 200000;
  const MIN_ARTICLE_SCORE = 150;

  const state = {
    undo: [], // functions that revert temporary changes (LIFO)
    removed: [], // { el, prev, prio } user removals (persist until reset / reload)
    picked: null, // element chosen with the "print element" picker
    picker: null, // active picker instance
  };

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ps:')) return false;
    Promise.resolve()
      .then(() => handle(msg))
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  });

  async function handle(msg) {
    switch (msg.type) {
      case 'ps:ping':
        return { ok: true };
      case 'ps:state':
        return {
          ok: true,
          removed: state.removed.filter((r) => r.el.isConnected).length,
          hasPicked: !!(state.picked && state.picked.isConnected),
          pickerActive: !!state.picker,
        };
      case 'ps:prepare':
        return prepare(msg);
      case 'ps:restore':
        restore();
        return { ok: true };
      case 'ps:measure':
        return { ok: true, height: measureHeight(), width: measureWidth() };
      case 'ps:start-picker':
        startPicker(msg.mode === 'remove' ? 'remove' : 'print');
        return { ok: true };
      case 'ps:stop-picker':
        stopPicker();
        return { ok: true };
      case 'ps:reset-page':
        stopPicker();
        restore();
        resetRemovals();
        state.picked = null;
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown message ' + msg.type };
    }
  }

  // ---------------------------------------------------------------------------
  // Preparation & restoration
  // ---------------------------------------------------------------------------

  async function prepare({ prep, hideFixed, loadLazy, expandScroll }) {
    stopPicker();
    restore();

    let root = null;
    if (prep === 'article') {
      root = findArticle();
      if (!root) return { ok: false, error: 'Could not detect an article on this page. Try "Select element" instead.' };
    } else if (prep === 'element') {
      root = state.picked;
      if (!root || !root.isConnected) {
        return { ok: false, error: 'No element is selected. Use "Select element" first.' };
      }
    }

    // First undo entry => runs last: the scroll position is put back only after every style
    // change has been reverted and the page has its original height again.
    rememberScroll();
    if (root) setAttr(root, ROOT_ATTR, '');
    if (loadLazy) await loadLazyContent();
    if (root) isolate(root);
    if (hideFixed) neutralizeFixed(root);
    if (expandScroll) expandScrollContainers(root);
    unlockDocument();
    scrollToInstant(0, 0);
    await nextFrame();
    await nextFrame();
    return { ok: true, title: document.title };
  }

  function restore() {
    while (state.undo.length) {
      const fn = state.undo.pop();
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  // Every change goes into a LIFO undo log and each entry restores exactly the snapshot it took,
  // so setting the same property twice on one element unwinds correctly: the later entry puts
  // back the first override, then the earlier entry puts back the page's own value.
  // Only pass *longhand* properties. For a shorthand such as `overflow`, getPropertyValue() is ''
  // when the page set a single longhand inline (e.g. `overflow-y: auto`), and removeProperty()
  // on restore would then wipe that longhand.
  function setStyle(el, prop, value) {
    const style = el.style;
    const hadAttr = el.hasAttribute('style');
    const prev = style.getPropertyValue(prop);
    const prevPrio = style.getPropertyPriority(prop);
    style.setProperty(prop, value, 'important');
    state.undo.push(() => {
      if (prev) style.setProperty(prop, prev, prevPrio);
      else style.removeProperty(prop);
      // Don't leave an empty style="" on elements that had no style attribute. Chromium syncs
      // the attribute lazily after CSSOM edits; read it first, or removeAttribute() is undone
      // by the pending sync and style="" comes back.
      if (!hadAttr && style.length === 0) {
        el.getAttribute('style');
        el.removeAttribute('style');
      }
    });
  }

  function setAttr(el, name, value) {
    const prev = el.getAttribute(name);
    el.setAttribute(name, value);
    state.undo.push(() => {
      if (prev === null) el.removeAttribute(name);
      else el.setAttribute(name, prev);
    });
  }

  function rememberScroll() {
    const x = window.scrollX;
    const y = window.scrollY;
    state.undo.push(() => scrollToInstant(x, y));
  }

  // Pages with `scroll-behavior: smooth` would otherwise animate every programmatic scroll
  // (lazy-load stepping would outrun it, and the restored position would arrive late).
  function scrollToInstant(left, top) {
    window.scrollTo({ left, top, behavior: 'instant' });
  }

  function isOurUi(el) {
    return !!(el && el.closest && el.closest(`[${UI_ATTR}]`));
  }

  // Parent in the rendered (flat) tree: slotted light-DOM nodes render inside their <slot>,
  // top-level shadow children render inside their host.
  function flatParent(n) {
    if (n.assignedSlot) return n.assignedSlot;
    if (n.parentElement) return n.parentElement;
    const p = n.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : null;
  }

  // Siblings of `n` in the flat tree (the other children of whatever renders it).
  function flatSiblings(n) {
    if (n.assignedSlot) return n.assignedSlot.assignedElements();
    const p = n.parentNode;
    return p && p.children ? Array.from(p.children) : [];
  }

  function flatAncestors(el) {
    const set = new Set();
    for (let n = el; n; n = flatParent(n)) set.add(n);
    return set;
  }

  // Hide everything that is not the root or one of its ancestors, and relax layout
  // constraints on the ancestor chain so the root can flow freely across pages.
  // Walks the flat tree, so a root inside an open shadow root or a slotted root works too.
  function isolate(root) {
    const keep = flatAncestors(root);
    for (let node = root; node && node !== document.body && node !== document.documentElement; ) {
      const parent = flatParent(node);
      if (!parent) break;
      for (const sib of flatSiblings(node)) {
        if (sib === node || keep.has(sib) || isOurUi(sib)) continue;
        if (/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT|META|TITLE|BASE)$/.test(sib.tagName)) continue;
        setStyle(sib, 'display', 'none');
      }
      relax(parent, true);
      node = parent;
    }
    relax(root, false);
    if (getComputedStyle(root).display === 'none') setStyle(root, 'display', 'block');
    if (getComputedStyle(root).visibility === 'hidden') setStyle(root, 'visibility', 'visible');
  }

  function relax(el, isAncestor) {
    if (el === document.body || el === document.documentElement) return; // see unlockDocument()
    const cs = getComputedStyle(el);
    if (cs.display === 'contents') return; // e.g. <slot>: no box of its own
    releaseOverflow(el, cs.overflowX, cs.overflowY, el.scrollWidth > el.clientWidth + 1);
    if (cs.maxHeight !== 'none') setStyle(el, 'max-height', 'none');
    if (isAncestor) {
      setStyle(el, 'height', 'auto');
      setStyle(el, 'min-height', '0');
      if (cs.position === 'fixed' || cs.position === 'sticky' || cs.position === 'absolute') {
        setStyle(el, 'position', 'static');
      }
      if (cs.transform !== 'none') setStyle(el, 'transform', 'none');
    } else if (cs.position === 'fixed' || cs.position === 'sticky') {
      setStyle(el, 'position', 'static');
    }
  }

  // Let a box grow vertically without letting wide content spill sideways.
  // `overflow-x: clip` is the only value that can be combined with `overflow-y: visible` (with
  // auto/scroll/hidden, `visible` on the other axis computes to `auto`), so a code block or wide
  // table keeps its horizontal clipping while every line becomes printable.
  function releaseOverflow(el, ox, oy, wide) {
    if (oy !== 'visible') setStyle(el, 'overflow-y', 'visible');
    const nx = wide ? 'clip' : 'visible';
    if (ox !== nx) setStyle(el, 'overflow-x', nx);
  }

  // Fixed elements repeat on every printed page; sticky ones can overlap content.
  // Small fixed elements (bars, banners, buttons) are hidden; large ones (app shells)
  // are put back into normal flow so their content still prints.
  // With an isolated root only its subtree needs scanning: everything outside the ancestor
  // chain is already display:none, and isolate() relaxed the chain itself.
  function neutralizeFixed(root) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ops = [];
    // Read phase: no writes in between, so style/layout is computed at most once.
    forEachScanned(root, (el) => {
      const cs = getComputedStyle(el);
      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') return;
      if (cs.display === 'none') return;
      if (pos === 'sticky') {
        ops.push([el, 'position', 'static']);
        return;
      }
      const r = el.getBoundingClientRect();
      const large = r.width > vw * 0.6 && r.height > vh * 0.6;
      ops.push(large ? [el, 'position', 'static'] : [el, 'display', 'none']);
    });
    // Write phase.
    for (const [el, prop, value] of ops) setStyle(el, prop, value);
  }

  // Inner scroll areas (chat apps, docs sites) would otherwise be clipped to one screen.
  function expandScrollContainers(root) {
    const vh = window.innerHeight;
    const found = [];
    // Read phase.
    forEachScanned(root, (el) => {
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      if (oy === 'visible' || cs.display === 'none' || cs.display === 'contents') return;
      const ch = el.clientHeight;
      if (el.scrollHeight <= ch + 4) return;
      if (oy === 'hidden' || oy === 'clip') {
        // Usually a deliberate crop (line-clamped teaser, thumbnail, collapsed card); only big
        // ones are treated as script-driven scroll panes.
        if (ch < vh * 0.4 || cs.webkitLineClamp !== 'none') return;
      }
      found.push({
        el,
        ox: cs.overflowX,
        oy,
        maxHeight: cs.maxHeight,
        wide: el.scrollWidth > el.clientWidth + 1,
        top: el.scrollTop,
        left: el.scrollLeft,
      });
    });
    // Write phase.
    for (const f of found) {
      const { el, top, left } = f;
      // Pushed before the style changes so it runs after they have been undone.
      if (top || left) {
        state.undo.push(() => {
          el.scrollTop = top;
          el.scrollLeft = left;
        });
      }
      releaseOverflow(el, f.ox, f.oy, f.wide);
      setStyle(el, 'height', 'auto');
      if (f.maxHeight !== 'none') setStyle(el, 'max-height', 'none');
    }
    // The panes' ancestors (e.g. an app shell with height:100vh; overflow:hidden) still clip the
    // now taller panes. Walk up from each expanded pane, nearest ancestor first, and release
    // every ancestor whose content no longer fits. isolate() already relaxed the root's chain.
    const relaxed = root ? flatAncestors(root) : new Set();
    relaxed.delete(root);
    const visited = new Set();
    for (const { el } of found) {
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        if (visited.has(a) || relaxed.has(a)) break;
        visited.add(a);
        if (a.scrollHeight <= a.clientHeight + 4) continue;
        const cs = getComputedStyle(a);
        if (cs.display === 'contents') continue;
        releaseOverflow(a, cs.overflowX, cs.overflowY, a.scrollWidth > a.clientWidth + 1);
        setStyle(a, 'height', 'auto');
        if (cs.maxHeight !== 'none') setStyle(a, 'max-height', 'none');
      }
    }
  }

  function forEachScanned(root, fn) {
    const list = (root || document.body).getElementsByTagName('*');
    const n = Math.min(list.length, MAX_SCAN);
    for (let i = 0; i < n; i++) fn(list[i]);
  }

  // Scroll locks (`body { position: fixed; inset: 0; overflow: auto }` for modals / iOS, app
  // shells) would otherwise limit the printout to one viewport.
  function unlockDocument() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        releaseOverflow(el, cs.overflowX, cs.overflowY, el.scrollWidth > el.clientWidth + 1);
      }
      if (cs.position === 'fixed' || cs.position === 'sticky' || cs.position === 'absolute') {
        setStyle(el, 'position', 'static');
      }
      if (cs.transform !== 'none') setStyle(el, 'transform', 'none');
      setStyle(el, 'height', 'auto');
      setStyle(el, 'max-height', 'none');
    }
  }

  // ---------------------------------------------------------------------------
  // Lazy content
  // ---------------------------------------------------------------------------

  async function loadLazyContent() {
    // loading="lazy" -> "eager" is on the undo log (restored). Sources copied from data-src /
    // data-srcset are intentionally kept: the page's own lazy loader would do the same, and
    // reverting them would only make the images disappear again.
    for (const el of document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]')) {
      setAttr(el, 'loading', 'eager');
    }
    for (const img of document.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]')) {
      const src = img.dataset.src || img.dataset.lazySrc || img.dataset.original;
      const cur = img.getAttribute('src') || '';
      if (src && (!cur || cur.startsWith('data:'))) img.src = src;
    }
    for (const img of document.querySelectorAll('img[data-srcset]')) {
      if (!img.getAttribute('srcset')) img.srcset = img.dataset.srcset;
    }

    const startY = window.scrollY;
    const step = Math.max(200, Math.floor(window.innerHeight * 0.85));
    let y = 0;
    let iterations = 0;
    while (y < document.documentElement.scrollHeight && iterations < 250) {
      scrollToInstant(0, y);
      await sleep(50);
      y += step;
      iterations++;
    }
    scrollToInstant(0, document.documentElement.scrollHeight);
    await sleep(150);
    scrollToInstant(0, startY);

    const pending = Array.from(document.images).filter((i) => !i.complete);
    await Promise.race([Promise.all(pending.map(imageSettled)), sleep(6000)]);
    await sleep(100);
  }

  function imageSettled(img) {
    return new Promise((resolve) => {
      if (img.complete) return resolve();
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }

  // ---------------------------------------------------------------------------
  // Article detection
  // ---------------------------------------------------------------------------

  const ARTICLE_SELECTORS = [
    'article',
    'main',
    '[role="main"]',
    '[itemprop="articleBody"]',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.article-body',
    '.post-body',
    '.story-body',
    '.markdown-body',
    '#content',
    '.content',
    '#main',
    '.main',
  ];
  const BLOCK_SEL = 'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, dd, figcaption';
  // Boilerplate containers: their text never counts towards an enclosing candidate, so a <main>
  // holding article + comments (or nav + article + toc) scores like the article alone.
  const NOISE_SEL =
    'nav, aside, footer, form, [role="navigation"], [role="complementary"], [role="contentinfo"], [aria-hidden="true"]';
  // Whole id / class tokens only (a substring match like [class*="comment"] would also hit
  // wrappers such as <body class="has-comments"> and wipe out the whole page).
  const NOISE_TOKEN =
    /^(comments?|comment-list|commentlist|comments-area|comment-section|disqus_thread|discussion|responses|sidebar|side-bar|related|related-posts|share|sharing|social|social-share|newsletter|subscribe|breadcrumbs?|toc|table-of-contents|site-header|site-footer)$/i;

  function findArticle() {
    const { score, blocks } = textScore();

    const choose = (candidates) => {
      const list = [];
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        const s = score.get(el) || 0;
        if (s < MIN_ARTICLE_SCORE || isOurUi(el) || !isVisible(el)) continue;
        list.push(el);
        if (s > bestScore) {
          bestScore = s;
          best = el;
        }
      }
      return best ? { el: tighten(best, list, score, blocks), score: bestScore } : null;
    };

    const semantic = new Set();
    for (const sel of ARTICLE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) semantic.add(el);
    }
    const hit = choose(semantic);
    if (hit) return hit.el;
    // No usable semantic container (div-only markup, or only a tiny ".content" widget): fall back
    // to generic block containers.
    const generic = choose(document.body.querySelectorAll('div, section, td'));
    return generic ? generic.el : null;
  }

  // Prefer the tightest container that still holds ~all of the article (>= 90% of the best
  // score), but never shrink to something that drops the headline or most of the text blocks
  // (e.g. `.entry-content` without the <h1>, or the wrapper of one huge code listing).
  function tighten(best, list, score, blocks) {
    const bestScore = score.get(best) || 0;
    const bestBlocks = blocks.get(best) || 0;
    const title = Array.from(best.querySelectorAll('h1')).find((h) => isVisible(h)) || null;
    let pick = best;
    let pickLen = (best.textContent || '').length;
    for (const c of list) {
      if (c === best || !best.contains(c)) continue;
      if ((score.get(c) || 0) < bestScore * 0.9) continue;
      if ((blocks.get(c) || 0) < bestBlocks * 0.5) continue;
      if (title && !c.contains(title)) continue;
      const len = (c.textContent || '').length;
      if (len < pickLen) {
        pick = c;
        pickLen = len;
      }
    }
    return pick;
  }

  // One pass over the document's text instead of a subtree query per candidate (which was
  // quadratic on div-only pages). Each text node adds its length to its ancestors if it sits in a
  // text block, and subtracts 1.5x its length if it is link text; the accumulation stops at the
  // nearest boilerplate container, so e.g. comments count for the comment list but not for the
  // <main> around it.
  function textScore() {
    const score = new Map();
    const blocks = new Map();
    const noiseCache = new Map();
    const isNoise = (el) => {
      let v = noiseCache.get(el);
      if (v === undefined) {
        v = el.matches(NOISE_SEL) || (!!el.id && NOISE_TOKEN.test(el.id));
        if (!v) for (const c of el.classList) if (NOISE_TOKEN.test(c)) { v = true; break; }
        noiseCache.set(el, v);
      }
      return v;
    };
    const bump = (from, map, delta) => {
      for (let a = from; a && a !== document.documentElement; a = a.parentElement) {
        if (isNoise(a)) return;
        map.set(a, (map.get(a) || 0) + delta);
      }
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n = 0;
    for (let t = walker.nextNode(); t && n < MAX_SCAN; t = walker.nextNode(), n++) {
      const parent = t.parentElement;
      if (!parent) continue;
      const len = t.data.trim().length;
      if (!len) continue;
      const v = (parent.closest(BLOCK_SEL) ? len : 0) - (parent.closest('a') ? len * 1.5 : 0);
      if (v) bump(parent, score, v);
    }
    for (const b of document.body.querySelectorAll(BLOCK_SEL)) bump(b, blocks, 1);
    return { score, blocks };
  }

  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------------------------------------------------------------------------
  // Measurement
  // ---------------------------------------------------------------------------

  function measureHeight() {
    const d = document.documentElement;
    const b = document.body;
    return Math.max(d.scrollHeight, d.offsetHeight, b ? b.scrollHeight : 0, b ? b.offsetHeight : 0);
  }

  function measureWidth() {
    const d = document.documentElement;
    return Math.max(d.scrollWidth, d.clientWidth);
  }

  // ---------------------------------------------------------------------------
  // Element picker (select to print / remove)
  // ---------------------------------------------------------------------------

  // The host is `position: fixed` with `all: initial` inline (inline beats page CSS and the
  // :host rule), so it has no transform/filter/contain and its fixed-position shadow children
  // are positioned against the viewport; highlight coordinates come straight from
  // getBoundingClientRect() and are refreshed on every scroll.
  const PICKER_CSS = `
    :host { all: initial; }
    .hl { position: fixed; pointer-events: none; z-index: 2147483646; box-sizing: border-box;
          border: 2px solid #2563eb; background: rgba(37, 99, 235, 0.12); border-radius: 3px;
          transition: all 40ms linear; display: none; }
    .hl.remove { border-color: #dc2626; background: rgba(220, 38, 38, 0.12); }
    .tag { position: absolute; left: -2px; top: -22px; background: #2563eb; color: #fff; font: 11px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
           padding: 1px 6px; border-radius: 3px 3px 0 0; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
    .hl.remove .tag { background: #dc2626; }
    .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
           display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; background: #111827; color: #f9fafb;
           font: 13px/1.4 -apple-system, Segoe UI, Roboto, sans-serif; border-radius: 10px;
           box-shadow: 0 8px 24px rgba(0,0,0,0.35); pointer-events: auto; max-width: calc(100vw - 32px); }
    .bar b { font-weight: 600; }
    .bar .hint { color: #9ca3af; }
    .bar button { all: initial; cursor: pointer; font: 600 12px/1 -apple-system, Segoe UI, Roboto, sans-serif; color: #f9fafb;
                  background: #374151; padding: 7px 10px; border-radius: 6px; }
    .bar button:hover { background: #4b5563; }
    .bar button.primary { background: #2563eb; }
    .bar button.primary:hover { background: #1d4ed8; }
    .bar button.danger { background: #dc2626; }
    .count { background: #dc2626; color: #fff; border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 700; }
  `;

  // Pointer/mouse events that could trigger page behaviour (navigation on mousedown/pointerdown,
  // middle-click "open in new tab" via auxclick, dblclick handlers). `click` has its own handler.
  // `contextmenu` is left alone so the browser (and this extension's) context menu still works.
  const SWALLOWED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick'];

  function startPicker(mode) {
    stopPicker();
    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PICKER_CSS;
    shadow.appendChild(style);

    const hl = document.createElement('div');
    hl.className = 'hl' + (mode === 'remove' ? ' remove' : '');
    const tag = document.createElement('div');
    tag.className = 'tag';
    hl.appendChild(tag);
    shadow.appendChild(hl);

    const bar = document.createElement('div');
    bar.className = 'bar';
    shadow.appendChild(bar);

    const p = { mode, host, hl, tag, bar, current: null };
    state.picker = p;
    renderBar(p);

    p.onMove = (ev) => {
      const el = elementAt(ev.clientX, ev.clientY);
      if (el) setCurrent(p, el);
    };
    p.onClick = (ev) => {
      if (isOurUi(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      // Keep a selection widened with the arrow keys; only hit-test when nothing is selected
      // (e.g. a click without any preceding mouse movement).
      if (!p.current || !p.current.isConnected) p.current = elementAt(ev.clientX, ev.clientY);
      if (p.current) pick(p, p.current);
    };
    p.onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        stopPicker();
      } else if (ev.key === 'ArrowUp' && p.current) {
        ev.preventDefault();
        ev.stopPropagation();
        const parent = flatParent(p.current);
        // Never widen to <body>/<html>: removing or printing those is never what the user wants.
        if (parent && pickable(parent)) setCurrent(p, parent);
      } else if (ev.key === 'ArrowDown' && p.current) {
        ev.preventDefault();
        ev.stopPropagation();
        const kids = (p.current.shadowRoot || p.current).children;
        const child = Array.from(kids).find((c) => pickable(c) && isVisible(c));
        if (child) setCurrent(p, child);
      }
    };
    p.onScroll = () => positionHighlight(p);
    p.swallow = (ev) => {
      if (!isOurUi(ev.target)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };

    // Window capture listeners run before any listener the page registered on document or on
    // elements, so page handlers (client-side routers, shortcut managers) never see the events.
    window.addEventListener('mousemove', p.onMove, true);
    window.addEventListener('click', p.onClick, true);
    for (const type of SWALLOWED_EVENTS) window.addEventListener(type, p.swallow, true);
    window.addEventListener('keydown', p.onKey, true);
    window.addEventListener('scroll', p.onScroll, true);
    window.addEventListener('resize', p.onScroll);
    document.documentElement.appendChild(host);
  }

  function stopPicker() {
    const p = state.picker;
    if (!p) return;
    window.removeEventListener('mousemove', p.onMove, true);
    window.removeEventListener('click', p.onClick, true);
    for (const type of SWALLOWED_EVENTS) window.removeEventListener(type, p.swallow, true);
    window.removeEventListener('keydown', p.onKey, true);
    window.removeEventListener('scroll', p.onScroll, true);
    window.removeEventListener('resize', p.onScroll);
    p.host.remove();
    state.picker = null;
  }

  function pickable(el) {
    return !!el && el.nodeType === 1 && el !== document.documentElement && el !== document.body && !isOurUi(el);
  }

  // Hit-test that looks inside open shadow roots (document.elementFromPoint stops at the host).
  function elementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    if (!el || isOurUi(el)) return null;
    for (let depth = 0; el && el.shadowRoot && depth < 32; depth++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return pickable(el) ? el : null;
  }

  function setCurrent(p, el) {
    p.current = el;
    p.tag.textContent = describe(el);
    positionHighlight(p);
  }

  function positionHighlight(p) {
    if (!p.current || !p.current.isConnected) {
      p.hl.style.display = 'none';
      return;
    }
    const r = p.current.getBoundingClientRect();
    Object.assign(p.hl.style, {
      display: 'block',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    });
    p.tag.style.top = r.top < 24 ? '0' : '-22px';
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    const r = el.getBoundingClientRect();
    return `${s}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function renderBar(p) {
    const bar = p.bar;
    bar.textContent = '';
    const btn = (label, cls, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onClick();
      });
      return b;
    };
    const text = document.createElement('span');
    if (p.mode === 'remove') {
      const n = state.removed.filter((r) => r.el.isConnected).length;
      text.innerHTML =
        '<b>Remove elements</b> <span class="hint">· click anything to remove it · ↑/↓ widen or narrow · Esc when done</span>';
      bar.appendChild(text);
      if (n) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(n);
        bar.appendChild(c);
      }
      bar.appendChild(btn('Undo', '', () => undoRemoval(p)));
      bar.appendChild(
        btn('Save PDF', 'primary', () => {
          stopPicker();
          chrome.runtime.sendMessage({ type: 'ps:generate-from-content', prep: 'none' }).catch(() => {});
        }),
      );
      bar.appendChild(btn('Done', '', () => stopPicker()));
    } else {
      text.innerHTML =
        '<b>Select element</b> <span class="hint">· click the part of the page to save · ↑/↓ widen or narrow · Esc to cancel</span>';
      bar.appendChild(text);
      bar.appendChild(btn('Cancel', '', () => stopPicker()));
    }
  }

  function pick(p, el) {
    if (!pickable(el) || !el.isConnected) return; // never <html>, <body> or our own UI
    if (p.mode === 'remove') {
      state.removed.push({
        el,
        prev: el.style.getPropertyValue('display'),
        prio: el.style.getPropertyPriority('display'),
      });
      el.style.setProperty('display', 'none', 'important');
      p.current = null;
      p.hl.style.display = 'none';
      renderBar(p);
    } else {
      state.picked = el;
      stopPicker();
      chrome.runtime.sendMessage({ type: 'ps:generate-from-content', prep: 'element' }).catch(() => {});
    }
  }

  function undoRemoval(p) {
    const r = state.removed.pop();
    if (r) restoreRemoval(r);
    if (p) renderBar(p);
  }

  function restoreRemoval(r) {
    if (r.prev) r.el.style.setProperty('display', r.prev, r.prio);
    else r.el.style.removeProperty('display');
  }

  function resetRemovals() {
    while (state.removed.length) restoreRemoval(state.removed.pop());
  }

  // ---------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }
})();
