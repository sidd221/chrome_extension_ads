/*
 * AdScoop – dashboard (library, detail drawer, settings).
 * All ad content comes from a web page and is treated as untrusted: every value is written with
 * textContent / setAttribute through the h() helper – never innerHTML.
 */
(function () {
  'use strict';

  const NS = window.AdScoop;
  const H = NS.helpers;
  const S = NS.storage;
  const PAGE = 60;

  const $ = function (id) { return document.getElementById(id); };

  /* ---------- tiny DOM builder ---------- */

  function h(tag, props) {
    const el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      const v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled') { el[k] = !!v; }
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(function (k) { append(el, k); });
    else if (kid instanceof Node) el.appendChild(kid);
    else el.appendChild(document.createTextNode(String(kid)));
  }

  function toast(kind, text, ms) {
    const el = h('div', { class: 'toast ' + kind, text: text });
    $('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, ms || (kind === 'err' ? 10000 : 5000));
  }

  function safeHref(u) {
    const url = H.safeUrl(u || '');
    return url && /^https?:$/.test(url.protocol) ? url.toString() : '';
  }

  /* ---------- state ---------- */

  let ads = [];
  let settings = null;
  let selected = new Set();
  let limit = PAGE;
  let openId = null;
  const filters = { q: '', advertiser: '', platform: '', media: '', status: '', sort: 'extracted-desc' };

  const key = function (a) { return NS.dedupe.adKey(a); };
  const hookOf = function (a) { return a.analysis && a.analysis.hook ? a.analysis.hook : null; };

  /* ---------- loading ---------- */

  async function load() {
    ads = await S.getAll();
    settings = await S.getSettings();
    const ids = new Set(ads.map(key));
    selected.forEach(function (id) { if (!ids.has(id)) selected.delete(id); });
    $('libCount').textContent = String(ads.length);
    $('aiSelected').hidden = !(settings.ai && settings.ai.apiKey);
    populateFilters();
    render();
    if (openId) { const a = ads.find(function (x) { return key(x) === openId; }); if (a) renderDrawer(a); }
  }

  function fillSelect(sel, firstLabel, values, current) {
    const prev = current || '';
    sel.textContent = '';
    sel.appendChild(h('option', { value: '', text: firstLabel }));
    values.forEach(function (v) { sel.appendChild(h('option', { value: v, text: v })); });
    sel.value = values.indexOf(prev) >= 0 ? prev : '';
    return sel.value;
  }

  function populateFilters() {
    const adv = H.uniq(ads.map(function (a) { return a.advertiserName; }).filter(Boolean)).sort(function (a, b) { return a.localeCompare(b); });
    const plats = H.uniq([].concat.apply([], ads.map(function (a) { return String(a.platform || '').split(/,\s*/).filter(Boolean); }))).sort();
    const media = H.uniq(ads.map(function (a) { return a.mediaType; }).filter(Boolean)).sort();
    const stat = H.uniq(ads.map(function (a) { return a.status; }).filter(Boolean)).sort();
    filters.advertiser = fillSelect($('fAdvertiser'), 'All advertisers', adv, filters.advertiser);
    filters.platform = fillSelect($('fPlatform'), 'All platforms', plats, filters.platform);
    filters.media = fillSelect($('fMedia'), 'All media types', media, filters.media);
    filters.status = fillSelect($('fStatus'), 'Any status', stat, filters.status);
  }

  /* ---------- filtering & sorting ---------- */

  function haystack(a) {
    const an = a.analysis || {};
    const hk = an.hook || {};
    return [a.advertiserName, a.adId, a.primaryText, a.headline, a.description, a.cta, a.searchKeyword, a.landingUrl,
      hk.hook, hk.category, an.marketingAngle, an.intendedAudience, an.mainSellingProposition, a.creative && a.creative.ocrText]
      .filter(Boolean).join(' \n ').toLowerCase();
  }

  function filtered() {
    const q = filters.q.trim().toLowerCase();
    const list = ads.filter(function (a) {
      if (filters.advertiser && a.advertiserName !== filters.advertiser) return false;
      if (filters.platform && String(a.platform || '').split(/,\s*/).indexOf(filters.platform) < 0) return false;
      if (filters.media && a.mediaType !== filters.media) return false;
      if (filters.status && a.status !== filters.status) return false;
      if (q && haystack(a).indexOf(q) < 0) return false;
      return true;
    });
    const s = filters.sort;
    const cmpStr = function (x, y) { return String(x || '').localeCompare(String(y || '')); };
    list.sort(function (a, b) {
      if (s === 'extracted-asc') return cmpStr(a.extractedAt, b.extractedAt);
      if (s === 'start-desc') return cmpStr(b.startDate, a.startDate);
      if (s === 'start-asc') return cmpStr(a.startDate || '9999', b.startDate || '9999');
      if (s === 'hook-desc') return ((hookOf(b) && hookOf(b).score) || 0) - ((hookOf(a) && hookOf(a).score) || 0);
      if (s === 'advertiser') return cmpStr(a.advertiserName, b.advertiserName);
      return cmpStr(b.extractedAt, a.extractedAt);
    });
    return list;
  }

  /* ---------- rendering the grid ---------- */

  function previewNode(a, compact) {
    const wrap = h('div', { class: 'preview' + (compact ? ' compact' : '') });
    const src = safeHref(a.imageUrl);
    const placeholder = function (msg) { wrap.textContent = ''; wrap.appendChild(h('div', { class: 'ph', text: msg })); };
    if (src) {
      const img = h('img', { src: src, alt: 'Creative preview for ' + (a.advertiserName || 'ad'), loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', function () { placeholder('Preview unavailable – Meta image links expire. Re-extract the ad to refresh it.'); });
      wrap.appendChild(img);
    } else {
      placeholder(a.mediaType === 'video' ? 'Video ad – no preview image captured' : (a.mediaType === 'text' ? 'Text-only ad' : 'No preview captured'));
    }
    return wrap;
  }

  function scoreText(hk) { return hk && hk.score ? hk.score + '/10 est.' : ''; }

  function card(a) {
    const id = key(a);
    const an = a.analysis || {};
    const hk = an.hook || {};
    const adHref = a.isSample ? '' : safeHref(a.adUrl);
    const cb = h('input', { type: 'checkbox', checked: selected.has(id), 'aria-label': 'Select ad ' + id });
    cb.addEventListener('change', function () {
      if (cb.checked) selected.add(id); else selected.delete(id);
      el.classList.toggle('selected', cb.checked);
      updateBulk();
    });
    const el = h('article', { class: 'card' + (selected.has(id) ? ' selected' : ''), 'data-id': id },
      h('div', { class: 'card-head' }, cb,
        h('div', { class: 'who' },
          h('strong', { text: a.advertiserName || 'Unknown advertiser', title: a.advertiserName || '' }),
          h('div', { class: 'mono muted', text: 'ID ' + id }),
          h('div', { class: 'badges' },
            a.isSample && h('span', { class: 'badge sample', text: 'SAMPLE' }),
            a.status && h('span', { class: 'badge ' + (a.status === 'Active' ? 'ok' : 'off'), text: a.status }),
            a.mediaType && h('span', { class: 'badge', text: a.mediaType }),
            a.platform && h('span', { class: 'badge', text: a.platform })))),
      previewNode(a),
      h('div', { class: 'block' },
        h('div', { class: 'label' }, 'From the ad ', h('span', { class: 'tag', text: 'extracted' })),
        a.primaryText ? h('div', { class: 'text-clamp', text: a.primaryText }) : h('div', { class: 'muted', text: 'No primary text captured' }),
        a.headline && h('div', { class: 'muted', style: 'margin-top:6px;font-size:12.5px', text: a.headline }),
        a.cta && h('span', { class: 'cta', text: a.cta })),
      h('div', { class: 'block infer-block' },
        h('div', { class: 'label' }, '✦ AdScoop analysis ', h('span', { class: 'tag infer', text: 'inferred' })),
        hk.hook ? h('div', { class: 'hook', text: '“' + hk.hook + '”' }) : h('div', { class: 'muted', text: 'No hook – no copy to analyse' }),
        h('div', { class: 'kv' },
          hk.category && h('span', { class: 'chip', text: hk.category }),
          hk.score && h('span', { class: 'chip', text: scoreText(hk), title: hk.scoreLabel || '' }),
          an.marketingAngle && h('span', { class: 'chip', text: 'Angle: ' + an.marketingAngle }),
          an.funnelStage && h('span', { class: 'chip', text: an.funnelStage }))),
      h('div', { class: 'card-foot' },
        h('span', { class: 'muted', text: a.startDate || a.startDateRaw ? 'Started ' + (a.startDate || a.startDateRaw) : 'Start date n/a' }),
        h('span', { class: 'spacer' }),
        adHref ? h('a', { href: adHref, target: '_blank', rel: 'noopener noreferrer', text: 'View original ad ↗' }) : h('span', { class: 'muted', text: a.isSample ? 'sample – no link' : 'no link' }),
        h('button', { class: 'link-btn', type: 'button', text: 'Details', onclick: function () { openDrawer(id); } }),
        h('button', { class: 'icon-btn', type: 'button', title: 'Delete this ad', 'aria-label': 'Delete ad ' + id, text: '🗑', onclick: function () { deleteIds([id], true); } })));
    return el;
  }

  function render() {
    const list = filtered();
    const grid = $('grid');
    grid.textContent = '';
    list.slice(0, limit).forEach(function (a) { grid.appendChild(card(a)); });
    $('empty').hidden = ads.length > 0;
    $('more').hidden = list.length <= limit;
    $('resultInfo').textContent = ads.length
      ? 'Showing ' + Math.min(limit, list.length) + ' of ' + list.length + (list.length !== ads.length ? ' matching (' + ads.length + ' saved)' : ' saved ads')
      : '';
    updateBulk();
  }

  function updateBulk() {
    const list = filtered();
    const n = selected.size;
    $('expSelected').disabled = !n; $('delSelected').disabled = !n; $('reSelected').disabled = !n;
    $('aiSelected').disabled = !n;
    $('expSelected').textContent = n ? 'Export selected (' + n + ')' : 'Export selected';
    const shownIds = list.map(key);
    const allSel = shownIds.length > 0 && shownIds.every(function (id) { return selected.has(id); });
    $('selAll').checked = allSel;
    $('selAll').indeterminate = !allSel && shownIds.some(function (id) { return selected.has(id); });
    $('selLabel').textContent = n ? n + ' selected' : 'Select all shown';
  }

  /* ---------- export ---------- */

  async function exportAds(list, scope) {
    if (!list.length) return toast('err', 'There are no ads to export.');
    try {
      const content = $('csvKind').value;
      const sorted = list.slice().sort(function (a, b) { return String(b.extractedAt || '').localeCompare(String(a.extractedAt || '')); });
      const csv = NS.exporter.buildCsv(sorted, { content: content, formulaGuard: settings.csvFormulaGuard !== false, bom: settings.csvBom !== false });
      const name = NS.exporter.fileName({ content: content, scope: scope });
      await NS.exporter.download(csv, name);
      const hasSample = list.some(function (a) { return a.isSample; });
      toast('ok', 'Exported ' + list.length + ' ads → ' + name + (hasSample ? ' (includes SAMPLE rows, marked in the “Data Source” column)' : ''));
    } catch (e) { toast('err', 'Export failed: ' + (e && e.message || e)); }
  }

  /* ---------- delete / analyse ---------- */

  async function deleteIds(ids, confirmOne) {
    if (!ids.length) return;
    const msg = ids.length === 1 ? 'Delete this ad from your library?' : 'Delete ' + ids.length + ' ads from your library?';
    if ((confirmOne || ids.length > 1) && !window.confirm(msg)) return;
    await S.remove(ids);
    ids.forEach(function (id) { selected.delete(id); });
    if (openId && ids.indexOf(openId) >= 0) closeDrawer();
    await load();
    toast('ok', 'Deleted ' + ids.length + ' ad' + (ids.length === 1 ? '' : 's') + '.');
  }

  /** Re-run the local analysis. If an AI analysis exists it is kept; only creative fields refresh. */
  function reanalyseLocal(a) {
    const local = NS.marketingAnalyzer.analyzeAd(a);
    if (a.analysis && a.analysis.aiEnhanced) {
      a.analysis.creativeStyle = local.creativeStyle;
      a.analysis.visualMessaging = local.visualMessaging;
    } else {
      a.analysis = local;
    }
    return a;
  }

  async function reanalyseIds(ids) {
    const list = await S.getAds(ids);
    list.forEach(function (a) {
      if (a.analysis && a.analysis.aiEnhanced) delete a.analysis;     // explicit re-analysis resets to local
      a.analysis = NS.marketingAnalyzer.analyzeAd(a);
    });
    await S.putMany(list);
    await load();
    toast('ok', 'Re-analysed ' + list.length + ' ads with the local engine.');
  }

  async function aiAnalyse(a, btn) {
    if (!(settings.ai && settings.ai.apiKey)) return toast('err', 'Add your own API key in Settings → Optional AI analysis first.');
    if (!(await NS.creative.ensureHostAccess(NS.aiAnalyzer.normaliseBase(settings.ai.baseUrl, settings.ai.provider)))) return toast('err', 'Permission for the AI provider address was declined, so nothing was sent.');
    if (btn) btn.disabled = true;
    try {
      a.analysis = await NS.aiAnalyzer.analyzeWithAI(a, settings);
      await S.put(a);
      toast('ok', 'AI analysis saved (marked as inferred).');
      await load();
    } catch (e) { toast('err', 'AI analysis failed: ' + (e && e.message || e)); }
    finally { if (btn) btn.disabled = false; }
  }

  async function aiAnalyseMany(ids) {
    if (!(settings.ai && settings.ai.apiKey)) return toast('err', 'Add your own API key in Settings first.');
    if (!window.confirm('Send the copy of ' + ids.length + ' ad(s) to your AI provider (' + (settings.ai.baseUrl || 'default') + ')? This uses your own API credit.')) return;
    if (!(await NS.creative.ensureHostAccess(NS.aiAnalyzer.normaliseBase(settings.ai.baseUrl, settings.ai.provider)))) return toast('err', 'Permission for the AI provider address was declined, so nothing was sent.');
    const list = await S.getAds(ids);
    let ok = 0, fail = 0, firstErr = '';
    for (let i = 0; i < list.length; i++) {
      $('resultInfo').textContent = 'AI analysis ' + (i + 1) + '/' + list.length + '…';
      try { list[i].analysis = await NS.aiAnalyzer.analyzeWithAI(list[i], settings); await S.put(list[i]); ok++; }
      catch (e) { fail++; firstErr = firstErr || String(e && e.message || e); if (/key|quota|rate limit|429|401|403/i.test(firstErr)) break; }
    }
    await load();
    toast(fail ? 'err' : 'ok', 'AI analysis: ' + ok + ' done' + (fail ? ', ' + fail + ' failed. ' + firstErr : '.'));
  }

  /* ---------- detail drawer ---------- */

  function dl(rows) {
    const el = h('dl', { class: 'dl' });
    rows.forEach(function (r) {
      if (r[1] == null || r[1] === '' || (Array.isArray(r[1]) && !r[1].length)) return;
      el.appendChild(h('dt', { text: r[0] }));
      const dd = h('dd');
      if (r[2] === 'link') { const href = safeHref(r[1]); dd.appendChild(href ? h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', text: r[1] }) : document.createTextNode(String(r[1]))); }
      else dd.textContent = Array.isArray(r[1]) ? r[1].join(' · ') : String(r[1]);
      el.appendChild(dd);
    });
    return el;
  }

  function list(items) {
    return items && items.length ? h('ul', { class: 'ul' }, items.map(function (x) { return h('li', { text: x }); })) : null;
  }

  function section(cls, title, tag, body) {
    return h('div', { class: 'sect ' + cls }, h('h3', {}, title, tag), body);
  }

  function renderDrawer(a) {
    const id = key(a);
    const an = a.analysis || {};
    const hk = an.hook || {};
    const cr = a.creative || {};
    $('dTitle').textContent = a.advertiserName || 'Unknown advertiser';
    $('dSub').textContent = 'Ad ID ' + id + (a.isSample ? ' · SAMPLE DATA' : '');
    const body = $('dBody');
    body.textContent = '';

    // 1) extracted
    const adHref = a.isSample ? '' : safeHref(a.adUrl);
    body.appendChild(section('', 'From the ad', h('span', { class: 'tag', text: 'extracted from the Ad Library page' }), h('div', {},
      dl([
        ['Status', a.status], ['Started', a.startDate || a.startDateRaw], ['Ended', a.endDate || a.endDateRaw],
        ['Platform', a.platform], ['Media type', a.mediaType], ['Variations', a.variations === '' || a.variations == null ? a.variationsNote : (a.variations + (a.variationsNote ? ' (' + a.variationsNote + ')' : ''))],
        ['Headline', a.headline], ['Description', a.description], ['CTA button', a.cta],
        ['Landing page', a.landingUrl, 'link'], ['Display domain', a.displayDomain], ['Page ID', a.pageId],
        ['Search keyword', a.searchKeyword], ['Country', a.country], ['Extracted', a.extractedAt],
        ['Ad Library link', adHref, 'link']
      ]),
      h('div', { class: 'label', style: 'margin-top:12px', text: 'Primary text' }),
      h('pre', { class: 'fulltext', text: a.primaryText || '(none captured)' }))));

    // 2) creative
    body.appendChild(creativeSection(a, cr));

    // 3) analysis
    if (an && (an.hook || an.engine)) {
      const w = h('div', {},
        h('p', { class: 'notice', text: 'Everything in this block is an inference by ' + (an.engine || 'the analysis engine') + ' – Meta does not publish it. Treat it as a starting point.' }),
        h('div', { class: 'label', text: 'Hook' }),
        dl([
          ['Opening hook', hk.hook], ['Category', hk.category + (hk.secondaryCategory ? ' (+ ' + hk.secondaryCategory + ')' : '')],
          ['Why it may work', hk.why], ['Strength', hk.score ? hk.score + ' / 10 – ' + (hk.scoreLabel || 'estimated') : ''],
          ['Score factors', (hk.factors || []).map(function (f) { return f.label + ' (' + (f.delta > 0 ? '+' : '') + f.delta + ')'; })]
        ]),
        h('div', { class: 'label', style: 'margin-top:12px', text: 'Copy' }),
        dl([
          ['Main selling proposition', an.mainSellingProposition], ['Key benefits', an.keyBenefits], ['Pain points', an.painPoints],
          ['Emotional triggers', an.emotionalTriggers], ['Persuasive techniques', an.persuasiveTechniques],
          ['Offer / discount', an.offer && an.offer.summary], ['Urgency', an.urgency && an.urgency.urgency], ['Scarcity', an.urgency && an.urgency.scarcity]
        ]),
        h('div', { class: 'label', style: 'margin-top:12px', text: 'Strategy' }),
        dl([
          ['Marketing angle', an.marketingAngle], ['Secondary angles', an.secondaryAngles], ['Intended audience', an.intendedAudience],
          ['Industry', an.industry], ['Awareness stage', an.awarenessStage], ['Funnel stage', an.funnelStage], ['Funnel reasoning', an.funnelReason],
          ['Likely objective', an.campaignObjective], ['CTA strategy', an.ctaStrategy], ['USP', an.usp]
        ]),
        h('div', { class: 'label', style: 'margin-top:12px', text: 'Creative' }),
        dl([['Creative style', an.creativeStyle], ['Visual messaging', an.visualMessaging]]),
        dl([['Confidence', an.confidence], ['Language', an.language], ['Notes', an.notes]]));
      body.appendChild(section('infer', '✦ AdScoop analysis', h('span', { class: 'tag infer', text: 'inferred' }), w));
    }

    // 4) limitations
    if (a.limitations && a.limitations.length) {
      body.appendChild(section('', 'Extraction notes', h('span', { class: 'tag machine', text: 'what could not be read' }), list(a.limitations)));
    }

    // 5) actions
    const aiBtn = h('button', { class: 'btn outline', type: 'button', text: 'Analyse with AI (your key)' });
    aiBtn.addEventListener('click', function () { aiAnalyse(a, aiBtn); });
    aiBtn.hidden = !(settings.ai && settings.ai.apiKey);
    body.appendChild(h('div', { class: 'actions-row' },
      h('button', { class: 'btn outline', type: 'button', text: 'Re-analyse (local)', onclick: function () { reanalyseIds([id]); } }),
      aiBtn,
      h('button', { class: 'btn danger', type: 'button', text: 'Delete ad', onclick: function () { deleteIds([id], true); } })));
  }

  function creativeSection(a, cr) {
    const id = key(a);
    const wrap = h('div', { class: 'stack' });
    const imgs = (Array.isArray(a.imageUrls) && a.imageUrls.length ? a.imageUrls : (a.imageUrl ? [a.imageUrl] : [])).map(safeHref).filter(Boolean).slice(0, 6);
    if (imgs.length) {
      wrap.appendChild(h('div', { class: 'thumbs' }, imgs.map(function (u) {
        const img = h('img', { src: u, alt: 'Creative image', loading: 'lazy', referrerpolicy: 'no-referrer' });
        img.addEventListener('error', function () { img.remove(); });
        return img;
      })));
    }
    if (a.videoUrl) wrap.appendChild(dl([['Video URL', a.videoUrl, 'link']]));

    // OCR
    const ocrStatus = h('div', { class: 'note', 'aria-live': 'polite' });
    const ocrBtn = h('button', { class: 'btn outline small', type: 'button', text: cr.ocrStatus === 'done' ? 'Run OCR again' : 'Read text from image (OCR)' });
    const canOcr = (a.imageUrls && a.imageUrls.length) || a.imageUrl;
    ocrBtn.disabled = !canOcr;
    ocrBtn.addEventListener('click', async function () {
      const first = NS.creative.candidateImages(a)[0];
      if (first && !(await NS.creative.ensureHostAccess(first))) { ocrStatus.textContent = 'Permission to download the image was declined, so OCR did not run.'; return; }
      ocrBtn.disabled = true;
      const patch = await NS.creative.ocrAd(a, settings, { onProgress: function (t, f) { ocrStatus.textContent = t + (f ? ' ' + Math.round(f * 100) + '%' : ''); } });
      await saveCreative(a, patch);
      toast(patch.ocrStatus === 'done' ? 'ok' : 'err', patch.ocrStatus === 'done' ? (patch.ocrText ? 'OCR finished.' : 'OCR finished – no readable text in the image.') : 'OCR: ' + (patch.ocrNote || patch.ocrStatus));
    });
    wrap.appendChild(h('div', { class: 'label', text: 'Image text (OCR)' }));
    wrap.appendChild(h('div', { class: 'note', text: ocrLine(cr) }));
    if (cr.ocrText) wrap.appendChild(h('pre', { class: 'fulltext', text: cr.ocrText }));
    wrap.appendChild(h('div', { class: 'actions-row' }, ocrBtn));
    wrap.appendChild(ocrStatus);
    if (!canOcr) wrap.appendChild(h('div', { class: 'note', text: 'No image URL was captured for this ad.' }));

    // transcript (only meaningful for video ads, but pasting is allowed anywhere)
    wrap.appendChild(h('div', { class: 'label', style: 'margin-top:8px', text: 'Video transcript' }));
    wrap.appendChild(h('div', { class: 'note', text: transcriptLine(cr, a) }));
    if (cr.transcript) {
      wrap.appendChild(h('pre', { class: 'fulltext', text: NS.exporter.timestamped(cr) || cr.transcript }));
      const open3 = NS.exporter.openingSeconds(cr, 3);
      if (open3) wrap.appendChild(h('div', { class: 'note', text: 'Opening 3 seconds: ' + open3 }));
    }
    const trStatus = h('div', { class: 'note', 'aria-live': 'polite' });
    if (a.mediaType === 'video' || cr.transcriptStatus) {
      const trBtn = h('button', { class: 'btn outline small', type: 'button', text: 'Transcribe with my API key' });
      trBtn.addEventListener('click', async function () {
        const url = a.videoUrl;
        if (url && settings.transcription && settings.transcription.apiKey) {
          const okVideo = await NS.creative.ensureHostAccess(url);
          const okApi = await NS.creative.ensureHostAccess(NS.aiAnalyzer.normaliseBase(settings.transcription.baseUrl, 'openai-compatible'));
          if (!okVideo || !okApi) { trStatus.textContent = 'A permission was declined, so nothing was downloaded or sent.'; return; }
        }
        trBtn.disabled = true;
        const patch = await NS.creative.transcribeAd(a, settings, { onProgress: function (t) { trStatus.textContent = t; } });
        await saveCreative(a, patch);
        toast(patch.transcriptStatus === 'done' ? 'ok' : 'err', patch.transcriptStatus === 'done' ? 'Transcript saved.' : 'Transcription: ' + (patch.transcriptNote || patch.transcriptStatus));
      });
      wrap.appendChild(h('div', { class: 'actions-row' }, trBtn));
    }
    const ta = h('textarea', { placeholder: 'Or paste a transcript here. Optional "[0:03] text" line prefixes become timestamps.', 'aria-label': 'Paste transcript' });
    wrap.appendChild(ta);
    wrap.appendChild(h('div', { class: 'actions-row' },
      h('button', { class: 'btn outline small', type: 'button', text: 'Save pasted transcript', onclick: async function () {
        if (!ta.value.trim()) return toast('err', 'Paste some transcript text first.');
        await saveCreative(a, NS.creative.manualTranscript(ta.value));
        toast('ok', 'Transcript saved (marked as pasted by you).');
      } })));
    wrap.appendChild(trStatus);
    return section('', 'Creative', h('span', { class: 'tag machine', text: 'machine-read · only after you run it' }), wrap);
  }

  function ocrLine(cr) {
    if (!cr.ocrStatus) return 'OCR has not been run for this ad.';
    if (cr.ocrStatus === 'done') return 'Done with ' + (cr.ocrEngine || 'OCR') + (cr.ocrConfidence ? ' · avg. confidence ' + cr.ocrConfidence + '%' : '') + (cr.ocrNote ? ' · ' + cr.ocrNote : '') + '. OCR can contain mistakes.';
    return 'OCR status: ' + cr.ocrStatus + (cr.ocrNote ? ' – ' + cr.ocrNote : '');
  }
  function transcriptLine(cr, a) {
    if (!cr.transcriptStatus) return a.mediaType === 'video' ? 'No transcript yet. Captions are captured automatically only if the page exposes them.' : 'Not a video ad.';
    const eng = cr.transcriptEngine ? ' (' + cr.transcriptEngine + ')' : '';
    if (cr.transcriptStatus === 'page-captions') return 'Captions published with the video were captured' + eng + '. This is not speech-to-text.';
    if (cr.transcriptStatus === 'done' || cr.transcriptStatus === 'manual') return 'Transcript status: ' + cr.transcriptStatus + eng + (cr.transcriptNote ? ' · ' + cr.transcriptNote : '');
    return 'Transcript status: ' + cr.transcriptStatus + (cr.transcriptNote ? ' – ' + cr.transcriptNote : '');
  }

  async function saveCreative(a, patch) {
    a.creative = Object.assign({}, a.creative || {}, patch);
    reanalyseLocal(a);
    await S.put(a);
    await load();
  }

  async function openDrawer(id) {
    const a = ads.find(function (x) { return key(x) === id; });
    if (!a) return;
    openId = id;
    renderDrawer(a);
    $('drawer').setAttribute('aria-hidden', 'false');
    $('dBody').scrollTop = 0;
    const closeBtn = $('drawer').querySelector('.drawer-head button');
    if (closeBtn) closeBtn.focus();
  }
  function closeDrawer() { openId = null; $('drawer').setAttribute('aria-hidden', 'true'); }

  /* ---------- settings ---------- */

  const PROVIDER_DEFAULTS = {
    'openai-compatible': { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    anthropic: { base: 'https://api.anthropic.com', model: 'claude-haiku-5-5' }
  };

  function fillSettings() {
    const s = settings;
    $('s_expand').checked = s.expandSeeMore !== false;
    $('s_highlight').checked = s.highlightExtracted !== false;
    $('s_max').value = s.autoScrollMaxAds;
    $('s_delay').value = s.scrollDelayMs;
    $('s_bom').checked = s.csvBom !== false;
    $('s_guard').checked = s.csvFormulaGuard !== false;
    $('s_ocr').value = s.ocrEngine;
    $('ai_provider').value = s.ai.provider || 'openai-compatible';
    $('ai_base').value = s.ai.baseUrl || '';
    $('ai_model').value = s.ai.model || '';
    $('ai_key').value = s.ai.apiKey || '';
    $('tr_base').value = s.transcription.baseUrl || '';
    $('tr_model').value = s.transcription.model || '';
    $('tr_key').value = s.transcription.apiKey || '';
  }

  function readSettingsForm() {
    const clamp = function (v, lo, hi, d) { v = parseInt(v, 10); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
    return {
      expandSeeMore: $('s_expand').checked,
      highlightExtracted: $('s_highlight').checked,
      autoScrollMaxAds: clamp($('s_max').value, 1, 500, 40),
      scrollDelayMs: clamp($('s_delay').value, 1500, 15000, 2000),
      csvBom: $('s_bom').checked,
      csvFormulaGuard: $('s_guard').checked,
      ocrEngine: $('s_ocr').value,
      ai: { provider: $('ai_provider').value, baseUrl: $('ai_base').value.trim(), model: $('ai_model').value.trim(), apiKey: $('ai_key').value.trim() },
      transcription: { baseUrl: $('tr_base').value.trim(), model: $('tr_model').value.trim(), apiKey: $('tr_key').value.trim() }
    };
  }

  async function requestApiPermissions(next) {
    const wanted = [];
    if (next.ai.apiKey) wanted.push(NS.aiAnalyzer.normaliseBase(next.ai.baseUrl, next.ai.provider));
    if (next.transcription.apiKey) wanted.push(NS.aiAnalyzer.normaliseBase(next.transcription.baseUrl, 'openai-compatible'));
    const origins = H.uniq(wanted.map(NS.creative.originPattern).filter(Boolean));
    if (!origins.length || !chrome.permissions) return true;
    try {
      if (await chrome.permissions.contains({ origins: origins })) return true;
      return await chrome.permissions.request({ origins: origins });
    } catch (e) { return false; }
  }

  /* ---------- sample data & backup ---------- */

  async function loadSamples() {
    try {
      const res = await fetch(chrome.runtime.getURL('sample-data/sample-ads.json'));
      const list = await res.json();
      list.forEach(function (a) { a.isSample = true; a.extractedAt = H.isoNow(); a.analysis = NS.marketingAnalyzer.analyzeAd(a); });
      const r = await S.upsert(list);
      await load();
      toast('ok', 'Loaded ' + (r.added + r.updated) + ' SAMPLE ads. They are invented for testing and are marked SAMPLE everywhere, including the CSV.');
    } catch (e) { toast('err', 'Could not load sample data: ' + (e && e.message || e)); }
  }

  async function removeSamples() {
    const all = await S.getAll();
    const ids = all.filter(function (a) { return a.isSample; }).map(key);
    if (!ids.length) return toast('ok', 'There is no sample data in your library.');
    await S.remove(ids); await load();
    toast('ok', 'Removed ' + ids.length + ' sample ads.');
  }

  async function backup() {
    const all = await S.getAll();
    if (!all.length) return toast('err', 'Nothing to back up yet.');
    const json = JSON.stringify({ app: 'AdScoop', version: 1, exportedAt: H.isoNow(), ads: all }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try { await chrome.downloads.download({ url: url, filename: 'AdScoop_Backup_' + H.dateStamp() + '.json', conflictAction: 'uniquify' }); }
    finally { setTimeout(function () { URL.revokeObjectURL(url); }, 60000); }
    toast('ok', 'Backup of ' + all.length + ' ads saved to your Downloads folder. (API keys are not included.)');
  }

  async function restore(file) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.ads;
      if (!Array.isArray(list)) throw new Error('This file does not look like an AdScoop backup.');
      const clean = list.filter(function (a) { return a && typeof a === 'object' && (a.adId || a.primaryText); });
      const r = await S.upsert(clean);
      await load();
      toast('ok', 'Imported: ' + r.added + ' new, ' + r.updated + ' merged into existing ads.');
    } catch (e) { toast('err', 'Import failed: ' + (e && e.message || e)); }
  }

  /* ---------- views ---------- */

  function showView(name) {
    ['library', 'settings', 'help'].forEach(function (v) { $('view-' + v).hidden = v !== name; });
    document.querySelectorAll('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.view === name)); });
    try { history.replaceState(null, '', '?view=' + name); } catch (e) { /* ignore */ }
    if (name === 'settings') fillSettings();
  }

  /* ---------- wiring ---------- */

  function wire() {
    document.querySelectorAll('.tab').forEach(function (t) { t.addEventListener('click', function () { showView(t.dataset.view); }); });
    $('q').addEventListener('input', H.debounce(function () { filters.q = $('q').value; limit = PAGE; render(); }, 200));
    [['fAdvertiser', 'advertiser'], ['fPlatform', 'platform'], ['fMedia', 'media'], ['fStatus', 'status'], ['sort', 'sort']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { filters[p[1]] = $(p[0]).value; limit = PAGE; render(); });
    });
    $('selAll').addEventListener('change', function () {
      const ids = filtered().map(key);
      if ($('selAll').checked) ids.forEach(function (id) { selected.add(id); }); else ids.forEach(function (id) { selected.delete(id); });
      render();
    });
    $('more').addEventListener('click', function () { limit += PAGE; render(); });
    $('expSelected').addEventListener('click', function () { exportAds(ads.filter(function (a) { return selected.has(key(a)); }), 'selected'); });
    $('expFiltered').addEventListener('click', function () { exportAds(filtered(), 'filtered'); });
    $('expAll').addEventListener('click', function () { exportAds(ads, 'all'); });
    $('delSelected').addEventListener('click', function () { deleteIds(Array.from(selected), true); });
    $('reSelected').addEventListener('click', function () { reanalyseIds(Array.from(selected)); });
    $('aiSelected').addEventListener('click', function () { aiAnalyseMany(Array.from(selected)); });
    $('loadSample').addEventListener('click', loadSamples);
    $('loadSample2').addEventListener('click', loadSamples);
    $('rmSample').addEventListener('click', removeSamples);
    $('backup').addEventListener('click', backup);
    $('restore').addEventListener('change', function (e) { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; });
    $('wipe').addEventListener('click', async function () {
      if (!window.confirm('Delete ALL saved ads? This cannot be undone. (Export a backup first if unsure.)')) return;
      await S.clearAds(); selected.clear(); await load(); toast('ok', 'All saved ads were deleted.');
    });
    $('drawer').addEventListener('click', function (e) { if (e.target && e.target.getAttribute && e.target.getAttribute('data-close')) closeDrawer(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openId) closeDrawer(); });

    $('ai_provider').addEventListener('change', function () {
      const d = PROVIDER_DEFAULTS[$('ai_provider').value];
      const other = PROVIDER_DEFAULTS[$('ai_provider').value === 'anthropic' ? 'openai-compatible' : 'anthropic'];
      if (!$('ai_base').value.trim() || $('ai_base').value.trim() === other.base) $('ai_base').value = d.base;
      if (!$('ai_model').value.trim() || $('ai_model').value.trim() === other.model) $('ai_model').value = d.model;
    });

    $('ai_test').addEventListener('click', async function () {
      const next = readSettingsForm();
      const out = $('ai_test_result');
      out.textContent = 'Asking for permission…';
      if (!next.ai.apiKey) { out.textContent = 'Paste an API key first.'; return; }
      if (!(await requestApiPermissions({ ai: next.ai, transcription: { apiKey: '' } }))) { out.textContent = 'Permission for that address was declined, so nothing was sent.'; return; }
      out.textContent = 'Testing…';
      try { out.textContent = '✓ Connected. The provider replied: ' + (await NS.aiAnalyzer.testConnection(next)); }
      catch (e) { out.textContent = '✗ ' + (e && e.message || e); }
    });

    $('settingsForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      const next = readSettingsForm();
      const granted = await requestApiPermissions(next);
      settings = await S.setSettings(next);
      $('aiSelected').hidden = !(settings.ai && settings.ai.apiKey);
      $('saveMsg').textContent = granted ? 'Saved.' : 'Saved – but access to the API address was declined, so AI/transcription calls will fail until you allow it.';
      toast(granted ? 'ok' : 'err', $('saveMsg').textContent);
    });

    let t = null;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (!Object.keys(changes).some(function (k) { return k.indexOf('ad:') === 0; })) return;
      clearTimeout(t);
      t = setTimeout(load, 500);          // live-refresh while an extraction is running
    });
  }

  (async function init() {
    wire();
    await load();
    const view = new URLSearchParams(location.search).get('view');
    showView(['settings', 'help'].indexOf(view) >= 0 ? view : 'library');
    // test hook (used by the automated tests only; harmless in production)
    window.__adscoop = { reload: load, state: function () { return { ads: ads.length, selected: selected.size }; } };
  })().catch(function (e) { toast('err', 'Dashboard failed to start: ' + (e && e.message || e)); });
})();
