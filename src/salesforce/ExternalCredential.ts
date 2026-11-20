import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { request } from "./api.js";
import {
  asRecord,
  assertOrgUrl,
  externalCredentialsPath,
  missingField,
  numberField,
  recordsFrom,
  stringField,
} from "./connect.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { requireDeveloperName } from "./names.js";

/**
 * Connect REST external credential (`/named-credentials/external-credentials`).
 * Updates are PUT. `authenticationProtocol` is `"OAuth"` (capital A).
 * Tooling API is not used: it only accepts `FullName` + `Metadata`.
 */
export const AUTHENTICATION_PROTOCOLS = [
  "OAuth",
  "Custom",
  "NoAuthentication",
  "Basic",
  "AwsSv4",
  "Jwt",
] as const;

export type AuthenticationProtocol = (typeof AUTHENTICATION_PROTOCOLS)[number];

export const OAUTH_PROTOCOL_VARIANTS = [
  "ClientCredentialsClientSecretBasic",
  "ClientCredentialsClientSecret",
  "ClientCredentialsJwtAssertion",
  "JwtBearer",
] as const;

export type OAuthProtocolVariant = (typeof OAUTH_PROTOCOL_VARIANTS)[number];

export const PRINCIPAL_TYPES = ["NamedPrincipal", "PerUserPrincipal", "Anonymous"] as const;

export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export interface ExternalCredentialParameter {
  readonly parameterName: string;
  readonly parameterType: string;
  readonly parameterValue: string;
}

export interface ExternalCredentialPrincipalInput {
  readonly principalName: string;
  readonly principalType: PrincipalType;
  readonly sequenceNumber?: number;
  readonly parameters?: ReadonlyArray<ExternalCredentialParameter>;
}

export interface ExternalCredentialProps {
  readonly targetOrg?: string;
  readonly developerName: string;
  readonly masterLabel?: string;
  /** Connect REST value. Use `"OAuth"`, not Tooling's `"Oauth"`. */
  readonly authenticationProtocol: AuthenticationProtocol;
  readonly authenticationProtocolVariant?: string;
  readonly parameters?: ReadonlyArray<ExternalCredentialParameter>;
  readonly principals?: ReadonlyArray<ExternalCredentialPrincipalInput>;
  readonly customHeaders?: ReadonlyArray<ExternalCredentialHeader>;
}

export interface ExternalCredentialHeader {
  readonly headerName: string;
  readonly headerValue: string;
  readonly sequenceNumber?: number;
}

export interface ExternalCredentialPrincipalAttributes {
  readonly id: string;
  readonly principalName: string;
  readonly principalType: string;
  readonly sequenceNumber: number;
  readonly authenticationStatus: string | null;
}

export interface ExternalCredentialAttributes {
  readonly id: string;
  readonly developerName: string;
  readonly masterLabel: string;
  readonly authenticationProtocol: string;
  readonly authenticationProtocolVariant: string | null;
  readonly authenticationStatus: string;
  readonly parameters: ReadonlyArray<ExternalCredentialParameter>;
  readonly principals: ReadonlyArray<ExternalCredentialPrincipalAttributes>;
  readonly url: string | null;
}

export type ExternalCredential = ResourceInstance<
  "Salesforce.ExternalCredential",
  ExternalCredentialProps,
  ExternalCredentialAttributes
>;

export const ExternalCredentialResource = Resource<ExternalCredential>("Salesforce.ExternalCredential");

interface NormalizedParameter {
  readonly parameterName: string;
  readonly parameterType: string;
  readonly parameterValue: string;
}

interface NormalizedPrincipal {
  readonly principalName: string;
  readonly principalType: PrincipalType;
  readonly sequenceNumber: number;
  readonly parameters: ReadonlyArray<NormalizedParameter>;
}

interface NormalizedHeader {
  readonly headerName: string;
  readonly headerValue: string;
  readonly sequenceNumber: number;
}

interface NormalizedExternalCredential {
  readonly developerName: string;
  readonly masterLabel: string;
  readonly authenticationProtocol: AuthenticationProtocol;
  readonly authenticationProtocolVariant: string | undefined;
  readonly parameters: ReadonlyArray<NormalizedParameter>;
  readonly principals: ReadonlyArray<NormalizedPrincipal>;
  readonly customHeaders: ReadonlyArray<NormalizedHeader>;
}

