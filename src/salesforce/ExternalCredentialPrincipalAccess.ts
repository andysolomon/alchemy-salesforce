import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { queryRecords, request, sobjectPath } from "./api.js";
import { asRecord, externalCredentialsPath, stringField } from "./connect.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { requireDeveloperName } from "./names.js";
import { soqlNamespace, soqlString } from "./soql.js";

/**
 * Grants a permission set access to an external credential principal.
 *
 * `SetupEntityAccess` is createable, queryable, and deletable, not updateable.
 * `ParentId` is the permission set. `SetupEntityId` is the principal id
 * (`0pu...`) from the external credential. A change of permission set or
 * principal deletes the row and creates a new one.
 */
export interface ExternalCredentialPrincipalAccessProps {
  readonly targetOrg?: string;
  /** Permission set API name. Required when `permissionSetId` is omitted. */
  readonly permissionSetName?: string;
  /** Existing permission set id. Skips the name lookup when set. */
  readonly permissionSetId?: string;
  /** `PermissionSet.NamespacePrefix`. Omit for an unpackaged permission set. */
  readonly namespace?: string;
  readonly externalCredential: string;
  readonly principalName: string;
  /**
   * Principal id (`0pu...`). When omitted, the provider reads the external
   * credential and uses the principal with `principalName`.
   */
  readonly principalId?: string;
}

export interface ExternalCredentialPrincipalAccessAttributes {
  readonly id: string;
  readonly permissionSetId: string;
  readonly setupEntityId: string;
  readonly permissionSetName: string | null;
  readonly namespace: string | null;
  readonly externalCredential: string;
  readonly principalName: string;
}

export type ExternalCredentialPrincipalAccess = ResourceInstance<
  "Salesforce.ExternalCredentialPrincipalAccess",
  ExternalCredentialPrincipalAccessProps,
  ExternalCredentialPrincipalAccessAttributes
>;

export const ExternalCredentialPrincipalAccessResource = Resource<ExternalCredentialPrincipalAccess>(
  "Salesforce.ExternalCredentialPrincipalAccess",
);

interface NormalizedAccess {
  readonly permissionSetName: string | undefined;
  readonly permissionSetId: string | undefined;
  readonly namespace: string | undefined;
  readonly externalCredential: string;
  readonly principalName: string;
  readonly principalId: string | undefined;
}

const normalize = (
  props: ExternalCredentialPrincipalAccessProps,
): Effect.Effect<NormalizedAccess, SalesforceValidationError> =>
  Effect.gen(function* () {
    const permissionSetName = props.permissionSetName?.trim();
    const permissionSetId = props.permissionSetId?.trim();
    if (
      (permissionSetName === undefined || permissionSetName.length === 0) &&
      (permissionSetId === undefined || permissionSetId.length === 0)
    ) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalCredentialPrincipalAccess requires permissionSetName or permissionSetId.",
        }),
      );
    }
    if (permissionSetName !== undefined && permissionSetName.length > 80) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalCredentialPrincipalAccess permissionSetName must be at most 80 characters.",
        }),
      );
    }
    if (
      props.namespace !== undefined &&
      props.namespace.length > 0 &&
      !/^[A-Za-z][A-Za-z0-9]*$/.test(props.namespace)
    ) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: `Permission set namespace '${props.namespace}' is not a Salesforce namespace prefix.`,
        }),
      );
    }
    return {
      permissionSetName: permissionSetName === undefined || permissionSetName.length === 0 ? undefined : permissionSetName,
      permissionSetId: permissionSetId === undefined || permissionSetId.length === 0 ? undefined : permissionSetId,
      namespace: props.namespace === undefined || props.namespace.length === 0 ? undefined : props.namespace,
      externalCredential: yield* requireDeveloperName(
        props.externalCredential,
        "ExternalCredentialPrincipalAccess externalCredential",
      ),
      principalName: yield* requireDeveloperName(
        props.principalName,
        "ExternalCredentialPrincipalAccess principalName",
      ),
      principalId: props.principalId?.trim() || undefined,
    };
  });

const createdId = (body: unknown): string | undefined => {
  const record = asRecord(body);
  const id = record === undefined ? undefined : record.id;
  return typeof id === "string" ? id : undefined;
};

