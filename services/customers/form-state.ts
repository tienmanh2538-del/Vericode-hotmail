import type { FieldErrors } from '@/lib/validation/customer';

export interface CustomerFormState {
  status: 'idle' | 'error';
  errors?: FieldErrors;
  formError?: string;
  values: {
    name: string;
    status: string;
    notes: string;
  };
}

export const INITIAL_FORM_STATE: CustomerFormState = {
  status: 'idle',
  values: { name: '', status: 'ACTIVE', notes: '' },
};
