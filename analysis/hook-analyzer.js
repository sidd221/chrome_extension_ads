/*
 * AdScoop – local rule-based hook analysis (default engine, no network).
 *
 * Everything returned here is INFERRED from the ad copy with keyword / pattern rules. The 1-10 score is an
 * estimated analytical score, NOT performance data. English plus common Hindi / Hinglish ad vocabulary is covered.
 */
(function (root) {
  'use strict';

  const NS = (root.AdScoop = root.AdScoop || {});
  const H = function () { return NS.helpers; };

  const CATEGORIES = ['Question', 'Problem-Solution', 'Curiosity', 'Fear', 'Urgency', 'Benefit', 'Social Proof', 'Storytelling', 'Offer'];
  const SCORE_LABEL = 'Estimated hook strength 1-10 – rule-based heuristic, not a performance prediction';

  // [pattern, weight, signal]
  const RULES = {
    Question: [
      [/\?/, 3, 'asks a question'],
      [/^(are|do|does|did|is|can|could|will|would|have|has|why|how|what|which|who|when|where|ready|looking for|want|need|kya|kaun|kab|kaise|kyun|क्या|कैसे|क्यों)\b/i, 2, 'opens with an interrogative']
    ],
    'Problem-Solution': [
      [/\b(tired of|sick of|fed up|struggl\w+|frustrat\w+|can'?t (?:seem|find|sleep|lose|afford)|stop (?:wasting|losing|worrying|struggling|paying)|say goodbye|no more|say no to|finally|problem|solution|fix(?:es|ed)?|trouble|pain|worried|worry|stuck|hassle|pareshan|परेशान|समाधान)\b/i, 2, 'names a problem or promises a fix']
    ],
    Curiosity: [
      [/\b(secret|discover|revealed?|little[- ]known|hidden|you won'?t believe|here'?s (?:why|how|what)|the truth|surprising|unexpected|what happens|nobody tells|no one tells|what (?:they|most people) (?:don'?t|won'?t)|this (?:one|simple|weird)|trick|hack|raaz|रहस्य)\b/i, 2, 'opens a curiosity gap']
    ],
    Fear: [
      [/\b(warning|danger\w*|risk\w*|mistakes?|losing|lose out|don'?t let|before it'?s too late|avoid|scam|threat\w*|regret|miss out|missing out|beware|harmful|toxic|unsafe|nuksan|नुकसान|धोखा)\b/i, 2, 'uses risk / loss language']
    ],
    Urgency: [
      [/\b(limited (?:time|period|stock|seats|slots|units|offer)|today only|hurry|last chance|ends? (?:today|tonight|soon|tomorrow|this \w+|on \w+)|ending soon|don'?t miss|only \d+ (?:left|spots|seats|units|plots|pieces)|expires?|while (?:stocks?|supplies) last|act now|right now|before (?:it'?s gone|midnight)|few (?:left|seats|units)|abhi|अभी|सीमित|जल्दी|आखिरी)\b/i, 3, 'creates urgency / scarcity']
    ],
    Offer: [
      [/\b\d{1,3}\s?%\s?(?:off|discount|cashback|extra)?|\bflat\s+(?:₹|rs\.?|\$)?\s?\d+|\bfree\b|\bdiscount|\bsale\b|\boffer\b|\bdeal\b|\bbogo\b|\bbuy\s+\d+\s+get\s+\d+|\bcoupon|\bpromo|\bcode\b|\bbonus|\bcashback|\bsave\s+(?:up to\s+)?(?:₹|rs\.?|\$|€|£)?\s?\d+|\bno cost emi|ऑफर|छूट|मुफ्त|मुफ़्त|sasta/i, 3, 'states an offer or discount'],
      [/(?:₹|\brs\.?|\$|€|£)\s?\d[\d,]*/i, 1, 'mentions a price']
    ],
    'Social Proof': [
      [/\b\d[\d,.]*\+?\s*(?:k|m|lakh|million)?\+?\s*(?:[a-z]+\s){0,2}(?:customers|users|people|clients|families|buyers|members|students|businesses|brands|reviews|ratings|sold|downloads|owners|parents)\b/i, 3, 'quantified customer base'],
      [/\b(trusted by|rated|reviews?|testimonials?|best[- ]sell\w+|#1|number one|award[- ]winning|as seen (?:on|in)|recommended by|loved by|voted|top[- ]rated|5[- ]star|verified|bharosa|भरोसा)\b|⭐{2,}|★{2,}/i, 2, 'trust / proof language']
    ],
    Storytelling: [
      [/^(when i|i was|i used to|i never|i'?m (?:a|an)\b|my (?:story|journey|wife|husband|mother|father|son|daughter|friend)|last (?:year|month|week)|\d+ years ago|years ago|one day|she (?:was|had|said)|he (?:was|had|said)|once upon|remember when|meri kahani|मेरी)/i, 3, 'first-person / narrative opening'],
      [/\b(my story|our story|how i|how we|changed my life)\b/i, 2, 'narrative framing']
    ],
    Benefit: [
      [/\b(get|save|boost|grow|increase|improve|achieve|gain|lose \d+|earn|double|triple|unlock|enjoy|experience|transform|build|reduce|cut|win|faster|easier|better|smarter|healthier|stronger|relief|results?|benefits?|fayda|फायदा)\b/i, 1, 'leads with a benefit verb']
    ]
  };

  const WHY = {
    Question: 'A question prompts an instant mental answer and pulls the reader into the copy.',
    'Problem-Solution': 'Naming a pain the viewer already feels creates immediate relevance and promises relief.',
    Curiosity: 'An information gap makes people keep reading to close the loop.',
    Fear: 'Risk / loss framing triggers loss aversion, which is attention-grabbing.',
    Urgency: 'Time or stock pressure pushes the viewer to act now rather than later.',
    Offer: 'A concrete discount or freebie gives a tangible reason to stop scrolling.',
    'Social Proof': 'Numbers and endorsements reduce perceived risk and borrow credibility.',
    Storytelling: 'A narrative opening feels native to the feed and builds identification.',
    Benefit: 'Leading with the outcome tells the viewer straight away what is in it for them.',
    '': 'No strong hook pattern was detected; the opening reads as descriptive rather than persuasive.'
  };

  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}]/u;

  /** First sentence / opening phrase (≈160 chars max). */
  function extractHook(text) {
    const lines = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return '';
    let line = lines[0];
    const letters = line.replace(/[^\p{L}\p{N}]/gu, '');
    if (letters.length < 8 && lines[1]) line = line + ' ' + lines[1];
    const m = /^(.{12,}?[.!?।])(?:\s|$)/.exec(line);
    if (m && m[1].length <= 160) return m[1].trim();
    if (line.length > 160) {
      const cut = line.slice(0, 160);
      const sp = cut.lastIndexOf(' ');
      return cut.slice(0, sp > 80 ? sp : 160).trim() + '…';
    }
    return line;
  }

  function classify(hook, fullText) {
    const opening = String(fullText || '').slice(0, 240);
    const scores = {}, signals = {};
    CATEGORIES.forEach(function (cat) {
      let s = 0;
      RULES[cat].forEach(function (r) {
        if (r[0].test(hook)) { s += r[1] * 2; (signals[cat] = signals[cat] || []).push(r[2]); }
        else if (cat !== 'Question' && cat !== 'Storytelling' && r[0].test(opening)) { s += r[1]; (signals[cat] = signals[cat] || []).push(r[2] + ' (in the opening lines)'); }
      });
      if (s) scores[cat] = s;
    });
    const ranked = CATEGORIES.filter(function (c) { return scores[c]; }).sort(function (a, b) { return scores[b] - scores[a]; });
    if (!ranked.length || scores[ranked[0]] < 2) return { category: '', secondary: '', score: 0, signals: [] };
    return { category: ranked[0], secondary: ranked[1] && scores[ranked[1]] >= 3 ? ranked[1] : '', score: scores[ranked[0]], signals: signals[ranked[0]] || [] };
  }

  /** Estimated 1-10 strength with the list of factors that moved the score. */
  function score(hook, cls) {
    let s = 3;
    const factors = ['Base 3'];
    const add = function (n, why) { s += n; factors.push((n > 0 ? '+' : '') + n + ' ' + why); };
    if (hook.length >= 20 && hook.length <= 90) add(1, 'concise opening (20-90 chars)');
    if (hook.length > 150) add(-1, 'very long opening');
    if (hook.length < 12) add(-1, 'very short opening');
    if (/\d/.test(hook)) add(1, 'specific number');
    if (/\b(you|your|you're|aap|आप|aapka)\b/i.test(hook)) add(1, 'speaks directly to the viewer');
    if (cls.category) add(1, 'clear hook pattern (' + cls.category + ')');
    if (cls.score >= 6) add(1, 'strong pattern match');
    if (/\?\s*$/.test(hook) || cls.category === 'Curiosity') add(1, 'opens a loop');
    if (EMOJI_RE.test(hook)) add(0.5, 'emoji as visual interrupt');
    if (/^(check out|click|visit|we are|welcome to|introducing our)\b/i.test(hook)) add(-1, 'generic brand-first opening');
    return { score: Math.max(1, Math.min(10, Math.round(s))), factors: factors };
  }

  function analyzeHook(text) {
    const hook = extractHook(text);
    if (!hook) return { hook: '', category: '', why: '', score: null, scoreLabel: '', factors: [], confidence: 'none' };
    const cls = classify(hook, text);
    const mods = [];
    if (/\d/.test(hook)) mods.push('uses a specific number');
    if (/\b(you|your)\b/i.test(hook)) mods.push('speaks directly to the viewer');
    if (EMOJI_RE.test(hook)) mods.push('uses an emoji to interrupt the scroll');
    if (hook.length <= 60) mods.push('is short and scannable');
    const sc = score(hook, cls);
    const out = {
      hook: hook,
      category: cls.category,
      why: WHY[cls.category] + (mods.length ? ' It also ' + mods.join(', ') + '.' : ''),
      score: sc.score,
      scoreLabel: SCORE_LABEL,
      factors: sc.factors,
      signals: cls.signals,
      confidence: cls.category ? (cls.score >= 6 ? 'medium' : 'low') : 'low'
    };
    if (cls.secondary) out.secondaryCategory = cls.secondary;
    return out;
  }

  NS.hookAnalyzer = { analyzeHook: analyzeHook, extractHook: extractHook, CATEGORIES: CATEGORIES, SCORE_LABEL: SCORE_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.hookAnalyzer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
