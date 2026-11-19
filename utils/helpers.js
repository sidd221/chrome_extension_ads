/*
 * AdScoop – shared helpers (content scripts, popup, dashboard, service worker, Node tests).
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});

  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
    jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
  };
  const pad = function (n) { return String(n).padStart(2, '0'); };

  /** Collapse every kind of whitespace (incl. nbsp / zero-width) into single spaces. */
  function cleanInline(s) {
    return String(s == null ? '' : s).replace(/[​-‍﻿]/g, '').replace(/[\s ]+/g, ' ').trim();
  }

  /** Normalise whitespace but keep the author's line breaks (max one blank line). */
  function cleanMultiline(s) {
    return String(s == null ? '' : s)
      .replace(/[​-‍﻿]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
  }

  const isoNow = function () { return new Date().toISOString(); };
  const dateStamp = function (d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const uniq = function (arr) { return Array.from(new Set((arr || []).filter(function (x) { return x !== '' && x != null; }))); };

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /** Returns a URL object, or null when the string is not a valid absolute URL. */
  function safeUrl(s) {
    try { return new URL(String(s || '')); } catch (e) { return null; }
  }

  function isFacebookHost(hostOrUrl) {
    const host = typeof hostOrUrl === 'string' ? hostOrUrl : (hostOrUrl && hostOrUrl.hostname) || '';
    return /(^|\.)(facebook\.com|fb\.com|fb\.me|fbcdn\.net|instagram\.com|cdninstagram\.com|messenger\.com|meta\.com|whatsapp\.com|wa\.me)$/i.test(host);
  }

  /** Meta wraps outbound links as l.facebook.com/l.php?u=<url>. Returns the real destination (fbclid removed). */
  function decodeFbRedirect(href) {
    const u = safeUrl(href);
    if (!u) return String(href || '');
    let target = u;
    if (/(^|\.)(l|lm)\.facebook\.com$/i.test(u.hostname) || (/(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname === '/l.php')) {
      const inner = safeUrl(u.searchParams.get('u') || '');
      if (inner) target = inner;
    }
    ['fbclid', 'igshid'].forEach(function (p) { target.searchParams.delete(p); });
    return target.toString();
  }

  /** Share (0-1) of letters that are Devanagari – used to detect Hindi copy. */
  function devanagariRatio(text) {
    const s = String(text || '');
    const letters = s.match(/[\p{L}\p{M}]/gu);
    if (!letters || !letters.length) return 0;
    const dev = s.match(/[ऀ-ॿ]/g);
    return (dev ? dev.length : 0) / letters.length;
  }

  /* ---------- dates as shown in the Ad Library ---------- */

  const DAY_FIRST = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/;
  const MONTH_FIRST = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/;
  const DATE_SRC = '(?:\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})';

  function iso(y, m, d) {
    y = +y; m = +m; d = +d;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
    return y + '-' + pad(m) + '-' + pad(d);
  }

  /** "5 Nov 2026" / "Nov 5, 2026" / "2026-11-05" → "2026-11-05". Invalid dates → ''. */
  function parseDate(raw) {
    const s = cleanInline(raw);
    if (!s) return '';
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return iso(m[1], m[2], m[3]);
    m = DAY_FIRST.exec(s);
    if (m && MONTHS[m[2].toLowerCase()]) return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
    m = MONTH_FIRST.exec(s);
    if (m && MONTHS[m[1].toLowerCase()]) return iso(m[3], MONTHS[m[1].toLowerCase()], m[2]);
    return '';
  }

  /** Reads "Started running on 4 Nov 2026" or "1 Sep 2026 - 15 Sep 2026". */
  function parseDateRange(text) {
    const s = cleanInline(text);
    const out = { start: '', end: '', startRaw: '', endRaw: '' };
    const range = new RegExp('(' + DATE_SRC + ')\\s*[-–—]\\s*(' + DATE_SRC + ')').exec(s);
    if (range) {
      out.startRaw = range[1]; out.endRaw = range[2];
      out.start = parseDate(range[1]); out.end = parseDate(range[2]);
      return out;
    }
    const started = new RegExp('started running on\\s+(' + DATE_SRC + ')', 'i').exec(s);
    const first = started || new RegExp('(' + DATE_SRC + ')').exec(s);
    if (first) { out.startRaw = first[1]; out.start = parseDate(first[1]); }
    return out;
  }

  NS.helpers = {
    cleanInline: cleanInline, cleanMultiline: cleanMultiline, truncate: truncate, isoNow: isoNow, dateStamp: dateStamp,
    sleep: sleep, uniq: uniq, debounce: debounce, safeUrl: safeUrl, isFacebookHost: isFacebookHost,
    decodeFbRedirect: decodeFbRedirect, devanagariRatio: devanagariRatio, parseDate: parseDate, parseDateRange: parseDateRange
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
