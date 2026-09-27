// PageSnap PDF - content script.
// Injected on demand. Provides page preparation (lazy-load, hide fixed/sticky, isolate an
// element or the article), an element picker for "select element" / "remove elements",
// the element preview modal (PDF / PNG / JPEG / Markdown export), an HTML -> Markdown converter,
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
  const OUT_OF_FLOW = /^(fixed|sticky|absolute)$/; // positions taken out of the printable flow

  const state = {
    undo: [], // functions that revert temporary changes (LIFO)
    removed: [], // { el, prev, prio } user removals (persist until reset / reload)
    picked: null, // element chosen with the "print element" picker
    picker: null, // active picker instance
    preview: null, // open element preview modal
    ignoreNextPreview: false, // the modal was closed while its preview was still being captured
    strings: {}, // UI strings from the background (English fallbacks merged with translations)
    theme: 'system', // light | dark | system
  };

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ps:')) return false;
    Promise.resolve()
      .then(() => handle(msg))
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: errorText(err) }));
    return true;
  });

  function handle(msg) {
    switch (msg.type) {
      case 'ps:ping':
        return { ok: true };
      case 'ps:state':
        return {
          ok: true,
          removed: state.removed.filter((r) => r.el.isConnected).length,
          hasPicked: !!(state.picked && state.picked.isConnected),
          pickerActive: !!state.picker,
          previewOpen: !!state.preview,
        };
      case 'ps:prepare':
        return prepare(msg);
      case 'ps:restore':
        restore();
        return { ok: true };
      case 'ps:measure':
        return { ok: true, height: measureHeight(), width: measureWidth() };
      case 'ps:start-picker':
        setUi(msg);
        closePreview();
        state.ignoreNextPreview = false;
        startPicker(msg.mode === 'remove' ? 'remove' : 'print');
        return { ok: true };
      case 'ps:picked-rect':
        return pickedRect();
      case 'ps:show-preview':
        setUi(msg);
        showPreview(msg);
        return { ok: true };
      case 'ps:cancel-preview':
        closePreview();
        return { ok: true };
      case 'ps:to-markdown':
        return toMarkdown(msg.prep);
      case 'ps:reset-page':
        stopPicker();
        closePreview();
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

    const { root, error } = prepRoot(prep);
    if (error) return { ok: false, error };

    // First undo entry => runs last: the scroll position is put back only after every style
    // change has been reverted and the page has its original height again.
    rememberScroll();
    // The preview modal is a full-viewport fixed overlay outside <body>: it must not end up in
    // the PDF or in a screenshot. Shown again by restore().
    if (state.preview) setStyle(state.preview.host, 'display', 'none');
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

  // The element a prep mode works on: the detected article, the picked element, or null for the
  // whole page. Returns { error } when there is none.
  function prepRoot(prep) {
    if (prep === 'article') {
      const root = findArticle();
      return root
        ? { root }
        : { error: 'Could not detect an article on this page. Try "Select element" instead.' };
    }
    if (prep === 'element') {
      const root = state.picked;
      return root && root.isConnected
        ? { root }
        : { error: 'No element is selected. Use "Select element" first.' };
    }
    return { root: null };
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
    for (let node = root; node && node !== document.body && node !== document.documentElement;) {
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
    releaseOverflow(el, cs.overflowX, cs.overflowY, isWide(el));
    if (cs.maxHeight !== 'none') setStyle(el, 'max-height', 'none');
    if (isAncestor) {
      setStyle(el, 'height', 'auto');
      setStyle(el, 'min-height', '0');
      if (OUT_OF_FLOW.test(cs.position)) setStyle(el, 'position', 'static');
      if (cs.transform !== 'none') setStyle(el, 'transform', 'none');
    } else if (cs.position === 'fixed' || cs.position === 'sticky') {
      setStyle(el, 'position', 'static');
    }
  }

  // Content wider than the box (a code block or table that scrolls sideways).
  function isWide(el) {
    return el.scrollWidth > el.clientWidth + 1;
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
      found.push({ el, box: boxOf(el, cs), top: el.scrollTop, left: el.scrollLeft });
    });
    // Write phase.
    for (const { el, box, top, left } of found) {
      // Pushed before the style changes so it runs after they have been undone.
      if (top || left) {
        state.undo.push(() => {
          el.scrollTop = top;
          el.scrollLeft = left;
        });
      }
      growBox(el, box);
    }
    // The panes' ancestors (e.g. an app shell with height:100vh; overflow:hidden) still clip the
    // now taller panes. Walk up from each expanded pane, nearest ancestor first, and release
    // every ancestor whose content no longer fits. isolate() already relaxed the root's chain.
    const relaxed = root ? flatAncestors(root) : new Set();
    relaxed.delete(root);
    const visited = new Set();
    for (const { el } of found) {
      for (
        let a = el.parentElement;
        a && a !== document.body && a !== document.documentElement;
        a = a.parentElement
      ) {
        if (visited.has(a) || relaxed.has(a)) break;
        visited.add(a);
        if (a.scrollHeight <= a.clientHeight + 4) continue;
        const cs = getComputedStyle(a);
        if (cs.display === 'contents') continue;
        growBox(a, boxOf(a, cs));
      }
    }
  }

  // Computed overflow / max-height of a box, read before any write.
  function boxOf(el, cs) {
    return { ox: cs.overflowX, oy: cs.overflowY, maxHeight: cs.maxHeight, wide: isWide(el) };
  }

  // Let a box take the full height of its content.
  function growBox(el, { ox, oy, maxHeight, wide }) {
    releaseOverflow(el, ox, oy, wide);
    setStyle(el, 'height', 'auto');
    if (maxHeight !== 'none') setStyle(el, 'max-height', 'none');
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
        releaseOverflow(el, cs.overflowX, cs.overflowY, isWide(el));
      }
      if (OUT_OF_FLOW.test(cs.position)) setStyle(el, 'position', 'static');
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
    let tightest = best;
    let tightestLen = (best.textContent || '').length;
    for (const c of list) {
      if (c === best || !best.contains(c)) continue;
      if ((score.get(c) || 0) < bestScore * 0.9) continue;
      if ((blocks.get(c) || 0) < bestBlocks * 0.5) continue;
      if (title && !c.contains(title)) continue;
      const len = (c.textContent || '').length;
      if (len < tightestLen) {
        tightest = c;
        tightestLen = len;
      }
    }
    return tightest;
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
        if (!v)
          for (const c of el.classList)
            if (NOISE_TOKEN.test(c)) {
              v = true;
              break;
            }
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

  // Shadow-DOM container for our in-page UI (picker, preview modal), marked with UI_ATTR so the
  // page scans, isolation and the Markdown converter skip it. Not attached to the document yet.
  function createUiHost(uiAttrValue, css) {
    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, uiAttrValue);
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
    return { host, shadow };
  }

  // Pointer/mouse events that could trigger page behaviour (navigation on mousedown/pointerdown,
  // middle-click "open in new tab" via auxclick, dblclick handlers). `click` has its own handler.
  // `contextmenu` is left alone so the browser (and this extension's) context menu still works.
  const SWALLOWED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick'];

  function startPicker(mode) {
    stopPicker();
    const { host, shadow } = createUiHost('', PICKER_CSS);

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
    for (const [type, fn, capture] of pickerListeners(p)) window.addEventListener(type, fn, capture);
    document.documentElement.appendChild(host);
  }

  function stopPicker() {
    const p = state.picker;
    if (!p) return;
    for (const [type, fn, capture] of pickerListeners(p)) window.removeEventListener(type, fn, capture);
    p.host.remove();
    state.picker = null;
  }

  // [type, handler, capture] for every window listener of an active picker.
  function pickerListeners(p) {
    return [
      ['mousemove', p.onMove, true],
      ['click', p.onClick, true],
      ...SWALLOWED_EVENTS.map((type) => [type, p.swallow, true]),
      ['keydown', p.onKey, true],
      ['scroll', p.onScroll, true],
      ['resize', p.onScroll, false],
    ];
  }

  function pickable(el) {
    return (
      !!el && el.nodeType === 1 && el !== document.documentElement && el !== document.body && !isOurUi(el)
    );
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

  function describeTag(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (typeof el.className === 'string' ? el.className : '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return `${describeTag(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
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
    // Built with DOM nodes (no innerHTML): pages that enforce Trusted Types reject HTML strings.
    const text = document.createElement('span');
    const title = document.createElement('b');
    const hint = document.createElement('span');
    hint.className = 'hint';
    text.append(title, ' ', hint);
    if (p.mode === 'remove') {
      const n = state.removed.filter((r) => r.el.isConnected).length;
      title.textContent = str('picker_titleRemove');
      hint.textContent = '· ' + str('picker_hintRemove');
      bar.appendChild(text);
      if (n) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(n);
        c.title = str('picker_removedCount', [n]);
        bar.appendChild(c);
      }
      bar.appendChild(btn(str('picker_undo'), '', () => undoRemoval(p)));
      bar.appendChild(
        btn(str('picker_savePdf'), 'primary', () => {
          stopPicker();
          chrome.runtime.sendMessage({ type: 'ps:generate-from-content', prep: 'none' }).catch(() => {});
        }),
      );
      bar.appendChild(btn(str('picker_done'), '', () => stopPicker()));
    } else {
      title.textContent = str('picker_titleSelect');
      hint.textContent = '· ' + str('picker_hintSelect');
      bar.appendChild(text);
      bar.appendChild(btn(str('picker_cancel'), '', () => stopPicker()));
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
      requestPreview();
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
  // Element preview modal
  // ---------------------------------------------------------------------------

  function setUi(msg) {
    if (msg.strings && typeof msg.strings === 'object') state.strings = msg.strings;
    if (msg.theme) state.theme = msg.theme;
  }

  // UI string from the background, with $1..$n substitutions. A missing key shows the key itself.
  function str(key, subs = []) {
    let s = state.strings[key] || key;
    subs.forEach((v, i) => {
      s = s.replace(new RegExp(`\\$${i + 1}(?![0-9])`, 'g'), () => String(v));
    });
    return s;
  }

  function resolvedTheme() {
    if (state.theme === 'dark' || state.theme === 'light') return state.theme;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  // Document-relative box of the picked element, rounded outwards to whole CSS pixels
  // (Page.captureScreenshot clip coordinates are document-relative with captureBeyondViewport).
  function pickedRect() {
    const el = state.picked;
    if (!el || !el.isConnected) return { ok: false, error: str('picker_errorNoElement') };
    const r = el.getBoundingClientRect();
    const left = Math.floor(r.left + window.scrollX);
    const top = Math.floor(r.top + window.scrollY);
    const right = Math.ceil(r.right + window.scrollX);
    const bottom = Math.ceil(r.bottom + window.scrollY);
    return {
      ok: true,
      x: Math.max(0, left),
      y: Math.max(0, top),
      width: right - Math.max(0, left),
      height: bottom - Math.max(0, top),
      devicePixelRatio: window.devicePixelRatio || 1,
      description: describeTag(el),
    };
  }

  const PREVIEW_CSS = `
    :host { all: initial; }
    .overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
               padding: 16px; box-sizing: border-box; background: rgba(15, 23, 42, 0.55);
               font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg);
               --bg: #ffffff; --fg: #111827; --muted: #6b7280; --border: #e5e7eb; --stage: #f3f4f6; --check: #e5e7eb;
               --seg: #f3f4f6; --seg-on: #ffffff; --ghost: #f3f4f6; --ghost-hover: #e5e7eb; --accent: #2563eb;
               --accent-hover: #1d4ed8; --warn: #92400e; --warn-bg: #fef3c7; --error: #b91c1c; --ok: #15803d; }
    .overlay.dark { --bg: #1f2937; --fg: #f9fafb; --muted: #9ca3af; --border: #374151; --stage: #111827; --check: #1f2937;
                    --seg: #111827; --seg-on: #374151; --ghost: #374151; --ghost-hover: #4b5563; --accent: #3b82f6;
                    --accent-hover: #2563eb; --warn: #fcd34d; --warn-bg: #422006; --error: #fca5a5; --ok: #86efac;
                    background: rgba(0, 0, 0, 0.65); }
    .dialog { background: var(--bg); color: var(--fg); border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.35);
              width: min(920px, 100%); max-height: 100%; display: flex; flex-direction: column; overflow: hidden;
              border: 1px solid var(--border); box-sizing: border-box; }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 18px; border-bottom: 1px solid var(--border); }
    h2 { all: unset; flex: 1; font-size: 15px; font-weight: 600; }
    .stage { flex: 1 1 auto; min-height: 120px; max-height: 70vh; overflow: auto; overscroll-behavior: contain;
             background-color: var(--stage);
             background-image: conic-gradient(var(--check) 25%, transparent 0 50%, var(--check) 0 75%, transparent 0);
             background-size: 16px 16px; display: flex; align-items: flex-start; justify-content: center; padding: 16px;
             box-sizing: border-box; }
    .stage .shot { display: block; max-width: 100%; height: auto; box-shadow: 0 1px 4px rgba(0,0,0,0.25); background: #fff; }
    .placeholder { align-self: center; color: var(--muted); padding: 32px 8px; text-align: center; }
    .placeholder.error { color: var(--error); }
    .meta { padding: 10px 18px 0; display: flex; flex-direction: column; gap: 6px; }
    .caption { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .warning { color: var(--warn); background: var(--warn-bg); border-radius: 6px; padding: 6px 10px; font-size: 12px; }
    footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 18px 16px; }
    .seg { display: inline-flex; margin-right: auto; background: var(--seg); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
    .seg button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 12px; color: var(--muted); }
    .seg button[aria-checked="true"] { background: var(--seg-on); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
    .status { order: 10; flex: 1 0 100%; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .status:empty { display: none; }
    .status.error { color: var(--error); }
    .status.ok { color: var(--ok); }
    .btn { all: unset; cursor: pointer; font-weight: 600; font-size: 13px; padding: 8px 14px; border-radius: 8px;
           background: var(--ghost); color: var(--fg); white-space: nowrap; }
    .btn:hover { background: var(--ghost-hover); }
    .btn.primary { background: var(--accent); color: #fff; }
    .btn.primary:hover { background: var(--accent-hover); }
    .btn.icon { padding: 4px 10px; font-size: 18px; line-height: 1; background: transparent; color: var(--muted); }
    .btn.icon:hover { background: var(--ghost); color: var(--fg); }
    .btn[disabled], .seg button[disabled] { opacity: 0.5; cursor: default; pointer-events: none; }
    .btn:focus-visible, .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    [hidden] { display: none !important; }
  `;

  const PREVIEW_KEY_EVENTS = ['keydown', 'keyup', 'keypress'];

  function make(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  // Build (or reuse) the modal; a new one shows a loading placeholder until ps:show-preview arrives.
  function openPreview() {
    if (state.preview) return state.preview;
    const { host, shadow } = createUiHost('preview', PREVIEW_CSS);

    const title = make('h2', { id: 'ps-title', text: str('preview_title') });
    const close = make('button', {
      className: 'btn icon close',
      type: 'button',
      'aria-label': str('preview_close'),
      title: str('preview_close'),
      text: '×',
    });
    const stage = make('div', { className: 'stage' });
    const caption = make('div', { className: 'caption' });
    const warning = make('div', { className: 'warning', role: 'note' });
    warning.hidden = true;
    const seg = make('div', { className: 'seg', role: 'radiogroup', 'aria-label': str('preview_format') });
    const status = make('div', { className: 'status', role: 'status', 'aria-live': 'polite' });
    const reselect = make('button', {
      className: 'btn reselect',
      type: 'button',
      text: str('preview_reselect'),
    });
    const copy = make('button', { className: 'btn copy', type: 'button', text: str('preview_copyImage') });
    const download = make('button', {
      className: 'btn primary download',
      type: 'button',
      text: str('preview_download'),
    });
    const dialog = make(
      'div',
      { className: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ps-title' },
      make('header', {}, title, close),
      stage,
      make('div', { className: 'meta' }, caption, warning),
      make('footer', {}, seg, status, reselect, copy, download),
    );
    const overlay = make(
      'div',
      { className: 'overlay' + (resolvedTheme() === 'dark' ? ' dark' : '') },
      dialog,
    );
    shadow.append(overlay);

    const m = {
      host,
      overlay,
      stage,
      caption,
      warning,
      seg,
      status,
      copy,
      download,
      reselect,
      busy: false,
      data: null,
      format: 'pdf',
    };
    state.preview = m;

    close.addEventListener('click', () => closePreview());
    reselect.addEventListener('click', () => {
      closePreview();
      startPicker('print');
    });
    download.addEventListener('click', () => previewDownload(m));
    copy.addEventListener('click', () => previewCopy(m));
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay && !m.busy) closePreview();
    });
    // Escape is caught on window in the capture phase, before any page handler can swallow it.
    m.onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closePreview();
    };
    window.addEventListener('keydown', m.onKey, true);
    // Other keys typed in the modal (arrows in the format control, Enter/Space on buttons) are not
    // passed on to the page's own bubbling key handlers.
    for (const type of PREVIEW_KEY_EVENTS) overlay.addEventListener(type, (ev) => ev.stopPropagation());
    document.documentElement.appendChild(host);
    setPreviewLoading(m);
    return m;
  }

  function closePreview() {
    const m = state.preview;
    if (!m) return;
    if (m.loading) state.ignoreNextPreview = true;
    window.removeEventListener('keydown', m.onKey, true);
    m.host.remove();
    state.preview = null;
  }

  // Replace the preview image with a message; nothing can be exported meanwhile.
  function showPlaceholder(m, className, text) {
    m.stage.replaceChildren(make('div', { className, text }));
    renderFormats(m, { formats: [] });
    m.download.disabled = true;
    m.copy.hidden = true;
  }

  function setPreviewLoading(m) {
    showPlaceholder(m, 'placeholder', str('preview_loading'));
    m.caption.textContent = '';
    m.data = null;
    m.loading = true;
  }

  function showPreviewError(message) {
    const m = openPreview();
    m.loading = false;
    showPlaceholder(m, 'placeholder error', message || str('preview_errorCapture'));
    m.reselect.focus();
  }

  // Click in "select element" mode: open the modal in its loading state and ask the background
  // to capture the element (it answers with ps:show-preview).
  function requestPreview() {
    state.ignoreNextPreview = false;
    const m = openPreview();
    const fail = (error) => {
      if (state.preview === m && m.loading) showPreviewError(error || str('preview_errorCapture'));
    };
    chrome.runtime
      .sendMessage({ type: 'ps:preview-element' })
      .then((res) => {
        if (!res || !res.ok) fail(res && res.error);
      })
      .catch((err) => fail(errorText(err)));
  }

  function showPreview(msg) {
    if (!state.preview && state.ignoreNextPreview) {
      state.ignoreNextPreview = false;
      return;
    }
    const m = openPreview();
    m.loading = false;
    m.overlay.classList.toggle('dark', resolvedTheme() === 'dark');
    m.data = msg;
    m.busy = false;
    // Drawn on a canvas rather than an <img src="data:...">: the image element would be subject
    // to the page's Content-Security-Policy (img-src), createImageBitmap is not.
    const canvas = make('canvas', { className: 'shot', role: 'img', 'aria-label': str('preview_imageAlt') });
    // Displayed at the element's CSS size (the capture is at screen resolution), shrunk to fit.
    canvas.style.width = Math.max(1, Math.round(msg.width)) + 'px';
    m.stage.replaceChildren(canvas);
    createImageBitmap(dataUrlToBlob(msg.dataUrl))
      .then((bmp) => {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        canvas.dataset.ready = 'true';
      })
      .catch(() => showPreviewError(str('preview_errorCapture')));
    m.stage.scrollTop = 0;
    m.caption.textContent = str('preview_caption', [
      msg.description || 'element',
      Math.round(msg.width),
      Math.round(msg.height),
    ]);
    const formats = ['pdf', 'png', 'jpeg'];
    if (msg.markdownEnabled) formats.push('markdown');
    renderFormats(m, { formats, selected: formats.includes(msg.format) ? msg.format : 'pdf' });
    m.download.disabled = false;
    setStatus(m, '');
    m.download.focus();
  }

  const FORMAT_LABELS = {
    pdf: 'preview_formatPdf',
    png: 'preview_formatPng',
    jpeg: 'preview_formatJpeg',
    markdown: 'preview_formatMarkdown',
  };

  function renderFormats(m, { formats, selected = 'pdf' }) {
    m.seg.replaceChildren();
    m.seg.hidden = !formats.length;
    for (const f of formats) {
      const b = make('button', {
        type: 'button',
        role: 'radio',
        'data-format': f,
        text: str(FORMAT_LABELS[f]),
      });
      b.addEventListener('click', () => selectFormat(m, f));
      b.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const i = formats.indexOf(m.format) + (ev.key === 'ArrowRight' ? 1 : -1);
        selectFormat(m, formats[(i + formats.length) % formats.length]);
        m.seg.querySelector(`[data-format="${m.format}"]`).focus();
      });
      m.seg.appendChild(b);
    }
    if (formats.length) selectFormat(m, selected);
  }

  function selectFormat(m, format) {
    m.format = format;
    for (const b of m.seg.querySelectorAll('button')) {
      const on = b.dataset.format === format;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const image = format === 'png' || format === 'jpeg';
    m.copy.hidden = format !== 'png' || !m.data;
    const warn = image && m.data && m.data.imageWarning;
    m.warning.hidden = !warn;
    m.warning.textContent = warn || '';
  }

  function setStatus(m, text, kind = '') {
    m.status.textContent = text;
    m.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setBusy(m, busy) {
    m.busy = busy;
    m.download.disabled = busy;
    m.reselect.disabled = busy;
    m.copy.disabled = busy;
    for (const b of m.seg.querySelectorAll('button')) b.disabled = busy;
  }

  async function previewDownload(m) {
    if (m.busy || !m.data) return;
    const format = m.format;
    setBusy(m, true);
    setStatus(m, str('preview_saving'));
    let res;
    try {
      if (format === 'pdf') {
        res = await chrome.runtime.sendMessage({
          type: 'ps:generate-from-content',
          prep: 'element',
          format: 'pdf',
        });
      } else if (format === 'markdown') {
        res = await chrome.runtime.sendMessage({ type: 'ps:export-markdown-from-content', prep: 'element' });
      } else {
        res = await chrome.runtime.sendMessage({ type: 'ps:export-element', format });
      }
    } catch (err) {
      res = { ok: false, error: errorText(err) };
    }
    if (state.preview !== m) return; // closed meanwhile
    setBusy(m, false);
    if (res && res.ok) {
      if (res.warning) {
        // Keep the modal open so the warning can be read.
        setStatus(m, str('preview_saved', [res.filename || '']), 'ok');
        m.warning.hidden = false;
        m.warning.textContent = res.warning;
      } else {
        closePreview();
      }
    } else {
      setStatus(m, (res && res.error) || str('preview_errorGeneric'), 'error');
    }
  }

  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || 'application/octet-stream';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // Copies the preview image (screen resolution). Must run synchronously inside the click so the
  // clipboard write keeps the user activation: the PNG bytes are decoded from the data URL in place.
  function previewCopy(m) {
    if (!m.data || !m.data.dataUrl) return;
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      setStatus(m, str('preview_errorCopy'), 'error');
      return;
    }
    try {
      const blob = dataUrlToBlob(m.data.dataUrl);
      navigator.clipboard
        .write([new ClipboardItem({ 'image/png': blob })])
        .then(() => state.preview === m && setStatus(m, str('preview_copied'), 'ok'))
        .catch(() => state.preview === m && setStatus(m, str('preview_errorCopy'), 'error'));
    } catch {
      setStatus(m, str('preview_errorCopy'), 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // HTML -> Markdown (experimental export)
  // ---------------------------------------------------------------------------
  // Works on the live DOM (no preparation needed): elements hidden with display:none (including
  // the user's removals) are skipped, open shadow roots and slots are followed. Output is
  // CommonMark + GFM tables. Fenced code blocks are kept aside as placeholders so the final
  // whitespace normalisation never touches their contents.

  const MD_SKIP =
    /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|META|LINK|TITLE|BASE|IFRAME|CANVAS|VIDEO|AUDIO|OBJECT|EMBED|SELECT|DATALIST|MAP)$/;
  const MD_INLINE_CODE = /^(CODE|KBD|SAMP|TT)$/;
  const MD_BR = '\u0001'; // hard line break marker inside inline text
  const MD_PRE = '\u0002'; // fenced-block placeholder delimiter

  function toMarkdown(prep) {
    const { root: prepared, error } = prepRoot(prep);
    if (error) return { ok: false, error };
    const root = prepared || document.body;
    if (!root) return { ok: false, error: 'This page has no content.' };
    const ctx = { pres: [] };
    // A picked element may itself be a list, table, code block or an inline element.
    let body;
    if (root === document.body || root === document.documentElement) body = mdBlocks(root, ctx, false);
    else if (!mdIsBlock(root)) body = mdEscapeLineStarts(mdFinishInline(mdInline(root, ctx)));
    else body = mdBlock(root, ctx);
    const title = (document.title || '').trim();
    const hasH1 = root.tagName === 'H1' || !!root.querySelector('h1');
    if (!hasH1 && title) body = '# ' + mdEscape(title) + '\n\n' + body;
    body += '\n\nSource: <' + location.href + '>';
    // At most one blank line between blocks, no trailing spaces on blank lines.
    let md =
      body
        .replace(/^[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim() + '\n';
    // Put the fenced code blocks back, indented like the line that holds the placeholder.
    md = md.replace(new RegExp(`^(.*?)${MD_PRE}(\\d+)${MD_PRE}`, 'gm'), (_, prefix, i) => {
      const cont = prefix.replace(/[^>\s]/g, ' ');
      return ctx.pres[Number(i)]
        .split('\n')
        .map((line, k) => (k === 0 ? prefix : line ? cont : cont.replace(/\s+$/, '')) + line)
        .join('\n');
    });
    return { ok: true, markdown: md, title };
  }

  // Children in the rendered (flat) tree: a shadow host's shadow root, a slot's assigned nodes.
  function mdChildren(node) {
    if (node.shadowRoot) return node.shadowRoot.childNodes;
    if (node.tagName === 'SLOT') {
      const assigned = node.assignedNodes();
      return assigned.length ? assigned : node.childNodes;
    }
    return node.childNodes;
  }

  function mdHidden(el) {
    if (MD_SKIP.test(el.tagName.toUpperCase()) || el.hasAttribute(UI_ATTR)) return true;
    return getComputedStyle(el).display === 'none';
  }

  function mdIsBlock(el) {
    if (/^(H[1-6]|P|PRE|UL|OL|TABLE|BLOCKQUOTE|HR|DL|LI|FIGURE|FIGCAPTION|DETAILS|SUMMARY)$/.test(el.tagName))
      return true;
    const d = getComputedStyle(el).display;
    return !(d === 'inline' || d.startsWith('inline-') || d === 'contents' || d === 'ruby');
  }

  function mdEscape(text) {
    return text.replace(/([\\`*_[\]<])/g, '\\$1');
  }

  // Escape characters that would turn the start of a paragraph line into a heading, quote or list.
  function mdEscapeLineStarts(text) {
    return text
      .split('\n')
      .map((l) =>
        l
          .replace(/^(#{1,6}(?:\s|$)|>|[-+](?:\s|$)|=+\s*$)/, '\\$1')
          .replace(/^(\d+)([.)](?:\s|$))/, '$1\\$2'),
      )
      .join('\n');
  }

  // Collapse inline whitespace like a browser, then turn hard-break markers into Markdown breaks.
  function mdFinishInline(raw) {
    return raw
      .replace(/[ \t\n\r\f]+/g, ' ')
      .split(MD_BR)
      .map((l) => l.trim())
      .join('  \n')
      .replace(/^(?: {2}\n)+|(?: {2}\n)+$/g, '')
      .trim();
  }

  // Block content of a container: runs of inline content become paragraphs, block children are
  // rendered by mdBlock. `tight` joins blocks with a single newline (list items).
  function mdBlocks(parent, ctx, tight) {
    const blocks = [];
    let inline = '';
    const flush = () => {
      const text = mdFinishInline(inline);
      if (text) blocks.push(mdEscapeLineStarts(text));
      inline = '';
    };
    for (const child of mdChildren(parent)) {
      if (child.nodeType === 3) {
        inline += mdEscape(child.data);
      } else if (child.nodeType === 1) {
        if (mdHidden(child)) continue;
        if (child.tagName === 'BR') inline += MD_BR;
        else if (mdIsBlock(child)) {
          flush();
          const b = mdBlock(child, ctx);
          if (b && b.trim()) blocks.push(b);
        } else inline += mdInline(child, ctx);
      }
    }
    flush();
    return blocks.join(tight ? '\n' : '\n\n');
  }

  function mdBlock(el, ctx) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const text = mdInlineLine(el, ctx);
      return text ? '#'.repeat(Number(tag[1])) + ' ' + text : '';
    }
    switch (tag) {
      case 'PRE':
        return mdPre(el, ctx);
      case 'UL':
      case 'OL':
        return mdList(el, ctx);
      case 'TABLE':
        return mdTable(el, ctx);
      case 'HR':
        return '---';
      case 'BLOCKQUOTE': {
        const inner = mdBlocks(el, ctx, false);
        return inner
          ? inner
              .split('\n')
              .map((l) => (l ? '> ' + l : '>'))
              .join('\n')
          : '';
      }
      case 'DL':
        return mdDefinitionList(el, ctx);
      case 'LI':
        return mdBlocks(el, ctx, true); // stray <li> outside a list
      default:
        return mdBlocks(el, ctx, false);
    }
  }

  function mdInlineChildren(el, ctx) {
    let out = '';
    for (const child of mdChildren(el)) {
      if (child.nodeType === 3) out += mdEscape(child.data);
      else if (child.nodeType === 1 && !mdHidden(child)) {
        if (child.tagName === 'BR') out += MD_BR;
        else {
          // Block-level boxes inside inline content (e.g. a card <a> wrapping divs) are separated by spaces.
          const piece = mdInline(child, ctx);
          out += mdIsBlock(child) ? ' ' + piece + ' ' : piece;
        }
      }
    }
    return out;
  }

  // Inline content of `el` on a single line (hard breaks become spaces): headings, <dt> terms.
  function mdInlineLine(el, ctx) {
    return mdFinishInline(mdInlineChildren(el, ctx)).replace(/ {2}\n/g, ' ');
  }

  // Leading whitespace, content, trailing whitespace.
  function splitOuterSpace(text) {
    return /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  }

  // Wrap inline content in a delimiter, keeping surrounding whitespace outside of it
  // ("<b> bold </b>" -> " **bold** ", which is valid emphasis).
  function mdWrap(content, open, close = open) {
    const m = splitOuterSpace(content);
    return m[2] ? m[1] + open + m[2] + close + m[3] : content;
  }

  function mdInline(el, ctx) {
    const tag = el.tagName;
    if (tag === 'BR') return MD_BR;
    if (tag === 'IMG') return mdImage(el);
    if (MD_INLINE_CODE.test(tag)) {
      const code = (el.textContent || '').replace(/\s+/g, ' ');
      if (!code.trim()) return code;
      const run = Math.max(0, ...(code.match(/`+/g) || []).map((r) => r.length));
      const fence = '`'.repeat(run + 1);
      const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
      return fence + pad + code + pad + fence;
    }
    const inner = mdInlineChildren(el, ctx);
    switch (tag) {
      case 'STRONG':
      case 'B':
        return mdWrap(inner, '**');
      case 'EM':
      case 'I':
      case 'CITE':
      case 'DFN':
        return mdWrap(inner, '_');
      case 'DEL':
      case 'S':
      case 'STRIKE':
        return mdWrap(inner, '~~');
      case 'A':
        return mdLink(el, inner);
      default:
        return inner;
    }
  }

  function mdUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, document.baseURI).href;
      return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    } catch {
      return '';
    }
  }

  function mdLink(a, inner) {
    const href = a.getAttribute('href');
    const url = href && !/^\s*javascript:/i.test(href) ? mdUrl(href) : '';
    const text = inner.split(MD_BR).join(' ');
    if (!url) return text;
    const m = splitOuterSpace(text);
    const label = m[2] || mdEscape(url);
    return `${m[1]}[${label}](${url})${m[3]}`;
  }

  function mdImage(img) {
    const alt = mdEscape((img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim());
    let src = img.currentSrc || img.getAttribute('src') || '';
    // Inline data: images would bloat the file; keep small ones only.
    if (src.startsWith('data:') && src.length > 2048) src = '';
    const url = src.startsWith('data:') ? src : mdUrl(src);
    if (!url) return alt;
    return `![${alt}](${url})`;
  }

  function mdPre(pre, ctx) {
    const code = pre.querySelector('code');
    const cls = `${pre.className || ''} ${(code && code.className) || ''}`;
    const lang = (/(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls) || [])[1] || '';
    let text = pre.innerText || pre.textContent || '';
    text = text.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
    const run = Math.max(0, ...(text.match(/^`{3,}/gm) || []).map((r) => r.length));
    const fence = '`'.repeat(Math.max(3, run + 1));
    ctx.pres.push(`${fence}${lang}\n${text}\n${fence}`);
    return MD_PRE + (ctx.pres.length - 1) + MD_PRE;
  }

  function mdList(list, ctx) {
    const ordered = list.tagName === 'OL';
    let n = ordered ? parseInt(list.getAttribute('start') || '1', 10) : 0;
    if (!Number.isFinite(n)) n = 1;
    const items = [];
    for (const li of list.children) {
      if (mdHidden(li)) continue;
      if (li.tagName !== 'LI') {
        // A list nested directly in a list (invalid but common) belongs to the previous item.
        const b = mdBlock(li, ctx);
        if (b && b.trim()) {
          const pad = items.length ? ' '.repeat(ordered ? String(n - 1).length + 2 : 2) : '';
          items.push(
            b
              .split('\n')
              .map((l) => (l ? pad + l : l))
              .join('\n'),
          );
        }
        continue;
      }
      const marker = ordered ? `${n++}. ` : '- ';
      const indent = ' '.repeat(marker.length);
      const body = mdBlocks(li, ctx, true) || '';
      const lines = body.split('\n');
      items.push(
        marker +
          lines[0] +
          lines
            .slice(1)
            .map((l) => '\n' + (l ? indent + l : ''))
            .join(''),
      );
    }
    return items.join('\n');
  }

  function mdDefinitionList(dl, ctx) {
    const parts = [];
    // Definition lists may wrap dt/dd pairs in <div>s.
    const entries = [];
    for (const c of dl.children) {
      if (c.tagName === 'DIV') entries.push(...c.children);
      else entries.push(c);
    }
    for (const c of entries) {
      if (mdHidden(c)) continue;
      if (c.tagName === 'DT') {
        const term = mdInlineLine(c, ctx);
        if (term) parts.push({ term: `**${term}**`, defs: [] });
      } else if (c.tagName === 'DD') {
        const def = mdBlocks(c, ctx, true);
        if (!def) continue;
        if (!parts.length) parts.push({ term: '', defs: [] });
        parts[parts.length - 1].defs.push(def);
      }
    }
    return parts.map((p) => [p.term, ...p.defs].filter(Boolean).join('  \n')).join('\n\n');
  }

  function mdTable(table, ctx) {
    const rows = [];
    for (const row of table.rows) {
      if (row.closest('table') !== table || mdHidden(row)) continue;
      const cells = [];
      for (const cell of row.cells) {
        if (mdHidden(cell)) continue;
        const text = mdFinishInline(mdInlineChildren(cell, ctx))
          .replace(/ {2}\n/g, ' <br> ')
          .replace(/\|/g, '\\|');
        cells.push(text);
        for (let i = 1; i < Math.min(cell.colSpan || 1, 50); i++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    for (const r of rows) while (r.length < width) r.push('');
    // GFM needs exactly one header row: use the first row (header or not) and keep the rest as body.
    const line = (cells) => '| ' + cells.map((c) => c || ' ').join(' | ') + ' |';
    const out = [
      line(rows[0]),
      '| ' + Array(width).fill('---').join(' | ') + ' |',
      ...rows.slice(1).map(line),
    ];
    const caption =
      table.caption && !mdHidden(table.caption) ? mdFinishInline(mdInlineChildren(table.caption, ctx)) : '';
    return (caption ? mdEscapeLineStarts(caption) + '\n\n' : '') + out.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function errorText(err) {
    return String((err && err.message) || err);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }
})();
