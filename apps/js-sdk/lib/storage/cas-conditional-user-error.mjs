import { NotSupportedError } from "./errors.mjs";

export const CAS_CONDITIONAL_WRITES_DOCTOR_HINT =
  "This storage isn't confirmed to support safe conditional writes. Run `infinitecontext storage doctor --recheck-cas`.";

export class CasConditionalWritesUnconfirmedError extends Error {
  constructor(message = CAS_CONDITIONAL_WRITES_DOCTOR_HINT) {
    super(message);
    this.name = "CasConditionalWritesUnconfirmedError";
    this.code = "cas_conditional_unconfirmed";
  }
}

/** @param {unknown} err */
export function isConditionalCreateNotSupportedError(err) {
  return err instanceof NotSupportedError && /conditional create/i.test(String(err.message));
}

/** @param {unknown} err */
export function rethrowIfConditionalCreateUnsupported(err) {
  if (isConditionalCreateNotSupportedError(err)) {
    throw new CasConditionalWritesUnconfirmedError();
  }
  throw err;
}

/** @template T @param {() => Promise<T>} fn */
export async function withCasConditionalCreateFriendlyError(fn) {
  try {
    return await fn();
  } catch (err) {
    rethrowIfConditionalCreateUnsupported(err);
  }
}
