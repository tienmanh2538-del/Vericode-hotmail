// TASK-078 — shared fail-closed error for customer-scope violations on Telegram
// mapping/destination operations. Thrown by service mutations when the caller's
// access scope does not include the target resource's customer. The API layer
// maps this to 404 (not 403) so an out-of-scope caller cannot even confirm the
// resource exists.
export class TelegramScopeError extends Error {
  constructor(message = 'This resource is outside your customer scope.') {
    super(message);
    this.name = 'TelegramScopeError';
  }
}
