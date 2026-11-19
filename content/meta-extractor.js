/*
 * AdScoop – Meta Ads Library DOM extractor.
 *
 * Meta's class names are obfuscated and change often, so nothing here depends on them.
 * Instead the extractor relies on things that are stable because users read them:
 *
 *   1. CARD DETECTION  – every ad card shows "Library ID: <number>". We find those labels,
 *      then grow upwards to the LARGEST ancestor that still contains exactly one Library ID
 *      (stopping at page chrome such as the search box / navigation / <main>).
 *   2. TOKENISATION    – a card is flattened into an ordered list of text / image / video
 *      tokens in document order (hidden nodes skipped).
 *   3. REGION LOGIC    – the card layout is  [status · Library ID · dates · platforms]
 *      [advertiser · "Sponsored"] [primary text] [media] [domain · headline · description · CTA].
 *      Fields are assigned by position relative to the "Sponsored" label, the first media
 *      element and the CTA button label – not by class names.
 *   4. FALLBACKS       – pre-wrap text blocks, page-link anchors, aria-labels, avatar alt text.
 *
 * Anything that cannot be found is left EMPTY and an explanation is added to `limitations`.
 * Nothing is guessed or invented.
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});
  const H = function () { return NS.helpers; };

  const LIB_ID_RE = /Library\s*ID\s*[:：]?\s*(\d{6,})/i;
  const LIB_ID_GLOBAL = /Library\s*ID\s*[:：]?\s*(\d{6,})/gi;
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, svg: 1, CANVAS: 1, IFRAME: 1 };

  /* ---------- call-to-action labels offered by Meta ---------- */
  const CTA_LABELS = [
    'apply now', 'apply', 'book now', 'book travel', 'book appointment', 'buy now', 'buy tickets',
    'call now', 'contact us', 'contact', 'donate now', 'download', 'get directions', 'get offer',
    'get quote', 'get showtimes', 'get access', 'get updates', 'install now', 'interested',
    'join', 'learn more', 'listen now', 'message us', 'message page', 'open link', 'order now',
    'play game', 'request time', 'save', 'see menu', 'sell now', 'send message',
    'send whatsapp message', 'whatsapp message', 'chat on whatsapp', 'send email', 'shop now',
    'shop', 'sign up', 'subscribe', 'use app', 'vote now', 'watch more', 'watch video',
    'start now', 'try now', 'view more', 'view now', 'see more details', 'get started', 'enquire now',
    'inquire now', 'register now', 'reserve now', 'claim offer', 'redeem now', 'call', 'visit page'
  ];
  const CTA_SET = new Set(CTA_LABELS);

  function isCtaLabel(text) {
    const t = H().cleanInline(text).toLowerCase().replace(/[.!›>»→]+$/, '').trim();
    return CTA_SET.has(t);
  }

  /** Text that belongs to Ad Library chrome, never to the ad itself. */
  const META_JUNK = new RegExp('^(?:' + [
    'sponsored', 'active', 'inactive', 'see more', 'see less', 'see ad details', 'see summary details',
    'open dropdown', 'platforms?', 'categories', 'ad details', 'about this ad', 'about the advertiser',
    'library id.*', 'started running on.*', 'total active time.*', 'this ad has multiple versions',
    'multiple versions', '\\d+\\s+ads?\\s+use\\s+this\\s+creative\\s+and\\s+text', 'ad library report',
    'report ad', 'save ad', 'copy link', '…', '\\.\\.\\.', '·', '[-–—|•]'
  ].join('|') + ')$', 'i');

  const DOMAIN_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[\/?#]\S*)?$/i;
  function looksLikeDomain(t) { return t.length < 80 && !/\s/.test(t) && DOMAIN_RE.test(t); }

  const PLATFORM_NAMES = ['Facebook', 'Instagram', 'Messenger', 'Audience Network', 'Threads', 'WhatsApp'];

  /* ---------- page context ---------- */

  function getPageContext(loc) {
    loc = loc || root.location;
    const u = H().safeUrl(loc.href) || { searchParams: new URLSearchParams(), hostname: '', pathname: '' };
    const sp = u.searchParams;
    const isFb = /(^|\.)facebook\.com$/i.test(u.hostname);
    const isLib = isFb && /^\/ads\/library/i.test(u.pathname);
    return {
      isAdLibrary: isLib,
      url: loc.href,
      keyword: H().cleanInline(sp.get('q') || ''),
      country: H().cleanInline(sp.get('country') || ''),
      activeStatus: sp.get('active_status') || '',
      adType: sp.get('ad_type') || '',
      searchType: sp.get('search_type') || '',
      viewAllPageId: sp.get('view_all_page_id') || ''
    };
  }

  /* ---------- visibility ---------- */

  function isHidden(el) {
    if (el.hidden) return true;
    try {
      if (typeof el.checkVisibility === 'function') return !el.checkVisibility({ visibilityProperty: true });
      const cs = root.getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    } catch (e) { return false; }
  }

  /* ---------- card detection ---------- */

  function distinctIds(text) {
    const set = new Set();
    let m;
    LIB_ID_GLOBAL.lastIndex = 0;
    while ((m = LIB_ID_GLOBAL.exec(text))) set.add(m[1]);
    return set;
  }

  const CHROME_SELECTOR = 'input, nav, header, [role="search"], [role="navigation"], [role="banner"], [role="tablist"], [role="combobox"]';

  /**
   * Grow from the "Library ID" label to the largest ancestor that still holds exactly one
   * VISIBLE Library ID (hidden copies of other IDs inside a card are ignored).
   */
  function growToCard(startEl, id, idEls) {
    let cur = startEl, best = startEl;
    for (let depth = 0; depth < 25; depth++) {
      const parent = cur.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.matches('main, [role="main"], [role="feed"], form')) break;
      if (parent.querySelector(CHROME_SELECTOR)) break;
      const other = idEls.some(function (x) { return x.id !== id && parent.contains(x.el); });
      if (other) break;
      best = parent; cur = parent;
    }
    return best;
  }

  /**
   * Find every ad card currently in the DOM.
   * @returns {{id:string, el:Element}[]} in document order, one entry per Library ID.
   */
  function detectCards(scope) {
    scope = scope || document.body;
    if (!scope) return [];
    const found = new Map();
    const idEls = [];
    const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return /Library\s*ID/i.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
    });
    let n;
    while ((n = tw.nextNode())) {
      const parent = n.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(parent.tagName)) continue;
      if (parent.closest('[role="dialog"], [aria-modal="true"]')) continue;
      let el = parent, id = null;
      // the number may be in a sibling <span>, so look at ancestors' text for a few levels
      for (let i = 0; i < 4 && el; i++) {
        const m = (el.textContent || '').match(LIB_ID_RE);
        if (m) { id = m[1]; break; }
        el = el.parentElement;
      }
      if (!id || found.has(id)) continue;
      if (isHidden(parent)) continue;
      found.set(id, el);
      idEls.push({ id: id, el: el });
    }
    return Array.from(found, function (kv) { return { id: kv[0], el: growToCard(kv[1], kv[0], idEls) }; });
  }

  /* ---------- tokenisation ---------- */

  function tokenize(card) {
    const tokens = [];
    const tw = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (SKIP_TAGS[n.tagName] || SKIP_TAGS[n.localName]) return NodeFilter.FILTER_REJECT;
          if (isHidden(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return (n.nodeValue && n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) {
        const text = H().cleanInline(n.nodeValue);
        if (!text) continue;
        const el = n.parentElement;
        tokens.push({ t: 'text', text: text, node: n, el: el, inLink: !!(el && el.closest('a[href]')) });
      } else if (n.tagName === 'IMG') {
        const r = sizeOf(n);
        tokens.push({ t: 'img', node: n, el: n, src: n.currentSrc || n.src || n.getAttribute('src') || '', w: r.w, h: r.h, alt: n.alt || '' });
      } else if (n.tagName === 'VIDEO') {
        tokens.push({ t: 'video', node: n, el: n });
      }
    }
    return tokens;
  }

  function sizeOf(img) {
    let w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    try {
      const r = img.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { w = r.width; h = r.height; }
    } catch (e) { /* ignore */ }
    if (!w) w = parseInt(img.getAttribute('width'), 10) || 0;
    if (!h) h = parseInt(img.getAttribute('height'), 10) || 0;
    return { w: w, h: h };
  }

  function isCreativeImage(tok) {
    if (tok.t !== 'img' || !tok.src) return false;
    if (/^data:image\/svg/i.test(tok.src)) return false;
    if (/emoji|static\.xx\.fbcdn\.net\/images/i.test(tok.src)) return false;
    const big = Math.max(tok.w, tok.h);
    if (big === 0) return true;          // size unknown (not laid out): do not drop it
    return big >= 120 && Math.min(tok.w || big, tok.h || big) >= 60;
  }

  function stripQuery(u) { return String(u || '').split('?')[0]; }

  /* ---------- helpers on tokens ---------- */

  function firstIndex(tokens, pred, from, to) {
    for (let i = from || 0; i < (to == null ? tokens.length : to); i++) if (pred(tokens[i], i)) return i;
    return -1;
  }
  function lastIndex(tokens, pred, from, to) {
    for (let i = (to == null ? tokens.length : to) - 1; i >= (from || 0); i--) if (pred(tokens[i], i)) return i;
    return -1;
  }
  const isText = function (t) { return t.t === 'text'; };
  const isJunk = function (t) { return t.t === 'text' && META_JUNK.test(t.text); };
  const isMedia = function (t) { return t.t === 'video' || (t.t === 'img' && t.creative); };

  function blockAncestor(el) {
    let cur = el;
    while (cur && cur.parentElement) {
      try {
        const d = root.getComputedStyle(cur).display;
        if (d !== 'inline' && d !== 'contents' && d !== 'inline-block') return cur;
      } catch (e) { return cur; }
      cur = cur.parentElement;
    }
    return cur;
  }

  function commonAncestor(a, b) {
    const seen = new Set();
    for (let n = a; n; n = n.parentNode) seen.add(n);
    for (let n = b; n; n = n.parentNode) if (seen.has(n)) return n;
    return null;
  }

  /* ---------- "See more" ---------- */

  function findSeeMore(card) {
    const cands = card.querySelectorAll('[role="button"], button, span, div');
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      if (el.children.length > 1) continue;
      const t = H().cleanInline(el.textContent).replace(/^[….\s]+/, '');
      if (/^(see more|see all|read more|और देखें|अधिक देखें)$/i.test(t) && !isHidden(el)) {
        return el.closest('[role="button"], button') || el;
      }
    }
    return null;
  }

  /** Expand truncated ad copy by clicking the page's own "See more" control (user-visible UI action). */
  async function expandSeeMore(card) {
    let clicked = 0;
    for (let i = 0; i < 3; i++) {
      const el = findSeeMore(card);
      if (!el) break;
      try { el.click(); clicked++; } catch (e) { break; }
      await H().sleep(120);
    }
    return clicked;
  }

  /* ---------- text assembly ---------- */

  function tidyCopy(s) {
    let t = H().cleanMultiline(s);
    t = t.replace(/(?:^|\s)(?:…|\.\.\.)?\s*(?:See more|See less|Read more)\s*$/i, '');
    return t.trim();
  }

  function assemblePrimaryText(card, tokens, from, to) {
    const idxs = [];
    for (let i = from; i < to; i++) {
      const tk = tokens[i];
      if (tk.t === 'text' && !isJunk(tk)) idxs.push(i);
    }
    if (!idxs.length) return '';
    // Preferred: let the browser render the shared container (keeps real line breaks).
    const firstTok = tokens[idxs[0]], lastTok = tokens[idxs[idxs.length - 1]];
    const lca = commonAncestor(firstTok.node, lastTok.node);
    let container = lca && lca.nodeType === 3 ? lca.parentElement : lca;
    if (container && container !== card && card.contains(container)) {
      const inside = tokens.filter(function (tk, i) {
        return container.contains(tk.node) && (i < from || i >= to) && !(tk.t === 'text' && isJunk(tk));
      });
      if (!inside.length) {
        const txt = container.innerText != null ? container.innerText : container.textContent;
        const cleaned = tidyCopy(txt);
        if (cleaned) return cleaned;
      }
    }
    // Fallback: join tokens, using a space inside the same block and a newline between blocks.
    let out = '', prevBlock = null;
    idxs.forEach(function (i) {
      const blk = blockAncestor(tokens[i].el);
      out += (out ? (blk === prevBlock ? ' ' : '\n') : '') + tokens[i].text;
      prevBlock = blk;
    });
    return tidyCopy(out);
  }

  /* ---------- individual field helpers ---------- */

  /** Cues of captions/subtitles published with the video. Tracks load lazily, so wait briefly. */
  async function readCaptions(video) {
    const out = { segments: [], text: '' };
    try {
      const tracks = video.textTracks ? Array.from(video.textTracks) : [];
      const usable = tracks.filter(function (tr) { return tr.kind === 'captions' || tr.kind === 'subtitles'; });
      usable.forEach(function (tr) { if (tr.mode === 'disabled') { try { tr.mode = 'hidden'; } catch (e) { /* ignore */ } } });
      for (let waited = 0; waited < 800 && usable.length && usable.every(function (tr) { return !tr.cues || !tr.cues.length; }); waited += 100) {
        await H().sleep(100);
      }
      usable.forEach(function (tr) {
        const cues = tr.cues ? Array.from(tr.cues) : [];
        cues.forEach(function (c) { out.segments.push({ start: c.startTime, end: c.endTime, text: H().cleanInline(c.text) }); });
      });
    } catch (e) { /* ignore */ }
    out.text = out.segments.map(function (s) { return s.text; }).join(' ');
    return out;
  }

  function videoSource(v) {
    const direct = v.currentSrc || v.src || v.getAttribute('src') || '';
    if (direct) return direct;
    const s = v.querySelector('source[src]');
    return s ? s.getAttribute('src') : '';
  }

  function detectPlatforms(card, tokens, iPlatforms) {
    const found = [];
    const add = function (v) {
      const s = H().cleanInline(v);
      PLATFORM_NAMES.forEach(function (p) { if (s.toLowerCase() === p.toLowerCase()) found.push(p); });
    };
    // text right after the "Platforms" label
    if (iPlatforms >= 0) {
      for (let i = iPlatforms + 1; i < Math.min(tokens.length, iPlatforms + 8); i++) {
        if (tokens[i].t !== 'text') continue;
        const parts = tokens[i].text.split(/[,/&]| and /i);
        const before = found.length;
        parts.forEach(add);
        if (found.length === before && !isJunk(tokens[i])) break;
      }
    }
    // accessible names on icons (aria-label / title / alt) – exact matches only
    card.querySelectorAll('[aria-label], [title], img[alt]').forEach(function (el) {
      add(el.getAttribute('aria-label') || '');
      add(el.getAttribute('title') || '');
      if (el.tagName === 'IMG') add(el.getAttribute('alt') || '');
    });
    return H().uniq(found);
  }

  function pageIdFromAnchors(card) {
    const anchors = card.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length; i++) {
      const href = anchors[i].getAttribute('href') || '';
      let m = href.match(/[?&](?:view_all_page_id|page_id)=(\d+)/i) || href.match(/facebook\.com\/profile\.php\?id=(\d+)/i);
      if (m) return m[1];
    }
    return '';
  }

  function advertiserFromAnchors(card) {
    const anchors = card.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href') || '';
      if (!/view_all_page_id=|^https?:\/\/(www\.)?facebook\.com\/(?!ads\/|l\.php|policies|help)[^/?#]+\/?(\?|$)|^\/(?!ads\/)[^/?#]+\/?$/i.test(href)) continue;
      const txt = H().cleanInline(a.innerText != null ? a.innerText : a.textContent);
      if (txt && txt.length <= 120 && !META_JUNK.test(txt) && !isCtaLabel(txt)) return txt;
    }
    return '';
  }

  function landingFromAnchors(card, ctaTok, headTok) {
    const wanted = [];
    [ctaTok, headTok].forEach(function (tk) {
      if (tk && tk.el) { const a = tk.el.closest('a[href]'); if (a) wanted.push(a); }
    });
    Array.from(card.querySelectorAll('a[href]')).forEach(function (a) { if (wanted.indexOf(a) < 0) wanted.push(a); });
    for (let i = 0; i < wanted.length; i++) {
      const raw = wanted[i].getAttribute('href') || '';
      if (!raw || /^(javascript:|#|mailto:|tel:)/i.test(raw)) continue;
      const real = H().decodeFbRedirect(raw);
      const u = H().safeUrl(real);
      if (!u || !/^https?:$/.test(u.protocol)) continue;
      if (H().isFacebookHost(u.hostname)) continue;
      return u.toString();
    }
    return '';
  }

  /* ---------- the extractor ---------- */

  /**
   * Extract one card.
   * @param {Element} card
   * @param {string} id          Library ID (already known from detection)
   * @param {object} ctx         page context (keyword, country…)
   * @param {{expandSeeMore?:boolean}} opts
   * @returns {Promise<object>}  ad record (see sample-data/sample-ads.json for the shape)
   */
  async function extractCard(card, id, ctx, opts) {
    opts = opts || {};
    ctx = ctx || getPageContext();
    const limits = [];
    if (opts.expandSeeMore !== false) await expandSeeMore(card);

    const tokens = tokenize(card);
    tokens.forEach(function (tk) { if (tk.t === 'img') tk.creative = isCreativeImage(tk); });

    /* ---- header markers ---- */
    const iSponsored = firstIndex(tokens, function (t) { return isText(t) && /^(sponsored|प्रायोजित)$/i.test(t.text); });
    const headerLimit = iSponsored >= 0 ? iSponsored : tokens.length;
    const isHeaderMarker = function (t) {
      return isText(t) && (/^(active|inactive)$/i.test(t.text) || LIB_ID_RE.test(t.text) || /^started running on/i.test(t.text) ||
        /^platforms?$/i.test(t.text) || /ads?\s+use\s+this\s+creative/i.test(t.text) || /multiple versions/i.test(t.text) ||
        /^see (ad|summary) details$/i.test(t.text) || /^open dropdown$/i.test(t.text) || /^total active time/i.test(t.text));
    };
    const lastMarker = lastIndex(tokens, isHeaderMarker, 0, headerLimit);
    const bodyStart = iSponsored >= 0 ? iSponsored + 1 : lastMarker + 1;

    /* ---- status & dates (header only, so copy cannot pollute them) ---- */
    const headerText = tokens.slice(0, Math.max(headerLimit, lastMarker + 1)).filter(isText).map(function (t) { return t.text; }).join(' ');
    const stTok = firstIndex(tokens, function (t) { return isText(t) && /^(active|inactive)$/i.test(t.text); }, 0, headerLimit);
    const status = stTok >= 0 ? (/^active$/i.test(tokens[stTok].text) ? 'Active' : 'Inactive') : '';
    const dates = H().parseDateRange(headerText);
    if (!status) limits.push('Ad status not shown on the card');
    if (!dates.start && !dates.startRaw) limits.push('Start date not shown on the card');

    /* ---- advertiser ---- */
    let advertiserName = '';
    if (iSponsored > 0) {
      for (let i = iSponsored - 1; i > lastMarker; i--) {
        const t = tokens[i];
        if (isText(t) && !isJunk(t) && !/^\d+$/.test(t.text) && t.text.length <= 120) { advertiserName = t.text; break; }
      }
    }
    if (!advertiserName) advertiserName = advertiserFromAnchors(card);
    if (!advertiserName) {
      const av = tokens.find(function (t) { return t.t === 'img' && t.alt && Math.max(t.w, t.h) <= 80 && !/emoji/i.test(t.src); });
      if (av) advertiserName = H().cleanInline(av.alt).replace(/ profile picture$/i, '');
    }
    if (!advertiserName) limits.push('Advertiser name could not be read');

    const pageId = pageIdFromAnchors(card);
    if (!pageId) limits.push('Page ID not exposed on the results card');

    /* ---- media ---- */
    const mediaTokIdx = [];
    tokens.forEach(function (t, i) { if (i >= bodyStart && isMedia(t)) mediaTokIdx.push(i); });
    const videos = mediaTokIdx.map(function (i) { return tokens[i]; }).filter(function (t) { return t.t === 'video'; });
    const posterSet = new Set(videos.map(function (v) { return stripQuery(v.node.getAttribute('poster') || ''); }).filter(Boolean));
    const images = mediaTokIdx.map(function (i) { return tokens[i]; }).filter(function (t) {
      return t.t === 'img' && !posterSet.has(stripQuery(t.src));
    });
    const imageUrls = H().uniq(images.map(function (t) { return t.src; }).filter(function (s) { return /^https?:/i.test(s); }));
    const distinctImages = new Set(images.map(function (t) { return stripQuery(t.src); })).size;
    const hasArrow = !!card.querySelector('[aria-label*="next" i], [aria-label*="previous" i], [aria-roledescription="carousel"]');
    let mediaType = 'text';
    const mediaCount = distinctImages + videos.length;
    if (mediaCount >= 2 && (hasArrow || mediaCount >= 3 || distinctImages >= 2)) {
      mediaType = 'carousel';
      limits.push('Carousel inferred from ' + mediaCount + ' media elements on the card');
    } else if (videos.length) mediaType = 'video';
    else if (distinctImages) mediaType = 'image';

    let videoUrl = '';
    let imageUrl = imageUrls[0] || '';
    let captions = null;
    if (videos.length) {
      const v = videos[0].node;
      const src = videoSource(v);
      if (/^https?:/i.test(src)) videoUrl = src;
      else if (src) limits.push('Video is streamed through a blob: URL, so no downloadable video link exists (transcription from URL not possible)');
      else limits.push('No video source was exposed by the page');
      const poster = v.getAttribute('poster') || '';
      if (!imageUrl && /^https?:/i.test(poster)) imageUrl = poster;
      const cap = await readCaptions(v);
      if (cap.segments.length) captions = cap;
    }
    if (imageUrl) limits.push('Image/video URLs are signed Meta CDN links and expire after a while');

    /* ---- CTA, headline, description, domain ---- */
    const firstMedia = mediaTokIdx.length ? mediaTokIdx[0] : -1;
    let ctaIdx = -1;
    if (firstMedia >= 0) ctaIdx = firstIndex(tokens, function (t) { return isText(t) && isCtaLabel(t.text); }, firstMedia + 1);
    else ctaIdx = lastIndex(tokens, function (t) { return isText(t) && isCtaLabel(t.text); }, bodyStart);
    let cta = '';
    if (ctaIdx >= 0) cta = tokens[ctaIdx].text;
    else {
      // some CTA labels are not in my list: accept a short button-like label right after the link block
      limits.push('Call-to-action button not found');
    }

    // link block: tokens between the media item that precedes the CTA and the CTA
    let blockStart = -1;
    if (ctaIdx >= 0) {
      const mBefore = lastIndex(tokens, isMedia, bodyStart, ctaIdx);
      blockStart = mBefore >= 0 ? mBefore + 1 : -1;
    } else if (mediaTokIdx.length) blockStart = mediaTokIdx[mediaTokIdx.length - 1] + 1;

    let blockToks = [];
    let domainIdx = -1;
    if (blockStart >= 0) {
      const end = ctaIdx >= 0 ? ctaIdx : Math.min(tokens.length, blockStart + 4);
      blockToks = tokens.slice(blockStart, end).filter(function (t) { return isText(t) && !isJunk(t); });
    } else if (ctaIdx >= 0) {
      // no media: use a domain-looking token as the beginning of the link block, if present
      domainIdx = lastIndex(tokens, function (t) { return isText(t) && looksLikeDomain(t.text) && t.text === t.text.toUpperCase(); }, bodyStart, ctaIdx);
      if (domainIdx >= 0) blockToks = tokens.slice(domainIdx, ctaIdx).filter(function (t) { return isText(t) && !isJunk(t); });
    }
    let displayDomain = '';
    if (blockToks.length && looksLikeDomain(blockToks[0].text)) { displayDomain = blockToks[0].text; blockToks = blockToks.slice(1); }
    const headTok = blockToks[0] || null;
    const headline = headTok ? headTok.text : '';
    const description = blockToks.slice(1, 4).map(function (t) { return t.text; }).join(' ');

    /* ---- primary text ---- */
    let textEnd = tokens.length;
    if (firstMedia >= 0) textEnd = firstMedia;
    else if (domainIdx >= 0) textEnd = domainIdx;
    else if (ctaIdx >= 0) textEnd = ctaIdx;
    let primaryText = assemblePrimaryText(card, tokens, bodyStart, textEnd);
    if (!primaryText) {
      // fallback: the page often marks ad copy with white-space: pre-wrap
      const pre = Array.from(card.querySelectorAll('[style*="pre-wrap"]'))
        .map(function (e) { return tidyCopy(e.innerText != null ? e.innerText : e.textContent); })
        .filter(function (s) { return s && !META_JUNK.test(s); })
        .sort(function (a, b) { return b.length - a.length; });
      primaryText = pre[0] || '';
    }
    if (!primaryText) limits.push('No primary text on the card (image-only ad or text not rendered)');
    else if (/(…|\.\.\.)$/.test(primaryText) && findSeeMore(card)) limits.push('Primary text may be truncated: the "See more" control could not be expanded');
    if (mediaType !== 'text' && !headline && !description) limits.push('Headline / description not shown on the card');

    /* ---- landing page ---- */
    const landingUrl = landingFromAnchors(card, ctaIdx >= 0 ? tokens[ctaIdx] : null, headTok);
    if (!landingUrl) limits.push('Landing page URL not publicly visible on the card');

    /* ---- platforms ---- */
    const iPlatforms = firstIndex(tokens, function (t) { return isText(t) && /^platforms?$/i.test(t.text); });
    const platforms = detectPlatforms(card, tokens, iPlatforms);
    if (!platforms.length) limits.push('Platform icons carry no readable text on the card (platform left blank)');

    /* ---- variations ---- */
    let variations = '', variationsNote = '';
    const vTok = tokens.find(function (t) { return isText(t) && /(\d+)\s+ads?\s+use\s+this\s+creative\s+and\s+text/i.test(t.text); });
    if (vTok) {
      variations = Number(vTok.text.match(/(\d+)\s+ads?/i)[1]);
      variationsNote = vTok.text;
    } else if (tokens.some(function (t) { return isText(t) && /multiple versions/i.test(t.text); })) {
      variationsNote = 'Ad has multiple versions (count not shown on the card)';
    }

    const rec = {
      adId: id,
      advertiserName: advertiserName,
      pageId: pageId,
      adUrl: 'https://www.facebook.com/ads/library/?id=' + id,
      platform: platforms.join(', '),
      platformSource: platforms.length ? 'card' : '',
      status: status,
      startDate: dates.start,
      startDateRaw: dates.startRaw,
      endDate: dates.end,
      endDateRaw: dates.endRaw,
      primaryText: primaryText,
      headline: headline,
      description: description,
      cta: cta,
      landingUrl: landingUrl,
      displayDomain: displayDomain,
      mediaType: mediaType,
      imageUrl: imageUrl,
      imageUrls: imageUrls,
      videoUrl: videoUrl,
      variations: variations,
      variationsNote: variationsNote,
      textVariants: [],
      searchKeyword: ctx.keyword || '',
      country: ctx.country || '',
      extractedAt: H().isoNow(),
      limitations: H().uniq(limits),
      source: 'ad-library-page'
    };
    if (captions) {
      rec.creative = {
        transcript: captions.text,
        segments: captions.segments,
        transcriptStatus: 'page-captions',
        transcriptEngine: 'captions published with the video (not speech-to-text)'
      };
    }
    return rec;
  }

  /* ---------- blockers (login wall, CAPTCHA, rate limit) ---------- */

  function detectBlockers() {
    try {
      if (document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]')) {
        return { blocked: true, reason: 'A CAPTCHA / security check is showing. Solve it yourself, then try again. AdScoop never bypasses it.' };
      }
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      for (let i = 0; i < dialogs.length; i++) {
        const t = H().cleanInline(dialogs[i].textContent || '').slice(0, 600);
        if (/temporarily blocked|going too fast|try again later|confirm you.?re human|security check|suspicious activity/i.test(t)) {
          return { blocked: true, reason: 'Meta is rate-limiting or checking this browser ("' + H().truncate(t, 90) + '"). Stop, wait, and try again later.' };
        }
        if (/log ?in to continue|you must log ?in|log in to see/i.test(t) && !LIB_ID_RE.test(t)) {
          return { blocked: true, reason: 'Meta is asking you to log in before showing more ads. AdScoop does not bypass log-in walls.' };
        }
      }
    } catch (e) { /* ignore */ }
    return { blocked: false, reason: '' };
  }

  NS.metaExtractor = {
    getPageContext, detectCards, extractCard, expandSeeMore, detectBlockers, tokenize,
    _internals: { isCtaLabel, looksLikeDomain, META_JUNK, CTA_LABELS, distinctIds, LIB_ID_RE, tidyCopy }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.metaExtractor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
