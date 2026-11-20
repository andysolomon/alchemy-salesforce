import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { SalesforceValidationError } from "./errors.js";

/**
 * Process-local secret values for the current apply.
 *
 * Alchemy persists resource props. A `Redacted` value is still written, under
 * a marker that keeps the plaintext. These values therefore never become
 * props. The stack passes them in, this map holds them until reconcile, and
 * state stores only the key names and a SHA-256 digest.
 */
const secretsByLogicalId = new Map<string, ReadonlyArray<MaterializedCredential>>();
const errorsByLogicalId = new Map<string, string>();

export interface MaterializedCredential {
  readonly key: string;
  readonly encrypted: boolean;
  readonly value: string;
}

export interface CredentialSpec {
  readonly value: Redacted.Redacted<string> | string;
  readonly encrypted?: boolean;
}

const SENSITIVE_KEY = /secret|password|token|session/i;

export const clearCredentialSecrets = (): void => {
  secretsByLogicalId.clear();
  errorsByLogicalId.clear();
};

export const rememberCredentialSecrets = (
  logicalId: string,
  credentials: ReadonlyArray<MaterializedCredential>,
): void => {
  errorsByLogicalId.delete(logicalId);
  secretsByLogicalId.set(logicalId, credentials);
};

export const rememberCredentialSecretError = (logicalId: string, message: string): void => {
  secretsByLogicalId.delete(logicalId);
  errorsByLogicalId.set(logicalId, message);
};

export const credentialSecretErrorFor = (logicalId: string): string | undefined =>
  errorsByLogicalId.get(logicalId);

export const credentialSecretsFor = (
  logicalId: string,
): ReadonlyArray<MaterializedCredential> | undefined => secretsByLogicalId.get(logicalId);

export const credentialsDigest = (credentials: ReadonlyArray<MaterializedCredential>): string => {
  const canonical = [...credentials]
    .map((item) => ({ encrypted: item.encrypted, key: item.key, value: item.value }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
};

const unwrapValue = (
  key: string,
  value: Redacted.Redacted<string> | string,
): Effect.Effect<string, SalesforceValidationError> => {
  const raw = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  if (typeof raw !== "string") {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `Credential '${key}' must be a string or a Redacted string. ` +
          "Pass Redacted.make(value) from the stack. Do not pass a Config or an object; " +
          "those can be written into Alchemy state.",
      }),
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Effect.fail(
      new SalesforceValidationError({
        message: `Credential '${key}' must not be empty.`,
      }),
    );
  }
  if (trimmed.includes("REDACTED") || trimmed.includes("[redacted]") || trimmed === "<redacted>") {
    return Effect.fail(
      new SalesforceValidationError({
        message: `Credential '${key}' looks redacted. Pass the real value, wrapped in Redacted.make.`,
      }),
    );
  }
  return Effect.succeed(raw);
};

export const materializeCredentials = (
  credentials: Readonly<Record<string, CredentialSpec | Redacted.Redacted<string> | string>>,
): Effect.Effect<ReadonlyArray<MaterializedCredential>, SalesforceValidationError> =>
  Effect.gen(function* () {
    const entries = Object.entries(credentials);
    if (entries.length === 0) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalCredentialSecret requires at least one credential value.",
        }),
      );
    }
    const materialized: MaterializedCredential[] = [];
    for (const [key, spec] of entries) {
      const name = key.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `Credential name '${key}' must start with a letter and contain only letters, numbers, and underscores.`,
          }),
        );
      }
      const valueSpec =
        typeof spec === "string" || Redacted.isRedacted(spec)
          ? { value: spec, encrypted: undefined }
          : spec;
      if (valueSpec === null || typeof valueSpec !== "object") {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `Credential '${name}' must be a string, Redacted string, or { value, encrypted }.`,
          }),
        );
      }
      const value = yield* unwrapValue(name, valueSpec.value);
      const encrypted = valueSpec.encrypted ?? SENSITIVE_KEY.test(name);
      materialized.push({ key: name, encrypted, value });
    }
    materialized.sort((left, right) => left.key.localeCompare(right.key));
    return materialized;
  });

export const secretValues = (credentials: ReadonlyArray<MaterializedCredential>): ReadonlyArray<string> =>
  credentials.map((item) => item.value);
