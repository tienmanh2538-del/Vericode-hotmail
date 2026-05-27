export type DetectorEmailInput = {
  from?: string;
  sender?: string;
  subject?: string;
  bodyPreview?: string;
  bodyText?: string;
  receivedAt?: string | Date;
};

export type FacebookVerificationDetectionResult = {
  isFacebookVerification: boolean;
  platform: 'facebook_meta' | 'unknown';
  confidenceScore: number;
  matchedSignals: string[];
  warnings: string[];
  normalizedSenderDomain?: string;
};

const TRUSTED_META_DOMAINS = [
  'fb.com',
  'facebook.com',
  'facebookmail.com',
  'instagram.com',
  'meta.com',
  'metamail.com',
] as const;

const SUBJECT_KEYWORDS_EN = [
  'facebook',
  'meta',
  'instagram',
  'confirmation code',
  'security code',
  'login code',
  'verification code',
  'confirm your account',
  'account confirmation',
  'two-factor authentication',
  '2fa',
];

const SUBJECT_KEYWORDS_VI = [
  'mã xác nhận',
  'mã bảo mật',
  'mã xác minh',
  'mã đăng nhập',
  'xác minh tài khoản',
  'mã xác thực',
];

const BODY_KEYWORDS_EN = [
  'confirmation code',
  'security code',
  'login code',
  'verification code',
  'confirm your account',
  'two-factor authentication',
  '2fa',
];

const BODY_KEYWORDS_VI = [
  'mã xác nhận',
  'mã bảo mật',
  'mã xác minh',
  'mã đăng nhập',
  'xác minh tài khoản',
  'mã xác thực',
];

const CODE_CONTEXT_KEYWORDS = [
  'code',
  'security code',
  'confirmation code',
  'verification code',
  'login code',
  'mã xác minh',
  'mã bảo mật',
  'mã xác nhận',
  'mã xác thực',
  'mã đăng nhập',
];

const MARKETING_KEYWORDS = [
  'receipt',
  'invoice',
  'ads summary',
  'ad summary',
  'weekly report',
  'weekly digest',
  'monthly report',
  'newsletter',
  'unsubscribe',
  'policy update',
  'terms update',
  'promotion',
  'hóa đơn',
  'biên lai',
  'bản tin',
];

const NON_VERIFICATION_PHRASES = [
  'new login alert',
  'new sign-in to your',
  'we noticed a new sign-in',
  'does not contain a verification code',
];

const SCORE = {
  TRUSTED_SENDER: 40,
  SUBJECT_KEYWORD: 20,
  BODY_KEYWORD: 20,
  CODE_PATTERN_CONTEXT: 20,
  SUSPICIOUS_SENDER: -100,
  MULTIPLE_CODE_CANDIDATES: -20,
  MARKETING_OR_INVOICE_LIKE: -30,
  STALE_EMAIL: -10,
} as const;

const PASS_THRESHOLD = 70;
const STALE_EMAIL_DAYS = 30;
const CODE_CONTEXT_WINDOW = 40;
const MAX_CODE_CANDIDATES_BEFORE_WARNING = 3;

const CODE_PATTERN = /\b\d{5,8}\b/g;
const EMAIL_ADDRESS_PATTERN = /<([^>]+)>|([^\s<>]+@[^\s<>]+)/;
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

const LOOKALIKE_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/0/g, 'o'],
  [/1/g, 'l'],
  [/3/g, 'e'],
  [/4/g, 'a'],
  [/5/g, 's'],
  [/7/g, 't'],
  [/\$/g, 's'],
];

export function normalizeSenderDomain(sender?: string): string | undefined {
  if (typeof sender !== 'string') return undefined;
  const trimmed = sender.trim();
  if (trimmed.length === 0) return undefined;

  const match = trimmed.match(EMAIL_ADDRESS_PATTERN);
  const candidate = match ? match[1] ?? match[2] ?? trimmed : trimmed;

  const atIndex = candidate.lastIndexOf('@');
  if (atIndex < 0 || atIndex === candidate.length - 1) return undefined;

  const domain = candidate.slice(atIndex + 1).trim().toLowerCase();
  if (domain.length === 0) return undefined;
  if (!DOMAIN_PATTERN.test(domain)) return undefined;

  return domain;
}

export function isDomainOrSubdomain(
  domain: string,
  allowedDomain: string,
): boolean {
  if (typeof domain !== 'string' || typeof allowedDomain !== 'string') {
    return false;
  }
  const d = domain.toLowerCase();
  const a = allowedDomain.toLowerCase();
  if (d.length === 0 || a.length === 0) return false;
  return d === a || d.endsWith('.' + a);
}

function isTrustedDomain(domain: string): boolean {
  return TRUSTED_META_DOMAINS.some((allowed) =>
    isDomainOrSubdomain(domain, allowed),
  );
}

function isLookalikeDomain(domain: string): boolean {
  let folded = domain;
  for (const [pattern, replacement] of LOOKALIKE_SUBSTITUTIONS) {
    folded = folded.replace(pattern, replacement);
  }
  if (folded === domain) return false;
  return TRUSTED_META_DOMAINS.some((allowed) =>
    isDomainOrSubdomain(folded, allowed),
  );
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (needle.length > 0 && haystack.includes(needle)) return true;
  }
  return false;
}

