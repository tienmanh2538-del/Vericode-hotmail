import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');

describe('prisma/schema.prisma', () => {
  it('exists', () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true);
  });

  const schema = readFileSync(SCHEMA_PATH, 'utf8');

  it('uses postgresql provider and reads URL from env', () => {
    expect(schema).toContain('provider = "postgresql"');
    expect(schema).toContain('env("DATABASE_URL")');
  });

  describe('models', () => {
    const REQUIRED_MODELS = [
      'User',
      'Customer',
      'Mailbox',
      'TelegramMapping',
      'GraphSubscription',
      'ProcessedMessage',
      'AuditLog',
      // TASK-040: code event log persisted to the DB (shared UI ↔ worker).
      'CodeEvent',
    ];
    for (const m of REQUIRED_MODELS) {
      it(`defines model ${m}`, () => {
        expect(schema).toMatch(new RegExp(`model ${m}\\s*\\{`));
      });
    }
  });

  describe('enums', () => {
    // TASK-040: `AuditAction` was intentionally removed — AuditLog.action is now
    // a String column so the wider application-level action set (customer /
    // telegram / admin-login / system events) is not constrained by the DB enum.
    const REQUIRED_ENUMS = [
      'UserRole',
      'CustomerStatus',
      'MailboxProvider',
      'MailboxStatus',
      'TelegramMappingStatus',
      'GraphSubscriptionStatus',
      'ProcessedMessageStatus',
    ];
    for (const e of REQUIRED_ENUMS) {
      it(`defines enum ${e}`, () => {
        expect(schema).toMatch(new RegExp(`enum ${e}\\s*\\{`));
      });
    }
  });

  it('UserRole has OWNER, ADMIN, STAFF_READ_ONLY', () => {
    const block = schema.match(/enum UserRole\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(block).toContain('OWNER');
    expect(block).toContain('ADMIN');
    expect(block).toContain('STAFF_READ_ONLY');
  });

  it('MailboxStatus has all required values', () => {
    const block = schema.match(/enum MailboxStatus\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    for (const v of [
      'ACTIVE',
      'RECONNECT_REQUIRED',
      'SUBSCRIPTION_EXPIRED',
      'WEBHOOK_FAILED',
      'DISABLED',
      'ERROR',
    ]) {
      expect(block).toContain(v);
    }
  });

  it('AuditLog.action is a String column (no DB enum constraint)', () => {
    const block = schema.match(/model AuditLog\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
    expect(block).toMatch(/action\s+String/);
    // The obsolete enum must not be referenced anywhere.
    expect(schema).not.toContain('enum AuditAction');
  });

  it('CodeEvent stores only a masked code, never a raw verification code', () => {
    const block = schema.match(/model CodeEvent\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
    expect(block).toContain('maskedCode');
    expect(block).not.toMatch(/\bverificationCode\b/);
    expect(block).not.toMatch(/^\s*code\s+String/m);
  });

  describe('secret-safety invariants', () => {
    it('uses encryptedRefreshToken; no plaintext refreshToken field', () => {
      expect(schema).toContain('encryptedRefreshToken');
      expect(schema).not.toMatch(/\brefreshToken\s+String/);
    });

    it('uses codeHash; no plaintext verification code field', () => {
      expect(schema).toContain('codeHash');
      expect(schema).not.toMatch(/\bverificationCode\s+String/);
      expect(schema).not.toMatch(/^\s*code\s+String/m);
    });

    it('uses clientStateHash; no plaintext clientState field', () => {
      expect(schema).toContain('clientStateHash');
      expect(schema).not.toMatch(/\bclientState\s+String/);
    });
  });

  it('has dedup unique constraint on (mailboxId, graphMessageId)', () => {
    expect(schema).toMatch(/@@unique\(\[mailboxId,\s*graphMessageId\]\)/);
  });

  it('GraphSubscription has unique subscriptionId', () => {
    const block = schema.match(/model GraphSubscription\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
    expect(block).toMatch(/subscriptionId\s+String\s+@unique/);
  });
});
