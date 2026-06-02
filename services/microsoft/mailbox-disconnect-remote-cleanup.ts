// TASK-052 — default (production) best-effort remote cleanup for mailbox
// disconnect. Kept in a separate module from the core service so the unit-tested
// `disconnectMailbox` core has no hard dependency on token/encryption infra; the
// server action wires this in.
//
// SECURITY: the decrypted refresh token and minted access token never leave this
// function and are never logged. A failure here is swallowed by the caller
// (counted as a remote-cleanup failure) and never rolls back the local disconnect.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/security/encryption';
import { refreshMicrosoftAccessToken } from '@/services/microsoft/refresh-access-token.service';
import { deleteGraphSubscription } from '@/services/microsoft/graph-subscription.service';
import type { MailboxDisconnectRemoteCleanup } from './mailbox-disconnect.service';

interface RefreshTokenSlice {
  encryptedRefreshToken: string | null;
}

interface RemoteCleanupPrismaClient {
  mailbox: {
    findUnique: (args: {
      where: { id: string };
      select: { encryptedRefreshToken: true };
    }) => Promise<RefreshTokenSlice | null>;
  };
}

export class MailboxRemoteCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxRemoteCleanupError';
  }
}

/**
 * Build the production remote-cleanup port. Each call decrypts the mailbox's
 * refresh token, exchanges it for an access token, and asks Microsoft Graph to
 * delete the subscription. All failures throw so the disconnect service records
 * a best-effort failure without leaking any credential detail.
 */
export function buildDefaultMailboxDisconnectRemoteCleanup(
  client: RemoteCleanupPrismaClient = defaultPrisma as unknown as RemoteCleanupPrismaClient,
): MailboxDisconnectRemoteCleanup {
  return {
    async deleteRemoteSubscription({ mailboxId, subscriptionId }) {
      const row = await client.mailbox.findUnique({
        where: { id: mailboxId },
        select: { encryptedRefreshToken: true },
      });
      if (!row || !row.encryptedRefreshToken) {
        throw new MailboxRemoteCleanupError('mailbox has no refresh token');
      }

      let plaintextRefreshToken: string;
      try {
        plaintextRefreshToken = decryptSecret(row.encryptedRefreshToken);
      } catch {
        // Never include the underlying error — it may leak ciphertext/key context.
        throw new MailboxRemoteCleanupError('failed to decrypt refresh token');
      }

      let accessToken: string;
      try {
        const exchanged = await refreshMicrosoftAccessToken(plaintextRefreshToken);
        accessToken = exchanged.accessToken;
      } catch {
        throw new MailboxRemoteCleanupError('failed to exchange refresh token');
      }

      // deleteGraphSubscription tolerates a 404 (already gone) and re-marks the
      // local row EXPIRED — idempotent with the disconnect service's local write.
      await deleteGraphSubscription({ mailboxId, subscriptionId, accessToken });
    },
  };
}