function hasCodeWithContext(text: string): {
  found: boolean;
  candidateCount: number;
} {
  const matches: Array<{ index: number; value: string }> = [];
  CODE_PATTERN.lastIndex = 0;
  for (
    let m = CODE_PATTERN.exec(text);
    m !== null;
    m = CODE_PATTERN.exec(text)
  ) {
    matches.push({ index: m.index, value: m[0] });
  }
  if (matches.length === 0) return { found: false, candidateCount: 0 };

  for (const match of matches) {
    const start = Math.max(0, match.index - CODE_CONTEXT_WINDOW);
    const end = Math.min(
      text.length,
      match.index + match.value.length + CODE_CONTEXT_WINDOW,
    );
    const window = text.slice(start, end);
    if (containsAny(window, CODE_CONTEXT_KEYWORDS)) {
      return { found: true, candidateCount: matches.length };
    }
  }
  return { found: false, candidateCount: matches.length };
}

function parseReceivedAt(value: string | Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function isStale(receivedAt: Date | undefined): boolean {
  if (!receivedAt) return false;
  const ageMs = Date.now() - receivedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > STALE_EMAIL_DAYS;
}

function clampScore(score: number): number {
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

export function detectFacebookVerificationEmail(
  email: DetectorEmailInput,
): FacebookVerificationDetectionResult {
  const matchedSignals: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  const senderRaw = email.sender ?? email.from;
  const normalizedDomain = normalizeSenderDomain(senderRaw);

  const subjectLower = (email.subject ?? '').toLowerCase();
  const bodyLower = [email.bodyPreview ?? '', email.bodyText ?? '']
    .join('\n')
    .toLowerCase();
  const combinedText = subjectLower + '\n' + bodyLower;

  let trustedSender = false;
  let suspiciousSender = false;

  if (!normalizedDomain) {
    warnings.push('INVALID_SENDER');
    suspiciousSender = true;
  } else if (isTrustedDomain(normalizedDomain)) {
    trustedSender = true;
    matchedSignals.push('trusted_sender_match');
    score += SCORE.TRUSTED_SENDER;
  } else if (isLookalikeDomain(normalizedDomain)) {
    warnings.push('SUSPICIOUS_SENDER');
    suspiciousSender = true;
  } else {
    const looksImpersonating =
      /facebook|meta|instagram|fb[-_]?(security|support|verify)/i.test(
        normalizedDomain,
      );
    if (looksImpersonating) {
      warnings.push('SUSPICIOUS_SENDER');
      suspiciousSender = true;
    } else {
      const subjectMentionsBrand =
        /facebook|meta|instagram/.test(subjectLower) ||
        /facebook|meta|instagram/.test(bodyLower);
      if (subjectMentionsBrand) {
        warnings.push('SUSPICIOUS_SENDER');
        suspiciousSender = true;
      }
    }
  }

  const subjectKeywordMatch =
    containsAny(subjectLower, SUBJECT_KEYWORDS_EN) ||
    containsAny(subjectLower, SUBJECT_KEYWORDS_VI);
  if (subjectKeywordMatch) {
    matchedSignals.push('subject_keyword_match');
    score += SCORE.SUBJECT_KEYWORD;
  }

  const bodyKeywordMatch =
    containsAny(bodyLower, BODY_KEYWORDS_EN) ||
    containsAny(bodyLower, BODY_KEYWORDS_VI);
  if (bodyKeywordMatch) {
    matchedSignals.push('body_keyword_match');
    score += SCORE.BODY_KEYWORD;
  }

  const codeCheck = hasCodeWithContext(combinedText);
  if (codeCheck.found) {
    matchedSignals.push('code_pattern_context_match');
    score += SCORE.CODE_PATTERN_CONTEXT;
  }
  if (codeCheck.candidateCount >= MAX_CODE_CANDIDATES_BEFORE_WARNING) {
    warnings.push('MULTIPLE_CODE_CANDIDATES');
    score += SCORE.MULTIPLE_CODE_CANDIDATES;
  }

  const marketingLike =
    containsAny(combinedText, MARKETING_KEYWORDS) ||
    containsAny(combinedText, NON_VERIFICATION_PHRASES);
  if (marketingLike) {
    warnings.push('MARKETING_OR_INVOICE_LIKE');
    score += SCORE.MARKETING_OR_INVOICE_LIKE;
  }

  const receivedAt = parseReceivedAt(email.receivedAt);
  if (isStale(receivedAt)) {
    warnings.push('STALE_EMAIL');
    score += SCORE.STALE_EMAIL;
  }

  if (suspiciousSender) {
    score += SCORE.SUSPICIOUS_SENDER;
  }

  const finalScore = clampScore(score);

  const pass =
    !suspiciousSender &&
    trustedSender &&
    (subjectKeywordMatch || bodyKeywordMatch) &&
    codeCheck.found &&
    !marketingLike &&
    finalScore >= PASS_THRESHOLD;

  const result: FacebookVerificationDetectionResult = {
    isFacebookVerification: pass,
    platform: pass ? 'facebook_meta' : 'unknown',
    confidenceScore: finalScore,
    matchedSignals,
    warnings,
  };
  if (normalizedDomain !== undefined) {
    result.normalizedSenderDomain = normalizedDomain;
  }
  return result;
}
