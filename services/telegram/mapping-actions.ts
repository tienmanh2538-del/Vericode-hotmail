'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/auth/guards';
import {
  createTelegramMapping,
  deleteTelegramMapping,
  disableTelegramMapping,
  TelegramMappingConflictError,
  TelegramMappingValidationError,
  updateTelegramMapping,
} from './telegram-mapping.service';
import type { TelegramMappingFormState } from './mapping-form-state';

function readForm(formData: FormData) {
  return {
    mailboxId: (formData.get('mailboxId') ?? '').toString(),
    telegramChatId: (formData.get('telegramChatId') ?? '').toString(),
    telegramGroupName: (formData.get('telegramGroupName') ?? '').toString(),
    telegramThreadId: (formData.get('telegramThreadId') ?? '').toString(),
    telegramTopicName: (formData.get('telegramTopicName') ?? '').toString(),
    status: (formData.get('status') ?? '').toString(),
  };
}

function failureState(
  values: ReturnType<typeof readForm>,
  error: unknown,
): TelegramMappingFormState {
  if (error instanceof TelegramMappingValidationError) {
    return { status: 'error', errors: error.errors, values };
  }
  if (error instanceof TelegramMappingConflictError) {
    return {
      status: 'error',
      errors: { [error.field]: error.message },
      values,
    };
  }
  return {
    status: 'error',
    formError: 'Could not save Telegram mapping. Please try again.',
    values,
  };
}

export async function createTelegramMappingAction(
  _prev: TelegramMappingFormState,
  formData: FormData,
): Promise<TelegramMappingFormState> {
  await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const values = readForm(formData);

  try {
    await createTelegramMapping(values);
  } catch (error) {
    return failureState(values, error);
  }

  revalidatePath('/admin/telegram');
  redirect('/admin/telegram');
}

export async function updateTelegramMappingAction(
  id: string,
  _prev: TelegramMappingFormState,
  formData: FormData,
): Promise<TelegramMappingFormState> {
  await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const values = readForm(formData);

  try {
    await updateTelegramMapping(id, values);
  } catch (error) {
    return failureState(values, error);
  }

  revalidatePath('/admin/telegram');
  revalidatePath(`/admin/telegram/${id}/edit`);
  redirect('/admin/telegram');
}

export async function disableTelegramMappingAction(id: string): Promise<void> {
  await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  await disableTelegramMapping(id);
  revalidatePath('/admin/telegram');
}

export async function deleteTelegramMappingAction(id: string): Promise<void> {
  await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  await deleteTelegramMapping(id);
  revalidatePath('/admin/telegram');
}