const requirePermissionSet = (connection: ResolvedConnection, props: NormalizedAccess) =>
  Effect.gen(function* () {
    if (props.permissionSetId !== undefined) {
      return { id: props.permissionSetId, name: props.permissionSetName ?? null, namespace: props.namespace ?? null };
    }
    const records = yield* queryRecords(
      connection,
      "SELECT Id, Name, NamespacePrefix FROM PermissionSet " +
        `WHERE Name = ${soqlString(props.permissionSetName ?? "")} ` +
        "AND IsOwnedByProfile = false " +
        `AND NamespacePrefix = ${soqlNamespace(props.namespace)}`,
    );
    if (records.length === 0) {
      const where =
        props.namespace === undefined
          ? `unpackaged permission set '${props.permissionSetName}'`
          : `permission set '${props.permissionSetName}' in namespace '${props.namespace}'`;
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: `No ${where} in this org. Principal access links an existing permission set and does not create one.`,
        }),
      );
    }
    if (records.length > 1) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: `More than one permission set matched '${props.permissionSetName}'.`,
        }),
      );
    }
    const id = stringField(records[0] ?? {}, "Id");
    if (id === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `Permission set '${props.permissionSetName}' was returned without an Id.`,
          status: 200,
          errorCode: undefined,
          method: "GET",
          path: "/query",
        }),
      );
    }
    const rawNamespace = stringField(records[0] ?? {}, "NamespacePrefix");
    const namespace = rawNamespace === undefined || rawNamespace.length === 0 ? null : rawNamespace;
    return { id, name: props.permissionSetName ?? null, namespace };
  });

const requirePrincipalId = (connection: ResolvedConnection, props: NormalizedAccess) =>
  Effect.gen(function* () {
    if (props.principalId !== undefined) {
      return props.principalId;
    }
    const result = yield* request(connection, {
      method: "GET",
      path: externalCredentialsPath(connection.apiVersion, props.externalCredential),
    });
    const record = asRecord(result.body);
    const principals = record?.principals;
    if (!Array.isArray(principals)) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `External credential '${props.externalCredential}' did not include principals.`,
          status: 200,
          errorCode: undefined,
          method: "GET",
          path: externalCredentialsPath(connection.apiVersion, props.externalCredential),
        }),
      );
    }
    const matches = principals.flatMap((entry) => {
      const principal = asRecord(entry);
      if (principal === undefined || stringField(principal, "principalName") !== props.principalName) {
        return [];
      }
      const id = stringField(principal, "id");
      return id === undefined ? [] : [id];
    });
    if (matches.length !== 1) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `External credential '${props.externalCredential}' must have exactly one principal ` +
            `named '${props.principalName}' so SetupEntityAccess can target its id.`,
        }),
      );
    }
    return matches[0] ?? "";
  });

const findPair = (connection: ResolvedConnection, permissionSetId: string, setupEntityId: string) =>
  Effect.gen(function* () {
    const records = yield* queryRecords(
      connection,
      "SELECT Id, ParentId, SetupEntityId FROM SetupEntityAccess " +
        `WHERE ParentId = ${soqlString(permissionSetId)} AND SetupEntityId = ${soqlString(setupEntityId)}`,
    );
    return records[0];
  });

const attributesFrom = (
  record: Record<string, unknown>,
  props: NormalizedAccess,
  permissionSet: { readonly id: string; readonly name: string | null; readonly namespace: string | null },
  setupEntityId: string,
): Effect.Effect<ExternalCredentialPrincipalAccessAttributes, SalesforceApiError> => {
  const id = stringField(record, "Id");
  if (id === undefined) {
    return Effect.fail(
      new SalesforceApiError({
        message: "SetupEntityAccess record was missing Id.",
        status: 200,
        errorCode: undefined,
        method: "GET",
        path: "/sobjects/SetupEntityAccess",
      }),
    );
  }
  return Effect.succeed({
    id,
    permissionSetId: stringField(record, "ParentId") ?? permissionSet.id,
    setupEntityId: stringField(record, "SetupEntityId") ?? setupEntityId,
    permissionSetName: permissionSet.name,
    namespace: permissionSet.namespace,
    externalCredential: props.externalCredential,
    principalName: props.principalName,
  });
};

