import { prisma as defaultPrisma } from '@/lib/prisma';
import { encryptSecret as defaultEncryptSecret } from '@/lib/security/encryption';
import { createLogger } from '@/lib/logger';
import {
  createAuditLog as defaultCreateAuditLog,
  type AuditLogListItem,
  type CreateAuditLogInput,
} from '@/services/logs/audit-log.service';

const logger = createLogger();

export type MailboxConnectErrorKind = 'validation' | 'encryption' | 'database';

export class MailboxConnectError extends Error {
  readonly kind: MailboxConnectErrorKind;
  constructor(kind: MailboxConnectErrorKind, message: string) {
    super(message);
    this.name = 'MailboxConnectError';
    this.kind = kind;
  }
}

export interface SaveConnectedMailboxInput {
  microsoftUserId: string;
  emailAddress: string;
  displayName?: string | null;
  refreshToken: string;
  accessTokenExpiresAt?: Date | null;
  scope?: string | null;
  connectedByUserId?: string | null;
}

export interface SaveConnectedMailboxResult {
  mailboxId: string;
  emailAddress: string;
  status: 'ACTIVE';
  created: boolean;
}

interface MailboxRecord {
  id: string;
  emailAddress: string;
  status: string;
}

interface MailboxPrismaClient {
  findFirst: (args: {
    where: { provider: 'MICROSOFT'; microsoftUserId: string };
  }) => Promise<MailboxRecord | null>;
  findUnique: (args: {
    where: { emailAddress: string };
  }) => Promise<MailboxRecord | null>;
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<MailboxRecord>;
  create: (args: {
    data: Record<string, unknown>;
  }) => Promise<MailboxRecord>;
}

export interface PrismaClientLike {
  mailbox: MailboxPrismaClient;
}

export interface SaveConnectedMailboxDeps {
  prisma?: PrismaClientLike;
  encryptSecret?: (plaintext: string) => string;
  createAuditLog?: (input: CreateAuditLogInput) => AuditLogListItem;
  now?: () => Date;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MailboxConnectError('validation', `${field} is required`);
  }
  return value.trim();
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function saveConnectedMailbox(
  input: SaveConnectedMailboxInput,
  deps: SaveConnectedMailboxDeps = {},
): Promise<SaveConnectedMailboxResult> {
  const microsoftUserId = requireNonEmpty(input.microsoftUserId, 'microsoftUserId');
  const emailAddress = requireNonEmpty(input.emailAddress, 'emailAddress').toLowerCase();

  // Refresh token is required to keep the mailbox ACTIVE — without it we could
  // never refresh the access token, so creating an ACTIVE mailbox would be a
  // lie. Fail safely before any DB write.
  if (typeof input.refreshToken !== 'string' || input.refreshToken.trim().length === 0) {
    throw new MailboxConnectError(
      'validation',
      'refresh token is required to connect a mailbox',
    );
  }

  const prisma = (deps.prisma ?? (defaultPrisma as unknown as PrismaClientLike));
  const encryptSecret = deps.encryptSecret ?? defaultEncryptSecret;
  const writeAuditLog = deps.createAuditLog ?? defaultCreateAuditLog;
  const now = deps.now ?? (() => new Date());

  let encryptedRefreshToken: string;
  try {
    encryptedRefreshToken = encryptSecret(input.refreshToken);
  } catch {
    // Never include the token or the underlying error message — both could
    // leak secret material into logs.
    logger.error('Failed to encrypt refresh token before persisting mailbox');
    throw new MailboxConnectError('encryption', 'failed to encrypt refresh token');
  }

  const tokenLastRefreshedAt = now();
  const displayName = trimOrNull(input.displayName ?? null);
  const createdById = trimOrNull(input.connectedByUserId ?? null);

  let saved: MailboxRecord;
  let created: boolean;
  try {
    // Schema only enforces unique(emailAddress); there is no unique on
    // (provider, microsoftUserId). Resolve identity manually so reconnecting
    // the same Microsoft user updates the existing row instead of failing on
    // the unique constraint.
    const byMsUser = await prisma.mailbox.findFirst({
      where: { provider: 'MICROSOFT', microsoftUserId },
    });
    const existing =
      byMsUser ?? (await prisma.mailbox.findUnique({ where: { emailAddress } }));

    if (existing) {
      saved = await prisma.mailbox.update({
        where: { id: existing.id },
        data: {
          emailAddress,
          provider: 'MICROSOFT',
          microsoftUserId,
          encryptedRefreshToken,
          status: 'ACTIVE',
          tokenLastRefreshedAt,
        },
      });
      created = false;
    } else {
      saved = await prisma.mailbox.create({
        data: {
          emailAddress,
          provider: 'MICROSOFT',
          microsoftUserId,
          encryptedRefreshToken,
          status: 'ACTIVE',
          tokenLastRefreshedAt,
          createdById,
        },
      });
      created = true;
    }
  } catch {
    logger.error('Mailbox upsert failed', { microsoftUserId });
    throw new MailboxConnectError('database', 'failed to persist mailbox');
  }

  try {
    writeAuditLog({
      action: 'MAILBOX_CONNECTED',
      entityType: 'mailbox',
      entityId: saved.id,
      actorUserId: createdById,
      severity: 'info',
      summary: created ? 'Mailbox connected' : 'Mailbox reconnected',
      metadata: {
        mailboxId: saved.id,
        emailAddress: saved.emailAddress,
        provider: 'microsoft',
        status: saved.status,
        scope: input.scope ?? null,
        displayName,
      },
    });
  } catch {
    // Audit failure must not roll back a successful connect. The mailbox is
    // persisted; we just lose the audit row. Logged for ops visibility.
    logger.warn('Audit log for MAILBOX_CONNECTED failed', { mailboxId: saved.id });
  }

  return {
    mailboxId: saved.id,
    emailAddress: saved.emailAddress,
    status: 'ACTIVE',
    created,
  };
}
