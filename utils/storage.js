/*
 * AdScoop – persistence on chrome.storage.local.
 *
 * One key per ad ("ad:<Ad ID>") so saving or deleting one ad never rewrites the library, plus one settings key.
 * All writes are serialised through a promise queue. In production the service worker is the writer for
 * extraction; extension pages (dashboard / popup) may also read and write through this same module.
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});
  const AD_PREFIX = 'ad:';
  const SETTINGS_KEY = 'adscoop_settings';

  const DEFAULT_SETTINGS = {
    expandSeeMore: true,          // click the page's own "See more" so full ad copy is captured
    highlightExtracted: true,     // outline extracted ads on the Ad Library page
    autoScrollMaxAds: 40,
    scrollDelayMs: 2200,          // minimum 1500 is enforced by the content script
    csvBom: true,
    csvFormulaGuard: true,
    ocrEngine: 'tesseract',       // tesseract | vision-ai | off
    ai: { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
    transcription: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', apiKey: '' }
  };

  let areaOverride = null;
  const area = function () { return areaOverride || root.chrome.storage.local; };
  function setArea(a) { areaOverride = a; }

  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(function () { /* keep the queue alive */ });
    return run;
  }

  const keyOf = function (ad) { return AD_PREFIX + NS.dedupe.adKey(ad); };
  const isAdKey = function (k) { return k.indexOf(AD_PREFIX) === 0; };

  async function getAll() {
    const all = await area().get(null);
    return Object.keys(all).filter(isAdKey).map(function (k) { return all[k]; });
  }
  async function getAllIds() {
    const all = await area().get(null);
    return Object.keys(all).filter(isAdKey).map(function (k) { return k.slice(AD_PREFIX.length); });
  }
  async function count() { return (await getAllIds()).length; }
  async function getAds(ids) {
    const keys = (ids || []).map(function (id) { return AD_PREFIX + id; });
    if (!keys.length) return [];
    const got = await area().get(keys);
    return keys.map(function (k) { return got[k]; }).filter(Boolean);
  }

  /** Add or merge ads by Ad ID. Returns { added, updated, total, ids }. */
  function upsert(list) {
    return serial(async function () {
      const D = NS.dedupe;
      const ads = D.dedupeList(list);
      const keys = ads.map(keyOf);
      const existing = keys.length ? await area().get(keys) : {};
      const write = {};
      let added = 0, updated = 0;
      ads.forEach(function (ad, i) {
        const prev = existing[keys[i]];
        write[keys[i]] = D.mergeAd(prev, ad);
        if (prev) updated++; else added++;
      });
      if (keys.length) await area().set(write);
      return { added: added, updated: updated, total: (await getAllIds()).length, ids: ads.map(D.adKey) };
    });
  }

  /** Overwrite records exactly as given (no merging) – used for re-analysis and OCR / transcript results. */
  function putMany(list) {
    return serial(async function () {
      const write = {};
      (list || []).forEach(function (ad) { write[keyOf(ad)] = ad; });
      if (Object.keys(write).length) await area().set(write);
      return { saved: Object.keys(write).length };
    });
  }
  function put(ad) { return putMany([ad]); }

  /** Delete ads; resolves to the number of ads left. */
  function remove(ids) {
    return serial(async function () {
      const keys = (ids || []).map(function (id) { return AD_PREFIX + id; });
      if (keys.length) await area().remove(keys);
      return (await getAllIds()).length;
    });
  }

  /** Delete every saved ad. Settings (including API keys) are kept. */
  function clearAds() {
    return serial(async function () {
      const all = await area().get(null);
      const keys = Object.keys(all).filter(isAdKey);
      if (keys.length) await area().remove(keys);
      return keys.length;
    });
  }

  function mergeSettings(base, patch) {
    const out = Object.assign({}, base);
    Object.keys(patch || {}).forEach(function (k) {
      const v = patch[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') ? Object.assign({}, base[k], v) : v;
    });
    return out;
  }
  async function getSettings() {
    const r = await area().get(SETTINGS_KEY);
    return mergeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), r[SETTINGS_KEY] || {});
  }
  function setSettings(patch) {
    return serial(async function () {
      const next = mergeSettings(await getSettings(), patch);
      await area().set({ [SETTINGS_KEY]: next });
      return next;
    });
  }

  NS.storage = {
    AD_PREFIX: AD_PREFIX, SETTINGS_KEY: SETTINGS_KEY, DEFAULT_SETTINGS: DEFAULT_SETTINGS, setArea: setArea,
    getAll: getAll, getAllIds: getAllIds, getAds: getAds, count: count, upsert: upsert, put: put, putMany: putMany,
    remove: remove, clearAds: clearAds, getSettings: getSettings, setSettings: setSettings
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.storage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