const isProtocol = (value: string): value is AuthenticationProtocol =>
  (AUTHENTICATION_PROTOCOLS as ReadonlyArray<string>).includes(value);

const isPrincipalType = (value: string): value is PrincipalType =>
  (PRINCIPAL_TYPES as ReadonlyArray<string>).includes(value);

const CLIENT_CREDENTIALS = new Set<string>([
  "ClientCredentialsClientSecretBasic",
  "ClientCredentialsClientSecret",
  "ClientCredentialsJwtAssertion",
]);

const parameterKey = (parameter: NormalizedParameter): string =>
  `${parameter.parameterName}\0${parameter.parameterType}\0${parameter.parameterValue}`;

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const normalizeParameters = (
  parameters: ReadonlyArray<ExternalCredentialParameter> | undefined,
  label: string,
): Effect.Effect<ReadonlyArray<NormalizedParameter>, SalesforceValidationError> =>
  Effect.gen(function* () {
    const normalized: NormalizedParameter[] = [];
    for (const parameter of parameters ?? []) {
      const parameterName = parameter.parameterName.trim();
      const parameterType = parameter.parameterType.trim();
      const parameterValue = parameter.parameterValue.trim();
      if (parameterName.length === 0 || parameterType.length === 0 || parameterValue.length === 0) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `${label} parameters need parameterName, parameterType, and parameterValue.`,
          }),
        );
      }
      if (parameterName === "AuthProviderUrl" || parameterType === "AuthProviderUrl") {
        yield* assertOrgUrl(parameterValue, `${label} AuthProviderUrl`, { tokenPath: true });
      }
      normalized.push({ parameterName, parameterType, parameterValue });
    }
    return normalized;
  });

export const normalizeExternalCredential = (
  props: ExternalCredentialProps,
): Effect.Effect<NormalizedExternalCredential, SalesforceValidationError> =>
  Effect.gen(function* () {
    const developerName = yield* requireDeveloperName(props.developerName, "ExternalCredential developerName");
    const masterLabel = (props.masterLabel ?? developerName).trim();
    if (masterLabel.length === 0 || masterLabel.length > 80) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalCredential masterLabel must be 1 to 80 characters.",
        }),
      );
    }
    if (!isProtocol(props.authenticationProtocol)) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `ExternalCredential authenticationProtocol '${props.authenticationProtocol}' is not supported. ` +
            `Use one of ${AUTHENTICATION_PROTOCOLS.join(", ")}. OAuth is spelled "OAuth", not "Oauth".`,
        }),
      );
    }
    const variant = props.authenticationProtocolVariant?.trim();
    if (props.authenticationProtocol === "OAuth") {
      if (variant === undefined || variant.length === 0) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message:
              "OAuth external credentials require authenticationProtocolVariant. " +
              `Prefer ClientCredentialsClientSecretBasic. Allowed: ${OAUTH_PROTOCOL_VARIANTS.join(", ")}.`,
          }),
        );
      }
      if (!(OAUTH_PROTOCOL_VARIANTS as ReadonlyArray<string>).includes(variant)) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message:
              `OAuth authenticationProtocolVariant '${variant}' is not supported. ` +
              `Allowed: ${OAUTH_PROTOCOL_VARIANTS.join(", ")}.`,
          }),
        );
      }
    }
    const parameters = yield* normalizeParameters(props.parameters, "ExternalCredential");
    if (
      props.authenticationProtocol === "OAuth" &&
      variant !== undefined &&
      CLIENT_CREDENTIALS.has(variant) &&
      !parameters.some((parameter) => parameter.parameterType === "AuthProviderUrl")
    ) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            "OAuth client-credentials external credentials need an AuthProviderUrl parameter " +
            "whose value is {MyDomain}/services/oauth2/token.",
        }),
      );
    }
    const principals: NormalizedPrincipal[] = [];
    for (const [index, principal] of (props.principals ?? []).entries()) {
      const principalName = yield* requireDeveloperName(
        principal.principalName,
        "ExternalCredential principalName",
      );
      if (!isPrincipalType(principal.principalType)) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message:
              `ExternalCredential principalType '${principal.principalType}' is not supported. ` +
              `Use ${PRINCIPAL_TYPES.join(", ")}.`,
          }),
        );
      }
      const sequenceNumber = principal.sequenceNumber ?? index + 1;
      if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `ExternalCredential principal '${principalName}' sequenceNumber must be a positive integer.`,
          }),
        );
      }
      principals.push({
        principalName,
        principalType: principal.principalType,
        sequenceNumber,
        parameters: yield* normalizeParameters(principal.parameters, `Principal ${principalName}`),
      });
    }
    if (props.authenticationProtocol === "OAuth" && !principals.some((principal) => principal.principalType === "NamedPrincipal")) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "OAuth external credentials need at least one NamedPrincipal.",
        }),
      );
    }
    const customHeaders: NormalizedHeader[] = [];
    for (const [index, header] of (props.customHeaders ?? []).entries()) {
      const headerName = header.headerName.trim();
      const headerValue = header.headerValue.trim();
      if (headerName.length === 0 || headerValue.length === 0) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: "ExternalCredential custom headers need headerName and headerValue.",
          }),
        );
      }
      const sequenceNumber = header.sequenceNumber ?? index + 1;
      if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `ExternalCredential header '${headerName}' sequenceNumber must be a positive integer.`,
          }),
        );
      }
      customHeaders.push({ headerName, headerValue, sequenceNumber });
    }
    return {
      developerName,
      masterLabel,
      authenticationProtocol: props.authenticationProtocol,
      authenticationProtocolVariant: variant === undefined || variant.length === 0 ? undefined : variant,
      parameters,
      principals,
      customHeaders,
    };
  });

