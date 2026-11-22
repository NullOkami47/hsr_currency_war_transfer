export const PUBLICATION_PENDING_REVIEW_MESSAGE =
  "The Global strategy was created and is not public yet. It may still be under review. Please retry later.";

export class PublicInputError extends TypeError {
  constructor(message, reason = "invalid_request", options = {}) {
    super(message, options);
    this.name = "PublicInputError";
    this.reason = reason;
  }
}

export class WorkerPolicyError extends Error {
  constructor(code, message, { status = 403, retryAfter = null } = {}) {
    super(message);
    this.name = "WorkerPolicyError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
