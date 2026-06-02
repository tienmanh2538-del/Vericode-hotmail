import type { TelegramDestinationFieldErrors } from '@/lib/validation/telegram-destination';

export interface TelegramDestinationFormState {
  status: 'idle' | 'error';
  errors?: TelegramDestinationFieldErrors;
  formError?: string;
  values: {
    customerId: string;
    displayName: string;
    telegramGroupName: string;
    telegramChatId: string;
    telegramTopicName: string;
    telegramThreadId: string;
    status: string;
  };
}

export const INITIAL_TELEGRAM_DESTINATION_FORM_STATE: TelegramDestinationFormState = {
  status: 'idle',
  values: {
    customerId: '',
    displayName: '',
    telegramGroupName: '',
    telegramChatId: '',
    telegramTopicName: '',
    telegramThreadId: '',
    status: 'ACTIVE',
  },
};
