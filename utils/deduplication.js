/*
 * AdScoop – duplicate prevention. The Meta Ad Library ID is the unique key; if a record somehow has none,
 * a stable fingerprint of advertiser + copy is used so the same creative is still never stored twice.
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});

  const COPY_FIELDS = ['primaryText', 'headline', 'description', 'cta'];

  function isEmpty(v) {
    if (v == null || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

  /** Storage key for an ad: its Library ID, or a fingerprint when none exists. */
  function adKey(ad) {
    const id = ad && ad.adId != null ? String(ad.adId).trim() : '';
    if (id) return id;
    return 'fp-' + hash([norm(ad && ad.advertiserName), norm(ad && ad.primaryText), norm(ad && ad.headline)].join('|'));
  }

  /** True when `shorter` looks like a truncated ("… See more") version of `longer`. */
  function isTruncatedCopyOf(shorter, longer) {
    const s = String(shorter).replace(/[…\.\s]*(see more)?\s*$/i, '').trim();
    return s.length > 0 && String(longer).length > s.length && String(longer).indexOf(s) === 0;
  }

  /** Merge a fresh extraction of an ad into what is already saved. Empty values never erase saved data. */
  function mergeAd(existing, incoming) {
    if (!existing) return Object.assign({}, incoming, { firstExtractedAt: incoming.firstExtractedAt || incoming.extractedAt });
    const out = Object.assign({}, existing);
    let copyChanged = false;

    Object.keys(incoming).forEach(function (k) {
      const v = incoming[k];
      if (isEmpty(v)) return;
      if (k === 'creative' && typeof v === 'object') {
        out.creative = Object.assign({}, existing.creative || {}, v);
        return;
      }
      if (k === 'primaryText' && existing.primaryText && v !== existing.primaryText && isTruncatedCopyOf(v, existing.primaryText)) return; // keep the fuller copy
      if (COPY_FIELDS.indexOf(k) >= 0 && String(v) !== String(existing[k] || '')) copyChanged = true;
      out[k] = v;
    });

    out.firstExtractedAt = existing.firstExtractedAt || existing.extractedAt || incoming.extractedAt;
    out.extractedAt = incoming.extractedAt || existing.extractedAt;
    // Analysis describes the copy; it is only discarded when the copy actually changed (it is then recomputed).
    if (copyChanged) delete out.analysis;
    return out;
  }

  /** Collapse duplicates inside one batch (e.g. a card re-rendered while scrolling), keeping order. */
  function dedupeList(list) {
    const map = new Map();
    (list || []).forEach(function (ad) {
      if (!ad || typeof ad !== 'object') return;
      const k = adKey(ad);
      map.set(k, map.has(k) ? mergeAd(map.get(k), ad) : ad);
    });
    return Array.from(map.values());
  }

  NS.dedupe = { adKey: adKey, mergeAd: mergeAd, dedupeList: dedupeList, isEmpty: isEmpty, COPY_FIELDS: COPY_FIELDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.dedupe;
})(typeof globalThis !== 'undefined' ? globalThis : this);
