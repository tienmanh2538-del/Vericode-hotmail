'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/auth/guards';
import { resolveCustomerScope } from '@/lib/auth/access-scope';
import {
  createTelegramMappingFromDestination,
  deleteTelegramMapping,
  disableTelegramMapping,
  TelegramDestinationMappingConflictError,
  TelegramDestinationMappingValidationError,
  updateTelegramMappingFromDestination,
} from './telegram-mapping.service';
import type { TelegramMappingFormState } from './mapping-form-state';

function readForm(formData: FormData) {
  return {
    mailboxId: (formData.get('mailboxId') ?? '').toString(),
    destinationId: (formData.get('destinationId') ?? '').toString(),
    status: (formData.get('status') ?? '').toString(),
  };
}

function failureState(
  values: ReturnType<typeof readForm>,
  error: unknown,
): TelegramMappingFormState {
  if (error instanceof TelegramDestinationMappingValidationError) {
    return { status: 'error', errors: error.errors, values };
  }
  if (error instanceof TelegramDestinationMappingConflictError) {
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
  const user = await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const scope = await resolveCustomerScope(user);
  const values = readForm(formData);

  try {
    await createTelegramMappingFromDestination(values, scope);
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
  const user = await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const scope = await resolveCustomerScope(user);
  const values = readForm(formData);

  try {
    await updateTelegramMappingFromDestination(id, values, scope);
  } catch (error) {
    return failureState(values, error);
  }

  revalidatePath('/admin/telegram');
  revalidatePath(`/admin/telegram/${id}/edit`);
  redirect('/admin/telegram');
}

export async function disableTelegramMappingAction(id: string): Promise<void> {
  const user = await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const scope = await resolveCustomerScope(user);
  await disableTelegramMapping(id, scope);
  revalidatePath('/admin/telegram');
}

export async function deleteTelegramMappingAction(id: string): Promise<void> {
  const user = await requirePermission('MANAGE_TELEGRAM_MAPPINGS');
  const scope = await resolveCustomerScope(user);
  await deleteTelegramMapping(id, scope);
  revalidatePath('/admin/telegram');
}
