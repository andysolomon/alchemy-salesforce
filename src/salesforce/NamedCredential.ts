import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { request } from "./api.js";
import { asRecord, assertOrgUrl, missingField, namedCredentialSetupPath, recordsFrom, stringField } from "./connect.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { requireDeveloperName } from "./names.js";

/**
 * Modern named credential via Connect REST `named-credential-setup`.
 * `/named-credentials/named-credentials` is not a live route (404).
 * Updates are PUT. One external credential per named credential.
 */
export const NAMED_CREDENTIAL_TYPES = ["SecuredEndpoint", "PrivateEndpoint"] as const;

export type NamedCredentialType = (typeof NAMED_CREDENTIAL_TYPES)[number];

export interface NamedCredentialCalloutOptions {
  readonly allowMergeFieldsInBody?: boolean;
  readonly allowMergeFieldsInHeader?: boolean;
  readonly generateAuthorizationHeader?: boolean;
}

export interface NamedCredentialProps {
  readonly targetOrg?: string;
  readonly developerName: string;
  readonly masterLabel?: string;
  /** Defaults to `SecuredEndpoint`. */
  readonly type?: NamedCredentialType;
  /** Target org origin, for example `https://my-domain.my.salesforce.com`. */
  readonly calloutUrl: string;
  /** Developer name of the external credential this callout authenticates with. */
  readonly externalCredential: string;
  readonly description?: string;
  readonly calloutOptions?: NamedCredentialCalloutOptions;
  readonly customHeaders?: ReadonlyArray<{
    readonly headerName: string;
    readonly headerValue: string;
    readonly sequenceNumber?: number;
  }>;
}

export interface NamedCredentialAttributes {
  readonly id: string;
  readonly developerName: string;
  readonly masterLabel: string;
  readonly type: string;
  readonly calloutUrl: string;
  readonly externalCredential: string;
  readonly description: string | null;
  readonly calloutStatus: string | null;
  readonly url: string | null;
  /** `callout:<developerName>/services/data/v<apiVersion>` */
  readonly restBaseCallout: string;
  /** `callout:<developerName>/services/data/v<apiVersion>/graphql` */
  readonly graphqlCallout: string;
}

export type NamedCredential = ResourceInstance<
  "Salesforce.NamedCredential",
  NamedCredentialProps,
  NamedCredentialAttributes
>;

export const NamedCredentialResource = Resource<NamedCredential>("Salesforce.NamedCredential");

interface NormalizedHeader {
  readonly headerName: string;
  readonly headerValue: string;
  readonly sequenceNumber: number;
}

interface NormalizedNamedCredential {
  readonly developerName: string;
  readonly masterLabel: string;
  readonly type: NamedCredentialType;
  readonly calloutUrl: string;
  readonly externalCredential: string;
  readonly description: string | undefined;
  readonly allowMergeFieldsInBody: boolean;
  readonly allowMergeFieldsInHeader: boolean;
  readonly generateAuthorizationHeader: boolean;
  readonly customHeaders: ReadonlyArray<NormalizedHeader>;
}

const isType = (value: string): value is NamedCredentialType =>
  (NAMED_CREDENTIAL_TYPES as ReadonlyArray<string>).includes(value);

export const calloutUrls = (
  developerName: string,
  apiVersion: string,
): { readonly restBaseCallout: string; readonly graphqlCallout: string } => {
  const restBaseCallout = `callout:${developerName}/services/data/v${apiVersion}`;
  return { restBaseCallout, graphqlCallout: `${restBaseCallout}/graphql` };
};

