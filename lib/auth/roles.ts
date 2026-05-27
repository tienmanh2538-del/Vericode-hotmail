export const ROLE_VALUES = ['OWNER', 'ADMIN', 'STAFF_READ_ONLY'] as const;

export type Role = (typeof ROLE_VALUES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
}
