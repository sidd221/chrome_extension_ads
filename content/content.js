/*
 * AdScoop – content script controller (runs on facebook.com/ads/library/*).
 *
 * Responsibilities
 *   - answer popup pings (page context, detected ad count, blockers, run state)
 *   - run extraction in three modes:
 *       visible    every ad card currently in the DOM
 *       new        only cards whose Library ID is not saved yet (the "I just scrolled / clicked
 *                  load more" workflow)
 *       autoscroll scroll the page like a user would, extracting as results load, until the
 *                  requested number of ads, the end of the results, or a blocker
 *   - stream results to the service worker in small batches so nothing is lost if the popup closes
 *
 * AdScoop never bypasses a login wall, CAPTCHA or rate limit: when Meta shows one the run stops
 * and tells the user. Scrolling uses a delay between steps (default 2 s, never below 1.5 s).
 */
(function (root) {
  'use strict';
  if (root.__adscoopLoaded) return;          // idempotent (manifest injection + scripting injection)
  root.__adscoopLoaded = true;

  const NS = root.AdScoop;
  const H = NS.helpers;
  const X = NS.metaExtractor;
  const O = NS.domObserver;
  const BATCH = 5;
  const MIN_SCROLL_DELAY = 1500;

  const state = {
    running: false, stopRequested: false, mode: '', total: 0, done: 0, saved: 0, added: 0, updated: 0,
    failed: 0, skippedKnown: 0, errors: [], message: '', startedAt: 0, finishedAt: 0, finishReason: ''
  };

  function publicState() { return JSON.parse(JSON.stringify(state)); }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) { void chrome.runtime.lastError; resolve(resp); });
      } catch (e) { resolve(undefined); }       // extension reloaded: context invalidated
    });
  }

  function progress() { send({ type: 'AS_PROGRESS', state: publicState() }); }

  /* ---------- highlight ---------- */

  function ensureStyle() {
    if (document.getElementById('adscoop-style')) return;
    const st = document.createElement('style');
    st.id = 'adscoop-style';
    st.textContent = '[data-adscoop="1"]{outline:2px solid #ff7a45 !important;outline-offset:-2px;border-radius:8px;}';
    (document.head || document.documentElement).appendChild(st);
  }
  function mark(el) { try { ensureStyle(); el.setAttribute('data-adscoop', '1'); } catch (e) { /* ignore */ } }
  function clearMarks() { document.querySelectorAll('[data-adscoop]').forEach(function (e) { e.removeAttribute('data-adscoop'); }); }

  /* ---------- extraction ---------- */

  async function extractEntries(entries, ctx, settings, saveBuffer) {
    for (let i = 0; i < entries.length; i++) {
      if (state.stopRequested) return;
      const entry = entries[i];
      // React may have replaced the node since detection: re-resolve by Library ID.
      let el = entry.el;
      if (!el.isConnected) {
        const again = X.detectCards().find(function (c) { return c.id === entry.id; });
        if (!again) { state.failed++; state.errors.push({ id: entry.id, message: 'Card left the page before it could be read' }); continue; }
        el = again.el;
      }
      try {
        const ad = await X.extractCard(el, entry.id, ctx, { expandSeeMore: settings.expandSeeMore !== false });
        saveBuffer.push(ad);
        if (settings.highlightExtracted !== false) mark(el);
      } catch (e) {
        state.failed++;
        state.errors.push({ id: entry.id, message: String(e && e.message || e).slice(0, 200) });
      }
      state.done++;
      state.message = 'Extracted ' + state.done + (state.total ? ' of ' + state.total : '') + ' ads';
      if (saveBuffer.length >= BATCH) await flush(saveBuffer);
      progress();
      await H.sleep(30);   // yield so the page stays responsive
    }
  }

  async function flush(buffer) {
    if (!buffer.length) return;
    const ads = buffer.splice(0, buffer.length);
    const resp = await send({ type: 'AS_SAVE_ADS', ads: ads });
    if (!resp || resp.error) {
      state.failed += ads.length;
      state.errors.push({ id: '', message: 'Saving failed: ' + ((resp && resp.error) || 'the extension did not respond (was it reloaded? refresh this tab)') });
      return;
    }
    state.saved += resp.added + resp.updated;
    state.added += resp.added;
    state.updated += resp.updated;
  }

  function blocked() {
    const b = X.detectBlockers();
    if (b.blocked) { state.finishReason = 'blocked'; state.message = b.reason; state.errors.push({ id: '', message: b.reason }); }
    return b.blocked;
  }

  async function run(mode, maxAds) {
    Object.assign(state, {
      running: true, stopRequested: false, mode: mode, total: 0, done: 0, saved: 0, added: 0, updated: 0, failed: 0,
      skippedKnown: 0, errors: [], message: 'Starting…', startedAt: Date.now(), finishedAt: 0, finishReason: ''
    });
    progress();
    const settings = (await send({ type: 'AS_GET_SETTINGS' })) || {};
    const ctx = X.getPageContext();
    const buffer = [];
    const processed = new Set();
    let known = new Set();
    if (mode === 'new') {
      const ids = await send({ type: 'AS_KNOWN_IDS' });
      known = new Set(Array.isArray(ids) ? ids : []);
    }
    const pending = function () {
      const cards = X.detectCards();
      return cards.filter(function (c) {
        if (processed.has(c.id)) return false;
        if (mode === 'new' && known.has(c.id)) { return false; }
        return true;
      });
    };
    const markProcessed = function (entries) { entries.forEach(function (e) { processed.add(e.id); }); };

    try {
      if (blocked()) return;
      if (mode === 'visible' || mode === 'new') {
        const all = X.detectCards();
        const todo = pending();
        state.skippedKnown = mode === 'new' ? all.length - todo.length : 0;
        state.total = todo.length;
        if (!all.length) {
          state.finishReason = 'no-ads';
          state.message = 'No ad cards found. Search for an advertiser or keyword in the Ad Library first, then wait for results to load.';
        } else if (!todo.length) {
          state.finishReason = 'nothing-new';
          state.message = 'All ' + all.length + ' visible ads are already saved. Scroll to load more, or use "Extract all visible ads" to refresh them.';
        } else {
          markProcessed(todo);
          await extractEntries(todo, ctx, settings, buffer);
          state.finishReason = state.stopRequested ? 'stopped' : 'complete';
        }
      } else if (mode === 'autoscroll') {
        const target = Math.max(1, Math.min(Number(maxAds) || Number(settings.autoScrollMaxAds) || 40, 500));
        const delay = Math.max(MIN_SCROLL_DELAY, Number(settings.scrollDelayMs) || 2000);
        const startY = root.scrollY;
        state.total = target;
        let idle = 0;
        while (!state.stopRequested && state.done < target) {
          if (blocked()) break;
          const batch = pending().slice(0, target - state.done);
          if (batch.length) {
            idle = 0;
            markProcessed(batch);
            await extractEntries(batch, ctx, settings, buffer);
            continue;
          }
          state.message = 'Scrolling to load more ads… (' + state.done + '/' + target + ')';
          progress();
          O.scan();
          const waiting = O.waitForNew(delay + 2500);
          root.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
          await H.sleep(delay);
          const gotNew = await waiting;
          if (!gotNew && !pending().length) {
            idle++;
            if (idle >= 3) { state.finishReason = 'end-of-results'; break; }
          }
        }
        if (!state.finishReason) state.finishReason = state.stopRequested ? 'stopped' : (state.done >= target ? 'complete' : 'end-of-results');
        try { root.scrollTo({ top: startY, behavior: 'auto' }); } catch (e) { /* ignore */ }
      } else {
        throw new Error('Unknown extraction mode: ' + mode);
      }
      await flush(buffer);
    } catch (e) {
      state.errors.push({ id: '', message: String(e && e.message || e).slice(0, 300) });
      state.finishReason = state.finishReason || 'error';
      try { await flush(buffer); } catch (e2) { /* ignore */ }
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      if (state.finishReason === 'end-of-results') {
        state.message = 'Reached the end of the results (' + state.done + ' ads extracted).';
      } else if (state.finishReason === 'stopped') {
        state.message = 'Stopped. ' + state.done + ' ads were extracted and saved.';
      } else if (state.finishReason === 'complete') {
        state.message = 'Done: ' + state.done + ' ads extracted' + (state.failed ? ', ' + state.failed + ' failed' : '') + '.';
      }
      progress();
      send({ type: 'AS_DONE', state: publicState() });
    }
  }

  /* ---------- badge: number of ads detected on the page ---------- */

  const reportDetected = H.debounce(function (res) {
    send({ type: 'AS_DETECTED', count: res.total });
  }, 800);

  O.start(function (res) { reportDetected(res); });

  /* ---------- messages from popup / service worker ---------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    try {
      if (msg.type === 'AS_PING') {
        const scan = O.scan();
        sendResponse({ ok: true, context: X.getPageContext(), detected: scan.total, blocker: X.detectBlockers(), state: publicState() });
      } else if (msg.type === 'AS_STATUS') {
        sendResponse({ ok: true, state: publicState() });
      } else if (msg.type === 'AS_EXTRACT') {
        if (state.running) { sendResponse({ ok: false, error: 'An extraction is already running.' }); return false; }
        run(String(msg.mode || 'visible'), msg.maxAds).catch(function (e) {
          state.running = false;
          state.errors.push({ id: '', message: String(e && e.message || e) });
          progress();
        });
        sendResponse({ ok: true, started: true });
      } else if (msg.type === 'AS_STOP') {
        state.stopRequested = true;
        state.message = 'Stopping…';
        sendResponse({ ok: true });
      } else if (msg.type === 'AS_CLEAR_HIGHLIGHT') {
        clearMarks();
        sendResponse({ ok: true });
      } else {
        return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return false;
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