export const normalizeNamedCredential = (
  props: NamedCredentialProps,
): Effect.Effect<NormalizedNamedCredential, SalesforceValidationError> =>
  Effect.gen(function* () {
    const developerName = yield* requireDeveloperName(props.developerName, "NamedCredential developerName");
    const masterLabel = (props.masterLabel ?? developerName).trim();
    if (masterLabel.length === 0 || masterLabel.length > 80) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "NamedCredential masterLabel must be 1 to 80 characters.",
        }),
      );
    }
    const type = props.type ?? "SecuredEndpoint";
    if (!isType(type)) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: `NamedCredential type '${type}' is not supported. Use SecuredEndpoint or PrivateEndpoint.`,
        }),
      );
    }
    const calloutUrl = yield* assertOrgUrl(props.calloutUrl, "NamedCredential calloutUrl");
    const externalCredential = yield* requireDeveloperName(
      props.externalCredential,
      "NamedCredential externalCredential",
    );
    if (props.description !== undefined && props.description.length > 255) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "NamedCredential description must be at most 255 characters.",
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
            message: "NamedCredential custom headers need headerName and headerValue.",
          }),
        );
      }
      const sequenceNumber = header.sequenceNumber ?? index + 1;
      if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `NamedCredential header '${headerName}' sequenceNumber must be a positive integer.`,
          }),
        );
      }
      customHeaders.push({ headerName, headerValue, sequenceNumber });
    }
    return {
      developerName,
      masterLabel,
      type,
      calloutUrl,
      externalCredential,
      description: props.description,
      allowMergeFieldsInBody: props.calloutOptions?.allowMergeFieldsInBody ?? false,
      allowMergeFieldsInHeader: props.calloutOptions?.allowMergeFieldsInHeader ?? true,
      generateAuthorizationHeader: props.calloutOptions?.generateAuthorizationHeader ?? true,
      customHeaders,
    };
  });

const externalCredentialName = (record: Record<string, unknown>): string | undefined => {
  const linked = record.externalCredentials;
  if (!Array.isArray(linked) || linked.length === 0) {
    return undefined;
  }
  const first = asRecord(linked[0]);
  return first === undefined ? undefined : stringField(first, "developerName");
};

const attributesFrom = (
  record: Record<string, unknown>,
  apiVersion: string,
): Effect.Effect<NamedCredentialAttributes, SalesforceApiError> => {
  const id = stringField(record, "id");
  const developerName = stringField(record, "developerName");
  const masterLabel = stringField(record, "masterLabel") ?? developerName;
  const calloutUrl = stringField(record, "calloutUrl");
  const externalCredential = externalCredentialName(record);
  if (
    id === undefined ||
    developerName === undefined ||
    masterLabel === undefined ||
    calloutUrl === undefined ||
    externalCredential === undefined
  ) {
    return Effect.fail(
      missingField(
        "Named credential was missing id, developerName, calloutUrl, or externalCredentials.",
        "GET",
        "/named-credentials/named-credential-setup",
      ),
    );
  }
  const description = record.description;
  const callouts = calloutUrls(developerName, apiVersion);
  return Effect.succeed({
    id,
    developerName,
    masterLabel,
    type: stringField(record, "type") ?? "SecuredEndpoint",
    calloutUrl,
    externalCredential,
    description: typeof description === "string" ? description : null,
    calloutStatus: stringField(record, "calloutStatus") ?? null,
    url: stringField(record, "url") ?? null,
    restBaseCallout: callouts.restBaseCallout,
    graphqlCallout: callouts.graphqlCallout,
  });
};

const requestBody = (credential: NormalizedNamedCredential): Record<string, unknown> => ({
  developerName: credential.developerName,
  masterLabel: credential.masterLabel,
  type: credential.type,
  calloutUrl: credential.calloutUrl,
  externalCredentials: [{ developerName: credential.externalCredential }],
  customHeaders: credential.customHeaders.map((header) => ({
    headerName: header.headerName,
    headerValue: header.headerValue,
    sequenceNumber: header.sequenceNumber,
  })),
  calloutOptions: {
    allowMergeFieldsInBody: credential.allowMergeFieldsInBody,
    allowMergeFieldsInHeader: credential.allowMergeFieldsInHeader,
    generateAuthorizationHeader: credential.generateAuthorizationHeader,
  },
  ...(credential.description === undefined ? {} : { description: credential.description }),
});

const calloutOptionsOf = (
  record: Record<string, unknown>,
): { readonly body: boolean; readonly header: boolean; readonly authorization: boolean } => {
  const options = asRecord(record.calloutOptions);
  return {
    body: options?.allowMergeFieldsInBody === true,
    header: options?.allowMergeFieldsInHeader === true,
    authorization: options?.generateAuthorizationHeader === true,
  };
};

