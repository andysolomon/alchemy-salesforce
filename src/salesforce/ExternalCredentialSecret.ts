import { Resource, type Input, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { request } from "./api.js";
import {
  asRecord,
  credentialPath,
  stringField,
} from "./connect.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import {
  clearCredentialSecrets,
  credentialSecretErrorFor,
  credentialSecretsFor,
  credentialsDigest,
  materializeCredentials,
  rememberCredentialSecretError,
  rememberCredentialSecrets,
  secretValues,
  type CredentialSpec,
  type MaterializedCredential,
} from "./credentialSecrets.js";
import { isNotFound, redactApiError, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { requireDeveloperName } from "./names.js";
import {
  PRINCIPAL_TYPES,
  publishExternalCredentialAuthenticationStatus,
  type PrincipalType,
} from "./ExternalCredential.js";

/**
 * Connect REST `/named-credentials/credential`.
 *
 * Secret values are accepted as strings or `Redacted` values and kept in
 * process memory for the apply. They are not resource props, not attributes,
 * and not written to `.alchemy/state/`. State stores the credential key
 * names, which keys are encrypted, and a SHA-256 digest so a changed secret
 * plans an update and an unchanged secret plans a noop.
 */
export interface ExternalCredentialSecretInput {
  readonly targetOrg?: Input<string>;
  /** Resolved before apply. An `ExternalCredential` output wires the dependency. */
  readonly externalCredential: Input<string>;
  readonly principalName: Input<string>;
  readonly principalType?: Input<PrincipalType>;
  readonly credentials: Readonly<Record<string, CredentialSpec | Redacted.Redacted<string> | string>>;
  /**
   * When set, `sha256(credentials.clientId)` must equal `consumerKeySha256`
   * before any credential request is sent. A mismatch means the secret store
   * is behind the External Client App.
   */
  readonly clientApp?: Input<{
    readonly consumerKeySha256: string;
    readonly consumerId: string;
  }>;
}

export interface ExternalCredentialSecretProps {
  readonly targetOrg?: string;
  readonly externalCredential: string;
  readonly principalName: string;
  readonly principalType: PrincipalType;
  readonly credentialKeys: ReadonlyArray<string>;
  readonly encryptedKeys: ReadonlyArray<string>;
  /** SHA-256 of the credential names, encryption flags, and values. Not the secret. */
  readonly credentialsDigest: string;
  readonly clientApp?: {
    readonly consumerKeySha256: string;
    readonly consumerId: string;
  };
}

export interface ExternalCredentialSecretAttributes {
  readonly externalCredential: string;
  readonly principalName: string;
  readonly principalType: string;
  readonly credentialKeys: ReadonlyArray<string>;
  readonly encryptedKeys: ReadonlyArray<string>;
  readonly credentialsDigest: string;
  readonly authenticationStatus: string;
  readonly targetOrg: string | null;
}

export type ExternalCredentialSecret = ResourceInstance<
  "Salesforce.ExternalCredentialSecret",
  ExternalCredentialSecretProps,
  ExternalCredentialSecretAttributes
>;

export const ExternalCredentialSecretResource = Resource<ExternalCredentialSecret>(
  "Salesforce.ExternalCredentialSecret",
);

interface LiveCredential {
  readonly record: Record<string, unknown>;
  readonly keys: ReadonlyArray<{ readonly key: string; readonly encrypted: boolean; readonly value: string | undefined }>;
  readonly authenticationStatus: string;
}

const isPrincipalType = (value: string): value is PrincipalType =>
  (PRINCIPAL_TYPES as ReadonlyArray<string>).includes(value);

const credentialMap = (record: Record<string, unknown>): LiveCredential["keys"] => {
  const credentials = asRecord(record.credentials);
  if (credentials === undefined) {
    return [];
  }
  return Object.entries(credentials).flatMap(([key, entry]) => {
    const spec = asRecord(entry);
    if (spec === undefined) {
      return [];
    }
    const value = spec.value;
    return [
      {
        key,
        encrypted: spec.encrypted === true,
        value: typeof value === "string" ? value : undefined,
      },
    ];
  });
};

const attributesFrom = (
  props: ExternalCredentialSecretProps,
  authenticationStatus: string,
): ExternalCredentialSecretAttributes => ({
  externalCredential: props.externalCredential,
  principalName: props.principalName,
  principalType: props.principalType,
  credentialKeys: props.credentialKeys,
  encryptedKeys: props.encryptedKeys,
  credentialsDigest: props.credentialsDigest,
  authenticationStatus,
  targetOrg: props.targetOrg ?? null,
});

const assertResolvedIdentity = (
  props: ExternalCredentialSecretProps,
): Effect.Effect<ExternalCredentialSecretProps, SalesforceValidationError> =>
  Effect.gen(function* () {
    const externalCredential = yield* requireDeveloperName(
      props.externalCredential,
      "ExternalCredentialSecret externalCredential",
    );
    const principalName = yield* requireDeveloperName(
      props.principalName,
      "ExternalCredentialSecret principalName",
    );
    if (!isPrincipalType(props.principalType)) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `ExternalCredentialSecret principalType '${props.principalType}' is not supported. ` +
            `Use ${PRINCIPAL_TYPES.join(", ")}.`,
        }),
      );
    }
    return { ...props, externalCredential, principalName };
  });

