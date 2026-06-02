export type CodeExtractorInput = {
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  bodyPreview?: string;
};

export type CodeCandidate = {
  code: string;
  maskedCode: string;
  source: 'subject' | 'bodyText' | 'bodyHtml' | 'bodyPreview' | 'combined';
  confidence: number;
  reason: string;
  contextSnippet?: string;
};

export type CodeExtractionResult =
  | {
      success: true;
      code: string;
      maskedCode: string;
      confidence: number;
      candidates: CodeCandidate[];
      warnings: string[];
    }
  | {
      success: false;
      code: null;
      maskedCode: null;
      confidence: 0;
      candidates: CodeCandidate[];
      warnings: string[];
      reason: string;
    };

const STRONG_KEYWORDS_EN: readonly string[] = [
  'security code',
  'confirmation code',
  'verification code',
  'login code',
  'one-time code',
  'one time code',
  'two-factor code',
  '2fa code',
  'facebook code',
  'meta code',
];

const STRONG_KEYWORDS_VI: readonly string[] = [
  'mã xác minh',
  'mã xác nhận',
  'mã bảo mật',
  'mã đăng nhập',
  'mã một lần',
  'mã facebook',
  'mã meta',
  'mã xác thực',
];

const WEAK_KEYWORDS_EN: readonly string[] = ['code'];
const WEAK_KEYWORDS_VI: readonly string[] = ['mã'];

// Brand / verification-intent words. In a real Facebook/Meta email the security
// framing ("verify your Facebook account for security") is often phrased around
// the code rather than as the exact "<x> code" bigram the strong list expects.
// This mirrors the trusted vocabulary the upstream detector already accepts, so
// an email the detector treats as Facebook verification is not then rejected by
// the extractor purely for lacking an adjacent keyword phrase. It is a modest
// fallback signal, only applied near the candidate and only when no strong
// keyword matched — it cannot, on its own, push noise over the threshold.
const BRAND_CONTEXT_KEYWORDS_EN: readonly string[] = [
  'facebook',
  'meta',
  'instagram',
  'verify',
  'verification',
  'security',
  'confirm',
  'confirmation',
  'login',
  'sign in',
  'sign-in',
  'two-factor',
  'two factor',
  '2fa',
];

const BRAND_CONTEXT_KEYWORDS_VI: readonly string[] = [
  'xác minh',
  'xác nhận',
  'xác thực',
  'bảo mật',
  'đăng nhập',
];

const NEGATIVE_KEYWORDS: readonly string[] = [
  'case',
  'ticket',
  'invoice',
  'phone',
  'tel:',
  'ip:',
  'ipv4',
  'ipv6',
  'address',
  'reference',
  'ref:',
  'order',
  'tracking',
  'số điện thoại',
  'điện thoại',
  'hóa đơn',
  'số hóa đơn',
  'đơn hàng',
];

const PHRASE_PATTERNS: readonly RegExp[] = [
  /is your[^.\n]{0,40}code/i,
  /your[^.\n]{0,40}code is\s+\d/i,
  /code is\s+\d/i,
  /code:\s*\d/i,
  /của bạn là\s+\d/i,
  /mã[^.\n]{0,40}là\s+\d/i,
];

const SCORE = {
  SIX_DIGITS: 30,
  FIVE_OR_LONG_DIGITS: 15,
  STRONG_KEYWORD_NEAR: 40,
  STRONG_KEYWORD_FAR: 20,
  WEAK_KEYWORD_NEAR: 15,
  BRAND_CONTEXT_NEAR: 15,
  IN_SUBJECT_WITH_KEYWORD: 20,
  IN_BODY_WITH_KEYWORD: 20,
  PHRASE_MATCH: 20,
  IN_URL: -50,
  DATE_LIKE: -30,
  NEGATIVE_KEYWORD_NEAR: -30,
} as const;

const PASS_THRESHOLD = 70;
const STRONG_CONTEXT_WINDOW = 40;
const FALLBACK_CONTEXT_WINDOW = 80;
const NEGATIVE_CONTEXT_WINDOW = 20;
const SIMILAR_CANDIDATES_DELTA = 15;
const CONTEXT_SNIPPET_WINDOW = 30;

const CODE_PATTERN_SOURCE = '\\b\\d{5,8}\\b';
const URL_PATTERN_SOURCE = 'https?:\\/\\/\\S+';

type Source = 'subject' | 'bodyText' | 'bodyHtml' | 'bodyPreview';

type RawCandidate = {
  code: string;
  source: Source;
  text: string;
  index: number;
};

type ClosestMatch = { distance: number; keyword: string };

export function normalizeEmailText(text: string | undefined): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

export function stripHtmlToText(html: string | undefined): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  let text = html;
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<br\s*\/?\s*>/gi, '\n');
  text = text.replace(/<\/(?:p|div|h[1-6]|li|tr|td|th)\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&apos;/gi, "'");
  text = text.replace(/&#(\d+);/g, (_, dec: string) => {
    const code = parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCharCode(code) : '';
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : '';
  });
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\s*\n\s*/g, '\n');
  return text.trim();
}

