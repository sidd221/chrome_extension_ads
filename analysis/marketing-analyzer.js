/*
 * AdScoop – local rule-based marketing analysis (default engine, runs offline).
 *
 * analyzeAd(ad) returns a flat `analysis` object that is stored NEXT TO – never mixed into – the extracted
 * fields, so the UI and the CSV can label it clearly as inferred. Nothing here is published by Meta.
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});
  const H = function () { return NS.helpers; };
  const ENGINE = 'AdScoop local rules v1.1 (rule-based, inferred)';

  /* ---------- lexicons ---------- */

  const ANGLES = {
    'Price & Discount': /\b(\d{1,3}\s?%\s?off|off\b|discount|sale\b|deal\b|offer\b|save\b|cheap|affordable|lowest price|best price|budget|emi\b|cashback|flat\s+\d+|sasta|सस्ता|छूट|ऑफर)/gi,
    'Convenience & Speed': /\b(easy|easily|simple|fast|quick|quickly|instant|instantly|hassle[- ]free|in minutes|in \d+ (?:minutes|hours|days)|delivered|delivery|doorstep|one[- ]click|no waiting|effortless|seamless|24\/7)\b/gi,
    'Quality & Premium': /\b(premium|luxury|luxurious|handcrafted|handmade|finest|best quality|high[- ]quality|authentic|certified|durable|crafted|genuine|original|organic|pure|imported|quality)\b/gi,
    'Trust & Social Proof': /\b(trusted|reviews?|rated|testimonials?|since (?:19|20)\d\d|guarantee[d]?|verified|award|#1|years of (?:experience|trust)|\d[\d,]*\+?\s*(?:happy )?(?:customers|clients|families|users)|money[- ]back|rera|bharosa|भरोसा)\b/gi,
    'Problem-Solution': /\b(tired of|struggl\w+|problem|solution|fix\b|stop\b|say goodbye|no more|pain|worried|frustrat\w+|stuck|pareshan|परेशान|समाधान)\b/gi,
    'Transformation & Results': /\b(results?|before and after|transform\w*|lose \d+|gain|grow|boost|increase|double|triple|achieve|glow|stronger)\b/gi,
    'Aspiration & Lifestyle': /\b(dream|lifestyle|imagine|enjoy|freedom|your (?:own|dream)|live (?:the|your)|upgrade your|elevate|living|home sweet)\b/gi,
    'Education & Authority': /\b(how to|tips?|guide|learn|mistakes?|tutorial|expert|webinar|masterclass|free class|workshop|did you know|explained|checklist|step[- ]by[- ]step)\b/gi,
    'Lead Generation / Consultation': /\b(book (?:a|your|now)|consult\w*|site visit|enquire|inquire|enquiry|call (?:us|now)|register|get a quote|free quote|demo|callback|call back|whatsapp|contact us|get in touch|talk to|schedule)\b/gi,
    'Launch & Event': /\b(new\b|launch\w*|introducing|now open|grand opening|announcing|just (?:dropped|launched|arrived)|coming soon|pre[- ]?launch|event|inaugurat\w+)\b/gi,
    'Investment & ROI': /\b(invest\w*|returns?|roi\b|appreciation|high growth|wealth|assets?|rental (?:income|yield)|capital|portfolio|profit\w*|passive income|future[- ]proof)\b/gi,
    'Local / Geo-targeted': /\b(near you|nearby|local|in your (?:city|area)|your neighbou?rhood|serving|available in|only in|across (?:india|the city))\b/gi,
    'Fear / Loss Avoidance': /\b(risk|mistake|avoid|don'?t miss|losing|lose out|warning|before it'?s too late|regret|miss out|beware)\b/gi
  };

  const EMOTIONS = {
    'Fear of missing out (FOMO)': /\b(don'?t miss|miss out|last chance|limited|before it'?s gone|only \d+|ending soon|hurry|exclusive)\b/i,
    'Fear / anxiety': /\b(risk|worr\w+|danger\w*|afraid|scam|mistake|regret|losing|lose|unsafe|threat)\b/i,
    'Trust / security': /\b(trusted|guarantee\w*|secure|safe|certified|verified|protect\w*|reliable|rera|money[- ]back|bharosa|भरोसा)\b/i,
    'Desire / aspiration': /\b(dream|luxury|premium|upgrade|imagine|exclusive|elegant|stunning|beautiful|desire|your own)\b/i,
    'Joy / happiness': /\b(happy|joy\w*|love|enjoy|smile|fun|celebrate|delight\w*|excited|amazing|wonderful)\b/i,
    'Pride / status': /\b(proud|prestig\w+|elite|premium|best[- ]in|number one|#1|award|iconic|status)\b/i,
    'Relief / ease': /\b(relief|relax|stress[- ]free|hassle[- ]free|easy|effortless|peace of mind|no more|finally)\b/i,
    Curiosity: /\b(secret|discover|revealed?|hidden|little[- ]known|surpris\w+|truth|what happens|here'?s why)\b/i,
    'Belonging / community': /\b(join|community|family|together|members?|club|tribe|everyone|our customers)\b/i,
    'Greed / savings': /\b(save|savings|free|bonus|discount|cashback|% off|deal|bargain|profit|earn|returns?)\b/i,
    'Hope / ambition': /\b(grow|success|achieve|future|goal|financial freedom|wealth|opportunity|career|promotion)\b/i
  };

  const TECHNIQUES = {
    Scarcity: /\b(limited (?:stock|seats|units|slots|plots)|only \d+ (?:left|available)|few (?:left|units|seats|plots)|while stocks? last|selling fast|almost sold|last \d+)\b/i,
    'Urgency / deadline': /\b(today only|ends? (?:today|tonight|soon|this|on|tomorrow|sunday|monday|saturday)|hurry|last chance|expires?|limited[- ]time|act now|before (?:midnight|it'?s gone)|offer valid|abhi|अभी)\b/i,
    'Social proof': /\b(\d[\d,]*\+?\s*(?:[a-z]+\s){0,2}(?:customers|clients|users|families|buyers|members|people|parents|students)|trusted by|rated|reviews?|testimonials?|best[- ]sell\w+|loved by)\b|⭐|★/i,
    'Authority / credentials': /\b(certified|award[- ]winning|expert|doctor|dr\.|years of experience|since (?:19|20)\d\d|rera|iso|approved|accredited|featured in|as seen (?:on|in))\b/i,
    'Reciprocity (free offer)': /\bfree (?:shipping|delivery|trial|consultation|demo|gift|site visit|quote|installation|returns?|sample|ebook|guide|class|webinar|checkup|check-up|registration)\b|\bcomplimentary\b|मुफ्त/i,
    'Anchoring / price comparison': /\b(was|mrp|instead of|originally|worth|compare at)\s*(?:₹|rs\.?|\$)?\s?\d/i,
    'Risk reversal': /\b(money[- ]back|guarantee[d]?|no (?:obligation|risk|questions asked|hidden (?:fees|charges))|cancel anytime|refund|free returns|try risk[- ]free|100% satisfaction)\b/i,
    'Specificity (numbers)': /\b\d[\d,.]*\s*(?:%|x\b|days?|hours?|minutes?|weeks?|months?|years?|sq\.?\s?ft|lakh|crore|k\b)/i,
    'Direct address (“you”)': /\b(you|your|you're|aap|आप)\b/i,
    Storytelling: /^(when i|i was|i used to|my story|last year|years ago|one day)|\b(my story|our story|how i|changed my life)\b/im,
    'Question / curiosity hook': /\?|\b(secret|discover|revealed|here'?s why)\b/i,
    'Loss aversion': /\b(don'?t miss|miss out|losing|lose out|before it'?s too late|regret|waste)\b/i,
    'Bonus stacking': /\b(plus|bonus|extra|also get|\+ free|and (?:get )?a free)\b/i,
    'Emoji / visual punctuation': /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    'Audience call-out': /\b(attention|calling all|hey|hello|dear|if you(?:'re| are)|are you (?:a|an))\b/i
  };

  const AUDIENCE_TERMS = [
    'small business owners', 'business owners', 'shop owners', 'restaurant owners', 'agency owners', 'entrepreneurs', 'founders', 'startups', 'marketers',
    'freelancers', 'e-commerce sellers', 'ecommerce sellers', 'sellers', 'real estate agents', 'brokers', 'builders', 'developers',
    'first-time home buyers', 'first time home buyers', 'home buyers', 'homebuyers', 'homeowners', 'landlords', 'investors', 'nris', 'plot buyers', 'buyers',
    'students', 'parents', 'moms', 'mothers', 'dads', 'fathers', 'women', 'men', 'seniors', 'senior citizens', 'teens', 'kids', 'couples', 'newlyweds', 'brides',
    'patients', 'doctors', 'clinics', 'farmers', 'teachers', 'job seekers', 'professionals', 'employees', 'gamers', 'travellers', 'travelers', 'pet owners',
    'fitness enthusiasts', 'runners', 'drivers', 'car owners', 'families', 'millennials', 'gen z'
  ];

  const INDUSTRIES = {
    'Real estate': /\b(plots?|flats?|apartments?|property|properties|rera|sq\.?\s?ft|bhk|villa|registry|site visit|builder|real estate|township|zameen|जमीन|प्लॉट)\b/gi,
    'Fitness & wellness': /\b(workout|gym|fitness|yoga|weight loss|diet|muscle|trainer|wellness)\b/gi,
    'Fashion & apparel': /\b(sneakers?|dress|saree|kurta|fashion|collection|apparel|jeans|shirts?|wear)\b/gi,
    'Health & medical': /\b(clinic|doctor|treatment|homeopath\w*|dental|dentist|medical|therapy|hospital|patients?)\b/gi,
    'Education & training': /\b(course|classes|coaching|admission|exam|webinar|masterclass|certification|tutorial|students?)\b/gi,
    'Food & beverage': /\b(restaurant|cafe|café|menu|pizza|biryani|coffee|food|bakery|dining)\b/gi,
    'Beauty & personal care': /\b(skincare|skin|salon|hair|makeup|beauty|serum|cosmetics?)\b/gi,
    'E-commerce / retail': /\b(shop now|free delivery|cash on delivery|\bcod\b|store|add to cart|free returns)\b/gi,
    'Finance & insurance': /\b(loan|insurance|credit|mutual fund|gst|tax|investment|savings account|demat)\b/gi,
    'Software / SaaS': /\b(software|saas|platform|app\b|automate|automation|dashboard|\bai\b|crm)\b/gi,
    'Travel & hospitality': /\b(hotel|flight|trip|tour|resort|holiday|booking|travel)\b/gi,
    Automotive: /\b(car|bike|scooter|test drive|showroom|suv|ev\b)\b/gi,
    'Marketing & business services': /\b(agency|leads?|seo|branding|website|digital marketing|ads\b|social media)\b/gi
  };

  const CTA_GROUPS = [
    { kind: 'direct-action', objective: 'Sales / Conversions', bofu: true, re: /^(shop now|buy now|order now|buy|shop|add to cart|get offer|order online|buy tickets|book now|call now|apply now|donate now|claim offer|redeem now|reserve now|start now|try now)$/i },
    { kind: 'messaging', objective: 'Messages / Conversations', re: /^(send message|send whatsapp message|whatsapp message|chat on whatsapp|message us|message page|send email)$/i },
    { kind: 'lead', objective: 'Lead Generation', re: /^(contact us|contact|get quote|request time|sign up|subscribe|register now|register|get started|download|inquire now|enquire now|join|see menu|get access|book travel|book appointment|get showtimes|get updates|call)$/i },
    { kind: 'learn', objective: 'Traffic / Awareness', re: /^(learn more|see more details|view more|view now|open link|watch more|watch video|listen now|visit page)$/i },
    { kind: 'install', objective: 'App Installs / Engagement', re: /^(install now|play game|use app)$/i },
    { kind: 'engage', objective: 'Engagement', re: /^(interested|save|vote now)$/i }
  ];

  /* ---------- small utils ---------- */

  const uniq = function (a) { return Array.from(new Set(a)); };
  const count = function (re, s) { re.lastIndex = 0; const m = String(s).match(re); return m ? m.length : 0; };
  const sentences = function (t) { return String(t || '').split(/\n+|(?<=[.!?।])\s+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 3; }); };
  const matching = function (list, re, max) { return list.filter(function (s) { re.lastIndex = 0; return re.test(s); }).slice(0, max); };
  const stripLead = function (s) { return s.replace(/^[^\p{L}\p{N}]+/u, '').trim(); };

  /* ---------- detectors ---------- */

  function detectOffer(text) {
    const t = String(text || '');
    const found = function (re) { return uniq((t.match(re) || []).map(function (s) { return s.trim(); })); };
    const pct = found(/\b(?:up to\s+)?\d{1,3}\s?%\s?(?:off|discount|cashback|extra)?/gi);
    const flat = found(/\bflat\s+(?:₹|rs\.?|\$)?\s?\d[\d,]*(?:\s*off)?|\bsave\s+(?:up to\s+)?(?:₹|rs\.?|\$|€|£)\s?\d[\d,]*|(?:₹|rs\.?|\$|€|£)\s?\d[\d,]*\s*off\b/gi);
    const bogo = found(/\bbuy\s+\d+\s+get\s+\d+(?:\s+free)?|\bbogo\b|\b\d\s+for\s+\d\b/gi);
    const freebies = found(/\bfree\s+(?:shipping|delivery|trial|consultation|demo|gift|site visit|quote|installation|returns?|sample|ebook|guide|class|webinar|checkup|check-up|registration|stamp duty)\b/gi).map(function (s) { return s.toLowerCase(); });
    const prices = found(/(?:₹|\brs\.?\s?|\binr\s?|\$|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|lac|cr|crore|k|\/-))?/gi);
    const codeM = /\b(?:use|apply|enter|with)?\s*(?:code|coupon|promo(?:\s?code)?)\s*[:\-]?\s*["“']?([A-Z0-9]{3,16})\b/.exec(t);
    const emi = /\b(no[- ]cost emi|easy emi|emi (?:available|starting)|bank loan|loan available|financing)\b/i.exec(t);
    const deadlineM = /\b((?:offer )?(?:ends?|valid (?:till|until|through)|expires?|until|till|only (?:till|until))\s+(?:on\s+)?[A-Za-z0-9 ,/-]{3,28})/i.exec(t);

    const types = [];
    if (pct.length) types.push('Percentage discount');
    if (flat.length) types.push('Flat amount off');
    if (bogo.length) types.push('Buy-one-get-one / bundle');
    if (freebies.length) types.push('Free extra (' + freebies.slice(0, 2).join(', ') + ')');
    if (codeM) types.push('Coupon code');
    if (emi) types.push('EMI / financing');
    if (deadlineM) types.push('Time-limited');
    const parts = [];
    if (pct.length || flat.length || bogo.length) parts.push('Discount: ' + pct.concat(flat, bogo).slice(0, 3).join(', '));
    if (freebies.length) parts.push('Freebies: ' + freebies.slice(0, 3).join(', '));
    if (codeM) parts.push('Code: ' + codeM[1]);
    if (emi) parts.push('Financing: ' + emi[1].toLowerCase());
    if (deadlineM) parts.push('Deadline: ' + deadlineM[1].trim());
    if (prices.length) parts.push('Prices mentioned: ' + prices.slice(0, 3).join(', '));
    return { types: types, prices: prices.slice(0, 6), summary: parts.length ? parts.join(' | ') : 'No explicit offer detected', has: !!(pct.length || flat.length || bogo.length || freebies.length || codeM) };
  }

  const URGENCY_RE = /\b(?:limited[- ]time|limited period|limited offer|today only|hurry|last chance|ends? (?:today|tonight|soon|tomorrow|this \w+|on \w+|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(?:st|nd|rd|th)?\s?[a-z]*)|ending soon|don'?t miss(?: out)?|expires?(?: \w+)?|act now|right now|before (?:midnight|it'?s gone|the price goes up)|valid (?:till|until) [A-Za-z0-9 ]{2,15}|abhi|अभी|जल्दी|आखिरी)\b/gi;
  const SCARCITY_RE = /\b(?:only \d+ (?:left|spots|seats|units|plots|pieces|slots)|\d+ (?:left|spots left|seats left|plots left)|few (?:left|seats|units|plots)|limited (?:stock|seats|slots|units|plots)|selling fast|almost sold(?: out)?|while (?:stocks?|supplies) last|last \d+|सीमित)\b/gi;

  function detectAudience(text) {
    const t = String(text || '');
    const found = [];
    AUDIENCE_TERMS.forEach(function (term) {
      const re = new RegExp('\\b' + term.replace(/s$/, '').replace(/[-\s]/g, '[-\\s]') + 's?\\b', 'i');
      if (re.test(t)) found.push(term);
    });
    [/\bif you(?:'re| are)(?: a| an)? ([^,.!?\n]{3,40})/i, /\bare you(?: a| an)? ([^,.!?\n]{3,40})\?/i, /\b(?:attention|calling all|dear) ([A-Za-z][A-Za-z &-]{2,30})(?=[,.!:?\n]|$)/i].forEach(function (p) {
      const m = p.exec(t);
      if (m) found.push(m[1].trim().toLowerCase());
    });
    const cleaned = uniq(found).filter(function (f) { return !/^(you|your|ready|looking|tired|a |an )/.test(f); }).slice(0, 4);
    return cleaned.filter(function (f) { return !cleaned.some(function (o) { return o !== f && o.indexOf(f) >= 0; }); });
  }

  function ctaInfo(cta) {
    const c = String(cta || '').trim();
    for (let i = 0; i < CTA_GROUPS.length; i++) if (CTA_GROUPS[i].re.test(c)) return CTA_GROUPS[i];
    return null;
  }

  function detectLanguage(text) {
    const t = String(text || '');
    if (!/\p{L}/u.test(t)) return '';
    const dev = H().devanagariRatio(t);
    if (dev > 0.5) return 'Hindi';
    if (dev > 0.02) return 'Hindi + English (mixed)';
    const roman = (t.toLowerCase().match(/\b(mein|hai|hain|kya|aap|ke liye|kharid\w*|sasta|ghar|zameen|nahi|abhi|karein|kijiye|wala|wale|apna|bhi|se|ko)\b/g) || []).length;
    return roman >= 2 ? 'Hinglish (romanised Hindi)' : 'English';
  }

  function detectIndustry(text) {
    let best = '', n = 0;
    Object.keys(INDUSTRIES).forEach(function (k) { const c = count(INDUSTRIES[k], text); if (c > n) { n = c; best = k; } });
    return n >= 1 ? best : '';
  }

  function awarenessStage(c) {
    if (c.offer.has && (c.urgency.length || c.scarcity.length || (c.cta && c.cta.bofu))) return 'Most aware';
    if (c.techniques.indexOf('Social proof') >= 0 || c.techniques.indexOf('Authority / credentials') >= 0) return 'Product-aware';
    if (c.benefits.length >= 2 || c.hookCategory === 'Benefit' || c.hookCategory === 'Offer') return 'Solution-aware';
    if (c.pains.length) return 'Problem-aware';
    if (['Curiosity', 'Storytelling', 'Question'].indexOf(c.hookCategory) >= 0 || c.words < 12) return 'Unaware';
    return 'Solution-aware';
  }

  function funnel(c) {
    if ((c.cta && c.cta.bofu) || (c.offer.has && (c.urgency.length || c.scarcity.length || c.offer.code))) {
      return ['BOFU', 'Direct-action CTA and/or an offer with urgency points to ready-to-act people.'];
    }
    if ((c.cta && ['lead', 'messaging', 'install'].indexOf(c.cta.kind) >= 0) || c.offer.has || c.techniques.indexOf('Social proof') >= 0) {
      return ['MOFU', 'Asks for an enquiry, sign-up or message, or leans on proof – aimed at people already considering options.'];
    }
    if (!c.cta || c.cta.kind === 'learn' || ['Education & Authority', 'Launch & Event'].indexOf(c.angle) >= 0) {
      return ['TOFU', 'Soft or no call-to-action with awareness / education framing – aimed at cold audiences.'];
    }
    return ['MOFU', 'Mixed signals; defaulted to the middle of the funnel.'];
  }

  function creativeStyle(ad, c) {
    const media = String(ad.mediaType || '').toLowerCase();
    if (!media) return '';
    if (media === 'text') return 'No image or video was captured (text-only card or media not accessible)';
    if (media === 'video' && (/^(i |my |when i)/im.test(c.text) || c.techniques.indexOf('Storytelling') >= 0)) return 'UGC / testimonial-style video (first-person copy)';
    if (c.offer.has && (media === 'image' || media === 'carousel')) return 'Promotional / offer-led graphic';
    if (media === 'carousel') return 'Multi-card showcase (carousel)';
    if (c.angle === 'Education & Authority') return 'Educational / explainer ' + media;
    if (media === 'video' && c.techniques.indexOf('Social proof') >= 0) return 'Testimonial / proof-led video';
    return (media === 'video' ? 'Video' : 'Static image') + ' creative – visual style cannot be determined from the copy alone';
  }

  /* ---------- main ---------- */

  function analyzeAd(ad) {
    ad = ad || {};
    const text = H().cleanMultiline(ad.primaryText || '');
    const headline = H().cleanInline(ad.headline || '');
    const description = H().cleanInline(ad.description || '');
    const cr = ad.creative || {};
    const all = [text, headline, description].filter(Boolean).join('\n');
    const words = text ? text.split(/\s+/).length : 0;
    const notes = [];
    const analysis = { engine: ENGINE, analyzedAt: H().isoNow(), confidence: 'none', notes: notes, aiEnhanced: false };

    if (!all) {
      notes.push('No ad copy was extracted for this ad (creative-only ad or an extraction limitation), so copy analysis is empty.');
      analysis.hook = NS.hookAnalyzer.analyzeHook('');
      analysis.creativeStyle = creativeStyle(ad, { text: '', techniques: [], offer: { has: false }, angle: '' });
      if (cr.ocrText) analysis.visualMessaging = 'Text read from the image (OCR): ' + H().truncate(H().cleanInline(cr.ocrText), 240);
      return analysis;
    }

    analysis.confidence = words >= 40 ? 'high' : words >= 12 ? 'medium' : 'low';
    const hook = NS.hookAnalyzer.analyzeHook(text || headline);
    if (!text && headline) notes.push('No primary text; the hook was derived from the headline.');
    analysis.hook = hook;

    const sents = sentences(text);
    const bulletLines = text.split('\n').filter(function (l) { return /^\s*[•✅✔✓☑▶►➤➜\-*]\s?\S/.test(l) || /^\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s?\S/u.test(l); });
    const benefitSents = matching(sents, /\b(get|save|boost|grow|increase|improve|achieve|enjoy|earn|reduce|lose|gain|unlock|build|experience|helps?|ensure|guarantee|fast|easy|free|premium|best)\b/gi, 5);
    const seen = {};
    const keyBenefits = bulletLines.concat(benefitSents).map(stripLead).filter(function (x) { const k = x.toLowerCase(); if (!x || seen[k]) return false; seen[k] = 1; return true; }).slice(0, 5);
    const pains = matching(sents, /\b(tired of|struggl\w+|problem|frustrat\w+|worried|worry|can'?t|cannot|stuck|hassle|pain|expensive|waste|confus\w+|difficult|hard to|stress\w*|pareshan|परेशान|delay\w*|fraud|scam|fake)\b/gi, 3);
    const offer = detectOffer(all);
    const urgency = uniq((all.match(URGENCY_RE) || []).map(function (s) { return s.trim(); }));
    const scarcity = uniq((all.match(SCARCITY_RE) || []).map(function (s) { return s.trim(); }));
    const techniques = Object.keys(TECHNIQUES).filter(function (k) { return TECHNIQUES[k].test(all); });
    const emotions = Object.keys(EMOTIONS).filter(function (k) { return EMOTIONS[k].test(all); });

    const angleScores = Object.keys(ANGLES).map(function (k) { return [k, count(ANGLES[k], all) + count(ANGLES[k], hook.hook)]; })
      .filter(function (e) { return e[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; });
    const angle = angleScores.length ? angleScores[0][0] : 'General brand / informational';
    const cta = ctaInfo(ad.cta);
    const audience = detectAudience(all);
    const ctx = { text: all, offer: offer, urgency: urgency, scarcity: scarcity, techniques: techniques, benefits: keyBenefits, pains: pains, words: words, cta: cta, angle: angle, hookCategory: hook.category };
    const f = funnel(ctx);

    analysis.mainSellingProposition = headline && headline.length > 8 ? headline : (keyBenefits[0] || hook.hook || '');
    analysis.keyBenefits = keyBenefits;
    analysis.painPoints = pains;
    analysis.emotionalTriggers = emotions;
    analysis.persuasiveTechniques = techniques;
    analysis.offer = { types: offer.types, prices: offer.prices, summary: offer.summary };
    analysis.urgency = { urgency: urgency, scarcity: scarcity };
    analysis.marketingAngle = angle;
    analysis.secondaryAngles = angleScores.slice(1, 3).filter(function (e) { return e[1] >= 2; }).map(function (e) { return e[0]; });
    analysis.intendedAudience = audience.length ? audience.join(', ') + ' (inferred from wording)' : 'Broad / not explicitly targeted in the copy (inferred)';
    analysis.awarenessStage = awarenessStage(ctx);
    analysis.funnelStage = f[0];
    analysis.funnelReason = f[1];
    analysis.campaignObjective = cta ? cta.objective + ' (likely – inferred from the CTA; Meta does not publish objectives)' : 'Not inferable (no recognised CTA) – inferred';
    analysis.ctaStrategy = cta
      ? '“' + ad.cta + '” is a ' + cta.kind + ' CTA' + (offer.has ? ' backed by an offer' : '') + (urgency.length || scarcity.length ? ' with urgency / scarcity' : '') + '.'
      : (ad.cta ? '“' + ad.cta + '” is not a recognised standard CTA.' : 'No call-to-action button was extracted.');
    const usp = matching(sents.concat(headline ? [headline] : []), /\b(only|first|unique|exclusive|patented|guaranteed|#1|no\s+\w+\s+(?:required|needed|fees|charges)|without|100%|rera|certified|proven|best[- ]in)\b/gi, 1);
    analysis.usp = usp[0] || '';
    analysis.industry = detectIndustry(all);
    analysis.language = detectLanguage(all);
    analysis.creativeStyle = creativeStyle(ad, ctx);

    const ocrOffer = cr.ocrText ? detectOffer(cr.ocrText) : null;
    if (cr.ocrText) {
      analysis.visualMessaging = 'Text read from the image (OCR): ' + H().truncate(H().cleanInline(cr.ocrText), 240) +
        (ocrOffer && ocrOffer.has ? ' | Offer cues inside the creative: ' + ocrOffer.summary : '');
    }
    if (analysis.confidence === 'low') notes.push('Very short copy – treat these inferences with extra caution.');
    if (ad.limitations && ad.limitations.length) notes.push('Extraction limitations on this ad: ' + ad.limitations.length + ' (see “Extraction notes”).');
    return analysis;
  }

  NS.marketingAnalyzer = { analyzeAd: analyzeAd, detectOffer: detectOffer, detectAudience: detectAudience, ENGINE: ENGINE };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.marketingAnalyzer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
