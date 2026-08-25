/**
 * Selector resolution injected into the page. Three things the raw
 * `document.querySelector` cannot do, and that an agent needs constantly:
 *
 *  - `text=Entrar`  — address an element by what the user reads, so the agent
 *    does not have to guess a class soup like `rounded-lg py-2 transition`.
 *  - shadow DOM piercing, for web components (`<sl-*>`, `<md-*>`, tldraw).
 *  - a stable selector *back out*, so a snapshot line can be fed to `click`.
 */
export const QUERY = `(() => {
  if (window.__bq) return;

  /**
   * Every searchable root, each with the pixel offset needed to turn a local
   * getBoundingClientRect into top-document coordinates. Shadow roots share the
   * host's coordinate space; a same-origin iframe does not, so its offset is
   * the iframe's own position. Cross-origin frames throw on access and are
   * skipped — CDP would need a separate target for those.
   */
  const roots = () => {
    const out = [];
    const walk = (node, ox, oy) => {
      out.push({ root: node, ox, oy });
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot, ox, oy);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let doc = null;
          try { doc = el.contentDocument; } catch { doc = null; }
          if (!doc) continue;
          const r = el.getBoundingClientRect();
          walk(doc, ox + r.left, oy + r.top);
        }
      }
    };
    walk(document, 0, 0);
    return out;
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();

  const label = (el) => norm(
    el.getAttribute?.('aria-label') ||
    (el.getAttribute?.('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent) ||
    el.alt || el.placeholder || el.title ||
    (el.labels && el.labels[0]?.textContent) ||
    el.value ||
    el.textContent
  ).slice(0, 120);

  /** Matches CSS, or \`text=Foo\` against the smallest element containing Foo. */
  window.__bq = (sel, nth = 0) => {
    const all = [];
    const push = (el, ox, oy) => all.push({ el, ox, oy });
    if (sel.startsWith('text=')) {
      const want = norm(sel.slice(5)).toLowerCase();
      for (const { root, ox, oy } of roots()) {
        for (const el of root.querySelectorAll('*')) {
          const t = norm(el.textContent).toLowerCase();
          if (!t.includes(want)) continue;
          // Smallest match wins: skip a parent that only matches via a child.
          if ([...el.children].some((c) => norm(c.textContent).toLowerCase().includes(want))) continue;
          push(el, ox, oy);
        }
      }
    } else {
      for (const { root, ox, oy } of roots()) {
        for (const el of root.querySelectorAll(sel)) push(el, ox, oy);
      }
    }
    const vis = all.filter((h) => visible(h.el));
    const pool = vis.length ? vis : all;
    const hit = pool[nth] || null;
    return {
      el: hit ? hit.el : null,
      ox: hit ? hit.ox : 0,
      oy: hit ? hit.oy : 0,
      matches: all.length,
      visibleMatches: vis.length,
    };
  };

  /** A selector short enough to print and specific enough to click again. */
  window.__bsel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label', 'placeholder']) {
      const v = el.getAttribute?.(attr);
      if (v) return \`[\${attr}="\${v.replace(/"/g, '\\\\"')}"]\`;
    }
    const tag = el.tagName.toLowerCase();
    // A form control has no text of its own, so class soup would be the only
    // fallback — and every input in a Tailwind form shares it. Type is better.
    if (tag === 'input' && el.type) return \`input[type="\${el.type}"]\`;
    const txt = norm(el.textContent);
    if (txt && txt.length <= 40) return 'text=' + txt;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean)[0];
    return tag + (cls ? '.' + CSS.escape(cls) : '');
  };

  window.__broots = roots;
  window.__bvisible = visible;
  window.__blabel = label;
})()`;

/**
 * Walks the page for the things an agent can act on or navigate by, and returns
 * one compact line each. This is the cheap answer to "what is on the screen?" —
 * a page like this costs a few hundred tokens where a screenshot costs ~1500.
 */
export const SNAPSHOT = `(() => {
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role], [onclick], [tabindex]:not([tabindex="-1"]), label';
  const STRUCTURE = 'h1, h2, h3, h4, main, nav, header, footer, aside, form, dialog, table, [aria-live]';
  const seen = new Set();
  const rows = [];

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') return (el.type || 'text') === 'text' ? 'textbox' : el.type;
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };

  const collect = (selector, kind) => {
    const found = [];
    // Same roots the selectors search: shadow DOM and same-origin iframes too,
    // so a snapshot never hides a control that click could actually reach.
    for (const { root, ox, oy } of window.__broots()) {
      for (const el of root.querySelectorAll(selector)) found.push({ el, ox, oy });
    }
    for (const { el, ox, oy } of found) {
      if (seen.has(el) || !window.__bvisible(el)) continue;
      seen.add(el);
      const raw = el.getBoundingClientRect();
      const r = { x: raw.x + ox, y: raw.y + oy, width: raw.width, height: raw.height,
        top: raw.y + oy, bottom: raw.y + oy + raw.height };
      const onScreen = r.top < innerHeight && r.bottom > 0;
      rows.push({
        kind,
        role: roleOf(el),
        name: window.__blabel(el),
        sel: window.__bsel(el),
        y: Math.round(r.y + scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
        onScreen,
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        value: 'value' in el && el.type !== 'password' ? String(el.value || '').slice(0, 60) : undefined,
      });
    }
  };

  collect(STRUCTURE, 'structure');
  collect(INTERACTIVE, 'control');
  rows.sort((a, b) => a.y - b.y);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    scroll: Math.round(scrollY),
    pageHeight: document.documentElement.scrollHeight,
    rows,
  });
})()`;
