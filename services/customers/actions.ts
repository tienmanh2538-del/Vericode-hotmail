'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdminAccess } from '@/lib/auth/guards';
import { validateCustomerInput } from '@/lib/validation/customer';
import {
  createCustomer,
  updateCustomer,
} from './customer.service';
import type { CustomerFormState } from './form-state';

function readForm(formData: FormData) {
  return {
    name: (formData.get('name') ?? '').toString(),
    status: (formData.get('status') ?? '').toString(),
    notes: (formData.get('notes') ?? '').toString(),
  };
}

export async function createCustomerAction(
  _prev: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  await requireAdminAccess();
  const raw = readForm(formData);
  const result = validateCustomerInput(raw);

  if (!result.ok) {
    return { status: 'error', errors: result.errors, values: raw };
  }

  try {
    await createCustomer(result.data);
  } catch {
    return {
      status: 'error',
      formError: 'Could not create customer. Please try again.',
      values: raw,
    };
  }

  revalidatePath('/admin/customers');
  redirect('/admin/customers');
}

export async function updateCustomerAction(
  id: string,
  _prev: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  await requireAdminAccess();
  const raw = readForm(formData);
  const result = validateCustomerInput(raw);

  if (!result.ok) {
    return { status: 'error', errors: result.errors, values: raw };
  }

  try {
    await updateCustomer(id, result.data);
  } catch {
    return {
      status: 'error',
      formError: 'Could not update customer. Please try again.',
      values: raw,
    };
  }

  revalidatePath('/admin/customers');
  revalidatePath(`/admin/customers/${id}/edit`);
  redirect('/admin/customers');
}
