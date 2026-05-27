import { describe, it, expect } from 'vitest';
import {
  extractVerificationCode,
  maskVerificationCode,
  normalizeEmailText,
  stripHtmlToText,
} from '@/services/email/code-extractor.service';

describe('maskVerificationCode', () => {
  it('keeps first 2 digits and masks the rest for a 6-digit code', () => {
    expect(maskVerificationCode('123456')).toBe('12****');
  });

  it('masks a 5-digit code as 12***', () => {
    expect(maskVerificationCode('98765')).toBe('98***');
  });

  it('masks an 8-digit code as 12******', () => {
    expect(maskVerificationCode('12345678')).toBe('12******');
  });

  it('returns empty string for empty input', () => {
    expect(maskVerificationCode('')).toBe('');
  });

  it('masks fully when code length is 1 or 2', () => {
    expect(maskVerificationCode('1')).toBe('*');
    expect(maskVerificationCode('12')).toBe('**');
  });
});

describe('normalizeEmailText', () => {
  it('returns empty string for undefined input without throwing', () => {
    expect(normalizeEmailText(undefined)).toBe('');
  });

  it('returns empty string for non-string input safely', () => {
    expect(
      normalizeEmailText(null as unknown as string | undefined),
    ).toBe('');
  });

  it('collapses tabs / multiple spaces and trims', () => {
    expect(normalizeEmailText('  hello   world\t!  ')).toBe('hello world !');
  });

  it('normalizes CRLF to LF', () => {
    expect(normalizeEmailText('a\r\nb')).toBe('a\nb');
  });
});

describe('stripHtmlToText', () => {
  it('returns empty for undefined input', () => {
    expect(stripHtmlToText(undefined)).toBe('');
  });

  it('strips tags and decodes common entities', () => {
    const out = stripHtmlToText(
      '<p>Hello&nbsp;<b>world</b>&amp;more</p>',
    );
    expect(out).toContain('Hello');
    expect(out).toContain('world');
    expect(out).toContain('&more');
  });

  it('removes script and style content entirely', () => {
    const out = stripHtmlToText(
      '<style>.x { color: red }</style><p>Hi</p><script>alert(1)</script>',
    );
    expect(out).not.toContain('alert');
    expect(out).not.toContain('color: red');
    expect(out).toContain('Hi');
  });

  it('preserves digit content from inline tags', () => {
    const out = stripHtmlToText(
      '<div>Your verification code is <b>112233</b></div>',
    );
    expect(out).toContain('112233');
    expect(out).toContain('verification code');
    expect(out).not.toContain('<b>');
  });
});

