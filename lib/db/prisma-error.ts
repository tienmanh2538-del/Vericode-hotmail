// TASK-068A — small, dependency-free helpers for recognising Prisma error shapes
// without importing the Prisma runtime (`Prisma.PrismaClientKnownRequestError`).
//
// We only need to recognise a unique-constraint violation (error code `P2002`)
// so the dedup claim and the one-active-mapping guard can convert a racing
// duplicate insert into a clean, intentional outcome instead of an unhandled
// throw. Reading `.code` / `.meta.target` defensively keeps this usable with the
// real Prisma error, a thrown plain object in a test, or anything else.

/** True when `err` is a Prisma unique-constraint violation (`P2002`). */
export function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * True when a P2002's `meta.target` (the constraint/index that was violated)
 * contains `needle`. Prisma reports `target` as a string[] for `@@unique`
 * field-lists and as the index name for raw indexes, so we accept both shapes.
 * Used to tell "duplicate (mailbox, chat) row" apart from the
 * "one ACTIVE mapping per mailbox" partial index.
 */
export function uniqueConstraintTargetIncludes(
  err: unknown,
  needle: string,
): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    return target.some((t) => typeof t === 'string' && t.includes(needle));
  }
  if (typeof target === 'string') return target.includes(needle);
  return false;
}
