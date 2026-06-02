// TASK-052 — form state for the mailbox disconnect action. Kept out of the
// `'use server'` actions module because such a module may only export async
// functions (mirrors services/microsoft/mailbox-assign-form-state.ts).

export interface DisconnectMailboxState {
  status: 'idle' | 'success' | 'error';
  error?: string;
  /** Safe summary surfaced after a successful disconnect (no secrets). */
  summary?: {
    disabledMappingCount: number;
    deactivatedSubscriptionCount: number;
    remoteSubscriptionsFailed: number;
  };
}

export const INITIAL_DISCONNECT_MAILBOX_STATE: DisconnectMailboxState = {
  status: 'idle',
};
