import { prisma } from '@/lib/prisma';
import type { CustomerScope } from '@/lib/auth/access-scope';

// TASK-051 — options for the Mock Email mailbox dropdown. Each option carries
// the mailbox's customer and its ACTIVE Telegram destination so the form can
// show "where would this code go?" and warn when a mailbox needs a mapping,
// BEFORE anyone hits "Process & send". Mirrors the active-mapping lookup the
// /api/mock-email/process route uses, so the preview matches the real outcome.

export interface MockEmailMailboxOption {
  emailAddress: string;
  customerName: string | null;
  hasActiveMapping: boolean;
  // Human label of the active destination (group › topic). Never the raw chat
  // id — only the group name, or a masked chat id when no group name is set.
  destinationLabel: string | null;
}

interface ActiveMappingRow {
  telegramGroupName: string | null;
  telegramChatId: string;
  telegramTopicName: string | null;
  telegramThreadId: string | null;
}

interface MailboxOptionRow {
  emailAddress: string;
  customer: { name: string } | null;
  telegramMappings: ActiveMappingRow[];
}

function maskChatId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

function formatDestination(mapping: ActiveMappingRow): string {
  const group = mapping.telegramGroupName ?? maskChatId(mapping.telegramChatId);
  if (mapping.telegramThreadId) {
    const topic = mapping.telegramTopicName ?? 'Topic';
    return `${group} › ${topic} (#${mapping.telegramThreadId})`;
  }
  return group;
}

export function toMockEmailMailboxOption(
  row: MailboxOptionRow,
): MockEmailMailboxOption {
  const active = row.telegramMappings[0] ?? null;
  return {
    emailAddress: row.emailAddress,
    customerName: row.customer?.name ?? null,
    hasActiveMapping: active !== null,
    destinationLabel: active ? formatDestination(active) : null,
  };
}

export async function listMockEmailMailboxOptions(
  scope?: CustomerScope,
): Promise<MockEmailMailboxOption[]> {
  const rows = await prisma.mailbox.findMany({
    orderBy: { emailAddress: 'asc' },
    // TASK-045 — STAFF only sees mailboxes whose customer is assigned to them.
    ...(scope && scope.kind === 'assigned'
      ? { where: { customerId: { in: scope.customerIds } } }
      : {}),
    select: {
      emailAddress: true,
      customer: { select: { name: true } },
      telegramMappings: {
        where: { status: 'ACTIVE' },
        take: 1,
        select: {
          telegramGroupName: true,
          telegramChatId: true,
          telegramTopicName: true,
          telegramThreadId: true,
        },
      },
    },
  });

  return rows.map(toMockEmailMailboxOption);
}