const parametersFrom = (value: unknown): ReadonlyArray<NormalizedParameter> => {
  if (!Array.isArray(value)) {
    return [];
  }
  const parameters: NormalizedParameter[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === undefined) {
      continue;
    }
    const parameterName = stringField(record, "parameterName");
    const parameterType = stringField(record, "parameterType");
    const parameterValue = stringField(record, "parameterValue");
    if (parameterName === undefined || parameterType === undefined || parameterValue === undefined) {
      continue;
    }
    parameters.push({ parameterName, parameterType, parameterValue });
  }
  return parameters;
};

const principalsFrom = (
  value: unknown,
): Effect.Effect<ReadonlyArray<ExternalCredentialPrincipalAttributes>, SalesforceApiError> => {
  if (!Array.isArray(value)) {
    return Effect.succeed([]);
  }
  return Effect.gen(function* () {
    const principals: ExternalCredentialPrincipalAttributes[] = [];
    for (const entry of value) {
      const record = asRecord(entry);
      if (record === undefined) {
        continue;
      }
      const id = stringField(record, "id");
      const principalName = stringField(record, "principalName");
      const principalType = stringField(record, "principalType");
      if (id === undefined || principalName === undefined || principalType === undefined) {
        return yield* Effect.fail(
          missingField(
            "External credential principal was missing id, principalName, or principalType.",
            "GET",
            "/named-credentials/external-credentials",
          ),
        );
      }
      const status = stringField(record, "authenticationStatus");
      principals.push({
        id,
        principalName,
        principalType,
        sequenceNumber: numberField(record, "sequenceNumber") ?? 0,
        authenticationStatus: status ?? null,
      });
    }
    return principals;
  });
};

const attributesFrom = (
  record: Record<string, unknown>,
): Effect.Effect<ExternalCredentialAttributes, SalesforceApiError> =>
  Effect.gen(function* () {
    const id = stringField(record, "id");
    const developerName = stringField(record, "developerName");
    const masterLabel = stringField(record, "masterLabel") ?? developerName;
    const authenticationProtocol = stringField(record, "authenticationProtocol");
    if (id === undefined || developerName === undefined || masterLabel === undefined || authenticationProtocol === undefined) {
      return yield* Effect.fail(
        missingField(
          "External credential was missing id, developerName, masterLabel, or authenticationProtocol.",
          "GET",
          "/named-credentials/external-credentials",
        ),
      );
    }
    const variant = stringField(record, "authenticationProtocolVariant");
    const url = stringField(record, "url");
    return {
      id,
      developerName,
      masterLabel,
      authenticationProtocol,
      authenticationProtocolVariant: variant ?? null,
      authenticationStatus: stringField(record, "authenticationStatus") ?? "Unknown",
      parameters: parametersFrom(record.parameters),
      principals: yield* principalsFrom(record.principals),
      url: url ?? null,
    };
  });

