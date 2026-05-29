import { ConnectMailboxButton } from '@/components/admin/ConnectMailboxButton';
import { MailboxListTable } from '@/components/tables/MailboxListTable';
import { createLogger } from '@/lib/logger';
import {
  listMailboxesForAdmin,
  type MailboxListItem,
} from '@/services/microsoft/mailbox-list.service';
import '../customers/customers.css';

export const dynamic = 'force-dynamic';

const logger = createLogger({ level: 'warn' });

type LoadResult =
  | { ok: true; mailboxes: MailboxListItem[] }
  | { ok: false };

async function loadMailboxes(): Promise<LoadResult> {
  try {
    const mailboxes = await listMailboxesForAdmin();
    return { ok: true, mailboxes };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to load mailbox list for /admin/mailboxes', {
      errorMessage: message,
    });
    return { ok: false };
  }
}

export default async function MailboxesListPage() {
  const result = await loadMailboxes();

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Mailboxes</h2>
          <p className="customers-subtitle">
            Danh sách mailbox Hotmail/Outlook đã kết nối, trạng thái Telegram
            mapping và Microsoft Graph subscription.
          </p>
        </div>
        <ConnectMailboxButton variant="compact" showIntro={false} />
      </div>

      {!result.ok ? (
        <div className="admin-banner admin-banner--error" role="alert">
          <strong>Không tải được danh sách mailbox.</strong>{' '}
          Vui lòng kiểm tra database/dev server rồi thử lại.
        </div>
      ) : result.mailboxes.length === 0 ? (
        <div className="mailboxes-empty">
          <h3 className="mailboxes-empty__title">
            Chưa có mailbox nào được kết nối
          </h3>
          <p className="mailboxes-empty__description">
            Hãy kết nối mailbox Hotmail/Outlook đầu tiên để hệ thống bắt đầu đọc
            email xác minh Facebook/Meta. Mailbox sau khi OAuth thành công sẽ
            xuất hiện ở đây.
          </p>
          <ConnectMailboxButton />
        </div>
      ) : (
        <MailboxListTable mailboxes={result.mailboxes} />
      )}
    </>
  );
}
