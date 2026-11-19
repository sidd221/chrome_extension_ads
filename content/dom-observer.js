/*
 * AdScoop – DOM observer.
 *
 * The Ad Library is a single-page app: results are appended while the user scrolls and the
 * whole result list is swapped when a search changes. This module watches for that with a
 * debounced MutationObserver and tells the rest of the content script which ad cards are new.
 *
 * It only observes childList changes (never attributes), so AdScoop's own highlight attribute
 * can never trigger a feedback loop.
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});

  let observer = null;
  let timer = null;
  let listener = null;
  let lastHref = '';
  let known = new Set();
  let waiters = [];
  let lastTotal = 0;

  function searchSignature() {
    try {
      const u = new URL(root.location.href);
      return [u.pathname, u.searchParams.get('q'), u.searchParams.get('country'), u.searchParams.get('view_all_page_id'),
        u.searchParams.get('active_status'), u.searchParams.get('ad_type'), u.searchParams.get('media_type')].join('|');
    } catch (e) { return root.location.href; }
  }

  /** Detect cards now. Returns { total, added:[ids], map:Map(id -> element) }. */
  function scan() {
    const sig = searchSignature();
    if (sig !== lastHref) { lastHref = sig; known = new Set(); }
    const cards = NS.metaExtractor.detectCards();
    const map = new Map();
    const added = [];
    cards.forEach(function (c) {
      map.set(c.id, c.el);
      if (!known.has(c.id)) { known.add(c.id); added.push(c.id); }
    });
    lastTotal = map.size;
    return { total: map.size, added: added, map: map };
  }

  function onMutations(mutations) {
    let relevant = false;
    for (let i = 0; i < mutations.length && !relevant; i++) {
      if (mutations[i].addedNodes && mutations[i].addedNodes.length) relevant = true;
      else if (mutations[i].removedNodes && mutations[i].removedNodes.length) relevant = true;
    }
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      let result;
      try { result = scan(); } catch (e) { return; }
      if (result.added.length) {
        const ws = waiters; waiters = [];
        ws.forEach(function (w) { clearTimeout(w.t); w.resolve(true); });
      }
      if (listener) { try { listener(result); } catch (e) { /* ignore listener errors */ } }
    }, 600);
  }

  function start(cb) {
    listener = cb || null;
    if (observer) return;
    try {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) { observer = null; }
    lastHref = searchSignature();
    try { const r = scan(); if (listener) listener(r); } catch (e) { /* ignore */ }
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null; listener = null;
    clearTimeout(timer);
    waiters.forEach(function (w) { clearTimeout(w.t); w.resolve(false); });
    waiters = [];
  }

  /** Resolve true as soon as new ad cards appear, false after `ms` without any. */
  function waitForNew(ms) {
    return new Promise(function (resolve) {
      const w = { resolve: resolve, t: null };
      w.t = setTimeout(function () {
        waiters = waiters.filter(function (x) { return x !== w; });
        resolve(false);
      }, ms);
      waiters.push(w);
    });
  }

  NS.domObserver = { start: start, stop: stop, scan: scan, waitForNew: waitForNew, get lastTotal() { return lastTotal; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.domObserver;
})(typeof globalThis !== 'undefined' ? globalThis : this);
