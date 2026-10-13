export class StorageError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "storage_error") {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export class PreconditionFailedError extends StorageError {
  /** @param {string} [message] */
  constructor(message = "Precondition failed") {
    super(message, "precondition_failed");
    this.name = "PreconditionFailedError";
  }
}

export class NotSupportedError extends StorageError {
  /** @param {string} message */
  constructor(message) {
    super(message, "not_supported");
    this.name = "NotSupportedError";
  }
}

export class AuthExpiredError extends StorageError {
  /** @param {string} [message] */
  constructor(message = "Storage authentication expired") {
    super(message, "auth_expired");
    this.name = "AuthExpiredError";
  }
}

export class RateLimitedError extends StorageError {
  /** @param {string} [message] */
  constructor(message = "Storage rate limit exceeded") {
    super(message, "rate_limited");
    this.name = "RateLimitedError";
  }
}
