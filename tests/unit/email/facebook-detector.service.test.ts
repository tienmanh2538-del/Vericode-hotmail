import { describe, it, expect } from 'vitest';
import {
  detectFacebookVerificationEmail,
  isDomainOrSubdomain,
  normalizeSenderDomain,
} from '@/services/email/facebook-detector.service';

function recentIso(): string {
  return new Date().toISOString();
}

describe('normalizeSenderDomain', () => {
  it('extracts lowercase domain from plain email', () => {
    expect(normalizeSenderDomain('Security@Facebookmail.com')).toBe(
      'facebookmail.com',
    );
  });

  it('extracts domain from RFC-style "Name <email@domain>" header', () => {
    expect(
      normalizeSenderDomain('Facebook Security <security@facebookmail.com>'),
    ).toBe('facebookmail.com');
  });

  it('returns undefined for empty / missing input', () => {
    expect(normalizeSenderDomain(undefined)).toBeUndefined();
    expect(normalizeSenderDomain('')).toBeUndefined();
    expect(normalizeSenderDomain('   ')).toBeUndefined();
  });

  it('returns undefined when there is no domain part', () => {
    expect(normalizeSenderDomain('not-an-email')).toBeUndefined();
    expect(normalizeSenderDomain('user@')).toBeUndefined();
  });
});

describe('isDomainOrSubdomain', () => {
  it('matches exact domain', () => {
    expect(isDomainOrSubdomain('facebookmail.com', 'facebookmail.com')).toBe(
      true,
    );
  });

  it('matches a real subdomain', () => {
    expect(
      isDomainOrSubdomain('mail.facebookmail.com', 'facebookmail.com'),
    ).toBe(true);
    expect(
      isDomainOrSubdomain('a.b.facebookmail.com', 'facebookmail.com'),
    ).toBe(true);
  });

  it('rejects spoofed lookalikes that only contain the allowed string', () => {
    expect(
      isDomainOrSubdomain('facebookmail.com.attacker.com', 'facebookmail.com'),
    ).toBe(false);
    expect(
      isDomainOrSubdomain('fake-facebookmail.com', 'facebookmail.com'),
    ).toBe(false);
    expect(
      isDomainOrSubdomain('xfacebookmail.com', 'facebookmail.com'),
    ).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isDomainOrSubdomain('', 'facebookmail.com')).toBe(false);
    expect(isDomainOrSubdomain('facebookmail.com', '')).toBe(false);
  });
});

describe('detectFacebookVerificationEmail - positive cases', () => {
  it('passes English email from trusted sender with confirmation code in body', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com',
      subject: 'Your Facebook confirmation code',
      bodyPreview: '123456 is your Facebook confirmation code.',
      bodyText:
        'Hi, your Facebook confirmation code is 123456. It expires in 10 minutes.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(true);
    expect(result.platform).toBe('facebook_meta');
    expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
    expect(result.matchedSignals).toContain('trusted_sender_match');
    expect(result.matchedSignals).toContain('subject_keyword_match');
    expect(result.matchedSignals).toContain('code_pattern_context_match');
    expect(result.warnings).toEqual([]);
    expect(result.normalizedSenderDomain).toBe('facebookmail.com');
  });

  it('passes English email with security code', () => {
    const result = detectFacebookVerificationEmail({
      from: 'noreply@facebook.com',
      subject: 'Your security code',
      bodyText:
        'Hi, your Facebook security code is 998877. Use it within 5 minutes.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(true);
    expect(result.platform).toBe('facebook_meta');
  });

  it('passes Vietnamese email from trusted sender with mã xác minh', () => {
    const result = detectFacebookVerificationEmail({
      from: 'no-reply@facebookmail.com',
      subject: 'Mã xác minh Facebook của bạn',
      bodyPreview: 'Mã xác minh của bạn là 654321.',
      bodyText:
        'Xin chào, mã xác minh Facebook của bạn là 654321. Mã sẽ hết hạn trong 10 phút.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(true);
    expect(result.platform).toBe('facebook_meta');
    expect(result.matchedSignals).toContain('trusted_sender_match');
    expect(result.warnings).toEqual([]);
  });

  it('passes when sender is a valid subdomain of an allowed domain', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@mail.facebookmail.com',
      subject: 'Your Facebook verification code',
      bodyText: 'Your verification code is 246810. Use it within 10 minutes.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(true);
    expect(result.normalizedSenderDomain).toBe('mail.facebookmail.com');
  });
});

describe('detectFacebookVerificationEmail - suspicious sender cases', () => {
  it('rejects digit lookalike domain (faceb00kmail.com)', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@faceb00kmail.com',
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 123456.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.platform).toBe('unknown');
    expect(result.warnings).toContain('SUSPICIOUS_SENDER');
    expect(result.matchedSignals).not.toContain('trusted_sender_match');
  });

  it('rejects suffix-appended spoof (facebookmail.com.attacker.com)', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com.attacker.com',
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 123456.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.warnings).toContain('SUSPICIOUS_SENDER');
    expect(result.normalizedSenderDomain).toBe(
      'facebookmail.com.attacker.com',
    );
  });

  it('rejects a Gmail sender impersonating Facebook', () => {
    const result = detectFacebookVerificationEmail({
      from: 'facebook-security@gmail.com',
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 123456.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.warnings).toContain('SUSPICIOUS_SENDER');
  });

  it('rejects an Outlook sender impersonating Meta', () => {
    const result = detectFacebookVerificationEmail({
      from: 'meta-verification@outlook.com',
      subject: 'Your Meta verification code',
      bodyText: 'Your Meta verification code is 654321.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.warnings).toContain('SUSPICIOUS_SENDER');
  });

  it('rejects empty / invalid sender', () => {
    const result = detectFacebookVerificationEmail({
      from: '',
      subject: 'Your Facebook verification code',
      bodyText: 'Your Facebook verification code is 123456.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.warnings).toContain('INVALID_SENDER');
    expect(result.normalizedSenderDomain).toBeUndefined();
  });

  it('does not assign trusted_sender_match for a "fake-facebookmail.com" sender', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@fake-facebookmail.com',
      subject: 'Your Facebook verification code',
      bodyText: 'Your Facebook verification code is 246810.',
      receivedAt: recentIso(),
    });
    expect(result.matchedSignals).not.toContain('trusted_sender_match');
    expect(result.isFacebookVerification).toBe(false);
  });
});