export function maskVerificationCode(code: string): string {
  if (typeof code !== 'string' || code.length === 0) return '';
  if (code.length <= 2) return '*'.repeat(code.length);
  return code.slice(0, 2) + '*'.repeat(code.length - 2);
}

function findUrlSpans(text: string): Array<[number, number]> {
  if (text.length === 0) return [];
  const spans: Array<[number, number]> = [];
  const re = new RegExp(URL_PATTERN_SOURCE, 'gi');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function findRawCandidates(text: string, source: Source): RawCandidate[] {
  if (text.length === 0) return [];
  const out: RawCandidate[] = [];
  const re = new RegExp(CODE_PATTERN_SOURCE, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ code: m[0], source, text, index: m.index });
  }
  return out;
}

function looksLikeDateCode(code: string): boolean {
  if (code.length !== 8) return false;
  const year = parseInt(code.slice(0, 4), 10);
  const month = parseInt(code.slice(4, 6), 10);
  const day = parseInt(code.slice(6, 8), 10);
  return (
    year >= 1900 &&
    year <= 2099 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

function findClosestKeyword(
  textLower: string,
  start: number,
  end: number,
  keywords: readonly string[],
): ClosestMatch | null {
  let best: ClosestMatch | null = null;
  for (const kw of keywords) {
    if (kw.length === 0) continue;
    let idx = textLower.indexOf(kw);
    while (idx !== -1) {
      const kwEnd = idx + kw.length;
      let distance: number;
      if (kwEnd <= start) {
        distance = start - kwEnd;
      } else if (idx >= end) {
        distance = idx - end;
      } else {
        distance = 0;
      }
      if (best === null || distance < best.distance) {
        best = { distance, keyword: kw };
      }
      idx = textLower.indexOf(kw, idx + 1);
    }
  }
  return best;
}

function pickClosest(
  a: ClosestMatch | null,
  b: ClosestMatch | null,
): ClosestMatch | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.distance <= b.distance ? a : b;
}

function hasAny(text: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (n.length > 0 && text.includes(n)) return true;
  }
  return false;
}

