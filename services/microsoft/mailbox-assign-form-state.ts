// TASK-051 — form state for the mailbox→customer assign action. Kept out of the
// `'use server'` actions module because such a module may only export async
// functions (mirrors services/telegram/mapping-form-state.ts).

export interface AssignMailboxCustomerState {
  status: 'idle' | 'success' | 'error';
  error?: string;
  // Echoed so the controlled select keeps the just-submitted value after the
  // server round-trip (success or error).
  customerId: string;
}

export const INITIAL_ASSIGN_MAILBOX_CUSTOMER_STATE: AssignMailboxCustomerState = {
  status: 'idle',
  customerId: '',
};
