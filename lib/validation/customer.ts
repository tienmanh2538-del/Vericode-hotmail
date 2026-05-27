export const CUSTOMER_STATUS_VALUES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUS_VALUES)[number];

export interface CustomerInput {
  name: string;
  status: CustomerStatus;
  notes: string | null;
}

export interface RawCustomerInput {
  name?: unknown;
  status?: unknown;
  notes?: unknown;
}

export type FieldErrors = Partial<Record<keyof CustomerInput, string>>;

export type ValidationResult =
  | { ok: true; data: CustomerInput }
  | { ok: false; errors: FieldErrors };

const NAME_MAX = 120;
const NOTES_MAX = 2000;

function isCustomerStatus(value: unknown): value is CustomerStatus {
  return (
    typeof value === 'string' &&
    (CUSTOMER_STATUS_VALUES as readonly string[]).includes(value)
  );
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value;
}

export function validateCustomerInput(raw: RawCustomerInput): ValidationResult {
  const errors: FieldErrors = {};

  const rawName = toStringOrUndefined(raw.name)?.trim() ?? '';
  if (rawName.length === 0) {
    errors.name = 'Name is required.';
  } else if (rawName.length > NAME_MAX) {
    errors.name = `Name must be ${NAME_MAX} characters or fewer.`;
  }

  let status: CustomerStatus = 'ACTIVE';
  if (raw.status === undefined || raw.status === '' || raw.status === null) {
    status = 'ACTIVE';
  } else if (isCustomerStatus(raw.status)) {
    status = raw.status;
  } else {
    errors.status = 'Status must be ACTIVE, PAUSED, or ARCHIVED.';
  }

  let notes: string | null = null;
  const rawNotes = toStringOrUndefined(raw.notes);
  if (rawNotes !== undefined) {
    const trimmed = rawNotes.trim();
    if (trimmed.length === 0) {
      notes = null;
    } else if (trimmed.length > NOTES_MAX) {
      errors.notes = `Notes must be ${NOTES_MAX} characters or fewer.`;
    } else {
      notes = trimmed;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: { name: rawName, status, notes },
  };
}
