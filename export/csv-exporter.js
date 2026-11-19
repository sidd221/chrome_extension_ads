/*
 * AdScoop – CSV export (RFC 4180, UTF-8 + BOM for Excel, CRLF rows, one ad per row).
 *
 * Column provenance is visible in the header:
 *   (no prefix)  = data read from the Ad Library page
 *   [Derived]    = machine-read from the creative: OCR text, page captions, user-pasted or API transcripts
 *   [Inferred]   = analysis by AdScoop's local rules or the user's own AI model – never published by Meta
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});
  const join = function (v) { return Array.isArray(v) ? v.join(' | ') : (v == null ? '' : v); };
  const an = function (ad, k) { return join(ad && ad.analysis ? ad.analysis[k] : ''); };
  const cr = function (ad, k) { return join(ad && ad.creative ? ad.creative[k] : ''); };

  function mmss(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  /** "[0:00] text" lines for a creative's timestamped segments ('' when there are none). */
  function timestamped(creative) {
    const segs = creative && Array.isArray(creative.segments) ? creative.segments : [];
    return segs.map(function (s) { return '[' + mmss(s.start) + '] ' + String(s.text || '').trim(); }).join('\n');
  }
  /** Spoken / captioned text that starts within the first `n` seconds. */
  function openingSeconds(creative, n) {
    const segs = creative && Array.isArray(creative.segments) ? creative.segments : [];
    return segs.filter(function (s) { return Number(s.start) < n; })
      .map(function (s) { return '[' + mmss(s.start) + '] ' + String(s.text || '').trim(); }).join(' ');
  }

  const sourceLabel = function (ad) {
    if (ad.isSample) return 'SAMPLE / TEST DATA – not a real ad';
    return ad.source === 'ad-library-page' || !ad.source ? 'Extracted from the Meta Ad Library page' : String(ad.source);
  };

  /* group: id (always) | raw | derived | inferred */
  const COLUMNS = [
    { header: 'Ad ID', group: 'id', long: true, get: function (a) { return a.adId; } },
    { header: 'Advertiser Name', group: 'id', get: function (a) { return a.advertiserName; } },
    { header: 'Ad Library URL', group: 'id', get: function (a) { return a.adUrl; } },

    { header: 'Page ID', group: 'raw', long: true, get: function (a) { return a.pageId; } },
    { header: 'Platform', group: 'raw', get: function (a) { return a.platform; } },
    { header: 'Platform Source', group: 'raw', get: function (a) { return a.platformSource; } },
    { header: 'Ad Status', group: 'raw', get: function (a) { return a.status; } },
    { header: 'Start Date', group: 'raw', get: function (a) { return a.startDate || a.startDateRaw; } },
    { header: 'End Date', group: 'raw', get: function (a) { return a.endDate || a.endDateRaw; } },
    { header: 'Primary Text', group: 'raw', get: function (a) { return a.primaryText; } },
    { header: 'Headline', group: 'raw', get: function (a) { return a.headline; } },
    { header: 'Description', group: 'raw', get: function (a) { return a.description; } },
    { header: 'CTA', group: 'raw', get: function (a) { return a.cta; } },
    { header: 'Landing Page URL', group: 'raw', get: function (a) { return a.landingUrl; } },
    { header: 'Display Domain', group: 'raw', get: function (a) { return a.displayDomain; } },
    { header: 'Media Type', group: 'raw', get: function (a) { return a.mediaType; } },
    { header: 'Image URL', group: 'raw', get: function (a) { return a.imageUrl; } },
    { header: 'All Image URLs', group: 'raw', get: function (a) { return a.imageUrls; } },
    { header: 'Video URL', group: 'raw', get: function (a) { return a.videoUrl; } },
    { header: 'Number of Variations', group: 'raw', get: function (a) { return a.variations; } },
    { header: 'Variations Note', group: 'raw', get: function (a) { return a.variationsNote; } },
    { header: 'Search Keyword', group: 'raw', get: function (a) { return a.searchKeyword; } },
    { header: 'Country', group: 'raw', get: function (a) { return a.country; } },
    { header: 'Extraction Date', group: 'raw', get: function (a) { return a.extractedAt; } },
    { header: 'Data Source', group: 'raw', get: sourceLabel },
    { header: 'Extraction Notes', group: 'raw', get: function (a) { return a.limitations; } },

    { header: '[Derived] Text Inside Image (OCR)', group: 'derived', get: function (a) { return cr(a, 'ocrText'); } },
    { header: '[Derived] OCR Status', group: 'derived', get: function (a) { return cr(a, 'ocrStatus') + (a.creative && a.creative.ocrNote ? ': ' + a.creative.ocrNote : ''); } },
    { header: '[Derived] Video Transcript / Captions', group: 'derived', get: function (a) { return cr(a, 'transcript'); } },
    { header: '[Derived] Transcript Status', group: 'derived', get: function (a) { return cr(a, 'transcriptStatus') + (a.creative && a.creative.transcriptNote ? ': ' + a.creative.transcriptNote : ''); } },
    { header: '[Derived] Transcript Source', group: 'derived', get: function (a) { return cr(a, 'transcriptEngine'); } },
    { header: '[Derived] Opening 3 Seconds (video, timestamped)', group: 'derived', get: function (a) { return openingSeconds(a.creative, 3); } },

    { header: '[Inferred] Analysis Engine', group: 'inferred', get: function (a) { return an(a, 'engine'); } },
    { header: '[Inferred] Confidence', group: 'inferred', get: function (a) { return an(a, 'confidence'); } },
    { header: '[Inferred] Opening Hook', group: 'inferred', get: function (a) { return a.analysis && a.analysis.hook ? a.analysis.hook.hook : ''; } },
    { header: '[Inferred] Hook Category', group: 'inferred', get: function (a) { return a.analysis && a.analysis.hook ? a.analysis.hook.category : ''; } },
    { header: '[Inferred] Why The Hook May Work', group: 'inferred', get: function (a) { return a.analysis && a.analysis.hook ? a.analysis.hook.why : ''; } },
    { header: '[Inferred] Hook Strength Score 1-10 (estimated, not performance data)', group: 'inferred', get: function (a) { return a.analysis && a.analysis.hook ? a.analysis.hook.score : ''; } },
    { header: '[Inferred] Main Selling Proposition', group: 'inferred', get: function (a) { return an(a, 'mainSellingProposition'); } },
    { header: '[Inferred] Key Benefits', group: 'inferred', get: function (a) { return an(a, 'keyBenefits'); } },
    { header: '[Inferred] Pain Points Addressed', group: 'inferred', get: function (a) { return an(a, 'painPoints'); } },
    { header: '[Inferred] Emotional Triggers', group: 'inferred', get: function (a) { return an(a, 'emotionalTriggers'); } },
    { header: '[Inferred] Persuasive Techniques', group: 'inferred', get: function (a) { return an(a, 'persuasiveTechniques'); } },
    { header: '[Inferred] Offer / Promotion', group: 'inferred', get: function (a) { return a.analysis && a.analysis.offer ? a.analysis.offer.summary : ''; } },
    { header: '[Inferred] Urgency Language', group: 'inferred', get: function (a) { return a.analysis && a.analysis.urgency ? a.analysis.urgency.urgency : ''; } },
    { header: '[Inferred] Scarcity Language', group: 'inferred', get: function (a) { return a.analysis && a.analysis.urgency ? a.analysis.urgency.scarcity : ''; } },
    { header: '[Inferred] Marketing Angle', group: 'inferred', get: function (a) { return an(a, 'marketingAngle'); } },
    { header: '[Inferred] Secondary Angles', group: 'inferred', get: function (a) { return an(a, 'secondaryAngles'); } },
    { header: '[Inferred] Intended Audience', group: 'inferred', get: function (a) { return an(a, 'intendedAudience'); } },
    { header: '[Inferred] Customer Awareness Stage', group: 'inferred', get: function (a) { return an(a, 'awarenessStage'); } },
    { header: '[Inferred] Funnel Stage', group: 'inferred', get: function (a) { return an(a, 'funnelStage'); } },
    { header: '[Inferred] Funnel Reasoning', group: 'inferred', get: function (a) { return an(a, 'funnelReason'); } },
    { header: '[Inferred] Likely Campaign Objective', group: 'inferred', get: function (a) { return an(a, 'campaignObjective'); } },
    { header: '[Inferred] CTA Strategy', group: 'inferred', get: function (a) { return an(a, 'ctaStrategy'); } },
    { header: '[Inferred] Unique Selling Proposition', group: 'inferred', get: function (a) { return an(a, 'usp'); } },
    { header: '[Inferred] Industry', group: 'inferred', get: function (a) { return an(a, 'industry'); } },
    { header: '[Inferred] Copy Language', group: 'inferred', get: function (a) { return an(a, 'language'); } },
    { header: '[Inferred] Creative Style', group: 'inferred', get: function (a) { return an(a, 'creativeStyle'); } },
    { header: '[Inferred] Visual Messaging', group: 'inferred', get: function (a) { return an(a, 'visualMessaging'); } },
    { header: '[Inferred] Analysis Notes', group: 'inferred', get: function (a) { return an(a, 'notes'); } }
  ];

  const KINDS = {
    full: function () { return true; },
    raw: function (c) { return c.group === 'id' || c.group === 'raw'; },
    analysis: function (c) { return c.group === 'id' || c.group === 'derived' || c.group === 'inferred'; }
  };

  function getColumns(kind) { return COLUMNS.filter(KINDS[kind] || KINDS.full); }

  /** One CSV cell. Numbers pass through; text is quoted when needed; formula-looking text is neutralised. */
  function cell(value, col, guard) {
    if (value == null) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    let s = String(value).replace(/\r\n?/g, '\n');
    if (col && col.long && /^\d{12,}$/.test(s)) s = '="' + s + '"';          // stop Excel turning long IDs into 1.23E+17
    else if (guard && /^[=+\-@\t\r]/.test(s)) s = "'" + s;                      // spreadsheet formula injection guard
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** opts: { content: 'full'|'raw'|'analysis', formulaGuard: true, bom: true } */
  function buildCsv(ads, opts) {
    opts = opts || {};
    const guard = opts.formulaGuard !== false;
    const cols = getColumns(opts.content);
    const lines = [cols.map(function (c) { return cell(c.header, null, false); }).join(',')];
    (ads || []).forEach(function (ad) {
      const a = ad || {};
      lines.push(cols.map(function (c) {
        let v = ''; try { v = c.get(a); } catch (e) { v = ''; }
        return cell(v, c, guard);
      }).join(','));
    });
    return (opts.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
  }

  /** Meta_Ads_Intelligence[_Raw|_Analysis][_Selected|_Shown]_YYYY-MM-DD.csv */
  function fileName(opts) {
    opts = opts || {};
    const parts = ['Meta_Ads_Intelligence'];
    if (opts.content === 'raw') parts.push('Raw');
    else if (opts.content === 'analysis') parts.push('Analysis');
    if (opts.scope === 'selected') parts.push('Selected');
    else if (opts.scope === 'filtered') parts.push('Shown');
    parts.push(NS.helpers.dateStamp(opts.date));
    return parts.join('_') + '.csv';
  }

  /** Save through the Chrome Downloads API (blob URL); falls back to an <a download> click. */
  async function download(csv, name) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const release = function () { setTimeout(function () { URL.revokeObjectURL(url); }, 60000); };
    try {
      if (root.chrome && root.chrome.downloads && root.chrome.downloads.download) {
        const id = await root.chrome.downloads.download({ url: url, filename: name, saveAs: false, conflictAction: 'uniquify' });
        release();
        return id;
      }
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      release();
      return null;
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }

  NS.exporter = { COLUMNS: COLUMNS, getColumns: getColumns, buildCsv: buildCsv, fileName: fileName, download: download, timestamped: timestamped, openingSeconds: openingSeconds };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.exporter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