const drifted = (record: Record<string, unknown>, credential: NormalizedNamedCredential): boolean => {
  const options = calloutOptionsOf(record);
  const description = typeof record.description === "string" ? record.description : null;
  const desiredDescription = credential.description === undefined ? undefined : credential.description;
  const headers = Array.isArray(record.customHeaders) ? record.customHeaders : [];
  const liveHeaders = headers.flatMap((entry) => {
    const header = asRecord(entry);
    if (header === undefined) {
      return [];
    }
    const sequence = typeof header.sequenceNumber === "number" ? header.sequenceNumber : 0;
    return [`${stringField(header, "headerName") ?? ""}\0${stringField(header, "headerValue") ?? ""}\0${sequence}`];
  });
  const desiredHeaders = credential.customHeaders.map(
    (header) => `${header.headerName}\0${header.headerValue}\0${header.sequenceNumber}`,
  );
  return (
    (stringField(record, "masterLabel") ?? "") !== credential.masterLabel ||
    (stringField(record, "type") ?? "SecuredEndpoint") !== credential.type ||
    stringField(record, "calloutUrl") !== credential.calloutUrl ||
    externalCredentialName(record) !== credential.externalCredential ||
    options.body !== credential.allowMergeFieldsInBody ||
    options.header !== credential.allowMergeFieldsInHeader ||
    options.authorization !== credential.generateAuthorizationHeader ||
    (desiredDescription !== undefined && description !== desiredDescription) ||
    [...liveHeaders].sort().join("|") !== [...desiredHeaders].sort().join("|")
  );
};

const isDuplicate = (error: SalesforceApiError): boolean =>
  error.errorCode === "DUPLICATE_DEVELOPER_NAME" || error.errorCode === "DUPLICATE_VALUE";

const findByName = (connection: ResolvedConnection, developerName: string) =>
  Effect.gen(function* () {
    const result = yield* request(connection, {
      method: "GET",
      path: namedCredentialSetupPath(connection.apiVersion, developerName),
    }).pipe(
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
    return yield* attributesFrom(record, connection.apiVersion);
  });

const reload = (connection: ResolvedConnection, developerName: string) =>
  Effect.gen(function* () {
    const record = yield* findByName(connection, developerName);
    if (record === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `Named credential '${developerName}' was not found after write.`,
          status: 404,
          errorCode: "NOT_FOUND",
          method: "GET",
          path: namedCredentialSetupPath(connection.apiVersion, developerName),
        }),
      );
    }
    return yield* attributesFrom(record, connection.apiVersion);
  });

/**
 * Nuke is skipped. `named-credential-setup` only lists modern named
 * credentials, but those still are not Alchemy-owned, and legacy rows such
 * as `Core_Banking` must never be deleted from here.
 */
export const NamedCredentialProvider = Provider.succeed(
  NamedCredentialResource,
  NamedCredentialResource.Provider.of({
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
          path: namedCredentialSetupPath(connection.apiVersion),
        });
        const records = recordsFrom(result.body, "namedCredentials");
        return yield* Effect.forEach(records, (record) => attributesFrom(record, connection.apiVersion));
      }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const credential = yield* normalizeNamedCredential(input.news);
        const current = yield* findByName(connection, credential.developerName);
        if (current !== undefined && !drifted(current, credential)) {
          return yield* attributesFrom(current, connection.apiVersion);
        }
        if (current === undefined) {
          const created = yield* request(connection, {
            method: "POST",
            path: namedCredentialSetupPath(connection.apiVersion),
            body: requestBody(credential),
          }).pipe(
            Effect.catchTag("SalesforceApiError", (error) =>
              isDuplicate(error) ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          );
          if (created !== undefined) {
            const raced = yield* findByName(connection, credential.developerName);
            if (raced !== undefined && !drifted(raced, credential)) {
              return yield* attributesFrom(raced, connection.apiVersion);
            }
          } else {
            const raced = yield* findByName(connection, credential.developerName);
            if (raced === undefined) {
              return yield* Effect.fail(
                new SalesforceApiError({
                  message: `Named credential '${credential.developerName}' was not found after create.`,
                  status: 0,
                  errorCode: undefined,
                  method: "POST",
                  path: namedCredentialSetupPath(connection.apiVersion),
                }),
              );
            }
            if (!drifted(raced, credential)) {
              return yield* attributesFrom(raced, connection.apiVersion);
            }
          }
        }
        yield* request(connection, {
          method: "PUT",
          path: namedCredentialSetupPath(connection.apiVersion, credential.developerName),
          body: requestBody(credential),
        });
        return yield* reload(connection, credential.developerName);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        yield* request(connection, {
          method: "DELETE",
          path: namedCredentialSetupPath(connection.apiVersion, input.olds.developerName),
        }).pipe(
          Effect.catchTag("SalesforceApiError", (error) =>
            isNotFound(error) ? Effect.void : Effect.fail(error),
          ),
        );
      }),
  }),
);

export const NamedCredential = NamedCredentialResource;
