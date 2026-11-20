import * as Effect from "effect/Effect";
import { SalesforceApiError, SalesforceValidationError } from "./errors.js";

/**
 * Connect REST paths that live orgs actually serve (API 66 and 68).
 * `/named-credentials/named-credentials` returns 404. Named credentials
 * are `/named-credentials/named-credential-setup`.
 */
export const externalCredentialsPath = (apiVersion: string, developerName?: string): string => {
  const root = `/services/data/v${apiVersion}/named-credentials/external-credentials`;
  return developerName === undefined ? root : `${root}/${encodeURIComponent(developerName)}`;
};

export const namedCredentialSetupPath = (apiVersion: string, developerName?: string): string => {
  const root = `/services/data/v${apiVersion}/named-credentials/named-credential-setup`;
  return developerName === undefined ? root : `${root}/${encodeURIComponent(developerName)}`;
};

export const credentialPath = (
  apiVersion: string,
  query?: {
    readonly externalCredential: string;
    readonly principalName: string;
    readonly principalType: string;
  },
): string => {
  const root = `/services/data/v${apiVersion}/named-credentials/credential`;
  if (query === undefined) {
    return root;
  }
  const params = new URLSearchParams({
    externalCredential: query.externalCredential,
    principalName: query.principalName,
    principalType: query.principalType,
  });
  return `${root}?${params.toString()}`;
};

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

export const numberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const recordsFrom = (body: unknown, key: string): ReadonlyArray<Record<string, unknown>> => {
  if (Array.isArray(body)) {
    return body.filter((entry): entry is Record<string, unknown> => asRecord(entry) !== undefined);
  }
  const record = asRecord(body);
  const nested = record?.[key];
  if (!Array.isArray(nested)) {
    return [];
  }
  return nested.filter((entry): entry is Record<string, unknown> => asRecord(entry) !== undefined);
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOGIN_HOSTS = new Set(["login.salesforce.com", "test.salesforce.com"]);

/**
 * My Domain or loopback. `login.salesforce.com` and `test.salesforce.com`
 * are rejected: OAuth client-credentials token URLs must be the target org's
 * My Domain. Loopback http is allowed so unit tests can point at a mock.
 */
export const assertOrgUrl = (
  value: string,
  label: string,
  options?: { readonly tokenPath?: boolean },
): Effect.Effect<string, SalesforceValidationError> => {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return Effect.fail(
      new SalesforceValidationError({
        message: `${label} must be an absolute http(s) URL.`,
      }),
    );
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return Effect.fail(
      new SalesforceValidationError({
        message: `${label} must use https, or http on localhost for tests.`,
      }),
    );
  }
  if (LOGIN_HOSTS.has(parsed.hostname.toLowerCase())) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `${label} must be the target org's My Domain URL, not ${parsed.hostname}. ` +
          "Client-credentials token requests fail against login.salesforce.com.",
      }),
    );
  }
  const normalized = trimmed.replace(/\/+$/, "");
  if (options?.tokenPath === true && !normalized.endsWith("/services/oauth2/token")) {
    return Effect.fail(
      new SalesforceValidationError({
        message: `${label} must end with /services/oauth2/token.`,
      }),
    );
  }
  return Effect.succeed(normalized);
};

export const missingField = (message: string, method: string, path: string) =>
  new SalesforceApiError({
    message,
    status: 200,
    errorCode: undefined,
    method,
    path,
  });