const requestBody = (credential: NormalizedExternalCredential): Record<string, unknown> => ({
  developerName: credential.developerName,
  masterLabel: credential.masterLabel,
  authenticationProtocol: credential.authenticationProtocol,
  ...(credential.authenticationProtocolVariant === undefined
    ? {}
    : { authenticationProtocolVariant: credential.authenticationProtocolVariant }),
  parameters: credential.parameters.map((parameter) => ({
    parameterName: parameter.parameterName,
    parameterType: parameter.parameterType,
    parameterValue: parameter.parameterValue,
  })),
  principals: credential.principals.map((principal) => ({
    principalName: principal.principalName,
    principalType: principal.principalType,
    sequenceNumber: principal.sequenceNumber,
    ...(principal.parameters.length === 0
      ? {}
      : {
          parameters: principal.parameters.map((parameter) => ({
            parameterName: parameter.parameterName,
            parameterType: parameter.parameterType,
            parameterValue: parameter.parameterValue,
          })),
        }),
  })),
  customHeaders: credential.customHeaders.map((header) => ({
    headerName: header.headerName,
    headerValue: header.headerValue,
    sequenceNumber: header.sequenceNumber,
  })),
});

const drifted = (record: Record<string, unknown>, credential: NormalizedExternalCredential): boolean => {
  const parameters = [...parametersFrom(record.parameters)].map(parameterKey).sort();
  const desiredParameters = [...credential.parameters].map(parameterKey).sort();
  const principals = Array.isArray(record.principals) ? record.principals : [];
  const livePrincipals = principals.flatMap((entry) => {
    const principal = asRecord(entry);
    if (principal === undefined) {
      return [];
    }
    const principalName = stringField(principal, "principalName") ?? "";
    const principalType = stringField(principal, "principalType") ?? "";
    const sequenceNumber = numberField(principal, "sequenceNumber") ?? 0;
    const nested = [...parametersFrom(principal.parameters)].map(parameterKey).sort().join("|");
    return [`${principalName}\0${principalType}\0${sequenceNumber}\0${nested}`];
  });
  const desiredPrincipals = credential.principals.map((principal) => {
    const nested = [...principal.parameters].map(parameterKey).sort().join("|");
    return `${principal.principalName}\0${principal.principalType}\0${principal.sequenceNumber}\0${nested}`;
  });
  const headers = Array.isArray(record.customHeaders) ? record.customHeaders : [];
  const liveHeaders = headers.flatMap((entry) => {
    const header = asRecord(entry);
    if (header === undefined) {
      return [];
    }
    return [
      `${stringField(header, "headerName") ?? ""}\0${stringField(header, "headerValue") ?? ""}\0${numberField(header, "sequenceNumber") ?? 0}`,
    ];
  });
  const desiredHeaders = credential.customHeaders.map(
    (header) => `${header.headerName}\0${header.headerValue}\0${header.sequenceNumber}`,
  );
  return (
    stringField(record, "developerName") !== credential.developerName ||
    (stringField(record, "masterLabel") ?? "") !== credential.masterLabel ||
    stringField(record, "authenticationProtocol") !== credential.authenticationProtocol ||
    (stringField(record, "authenticationProtocolVariant") ?? null) !==
      (credential.authenticationProtocolVariant ?? null) ||
    !sameList(parameters, desiredParameters) ||
    !sameList([...livePrincipals].sort(), [...desiredPrincipals].sort()) ||
    !sameList([...liveHeaders].sort(), [...desiredHeaders].sort())
  );
};

const isDuplicate = (error: SalesforceApiError): boolean =>
  error.errorCode === "DUPLICATE_DEVELOPER_NAME" || error.errorCode === "DUPLICATE_VALUE";

