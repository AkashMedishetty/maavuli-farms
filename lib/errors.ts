/**
 * Shared error types. Route handlers turn these into HTTP statuses via
 * lib/api.handleRouteError — so lib code throws meaning, never status codes.
 */

/** 400 — the input is wrong. `issues` are shown to the user; `code` lets a client route the error without matching message text. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public issues: string[] = [],
    public code?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 404 */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** 409 — valid input, but the current state does not allow it. */
export class ConflictError extends Error {
  constructor(
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** 403 — signed in, but not allowed. */
export class ForbiddenError extends Error {
  constructor(message = 'You do not have access to this.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** 409 — the delivery date is past its cutoff (or already locked). Carries the first open date. */
export class DateLockedError extends Error {
  constructor(
    public date: string,
    public firstOpen: string,
  ) {
    super(`Changes for ${date} have closed. The earliest date you can change is ${firstOpen}.`);
    this.name = 'DateLockedError';
  }
}

/** 503 — a third-party service is not configured. Names the missing variables. */
export class ServiceNotConfiguredError extends Error {
  constructor(
    public service: string,
    public missing: string[],
  ) {
    super(`${service} is not configured — missing: ${missing.join(', ')}`);
    this.name = 'ServiceNotConfiguredError';
  }
}

/** 502 — a third-party call failed. The message is safe to show; details are logged. */
export class UpstreamError extends Error {
  constructor(
    public service: string,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}
