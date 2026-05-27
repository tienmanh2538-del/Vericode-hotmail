import { describe, it, expect } from 'vitest';
import {
  validateCustomerInput,
  CUSTOMER_STATUS_VALUES,
} from '@/lib/validation/customer';

describe('validateCustomerInput — success', () => {
  it('accepts a minimal valid input and defaults status to ACTIVE', () => {
    const result = validateCustomerInput({ name: 'Acme Co' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        name: 'Acme Co',
        status: 'ACTIVE',
        notes: null,
      });
    }
  });

  it('trims whitespace from name and notes', () => {
    const result = validateCustomerInput({
      name: '   Acme   ',
      notes: '  hello world  ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('Acme');
      expect(result.data.notes).toBe('hello world');
    }
  });

  it('treats empty notes string as null', () => {
    const result = validateCustomerInput({ name: 'Acme', notes: '   ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.notes).toBeNull();
  });

  it('accepts every documented status value', () => {
    for (const status of CUSTOMER_STATUS_VALUES) {
      const result = validateCustomerInput({ name: 'Acme', status });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.status).toBe(status);
    }
  });
});

describe('validateCustomerInput — failure', () => {
  it('rejects empty name', () => {
    const result = validateCustomerInput({ name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('rejects whitespace-only name', () => {
    const result = validateCustomerInput({ name: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('rejects missing name field', () => {
    const result = validateCustomerInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('rejects non-string name', () => {
    const result = validateCustomerInput({ name: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('rejects name longer than 120 chars', () => {
    const result = validateCustomerInput({ name: 'x'.repeat(121) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('rejects unknown status value', () => {
    const result = validateCustomerInput({ name: 'Acme', status: 'DISABLED' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.status).toBeTruthy();
  });

  it('rejects notes longer than 2000 chars', () => {
    const result = validateCustomerInput({
      name: 'Acme',
      notes: 'x'.repeat(2001),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.notes).toBeTruthy();
  });

  it('collects multiple errors at once', () => {
    const result = validateCustomerInput({ name: '', status: 'WHATEVER' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBeTruthy();
      expect(result.errors.status).toBeTruthy();
    }
  });
});
