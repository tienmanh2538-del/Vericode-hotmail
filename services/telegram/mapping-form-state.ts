import type { TelegramMappingFieldErrors } from '@/lib/validation/telegram-mapping';

export interface TelegramMappingFormState {
  status: 'idle' | 'error';
  errors?: TelegramMappingFieldErrors;
  formError?: string;
  values: {
    mailboxId: string;
    telegramChatId: string;
    telegramGroupName: string;
    status: string;
  };
}

export const INITIAL_TELEGRAM_MAPPING_FORM_STATE: TelegramMappingFormState = {
  status: 'idle',
  values: {
    mailboxId: '',
    telegramChatId: '',
    telegramGroupName: '',
    status: 'ACTIVE',
  },
};