function scoreCandidate(
  raw: RawCandidate,
  context: { subjectLower: string; bodyLower: string },
  urlSpans: ReadonlyArray<[number, number]>,
): { confidence: number; reason: string; contextSnippet: string } {
  const reasons: string[] = [];
  let score = 0;

  if (raw.code.length === 6) {
    score += SCORE.SIX_DIGITS;
    reasons.push('six_digits');
  } else {
    score += SCORE.FIVE_OR_LONG_DIGITS;
    reasons.push('short_or_long_digits');
  }

  const inUrl = urlSpans.some(([s, e]) => raw.index >= s && raw.index < e);
  if (inUrl) {
    score += SCORE.IN_URL;
    reasons.push('in_url');
  }

  if (looksLikeDateCode(raw.code)) {
    score += SCORE.DATE_LIKE;
    reasons.push('date_like');
  }

  const textLower = raw.text.toLowerCase();
  const start = raw.index;
  const end = raw.index + raw.code.length;

  const strongEn = findClosestKeyword(textLower, start, end, STRONG_KEYWORDS_EN);
  const strongVi = findClosestKeyword(textLower, start, end, STRONG_KEYWORDS_VI);
  const strong = pickClosest(strongEn, strongVi);

  let strongApplied = false;
  if (strong !== null && strong.distance <= STRONG_CONTEXT_WINDOW) {
    score += SCORE.STRONG_KEYWORD_NEAR;
    reasons.push('strong_keyword_near');
    strongApplied = true;
  } else if (strong !== null && strong.distance <= FALLBACK_CONTEXT_WINDOW) {
    score += SCORE.STRONG_KEYWORD_FAR;
    reasons.push('strong_keyword_far');
    strongApplied = true;
  }

  if (!strongApplied) {
    const weakEn = findClosestKeyword(textLower, start, end, WEAK_KEYWORDS_EN);
    const weakVi = findClosestKeyword(textLower, start, end, WEAK_KEYWORDS_VI);
    const weak = pickClosest(weakEn, weakVi);
    if (weak !== null && weak.distance <= STRONG_CONTEXT_WINDOW) {
      score += SCORE.WEAK_KEYWORD_NEAR;
      reasons.push('weak_keyword_near');
    }

    const brandEn = findClosestKeyword(
      textLower,
      start,
      end,
      BRAND_CONTEXT_KEYWORDS_EN,
    );
    const brandVi = findClosestKeyword(
      textLower,
      start,
      end,
      BRAND_CONTEXT_KEYWORDS_VI,
    );
    const brand = pickClosest(brandEn, brandVi);
    if (brand !== null && brand.distance <= STRONG_CONTEXT_WINDOW) {
      score += SCORE.BRAND_CONTEXT_NEAR;
      reasons.push('brand_context_near');
    }
  }

  const negative = findClosestKeyword(
    textLower,
    start,
    end,
    NEGATIVE_KEYWORDS,
  );
  if (negative !== null && negative.distance <= NEGATIVE_CONTEXT_WINDOW) {
    score += SCORE.NEGATIVE_KEYWORD_NEAR;
    reasons.push('negative_context_near');
  }

  const winStart = Math.max(0, start - FALLBACK_CONTEXT_WINDOW);
  const winEnd = Math.min(raw.text.length, end + FALLBACK_CONTEXT_WINDOW);
  const window = raw.text.slice(winStart, winEnd);
  const phraseMatched = PHRASE_PATTERNS.some((p) => p.test(window));
  if (phraseMatched) {
    score += SCORE.PHRASE_MATCH;
    reasons.push('phrase_match');
  }

  if (raw.source === 'subject') {
    const subjectHasKeyword =
      hasAny(context.subjectLower, STRONG_KEYWORDS_EN) ||
      hasAny(context.subjectLower, STRONG_KEYWORDS_VI) ||
      hasAny(context.subjectLower, WEAK_KEYWORDS_EN) ||
      hasAny(context.subjectLower, WEAK_KEYWORDS_VI);
    if (subjectHasKeyword) {
      score += SCORE.IN_SUBJECT_WITH_KEYWORD;
      reasons.push('subject_has_keyword');
    }
  } else {
    const bodyHasStrong =
      hasAny(context.bodyLower, STRONG_KEYWORDS_EN) ||
      hasAny(context.bodyLower, STRONG_KEYWORDS_VI);
    if (bodyHasStrong) {
      score += SCORE.IN_BODY_WITH_KEYWORD;
      reasons.push('body_has_strong_keyword');
    }
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  const snippetStart = Math.max(0, start - CONTEXT_SNIPPET_WINDOW);
  const snippetEnd = Math.min(raw.text.length, end + CONTEXT_SNIPPET_WINDOW);
  const rawSnippet = raw.text.slice(snippetStart, snippetEnd);
  const safeSnippet = rawSnippet
    .split(raw.code)
    .join(maskVerificationCode(raw.code))
    .replace(/\s+/g, ' ')
    .trim();

  return {
    confidence: score,
    reason: reasons.join(','),
    contextSnippet: safeSnippet,
  };
}

function failResult(
  candidates: CodeCandidate[],
  warnings: string[],
  reason: string,
): CodeExtractionResult {
  return {
    success: false,
    code: null,
    maskedCode: null,
    confidence: 0,
    candidates,
    warnings,
    reason,
  };
}

export function extractVerificationCode(
  input: CodeExtractorInput,
): CodeExtractionResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return failResult([], [], 'INVALID_INPUT');
  }

  const warnings: string[] = [];

  const subject = normalizeEmailText(input.subject);
  const bodyText = normalizeEmailText(input.bodyText);
  const bodyPreview = normalizeEmailText(input.bodyPreview);
  const bodyHtmlText = stripHtmlToText(input.bodyHtml);

  const subjectLower = subject.toLowerCase();
  const bodyLower = [bodyText, bodyPreview, bodyHtmlText]
    .filter((s) => s.length > 0)
    .join('\n')
    .toLowerCase();

  const sources: Array<{ source: Source; text: string }> = [
    { source: 'subject', text: subject },
    { source: 'bodyText', text: bodyText },
    { source: 'bodyPreview', text: bodyPreview },
    { source: 'bodyHtml', text: bodyHtmlText },
  ];

  const allRaw: RawCandidate[] = [];
  for (const s of sources) {
    allRaw.push(...findRawCandidates(s.text, s.source));
  }

  if (allRaw.length === 0) {
    return failResult([], warnings, 'NO_CANDIDATES_FOUND');
  }

  const urlSpansBySource: Record<Source, Array<[number, number]>> = {
    subject: findUrlSpans(subject),
    bodyText: findUrlSpans(bodyText),
    bodyPreview: findUrlSpans(bodyPreview),
    bodyHtml: findUrlSpans(bodyHtmlText),
  };

  const context = { subjectLower, bodyLower };

  const scored: CodeCandidate[] = allRaw.map((raw) => {
    const result = scoreCandidate(raw, context, urlSpansBySource[raw.source]);
    return {
      code: raw.code,
      maskedCode: maskVerificationCode(raw.code),
      source: raw.source,
      confidence: result.confidence,
      reason: result.reason,
      contextSnippet: result.contextSnippet,
    };
  });

  scored.sort((a, b) => b.confidence - a.confidence);

  if (scored.length >= 2) {
    const top = scored[0];
    const second = scored[1];
    if (
      top.code !== second.code &&
      Math.abs(top.confidence - second.confidence) < SIMILAR_CANDIDATES_DELTA
    ) {
      warnings.push('MULTIPLE_SIMILAR_CANDIDATES');
    }
  }

  const top = scored[0];
  if (top.confidence >= PASS_THRESHOLD) {
    return {
      success: true,
      code: top.code,
      maskedCode: top.maskedCode,
      confidence: top.confidence,
      candidates: scored,
      warnings,
    };
  }

  return failResult(scored, warnings, 'LOW_CONFIDENCE');
}