describe('extractVerificationCode - positive cases', () => {
  it('extracts the code from a strong-context subject', () => {
    const result = extractVerificationCode({
      subject: '123456 is your Facebook confirmation code',
      bodyText: 'Hello there.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toBe('123456');
      expect(result.maskedCode).toBe('12****');
      expect(result.confidence).toBeGreaterThanOrEqual(70);
    }
  });

  it('extracts the code from an English body', () => {
    const result = extractVerificationCode({
      subject: 'Facebook',
      bodyText:
        'Hi, your Facebook security code is 654321. Use it within 5 minutes.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toBe('654321');
      expect(result.maskedCode).toBe('65****');
      expect(result.confidence).toBeGreaterThanOrEqual(70);
      expect(result.candidates[0].source).toBe('bodyText');
    }
  });

  it('extracts the code from a Vietnamese body', () => {
    const result = extractVerificationCode({
      subject: 'Facebook',
      bodyText:
        'Mã xác minh Facebook của bạn là 778899. Mã sẽ hết hạn trong 10 phút.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toBe('778899');
      expect(result.maskedCode).toBe('77****');
      expect(result.confidence).toBeGreaterThanOrEqual(70);
    }
  });

  it('extracts the code from an HTML body', () => {
    const result = extractVerificationCode({
      bodyHtml:
        '<div>Your Meta verification code is <b>112233</b>. Please use it within 10 minutes.</div>',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toBe('112233');
      expect(result.maskedCode).toBe('11****');
      expect(result.candidates[0].source).toBe('bodyHtml');
    }
  });

  it('picks the keyword-contextual code over numeric noise (IP, case)', () => {
    const result = extractVerificationCode({
      bodyText:
        'IP: 192.168.1.1\nCase: 20260527\nYour login code is 445566. It expires in 10 minutes.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toBe('445566');
      expect(result.maskedCode).toBe('44****');
    }
  });
});

describe('extractVerificationCode - negative cases', () => {
  it('returns success=false when there is no code anywhere', () => {
    const result = extractVerificationCode({
      subject: 'Facebook account update',
      bodyText: 'Your Facebook account was accessed from a new device.',
    });
    expect(result.success).toBe(false);
  });

  it('does not treat dates/times as a code', () => {
    const result = extractVerificationCode({
      bodyText: 'Login attempt on 2026-05-27 at 14:30.',
    });
    expect(result.success).toBe(false);
  });

  it('does not treat phone numbers as a code', () => {
    const result = extractVerificationCode({
      bodyText:
        'Contact support at 1800123456 or call us at 0987654321 for help.',
    });
    expect(result.success).toBe(false);
  });

  it('does not extract the case number as a verification code', () => {
    const result = extractVerificationCode({
      bodyText: 'Your support case 123456 has been updated.',
    });
    expect(result.success).toBe(false);
  });

  it('does not pass when a 6-digit number has no real code context', () => {
    const result = extractVerificationCode({
      bodyText: 'Random number 123456 appears in this marketing newsletter.',
    });
    expect(result.success).toBe(false);
  });

  it('does not throw and returns a safe fail result for an empty input object', () => {
    expect(() => extractVerificationCode({})).not.toThrow();
    const result = extractVerificationCode({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBeNull();
      expect(result.maskedCode).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.reason).toBeTruthy();
    }
  });

  it('does not throw when every input field is an empty string', () => {
    expect(() =>
      extractVerificationCode({
        subject: '',
        bodyText: '',
        bodyHtml: '',
        bodyPreview: '',
      }),
    ).not.toThrow();
    const result = extractVerificationCode({
      subject: '',
      bodyText: '',
      bodyHtml: '',
      bodyPreview: '',
    });
    expect(result.success).toBe(false);
  });

  it('does not extract a 6-digit code embedded inside a URL', () => {
    const result = extractVerificationCode({
      bodyText:
        'Click https://example.com/confirm/123456 to reset your account.',
    });
    expect(result.success).toBe(false);
  });
});

describe('extractVerificationCode - multiple candidates', () => {
  it('flags MULTIPLE_SIMILAR_CANDIDATES when two codes share similar weak context', () => {
    const result = extractVerificationCode({
      bodyText:
        'Code 111111 and code 222222 are both shown without clear context.',
    });
    expect(result.warnings).toContain('MULTIPLE_SIMILAR_CANDIDATES');
    expect(result.success).toBe(false);
  });

  it('does not flag MULTIPLE_SIMILAR_CANDIDATES when the same code repeats across sources', () => {
    const result = extractVerificationCode({
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 246810.',
      bodyPreview: 'Your Facebook confirmation code is 246810.',
    });
    expect(result.success).toBe(true);
    expect(result.warnings).not.toContain('MULTIPLE_SIMILAR_CANDIDATES');
  });
});

describe('extractVerificationCode - security and logging safety', () => {
  it('never leaks the full code in reason or contextSnippet', () => {
    const result = extractVerificationCode({
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 314159.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      for (const candidate of result.candidates) {
        expect(candidate.reason).not.toContain('314159');
        if (candidate.contextSnippet !== undefined) {
          expect(candidate.contextSnippet).not.toContain('314159');
          expect(candidate.contextSnippet).toContain('31****');
        }
      }
      for (const warning of result.warnings) {
        expect(warning).not.toContain('314159');
      }
    }
  });

  it('returns maskedCode that matches the masking spec exactly', () => {
    const result = extractVerificationCode({
      bodyText: 'Your Facebook security code is 654321.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.maskedCode).toBe('65****');
      expect(result.maskedCode).not.toContain('6543');
    }
  });
});
