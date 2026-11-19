/*
 * AdScoop – popup controller.
 * Talks to the content script on the active Ad Library tab, shows live progress, and exports CSV
 * straight from chrome.storage.local.
 */
(function () {
  'use strict';

  const NS = window.AdScoop;
  const H = NS.helpers;
  const $ = function (id) { return document.getElementById(id); };
  const LIB_RE = /^https:\/\/([a-z0-9-]+\.)*facebook\.com\/ads\/library/i;

  let tab = null;
  let onLibrary = false;
  let connected = false;
  let runState = null;
  let lastShownFinish = 0;
  let clearArmed = false;
  let clearTimer = null;
  let pollTimer = null;

  /* ---------- toasts ---------- */

  function toast(kind, text, ms) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('toasts').prepend(el);
    while ($('toasts').children.length > 3) $('toasts').lastChild.remove();
    setTimeout(function () { el.remove(); }, ms || (kind === 'err' ? 9000 : 5500));
  }

  /* ---------- tab messaging ---------- */

  function sendToTab(msg) {
    return new Promise(function (resolve) {
      if (!tab || tab.id == null) return resolve(null);
      chrome.tabs.sendMessage(tab.id, msg, function (resp) {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp || null);
      });
    });
  }

  async function injectContentScripts() {
    const files = chrome.runtime.getManifest().content_scripts[0].js;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: files });
  }

  async function connect() {
    let pong = await sendToTab({ type: 'AS_PING' });
    if (!pong) {
      // The tab was open before AdScoop was installed / reloaded: inject on demand.
      try { await injectContentScripts(); await H.sleep(500); pong = await sendToTab({ type: 'AS_PING' }); } catch (e) { pong = null; }
    }
    connected = !!pong;
    return pong;
  }

  /* ---------- rendering ---------- */

  function setPage(kind, title, sub) {
    $('pageBox').className = 'page ' + kind;
    $('pageTitle').textContent = title;
    $('pageSub').textContent = sub || '';
    $('pageSub').title = sub || '';
  }

  function renderRun(state) {
    runState = state || runState;
    const s = runState;
    const running = !!(s && s.running);
    $('progressBox').hidden = !running;
    if (s) {
      $('statExtracted').textContent = String(Math.max(0, (s.done || 0) - (s.failed || 0)));
      const total = s.total || 0;
      const pct = total ? Math.min(100, Math.round(((s.done || 0) / total) * 100)) : 0;
      $('progressLabel').textContent = total ? (s.done + '/' + total + ' ads') : (s.done + ' ads');
      $('barFill').style.width = pct + '%';
      $('barFill').parentElement.setAttribute('aria-valuenow', String(pct));
      $('barFill').parentElement.classList.toggle('indeterminate', running && !total);
      $('progressMsg').textContent = s.message || '';
    }
    const can = onLibrary && connected && !running;
    ['btnNew', 'btnAll', 'btnAuto'].forEach(function (id) { $(id).disabled = !can; });
    $('maxAds').disabled = running;

    if (s && !running && s.finishedAt && s.finishedAt !== lastShownFinish) {
      lastShownFinish = s.finishedAt;
      const errs = (s.errors || []).filter(function (e) { return e.message; });
      if (s.finishReason === 'blocked' || s.finishReason === 'error') toast('err', s.message || (errs[0] && errs[0].message) || 'Extraction stopped.');
      else if (s.finishReason === 'no-ads') toast('err', s.message);
      else if (s.finishReason === 'nothing-new') toast('info', s.message);
      else if (errs.length) toast('err', (s.message || 'Finished with problems.') + ' First problem: ' + errs[0].message);
      else toast('ok', s.message || 'Done.');
    }
  }

  async function refreshSaved() {
    try { $('statSaved').textContent = String(await NS.storage.count()); } catch (e) { $('statSaved').textContent = '?'; }
  }

  async function detect() {
    const url = (tab && tab.url) || '';
    onLibrary = LIB_RE.test(url);
    $('btnOpenLib').hidden = onLibrary;
    if (!onLibrary) {
      connected = false;
      $('statDetected').textContent = '–';
      if (/facebook\.com/i.test(url)) setPage('warn', 'Facebook – but not the Ad Library', 'Open facebook.com/ads/library to extract ads.');
      else setPage('warn', 'Not on the Meta Ads Library', url ? H.truncate(url.replace(/^https?:\/\//, ''), 48) : 'Open the Ad Library to start.');
      renderRun(null);
      return;
    }
    const pong = await connect();
    if (!pong) {
      setPage('err', 'Ad Library detected, but AdScoop cannot reach the page', 'Refresh this tab (F5) and open AdScoop again.');
      renderRun(null);
      return;
    }
    applyPong(pong);
  }

  function applyPong(pong) {
    const c = pong.context || {};
    $('statDetected').textContent = String(pong.detected);
    const bits = [];
    if (c.keyword) bits.push('“' + H.truncate(c.keyword, 26) + '”');
    if (c.country) bits.push(c.country);
    if (c.viewAllPageId) bits.push('page ' + c.viewAllPageId);
    if (pong.blocker && pong.blocker.blocked) setPage('err', 'Meta is showing a check or limit', pong.blocker.reason);
    else if (pong.detected === 0) setPage('warn', 'Meta Ads Library detected', 'No ad cards yet – search for an advertiser or keyword' + (bits.length ? ' (' + bits.join(' · ') + ')' : '') + '.');
    else setPage('ok', 'Meta Ads Library detected', pong.detected + ' ads on screen' + (bits.length ? ' · ' + bits.join(' · ') : ''));
    renderRun(pong.state);
  }

  async function poll() {
    if (!onLibrary) return;
    const running = runState && runState.running;
    const resp = await sendToTab({ type: running ? 'AS_STATUS' : 'AS_PING' });
    if (!resp) return;
    if (resp.detected != null) applyPong(resp); else renderRun(resp.state);
  }

  /* ---------- actions ---------- */

  async function startExtraction(mode) {
    if (!connected) await detect();
    if (!connected) return toast('err', 'Cannot reach the Ad Library page. Refresh it and try again.');
    const maxAds = Math.max(1, Math.min(500, parseInt($('maxAds').value, 10) || 40));
    if (mode === 'autoscroll') NS.storage.setSettings({ autoScrollMaxAds: maxAds }).catch(function () { /* ignore */ });
    lastShownFinish = 0;
    const resp = await sendToTab({ type: 'AS_EXTRACT', mode: mode, maxAds: maxAds });
    if (!resp || !resp.ok) return toast('err', (resp && resp.error) || 'Could not start extraction. Refresh the Ad Library tab and try again.');
    renderRun({ running: true, done: 0, total: 0, failed: 0, message: 'Starting…' });
    $('progressBox').hidden = false;
  }

  async function downloadCsv() {
    try {
      const all = await NS.storage.getAll();
      if (!all.length) return toast('err', 'Nothing to export yet. Extract some ads first.');
      all.sort(function (a, b) { return String(b.extractedAt || '').localeCompare(String(a.extractedAt || '')); });
      const content = $('csvKind').value;
      const settings = await NS.storage.getSettings();
      const csv = NS.exporter.buildCsv(all, { content: content, formulaGuard: settings.csvFormulaGuard !== false, bom: settings.csvBom !== false });
      const name = NS.exporter.fileName({ content: content, scope: 'all' });
      await NS.exporter.download(csv, name);
      toast('ok', 'Downloaded ' + all.length + ' ads → ' + name);
    } catch (e) {
      toast('err', 'Export failed: ' + (e && e.message || e));
    }
  }

  async function clearData() {
    const btn = $('btnClear');
    const n = await NS.storage.count();
    if (!n) return toast('info', 'Your library is already empty.');
    if (!clearArmed) {
      clearArmed = true;
      btn.classList.add('armed');
      btn.textContent = 'Click again to delete ' + n + ' ads';
      clearTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    try {
      await NS.storage.clearAds();
      await sendToTab({ type: 'AS_CLEAR_HIGHLIGHT' });
      await refreshSaved();
      toast('ok', 'Deleted ' + n + ' saved ads.');
    } catch (e) { toast('err', 'Could not clear data: ' + (e && e.message || e)); }
  }
  function disarm() {
    clearArmed = false; clearTimeout(clearTimer);
    $('btnClear').classList.remove('armed'); $('btnClear').textContent = 'Clear data';
  }

  /* ---------- wiring ---------- */

  $('btnNew').addEventListener('click', function () { startExtraction('new'); });
  $('btnAll').addEventListener('click', function () { startExtraction('visible'); });
  $('btnAuto').addEventListener('click', function () { startExtraction('autoscroll'); });
  $('btnStop').addEventListener('click', async function () { await sendToTab({ type: 'AS_STOP' }); $('progressMsg').textContent = 'Stopping…'; });
  $('btnCsv').addEventListener('click', downloadCsv);
  $('btnClear').addEventListener('click', clearData);
  $('btnDash').addEventListener('click', function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });
  $('btnOpenLib').addEventListener('click', function () {
    chrome.tabs.create({ url: 'https://www.facebook.com/ads/library/' });
    window.close();
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && (msg.type === 'AS_PROGRESS' || msg.type === 'AS_DONE') && msg.state) { renderRun(msg.state); refreshSaved(); }
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && Object.keys(changes).some(function (k) { return k.indexOf('ad:') === 0; })) refreshSaved();
  });

  (async function init() {
    try {
      // popup.html?tabId=123 lets the popup be opened in a normal tab for testing / screenshots.
      const forced = parseInt(new URLSearchParams(location.search).get('tabId'), 10);
      if (forced) tab = await chrome.tabs.get(forced);
      else tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
      const s = await NS.storage.getSettings();
      if (s.autoScrollMaxAds) $('maxAds').value = String(s.autoScrollMaxAds);
      await refreshSaved();
      await detect();
      pollTimer = setInterval(poll, 2000);
    } catch (e) {
      setPage('err', 'AdScoop could not start', String(e && e.message || e));
    }
  })();
  window.addEventListener('unload', function () { clearInterval(pollTimer); });
})();