const findByName = (connection: ResolvedConnection, developerName: string) =>
  Effect.gen(function* () {
    const path = externalCredentialsPath(connection.apiVersion, developerName);
    const result = yield* request(connection, { method: "GET", path }).pipe(
      Effect.catchTag("SalesforceApiError", (error) =>
        isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    return result === undefined ? undefined : asRecord(result.body);
  });

const load = (connection: ResolvedConnection, developerName: string | undefined) =>
  Effect.gen(function* () {
    if (developerName === undefined) {
      return undefined;
    }
    const record = yield* findByName(connection, developerName);
    if (record === undefined) {
      return undefined;
    }
    return yield* attributesFrom(record);
  });

const reload = (connection: ResolvedConnection, developerName: string) =>
  Effect.gen(function* () {
    const record = yield* findByName(connection, developerName);
    if (record === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `External credential '${developerName}' was not found after write.`,
          status: 404,
          errorCode: "NOT_FOUND",
          method: "GET",
          path: externalCredentialsPath(connection.apiVersion, developerName),
        }),
      );
    }
    return yield* attributesFrom(record);
  });

/**
 * Nuke is skipped. External credentials are not tagged with an Alchemy owner.
 * `list` describes only the default org, and destroying every credential in
 * that org would remove callouts this stack does not own.
 */
export const ExternalCredentialProvider = Provider.succeed(
  ExternalCredentialResource,
  ExternalCredentialResource.Provider.of({
    stables: ["id"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (
          targetOrgChanged(input.olds.targetOrg, input.news.targetOrg) ||
          input.olds.developerName !== input.news.developerName
        ) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        return yield* load(connection, input.olds.developerName);
      }),
    observe: (input) =>
      Effect.gen(function* () {
        const developerName = input.news?.developerName;
        if (typeof developerName !== "string") {
          return undefined;
        }
        const targetOrg = typeof input.news.targetOrg === "string" ? input.news.targetOrg : undefined;
        const connection = yield* connectionFor(targetOrg);
        return yield* load(connection, developerName);
      }),
    list: () =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(undefined);
        const result = yield* request(connection, {
          method: "GET",
          path: externalCredentialsPath(connection.apiVersion),
        });
        const records = recordsFrom(result.body, "externalCredentials");
        return yield* Effect.forEach(records, attributesFrom);
      }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const credential = yield* normalizeExternalCredential(input.news);
        const path = externalCredentialsPath(connection.apiVersion, credential.developerName);
        const current = yield* findByName(connection, credential.developerName);
        if (current !== undefined && !drifted(current, credential)) {
          return yield* attributesFrom(current);
        }
        if (current === undefined) {
          const created = yield* request(connection, {
            method: "POST",
            path: externalCredentialsPath(connection.apiVersion),
            body: requestBody(credential),
          }).pipe(
            Effect.catchTag("SalesforceApiError", (error) =>
              isDuplicate(error) ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          );
          if (created !== undefined) {
            const body = asRecord(created.body);
            if (body !== undefined && stringField(body, "id") !== undefined) {
              const again = yield* findByName(connection, credential.developerName);
              if (again !== undefined && !drifted(again, credential)) {
                return yield* attributesFrom(again);
              }
            }
          }
          const raced = yield* findByName(connection, credential.developerName);
          if (raced === undefined) {
            return yield* Effect.fail(
              new SalesforceApiError({
                message: `External credential '${credential.developerName}' was not found after create.`,
                status: 0,
                errorCode: undefined,
                method: "POST",
                path: externalCredentialsPath(connection.apiVersion),
              }),
            );
          }
          if (!drifted(raced, credential)) {
            return yield* attributesFrom(raced);
          }
        }
        yield* request(connection, { method: "PUT", path, body: requestBody(credential) });
        return yield* reload(connection, credential.developerName);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const remove = (developerName: string) =>
          request(connection, {
            method: "DELETE",
            path: externalCredentialsPath(connection.apiVersion, developerName),
          }).pipe(
            Effect.as("deleted" as const),
            Effect.catchTag("SalesforceApiError", (error) =>
              isNotFound(error) ? Effect.succeed("missing" as const) : Effect.fail(error),
            ),
          );
        yield* remove(input.olds.developerName);
      }),
  }),
);

export const ExternalCredential = ExternalCredentialResource;
