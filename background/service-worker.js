/*
 * AdScoop – background service worker (Manifest V3).
 *
 * Owns persistence so that extraction keeps working even if the popup is closed:
 *   content script --AS_SAVE_ADS--> here --> local rule-based analysis --> chrome.storage.local
 *
 * No network access happens here. Optional AI / OCR / transcription calls are made from the
 * dashboard page only, and only when the user presses the matching button.
 */
importScripts(
  '../utils/helpers.js',
  '../utils/deduplication.js',
  '../utils/storage.js',
  '../analysis/hook-analyzer.js',
  '../analysis/marketing-analyzer.js'
);

const NS = self.AdScoop;

/* ---------- badge ---------- */

function setBadge(tabId, count) {
  if (typeof tabId !== 'number') return;
  const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
  chrome.action.setBadgeText({ tabId: tabId, text: text }).catch(function () { /* tab closed */ });
  if (text) chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#ff7a45' }).catch(function () { /* ignore */ });
}

/* ---------- saving ---------- */

function sanitizeAd(ad) {
  const strFields = ['adId', 'advertiserName', 'pageId', 'adUrl', 'platform', 'platformSource', 'status', 'startDate',
    'startDateRaw', 'endDate', 'endDateRaw', 'primaryText', 'headline', 'description', 'cta', 'landingUrl',
    'displayDomain', 'mediaType', 'imageUrl', 'videoUrl', 'variationsNote', 'searchKeyword', 'country',
    'extractedAt', 'source'];
  const out = Object.assign({}, ad);
  strFields.forEach(function (k) { if (out[k] != null && typeof out[k] !== 'string') out[k] = String(out[k]); });
  ['imageUrls', 'textVariants', 'limitations'].forEach(function (k) { if (!Array.isArray(out[k])) out[k] = []; });
  delete out.analysis;                       // analysis is always computed here, never trusted from the page
  return out;
}

function analyseSafely(ad) {
  try {
    return NS.marketingAnalyzer.analyzeAd(ad);
  } catch (e) {
    return { engine: NS.marketingAnalyzer.ENGINE, notes: ['Analysis failed: ' + String(e && e.message || e)], confidence: 'none' };
  }
}

async function saveAds(ads) {
  const S = NS.storage;
  const clean = (Array.isArray(ads) ? ads : []).filter(function (a) { return a && typeof a === 'object'; }).map(sanitizeAd);
  if (!clean.length) return { added: 0, updated: 0, total: await S.count() };
  const res = await S.upsert(clean);
  // mergeAd keeps existing analysis unless the copy changed, so only analyse records without one.
  const merged = await S.getAds(res.ids);
  const todo = merged.filter(function (a) { return !a.analysis; });
  todo.forEach(function (a) { a.analysis = analyseSafely(a); });
  await S.putMany(todo);
  return { added: res.added, updated: res.updated, total: res.total };
}

async function reanalyse(ids) {
  const S = NS.storage;
  const list = ids && ids.length ? await S.getAds(ids) : await S.getAll();
  list.forEach(function (a) { a.analysis = analyseSafely(a); });
  await S.putMany(list);
  return { analysed: list.length };
}

/* ---------- messages ---------- */

const handlers = {
  AS_GET_SETTINGS: function () { return NS.storage.getSettings().then(function (s) {
    // never hand API keys to content scripts running inside facebook.com
    const safe = JSON.parse(JSON.stringify(s));
    if (safe.ai) safe.ai.apiKey = '';
    if (safe.transcription) safe.transcription.apiKey = '';
    return safe;
  }); },
  AS_KNOWN_IDS: function () { return NS.storage.getAllIds(); },
  AS_SAVE_ADS: function (msg) { return saveAds(msg.ads); },
  AS_REANALYSE: function (msg) { return reanalyse(msg.ids); },
  AS_COUNT: function () { return NS.storage.count().then(function (n) { return { total: n }; }); },
  AS_DELETE: function (msg) { return NS.storage.remove(msg.ids || []).then(function (n) { return { total: n }; }); },
  AS_CLEAR: function () { return NS.storage.clearAds().then(function () { return { total: 0 }; }); }
};

const CONTENT_ONLY = { AS_DETECTED: 1, AS_PROGRESS: 1, AS_DONE: 1 };

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'AS_DETECTED') {
    if (sender && sender.tab) setBadge(sender.tab.id, Number(msg.count) || 0);
    return false;
  }
  if (CONTENT_ONLY[msg.type]) return false;    // progress broadcasts are for the popup

  // Messages that touch storage must come from AdScoop's own pages or its content script.
  if (sender && sender.id !== chrome.runtime.id) return false;
  const fn = handlers[msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(function () { return fn(msg, sender); })
    .then(function (r) { sendResponse(r); })
    .catch(function (e) { sendResponse({ error: String(e && e.message || e) }); });
  return true;                                  // async response
});

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === 'loading') setBadge(tabId, 0);
});

chrome.runtime.onInstalled.addListener(function (details) {
  chrome.action.setBadgeBackgroundColor({ color: '#ff7a45' });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html?view=help') }).catch(function () { /* ignore */ });
  }
});
