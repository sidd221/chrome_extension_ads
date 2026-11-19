/*
 * AdScoop – creative analysis (OCR + transcription). Runs in the dashboard page only, and only
 * when the user presses a button.
 *
 *  IMAGES   OCR with Tesseract.js, bundled in vendor/tesseract (English + Hindi). Fully offline,
 *           free, no account. Optional alternative: "vision AI" using the user's own API key.
 *  VIDEO    1. captions published inside the page's <video> element are captured at extraction time
 *              (status "page-captions"). That is real text, but it is not speech-to-text.
 *           2. Optional speech-to-text through an OpenAI-compatible /audio/transcriptions endpoint
 *              with the user's own key (status "done", with timestamps).
 *           3. The user can paste a transcript by hand (status "manual").
 *
 * Honesty rules: a status is only "done" when text was really produced. Meta usually streams video
 * through blob: URLs and signed CDN links that expire; when the audio is not reachable the status
 * says so instead of pretending a transcript exists.
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});
  const H = function () { return NS.helpers; };

  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 24 * 1024 * 1024;     // OpenAI-compatible limit is 25 MB

  /* ---------- permissions & fetching ---------- */

  function originPattern(url) {
    const u = H().safeUrl(url);
    if (!u) return '';
    if (/\.fbcdn\.net$/i.test(u.hostname)) return 'https://*.fbcdn.net/*';
    if (/\.cdninstagram\.com$/i.test(u.hostname)) return 'https://*.cdninstagram.com/*';
    return u.protocol + '//' + u.hostname + '/*';     // match patterns cannot contain a port
  }

  /** Ask for access to a media host. Must be called from a user gesture (button click). */
  async function ensureHostAccess(url) {
    const pattern = originPattern(url);
    if (!pattern || typeof chrome === 'undefined' || !chrome.permissions) return true;
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) return true;
      return await chrome.permissions.request({ origins: [pattern] });
    } catch (e) { return false; }
  }

  async function fetchBlob(url, maxBytes, signal) {
    let res;
    try {
      res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal });
    } catch (e) {
      throw new Error('Could not download the file (network/permission problem). Meta CDN links also expire – re-extract the ad from the Ad Library page to refresh the link.');
    }
    if (!res.ok) {
      throw new Error('The media link returned HTTP ' + res.status + (res.status === 403 || res.status === 404 || res.status === 410
        ? ' – signed Meta CDN links expire. Re-extract the ad from the Ad Library page to get a fresh link.' : '.'));
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) throw new Error('The file is larger than ' + Math.round(maxBytes / 1048576) + ' MB, which AdScoop does not process.');
    const blob = await res.blob();
    if (blob.size > maxBytes) throw new Error('The file is larger than ' + Math.round(maxBytes / 1048576) + ' MB, which AdScoop does not process.');
    return blob;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('Could not read the image')); };
      r.readAsDataURL(blob);
    });
  }

  /* ---------- OCR (Tesseract.js, bundled) ---------- */

  const workers = {};

  function tesseractBase() {
    return (typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.getURL('vendor/tesseract/') : '../vendor/tesseract/');
  }

  async function getWorker(lang, onProgress) {
    if (!root.Tesseract) throw new Error('The bundled OCR engine (vendor/tesseract) is not loaded on this page.');
    if (workers[lang]) { workers[lang].onProgress = onProgress; return workers[lang].worker; }
    const holder = { onProgress: onProgress, worker: null };
    const base = tesseractBase();
    holder.worker = await root.Tesseract.createWorker(lang, 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core/',
      langPath: base + 'lang/',
      workerBlobURL: false,        // extension CSP: load the worker straight from the extension package
      gzip: true,
      logger: function (m) { if (holder.onProgress && m && m.status) holder.onProgress(m.status, m.progress || 0); }
    });
    workers[lang] = holder;
    return holder.worker;
  }

  async function terminateWorkers() {
    const list = Object.keys(workers).map(function (k) { return workers[k].worker; });
    Object.keys(workers).forEach(function (k) { delete workers[k]; });
    await Promise.all(list.map(function (w) { return w.terminate().catch(function () { /* ignore */ }); }));
  }

  function langFor(ad) {
    const text = (ad && ad.primaryText) || '';
    const label = (ad && ad.analysis && ad.analysis.language) || '';
    return (H().devanagariRatio(text) > 0.1 || /hindi|hinglish/i.test(label)) ? 'eng+hin' : 'eng';
  }

  /** OCR one image Blob. @returns {{text:string, confidence:number}} */
  async function ocrBlob(blob, lang, onProgress) {
    const worker = await getWorker(lang || 'eng', onProgress);
    const res = await worker.recognize(blob);
    const data = res && res.data ? res.data : {};
    return { text: H().cleanMultiline(data.text || ''), confidence: Math.round(Number(data.confidence) || 0) };
  }

  function candidateImages(ad) {
    const urls = [];
    (Array.isArray(ad.imageUrls) ? ad.imageUrls : []).forEach(function (u) { urls.push(u); });
    if (ad.imageUrl) urls.push(ad.imageUrl);
    return H().uniq(urls.filter(function (u) { return /^https?:/i.test(u); })).slice(0, MAX_IMAGES);
  }

  /**
   * Run OCR (or vision AI) for an ad and return a patch for ad.creative.
   * @param {object} hooks { onProgress(text, fraction) }
   */
  async function ocrAd(ad, settings, hooks) {
    hooks = hooks || {};
    const engine = (settings && settings.ocrEngine) || 'tesseract';
    const now = H().isoNow();
    if (engine === 'off') {
      return { ocrStatus: 'failed', ocrNote: 'OCR is switched off in Settings.', ocrAt: now };
    }
    const urls = candidateImages(ad);
    if (!urls.length) {
      return { ocrStatus: 'unavailable', ocrNote: 'No image URL was captured for this ad (text-only ad, or the image was not exposed by the page).', ocrAt: now };
    }
    const texts = [];
    const confs = [];
    const errors = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        if (hooks.onProgress) hooks.onProgress('Downloading image ' + (i + 1) + '/' + urls.length, 0);
        const blob = await fetchBlob(urls[i], MAX_IMAGE_BYTES, hooks.signal);
        if (engine === 'vision-ai') {
          const dataUrl = await blobToDataUrl(blob);
          if (hooks.onProgress) hooks.onProgress('Reading image ' + (i + 1) + ' with your AI provider', 0.5);
          const t = await NS.aiAnalyzer.readImageText(dataUrl, settings, { signal: hooks.signal });
          if (t) texts.push(t);
        } else {
          const r = await ocrBlob(blob, langFor(ad), function (s, f) {
            if (hooks.onProgress) hooks.onProgress('Image ' + (i + 1) + '/' + urls.length + ': ' + s, f);
          });
          if (r.text) { texts.push(r.text); confs.push(r.confidence); }
        }
      } catch (e) {
        errors.push(String(e && e.message || e));
      }
    }
    const engineLabel = engine === 'vision-ai'
      ? 'vision model via your own API key (' + ((settings.ai && settings.ai.model) || 'unknown') + ')'
      : 'Tesseract.js (bundled, offline)';
    if (!texts.length && errors.length === urls.length) {
      return { ocrStatus: 'failed', ocrNote: errors[0], ocrEngine: engineLabel, ocrAt: now };
    }
    const joined = texts.length > 1
      ? texts.map(function (t, i) { return '[Image ' + (i + 1) + ']\n' + t; }).join('\n\n')
      : (texts[0] || '');
    const patch = {
      ocrStatus: 'done', ocrText: joined, ocrEngine: engineLabel, ocrAt: now, ocrImagesRead: urls.length - errors.length,
      ocrConfidence: confs.length ? Math.round(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length) : '',
      ocrNote: errors.length ? errors.length + ' of ' + urls.length + ' images could not be read: ' + errors[0] : (joined ? '' : 'No readable text found in the image.')
    };
    return patch;
  }

  /* ---------- transcription ---------- */

  function segmentsFromResponse(j) {
    const segs = Array.isArray(j.segments) ? j.segments : [];
    return segs.map(function (s) {
      return { start: Number(s.start) || 0, end: Number(s.end) || 0, text: H().cleanInline(s.text) };
    }).filter(function (s) { return s.text; });
  }

  /** Speech-to-text through the user's own OpenAI-compatible endpoint. Returns a creative patch. */
  async function transcribeAd(ad, settings, hooks) {
    hooks = hooks || {};
    const now = H().isoNow();
    const cfg = (settings && settings.transcription) || {};
    if (!ad.videoUrl || !/^https?:/i.test(ad.videoUrl)) {
      return {
        transcriptStatus: 'unavailable', transcriptAt: now,
        transcriptNote: 'No downloadable video link was captured. Meta normally streams video through blob: URLs, so the audio is not accessible to the extension. You can paste a transcript by hand instead.'
      };
    }
    if (!cfg.apiKey) {
      return { transcriptStatus: 'needs-key', transcriptAt: now, transcriptNote: 'Speech-to-text needs your own API key (Settings → Transcription). Nothing was sent anywhere.' };
    }
    try {
      if (hooks.onProgress) hooks.onProgress('Downloading video…', 0.1);
      const blob = await fetchBlob(ad.videoUrl, MAX_VIDEO_BYTES, hooks.signal);
      const form = new FormData();
      form.append('file', blob, 'ad-video.mp4');
      form.append('model', cfg.model || 'whisper-1');
      form.append('response_format', 'verbose_json');
      if (hooks.onProgress) hooks.onProgress('Transcribing with your provider…', 0.5);
      const base = NS.aiAnalyzer.normaliseBase(cfg.baseUrl, 'openai-compatible');
      const res = await fetch(base + '/audio/transcriptions', {
        method: 'POST', headers: { authorization: 'Bearer ' + cfg.apiKey }, body: form, credentials: 'omit', signal: hooks.signal
      });
      const body = await res.text();
      if (!res.ok) throw new Error('The transcription provider returned HTTP ' + res.status + ': ' + body.slice(0, 200));
      const j = JSON.parse(body);
      const segments = segmentsFromResponse(j);
      const text = H().cleanMultiline(j.text || segments.map(function (s) { return s.text; }).join(' '));
      if (!text) return { transcriptStatus: 'failed', transcriptAt: now, transcriptNote: 'The provider returned an empty transcript (silent video?).' };
      return {
        transcript: text, segments: segments, transcriptStatus: 'done', transcriptAt: now,
        transcriptEngine: (cfg.model || 'whisper-1') + ' via your own API key', transcriptNote: segments.length ? '' : 'The provider returned no timestamps.'
      };
    } catch (e) {
      return { transcriptStatus: 'failed', transcriptAt: now, transcriptNote: String(e && e.message || e) };
    }
  }

  /** User-pasted transcript. Optional "[m:ss] text" line prefixes become timestamped segments. */
  function manualTranscript(text) {
    const clean = H().cleanMultiline(text);
    if (!clean) return { transcript: '', segments: [], transcriptStatus: '', transcriptEngine: '', transcriptNote: '' };
    const segments = [];
    clean.split('\n').forEach(function (line) {
      const m = line.match(/^\[?(\d{1,2}):(\d{2})\]?\s*[-–:]?\s*(.+)$/);
      if (m) {
        const start = Number(m[1]) * 60 + Number(m[2]);
        if (segments.length && !segments[segments.length - 1].end) segments[segments.length - 1].end = start;
        segments.push({ start: start, end: 0, text: m[3] });
      }
    });
    segments.forEach(function (s, i) { if (!s.end) s.end = segments[i + 1] ? segments[i + 1].start : s.start + 3; });
    const plain = segments.length ? segments.map(function (s) { return s.text; }).join(' ') : clean;
    return {
      transcript: plain, segments: segments, transcriptStatus: 'manual', transcriptAt: H().isoNow(),
      transcriptEngine: 'pasted by the user (not machine-generated)', transcriptNote: ''
    };
  }

  NS.creative = {
    ocrAd, ocrBlob, transcribeAd, manualTranscript, ensureHostAccess, originPattern, candidateImages, terminateWorkers, langFor,
    fetchBlob, blobToDataUrl
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.creative;
})(typeof globalThis !== 'undefined' ? globalThis : this);
