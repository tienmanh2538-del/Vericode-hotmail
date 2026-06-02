'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/auth/guards';
import {
  createTelegramDestination,
  disableTelegramDestination,
  TelegramDestinationConflictError,
  TelegramDestinationValidationError,
  updateTelegramDestination,
} from './telegram-destination.service';
import type { TelegramDestinationFormState } from './destination-form-state';

function readForm(formData: FormData) {
  return {
    customerId: (formData.get('customerId') ?? '').toString(),
    displayName: (formData.get('displayName') ?? '').toString(),
    telegramGroupName: (formData.get('telegramGroupName') ?? '').toString(),
    telegramChatId: (formData.get('telegramChatId') ?? '').toString(),
    telegramTopicName: (formData.get('telegramTopicName') ?? '').toString(),
    telegramThreadId: (formData.get('telegramThreadId') ?? '').toString(),
    status: (formData.get('status') ?? '').toString(),
  };
}

function failureState(
  values: ReturnType<typeof readForm>,
  error: unknown,
): TelegramDestinationFormState {
  if (error instanceof TelegramDestinationValidationError) {
    return { status: 'error', errors: error.errors, values };
  }
  if (error instanceof TelegramDestinationConflictError) {
    return {
      status: 'error',
      errors: { [error.field]: error.message },
      values,
    };
  }
  return {
    status: 'error',
    formError: 'Could not save Telegram destination. Please try again.',
    values,
  };
}

export async function createTelegramDestinationAction(
  _prev: TelegramDestinationFormState,
  formData: FormData,
): Promise<TelegramDestinationFormState> {
  await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const values = readForm(formData);

  try {
    await createTelegramDestination(values);
  } catch (error) {
    return failureState(values, error);
  }

  revalidatePath('/admin/telegram');
  redirect('/admin/telegram');
}

export async function updateTelegramDestinationAction(
  id: string,
  _prev: TelegramDestinationFormState,
  formData: FormData,
): Promise<TelegramDestinationFormState> {
  await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const values = readForm(formData);

  try {
    await updateTelegramDestination(id, values);
  } catch (error) {
    return failureState(values, error);
  }

  revalidatePath('/admin/telegram');
  revalidatePath(`/admin/telegram/destinations/${id}/edit`);
  redirect('/admin/telegram');
}

export async function disableTelegramDestinationAction(id: string): Promise<void> {
  await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  await disableTelegramDestination(id);
  revalidatePath('/admin/telegram');
}