/**
 * Identity fields may still be Alchemy outputs here. Only the credential
 * values are unwrapped, and they are stored beside the resource, not on it.
 */
const declareSecret = (id: string, props: ExternalCredentialSecretInput) =>
  Effect.gen(function* () {
    const credentials = yield* materializeCredentials(props.credentials).pipe(
      Effect.catchTag("SalesforceValidationError", (error) => {
        rememberCredentialSecretError(id, error.message);
        return Effect.succeed(undefined);
      }),
    );
    if (credentials === undefined) {
      const externalCredential = typeof props.externalCredential === "string" ? props.externalCredential : "Invalid";
      const principalName = typeof props.principalName === "string" ? props.principalName : "Invalid";
      return yield* ExternalCredentialSecretResource(id, {
        ...(typeof props.targetOrg === "string" ? { targetOrg: props.targetOrg } : {}),
        externalCredential,
        principalName,
        principalType: "NamedPrincipal",
        credentialKeys: [],
        encryptedKeys: [],
        credentialsDigest: credentialsDigest([]),
      });
    }
    rememberCredentialSecrets(id, credentials);
    return yield* ExternalCredentialSecretResource(id, {
      ...(props.targetOrg === undefined ? {} : { targetOrg: props.targetOrg }),
      externalCredential: props.externalCredential,
      principalName: props.principalName,
      principalType: props.principalType ?? "NamedPrincipal",
      credentialKeys: credentials.map((item) => item.key),
      encryptedKeys: credentials.filter((item) => item.encrypted).map((item) => item.key),
      credentialsDigest: credentialsDigest(credentials),
      ...(props.clientApp === undefined ? {} : { clientApp: props.clientApp }),
    });
  });

export const ExternalCredentialSecret = Object.assign(declareSecret, {
  Type: ExternalCredentialSecretResource.Type,
  Provider: ExternalCredentialSecretResource.Provider,
});

export { clearCredentialSecrets };

const scrub = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  secrets: ReadonlyArray<string>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof SalesforceApiError ? (redactApiError(error, secrets) as E) : error,
    ),
  );

const requireSecrets = (logicalId: string, externalCredential: string, principalName: string) => {
  const secrets = credentialSecretsFor(logicalId);
  if (secrets === undefined) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `Credential values for principal '${principalName}' on '${externalCredential}' ` +
          "are not in this process. Declare them on Salesforce.ExternalCredentialSecret. " +
          "Values stay in memory for the apply and are not written to Alchemy state.",
      }),
    );
  }
  return Effect.succeed(secrets);
};

