import * as Data from "effect/Data";

/**
 * The org connection could not be resolved from the environment or the CLI.
 */
export class SalesforceAuthError extends Data.TaggedError("SalesforceAuthError")<{
  readonly message: string;
}> {}

/**
 * `sf` could not be executed, or it exited without a usable payload.
 * `message` is scrubbed of access tokens.
 */
export class SalesforceCliError extends Data.TaggedError("SalesforceCliError")<{
  readonly message: string;
  readonly command: string;
}> {}

/**
 * A REST call failed, or the response was not usable.
 * `path` is the URL path without the query string.
 */
export class SalesforceApiError extends Data.TaggedError("SalesforceApiError")<{
  readonly message: string;
  readonly status: number;
  readonly errorCode: string | undefined;
  readonly method: string;
  readonly path: string;
}> {}

/**
 * Props that Salesforce would reject, caught before any request is sent.
 */
export class SalesforceValidationError extends Data.TaggedError("SalesforceValidationError")<{
  readonly message: string;
}> {}

const NOT_FOUND_CODES = new Set(["NOT_FOUND", "ENTITY_IS_DELETED", "INVALID_CROSS_REFERENCE_KEY"]);

/** Delete treats these as "already gone" so destroy and retries stay idempotent. */
export const isNotFound = (error: SalesforceApiError): boolean =>
  error.status === 404 || (error.errorCode !== undefined && NOT_FOUND_CODES.has(error.errorCode));

export const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return String(cause);
};

/**
 * Replace secret material in text that might be logged or thrown.
 * Longer secrets are applied first so a shorter one cannot split a longer one.
 * Secrets shorter than 4 characters are left alone so they cannot eat ordinary words.
 */
export const redactSensitiveText = (text: string, secrets: ReadonlyArray<string>): string => {
  const forms = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort(
    (left, right) => right.length - left.length,
  );
  let redacted = text;
  for (const secret of forms) {
    redacted = redacted.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      redacted = redacted.split(encoded).join("[redacted]");
    }
  }
  return redacted;
};

/** Rebuild an API error so a secret echoed by Salesforce cannot leave this process. */
export const redactApiError = (
  error: SalesforceApiError,
  secrets: ReadonlyArray<string>,
): SalesforceApiError =>
  new SalesforceApiError({
    message: redactSensitiveText(error.message, secrets),
    status: error.status,
    errorCode: error.errorCode,
    method: error.method,
    path: redactSensitiveText(error.path, secrets),
  });