const lookup = (connection: ResolvedConnection, props: NormalizedAccess) =>
  Effect.gen(function* () {
    const permissionSet = yield* requirePermissionSet(connection, props).pipe(
      Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
    );
    if (permissionSet === undefined) {
      return undefined;
    }
    const principalId = yield* requirePrincipalId(connection, props).pipe(
      Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
      Effect.catchTag("SalesforceApiError", (error) =>
        isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (principalId === undefined || principalId.length === 0) {
      return undefined;
    }
    const existing = yield* findPair(connection, permissionSet.id, principalId);
    if (existing === undefined) {
      return undefined;
    }
    return yield* attributesFrom(existing, props, permissionSet, principalId);
  });

const sameIdentity = (
  left: ExternalCredentialPrincipalAccessProps,
  right: ExternalCredentialPrincipalAccessProps,
): boolean =>
  (left.permissionSetName ?? "") === (right.permissionSetName ?? "") &&
  (left.permissionSetId ?? "") === (right.permissionSetId ?? "") &&
  (left.namespace ?? "") === (right.namespace ?? "") &&
  left.externalCredential === right.externalCredential &&
  left.principalName === right.principalName &&
  (left.principalId ?? "") === (right.principalId ?? "");

/**
 * Nuke is skipped and `list` is empty. `SetupEntityAccess` rows also grant
 * object, Apex, and tab access. Listing them would let nuke delete grants
 * this stack does not own.
 */
export const ExternalCredentialPrincipalAccessProvider = Provider.succeed(
  ExternalCredentialPrincipalAccessResource,
  ExternalCredentialPrincipalAccessResource.Provider.of({
    stables: ["id"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (
          targetOrgChanged(input.olds.targetOrg, input.news.targetOrg) ||
          !sameIdentity(input.olds, input.news)
        ) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        if (input.output?.id !== undefined) {
          const loaded = yield* request(connection, {
            method: "GET",
            path: sobjectPath(connection.apiVersion, "SetupEntityAccess", input.output.id),
          }).pipe(
            Effect.catchTag("SalesforceApiError", (error) =>
              isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          );
          const body = loaded === undefined ? undefined : asRecord(loaded.body);
          if (body !== undefined) {
            const props = yield* normalize(input.olds).pipe(
              Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
            );
            if (props !== undefined) {
              return {
                id: stringField(body, "Id") ?? input.output.id,
                permissionSetId: stringField(body, "ParentId") ?? input.output.permissionSetId,
                setupEntityId: stringField(body, "SetupEntityId") ?? input.output.setupEntityId,
                permissionSetName: props.permissionSetName ?? input.output.permissionSetName,
                namespace: props.namespace ?? input.output.namespace,
                externalCredential: props.externalCredential,
                principalName: props.principalName,
              };
            }
          }
        }
        const props = yield* normalize(input.olds).pipe(
          Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
        );
        if (props === undefined) {
          return undefined;
        }
        return yield* lookup(connection, props);
      }),
    list: () => Effect.succeed([]),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const props = yield* normalize(input.news);
        const permissionSet = yield* requirePermissionSet(connection, props);
        const principalId = yield* requirePrincipalId(connection, props);
        const existing = yield* findPair(connection, permissionSet.id, principalId);
        if (existing !== undefined) {
          return yield* attributesFrom(existing, props, permissionSet, principalId);
        }
        const created = yield* request(connection, {
          method: "POST",
          path: sobjectPath(connection.apiVersion, "SetupEntityAccess"),
          body: { ParentId: permissionSet.id, SetupEntityId: principalId },
        }).pipe(
          Effect.catchTag("SalesforceApiError", (error) =>
            error.errorCode === "DUPLICATE_VALUE" ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        );
        if (created !== undefined) {
          const id = createdId(created.body);
          if (id !== undefined) {
            const loaded = yield* request(connection, {
              method: "GET",
              path: sobjectPath(connection.apiVersion, "SetupEntityAccess", id),
            });
            const body = asRecord(loaded.body);
            if (body !== undefined) {
              return yield* attributesFrom(body, props, permissionSet, principalId);
            }
          }
        }
        const again = yield* findPair(connection, permissionSet.id, principalId);
        if (again === undefined) {
          return yield* Effect.fail(
            new SalesforceApiError({
              message:
                `SetupEntityAccess for '${props.principalName}' on permission set ` +
                `'${props.permissionSetName ?? props.permissionSetId}' was not found after create.`,
              status: 0,
              errorCode: undefined,
              method: "POST",
              path: "/sobjects/SetupEntityAccess",
            }),
          );
        }
        return yield* attributesFrom(again, props, permissionSet, principalId);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const remove = (id: string) =>
          request(connection, {
            method: "DELETE",
            path: sobjectPath(connection.apiVersion, "SetupEntityAccess", id),
          }).pipe(
            Effect.catchTag("SalesforceApiError", (error) =>
              isNotFound(error) ? Effect.succeed("missing" as const) : Effect.fail(error),
            ),
            Effect.map((result) => (result === "missing" ? "missing" : "deleted") as "missing" | "deleted"),
          );
        const first = yield* remove(input.output.id);
        if (first === "deleted") {
          return;
        }
        const props = yield* normalize(input.olds).pipe(
          Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
        );
        if (props === undefined) {
          return;
        }
        const found = yield* lookup(connection, props);
        if (found !== undefined && found.id !== input.output.id) {
          yield* remove(found.id);
        }
      }),
  }),
);

export const ExternalCredentialPrincipalAccess = ExternalCredentialPrincipalAccessResource;