const assertClientApp = (
  props: ExternalCredentialSecretProps,
  credentials: ReadonlyArray<MaterializedCredential>,
): Effect.Effect<void, SalesforceValidationError> => {
  const clientApp = props.clientApp;
  if (clientApp === undefined) {
    return Effect.void;
  }
  if (!/^[0-9a-f]{64}$/.test(clientApp.consumerKeySha256)) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "clientApp.consumerKeySha256 must be a SHA-256 hex digest. The consumer key is not stored here.",
      }),
    );
  }
  if (clientApp.consumerId.trim().length === 0) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "clientApp.consumerId is required when clientApp is set.",
      }),
    );
  }
  const clientId = credentials.find((item) => item.key === "clientId");
  if (clientId === undefined) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          "clientApp is set, but credentials do not include clientId. " +
          "The comparison is sha256(credentials.clientId) against the External Client App consumer key hash.",
      }),
    );
  }
  if (sha256Hex(clientId.value) !== clientApp.consumerKeySha256) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `Credential clientId for '${props.principalName}' on '${props.externalCredential}' ` +
          "does not match the External Client App consumer key (sha256). " +
          "The secret store is out of date. No credential request was sent, and the key is not included in this error.",
      }),
    );
  }
  return Effect.void;
};

const identityQuery = (props: ExternalCredentialSecretProps) => ({
  externalCredential: props.externalCredential,
  principalName: props.principalName,
  principalType: props.principalType,
});

/**
 * A principal that has never had secrets still answers GET with 200.
 * The body is `authenticationStatus: "NotConfigured"` and `credentials: {}`,
 * not 404. PUT against that principal fails and tells the caller to POST.
 */
const hasStoredCredentials = (live: LiveCredential): boolean =>
  live.authenticationStatus !== "NotConfigured" && live.keys.length > 0;

const needsCreate = (error: SalesforceApiError): boolean =>
  /no existing authentication credentials/i.test(error.message) ||
  /use the post method to create/i.test(error.message);

