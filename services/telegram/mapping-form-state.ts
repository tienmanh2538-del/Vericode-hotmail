import type { TelegramMappingFormField } from './telegram-mapping.service';

// TASK-053 — the mapping form now selects a saved destination instead of asking
// the operator to re-type chat/thread details. The form state therefore tracks
// the mailbox, the chosen destination, and the status only.
export interface TelegramMappingFormState {
  status: 'idle' | 'error';
  errors?: Partial<Record<TelegramMappingFormField, string>>;
  formError?: string;
  values: {
    mailboxId: string;
    destinationId: string;
    status: string;
  };
}

export const INITIAL_TELEGRAM_MAPPING_FORM_STATE: TelegramMappingFormState = {
  status: 'idle',
  values: {
    mailboxId: '',
    destinationId: '',
    status: 'ACTIVE',
  },
};