describe('detectFacebookVerificationEmail - negative content cases', () => {
  it('rejects when subject mentions Facebook but body has no code context', () => {
    const result = detectFacebookVerificationEmail({
      from: 'noreply@facebookmail.com',
      subject: 'Facebook product update',
      bodyText:
        "Hi! We've shipped a new feature. Visit your profile to learn more.",
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.matchedSignals).not.toContain('code_pattern_context_match');
  });

  it('rejects when body has 6-digit numbers but no code keyword context', () => {
    const result = detectFacebookVerificationEmail({
      from: 'noreply@facebookmail.com',
      subject: 'Facebook profile changes',
      bodyText:
        'Order number 482910 was processed. Tracking number 558392 is pending.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.matchedSignals).not.toContain('code_pattern_context_match');
  });

  it('rejects invoice/receipt-style email with many numbers and trusted sender', () => {
    const result = detectFacebookVerificationEmail({
      from: 'billing@facebookmail.com',
      subject: 'Your monthly ads receipt',
      bodyText:
        'Invoice number 100234. Amount 250000. Tax 25000. Total 275000. Reference 998123. Receipt id 778812.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.warnings).toContain('MARKETING_OR_INVOICE_LIKE');
  });

  it('rejects newsletter from trusted domain', () => {
    const result = detectFacebookVerificationEmail({
      from: 'news@facebookmail.com',
      subject: 'Your weekly digest from Facebook',
      bodyText:
        'This week on Facebook: top posts, suggested pages, and a friendly reminder. Unsubscribe anytime.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.warnings).toContain('MARKETING_OR_INVOICE_LIKE');
  });

  it('flags MULTIPLE_CODE_CANDIDATES when there are many ambiguous numeric blocks', () => {
    const result = detectFacebookVerificationEmail({
      from: 'noreply@facebookmail.com',
      subject: 'Account activity',
      bodyText:
        'Reference 111111. Ticket 222222. Order 333333. Session 444444.',
      receivedAt: recentIso(),
    });
    expect(result.warnings).toContain('MULTIPLE_CODE_CANDIDATES');
    expect(result.isFacebookVerification).toBe(false);
  });

  it('does not return any verification code in output for a passing email', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com',
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 123456.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('123456');
    for (const value of Object.values(result)) {
      expect(typeof value === 'string' ? value : '').not.toContain('123456');
    }
  });
});

describe('detectFacebookVerificationEmail - boundary cases', () => {
  it('does NOT pass when body is empty even if subject is strong', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com',
      subject: 'Your Facebook confirmation code',
      bodyText: '',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.matchedSignals).not.toContain('code_pattern_context_match');
  });

  it('can pass when subject is empty but body has trusted-sender + code context', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com',
      subject: '',
      bodyText:
        'Hi, your Facebook security code is 778899. It expires in 10 minutes.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(true);
    expect(result.matchedSignals).toContain('body_keyword_match');
    expect(result.matchedSignals).toContain('code_pattern_context_match');
  });

  it('reduces score for stale email beyond the configured window', () => {
    const stale = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = recentIso();
    const staleResult = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com',
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 123456.',
      receivedAt: stale,
    });
    const freshResult = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com',
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 123456.',
      receivedAt: fresh,
    });
    expect(staleResult.warnings).toContain('STALE_EMAIL');
    expect(staleResult.confidenceScore).toBeLessThan(
      freshResult.confidenceScore,
    );
  });

  it('clamps confidence score within [0, 100]', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@faceb00kmail.com',
      subject: 'Your Facebook confirmation code with security code login code',
      bodyText:
        'Your Facebook confirmation code 123456 security code 234567 login code 345678 verification code 456789.',
      receivedAt: recentIso(),
    });
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(100);
  });

  it('handles missing receivedAt gracefully', () => {
    const result = detectFacebookVerificationEmail({
      from: 'security@facebookmail.com',
      subject: 'Your Facebook confirmation code',
      bodyText: 'Your Facebook confirmation code is 123456.',
    });
    expect(result.warnings).not.toContain('STALE_EMAIL');
    expect(result.isFacebookVerification).toBe(true);
  });
});