const readLive = (connection: ResolvedConnection, props: ExternalCredentialSecretProps) =>
  Effect.gen(function* () {
    const path = credentialPath(connection.apiVersion, identityQuery(props));
    const result = yield* request(connection, { method: "GET", path }).pipe(
      Effect.catchTag("SalesforceApiError", (error) =>
        isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    const record = result === undefined ? undefined : asRecord(result.body);
    if (record === undefined) {
      return undefined;
    }
    const live = {
      record,
      keys: credentialMap(record),
      authenticationStatus: stringField(record, "authenticationStatus") ?? "Unknown",
    } satisfies LiveCredential;
    return hasStoredCredentials(live) ? live : undefined;
  });

const valuesMatch = (
  live: LiveCredential,
  desired: ReadonlyArray<MaterializedCredential>,
): boolean => {
  if (live.keys.length !== desired.length) {
    return false;
  }
  const byKey = new Map(live.keys.map((item) => [item.key, item]));
  return desired.every((item) => {
    const found = byKey.get(item.key);
    return (
      found !== undefined &&
      found.encrypted === item.encrypted &&
      found.value !== undefined &&
      found.value === item.value
    );
  });
};

const requestBody = (
  props: ExternalCredentialSecretProps,
  credentials: ReadonlyArray<MaterializedCredential>,
): Record<string, unknown> => ({
  externalCredential: props.externalCredential,
  principalName: props.principalName,
  principalType: props.principalType,
  credentials: Object.fromEntries(
    credentials.map((item) => [item.key, { value: item.value, encrypted: item.encrypted }]),
  ),
});

const isDuplicate = (error: SalesforceApiError): boolean =>
  error.errorCode === "DUPLICATE_VALUE" || error.errorCode === "DUPLICATE_DEVELOPER_NAME";

/**
 * Nuke is skipped and `list` is empty. Listing credentials would read secret
 * values, and a credential has no Alchemy ownership tag.
 */
export const ExternalCredentialSecretProvider = Provider.succeed(
  ExternalCredentialSecretResource,
  ExternalCredentialSecretResource.Provider.of({
    stables: ["externalCredential", "principalName"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (
          targetOrgChanged(input.olds.targetOrg, input.news.targetOrg) ||
          input.olds.externalCredential !== input.news.externalCredential ||
          input.olds.principalName !== input.news.principalName ||
          input.olds.principalType !== input.news.principalType
        ) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) => {
      if (credentialSecretErrorFor(input.id) !== undefined) {
        return Effect.succeed(undefined);
      }
      const known = credentialSecretsFor(input.id);
      if (known !== undefined && input.olds.clientApp !== undefined) {
        return assertClientApp(input.olds, known).pipe(
          Effect.flatMap(() =>
            scrub(
              Effect.gen(function* () {
                const connection = yield* connectionFor(input.olds.targetOrg);
                const live = yield* readLive(connection, input.olds);
                if (live === undefined) {
                  return undefined;
                }
                return attributesFrom(input.olds, live.authenticationStatus);
              }),
              secretValues(known),
            ),
          ),
        );
      }
      return scrub(
        Effect.gen(function* () {
          const connection = yield* connectionFor(input.olds.targetOrg);
          const live = yield* readLive(connection, input.olds);
          if (live === undefined) {
            return undefined;
          }
          return attributesFrom(input.olds, live.authenticationStatus);
        }),
        secretValues(credentialSecretsFor(input.id) ?? []),
      );
    },
    observe: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news)) {
          return undefined;
        }
        const known = credentialSecretsFor(input.id);
        if (known !== undefined) {
          yield* assertClientApp(input.news, known);
        }
        const connection = yield* connectionFor(input.news.targetOrg);
        const live = yield* readLive(connection, input.news);
        if (live === undefined) {
          return undefined;
        }
        return attributesFrom(input.news, live.authenticationStatus);
      }),
    list: () => Effect.succeed([]),
    reconcile: (input) =>
      Effect.gen(function* () {
        const earlier = credentialSecretErrorFor(input.id);
        if (earlier !== undefined) {
          return yield* Effect.fail(new SalesforceValidationError({ message: earlier }));
        }
        const identity = yield* assertResolvedIdentity(input.news);
        const secrets = yield* requireSecrets(input.id, identity.externalCredential, identity.principalName);
        yield* assertClientApp(identity, secrets);
        const values = secretValues(secrets);
        return yield* scrub(
          Effect.gen(function* () {
            const connection = yield* connectionFor(identity.targetOrg);
            const live = yield* readLive(connection, identity);
            const finish = (authenticationStatus: string) =>
              Effect.gen(function* () {
                const attributes = attributesFrom(identity, authenticationStatus);
                yield* publishExternalCredentialAuthenticationStatus(
                  identity.externalCredential,
                  identity.targetOrg,
                );
                return attributes;
              });
            if (live !== undefined && valuesMatch(live, secrets)) {
              return yield* finish(live.authenticationStatus);
            }
            const body = requestBody(identity, secrets);
            const path = credentialPath(connection.apiVersion);
            const createCredential = request(connection, { method: "POST", path, body }).pipe(
              Effect.catchTag("SalesforceApiError", (error) =>
                isDuplicate(error) ? Effect.succeed(undefined) : Effect.fail(error),
              ),
            );
            if (live === undefined) {
              const created = yield* createCredential;
              if (created !== undefined) {
                const record = asRecord(created.body);
                const status =
                  record === undefined
                    ? "Configured"
                    : (stringField(record, "authenticationStatus") ?? "Configured");
                return yield* finish(status);
              }
            }
            yield* request(connection, { method: "PUT", path, body }).pipe(
              Effect.catchTag("SalesforceApiError", (error) =>
                needsCreate(error) ? createCredential : Effect.fail(error),
              ),
            );
            const after = yield* readLive(connection, identity);
            if (
              after !== undefined &&
              !valuesMatch(after, secrets) &&
              after.keys.every((item) => item.value !== undefined)
            ) {
              return yield* Effect.fail(
                new SalesforceApiError({
                  message:
                    `Credential for '${identity.principalName}' on '${identity.externalCredential}' ` +
                    "did not match the values sent. The secret values are omitted from this error.",
                  status: 200,
                  errorCode: undefined,
                  method: "GET",
                  path: credentialPath(connection.apiVersion),
                }),
              );
            }
            return yield* finish(after?.authenticationStatus ?? "Configured");
          }),
          values,
        );
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        yield* request(connection, {
          method: "DELETE",
          path: credentialPath(connection.apiVersion, identityQuery(input.olds)),
        }).pipe(
          Effect.catchTag("SalesforceApiError", (error) =>
            isNotFound(error) ? Effect.void : Effect.fail(error),
          ),
        );
      }),
  }),
);
