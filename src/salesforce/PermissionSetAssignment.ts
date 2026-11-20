import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { queryRecords, request, sobjectPath } from "./api.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { soqlNamespace, soqlString } from "./soql.js";

export interface PermissionSetAssignmentProps {
  /** sf alias of the org that owns this assignment. Omit for the default org. */
  readonly targetOrg?: string;
  /** Permission set API name (`PermissionSet.Name`), for example `Example_Access`. */
  readonly permissionSet: string;
  /** Existing user. Matched with `User.Username`. */
  readonly username: string;
  /**
   * `PermissionSet.NamespacePrefix`. Omit for an unpackaged permission set.
   * Do not encode the namespace in `permissionSet`: unmanaged names may contain underscores.
   */
  readonly namespace?: string;
}

export interface PermissionSetAssignmentAttributes {
  readonly id: string;
  readonly assigneeId: string;
  readonly permissionSetId: string;
  readonly username: string;
  readonly permissionSet: string;
  readonly namespace: string | null;
}

export type PermissionSetAssignment = ResourceInstance<
  "Salesforce.PermissionSetAssignment",
  PermissionSetAssignmentProps,
  PermissionSetAssignmentAttributes
>;

export const PermissionSetAssignment = Resource<PermissionSetAssignment>(
  "Salesforce.PermissionSetAssignment",
);

interface NormalizedAssignment {
  readonly permissionSet: string;
  readonly username: string;
  readonly namespace: string | undefined;
}

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const nestedRecord = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
};

const nestedString = (
  record: Record<string, unknown>,
  parent: string,
  key: string,
): string | undefined => {
  const child = nestedRecord(record, parent);
  if (child === undefined) {
    return undefined;
  }
  return stringField(child, key);
};

const normalize = (
  props: PermissionSetAssignmentProps,
): Effect.Effect<NormalizedAssignment, SalesforceValidationError> => {
  const username = props.username.trim();
  const permissionSet = props.permissionSet.trim();
  if (username.length === 0 || username.length > 80) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "PermissionSetAssignment username must be 1 to 80 characters.",
      }),
    );
  }
  if (permissionSet.length === 0 || permissionSet.length > 80) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "PermissionSetAssignment permissionSet must be 1 to 80 characters.",
      }),
    );
  }
  if (
    props.namespace !== undefined &&
    props.namespace.length > 0 &&
    !/^[A-Za-z][A-Za-z0-9]*$/.test(props.namespace)
  ) {
    return Effect.fail(
      new SalesforceValidationError({
        message: `Permission set namespace '${props.namespace}' is not a Salesforce namespace prefix.`,
      }),
    );
  }
  return Effect.succeed({
    username,
    permissionSet,
    namespace: props.namespace === undefined || props.namespace.length === 0 ? undefined : props.namespace,
  });
};

const createdId = (body: unknown): string | undefined => {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
};

const attributesFrom = (
  record: Record<string, unknown>,
  fallback?: NormalizedAssignment,
): Effect.Effect<PermissionSetAssignmentAttributes, SalesforceApiError> => {
  const id = stringField(record, "Id");
  const assigneeId = stringField(record, "AssigneeId");
  const permissionSetId = stringField(record, "PermissionSetId");
  if (id === undefined || assigneeId === undefined || permissionSetId === undefined) {
    return Effect.fail(
      new SalesforceApiError({
        message: "PermissionSetAssignment record was missing Id, AssigneeId, or PermissionSetId.",
        status: 200,
        errorCode: undefined,
        method: "GET",
        path: "/sobjects/PermissionSetAssignment",
      }),
    );
  }
  const rawNamespace = nestedString(record, "PermissionSet", "NamespacePrefix") ?? fallback?.namespace ?? null;
  return Effect.succeed({
    id,
    assigneeId,
    permissionSetId,
    username: nestedString(record, "Assignee", "Username") ?? fallback?.username ?? "",
    permissionSet: nestedString(record, "PermissionSet", "Name") ?? fallback?.permissionSet ?? "",
    namespace: rawNamespace === null || rawNamespace.length === 0 ? null : rawNamespace,
  });
};

const queryOne = (connection: ResolvedConnection, soql: string) =>
  Effect.map(queryRecords(connection, soql), (records) => records[0]);

const requireUser = (connection: ResolvedConnection, username: string) =>
  Effect.gen(function* () {
    const records = yield* queryRecords(
      connection,
      `SELECT Id, Username FROM User WHERE Username = ${soqlString(username)}`,
    );
    if (records.length === 0) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `No User with Username '${username}' in this org. ` +
            "Permission set assignment only links an existing user.",
        }),
      );
    }
    if (records.length > 1) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: `More than one User matched Username '${username}'.`,
        }),
      );
    }
    const id = stringField(records[0] ?? {}, "Id");
    if (id === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `User '${username}' was returned without an Id.`,
          status: 200,
          errorCode: undefined,
          method: "GET",
          path: "/query",
        }),
      );
    }
    return { id };
  });

const requirePermissionSet = (connection: ResolvedConnection, props: NormalizedAssignment) =>
  Effect.gen(function* () {
    const records = yield* queryRecords(
      connection,
      "SELECT Id, Name, NamespacePrefix FROM PermissionSet " +
        `WHERE Name = ${soqlString(props.permissionSet)} ` +
        "AND IsOwnedByProfile = false " +
        `AND NamespacePrefix = ${soqlNamespace(props.namespace)}`,
    );
    if (records.length === 0) {
      const where =
        props.namespace === undefined
          ? `unpackaged permission set '${props.permissionSet}'`
          : `permission set '${props.permissionSet}' in namespace '${props.namespace}'`;
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `No ${where} in this org. This provider assigns an existing permission set and does not create one.`,
        }),
      );
    }
    if (records.length > 1) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: `More than one permission set matched '${props.permissionSet}'.`,
        }),
      );
    }
    const id = stringField(records[0] ?? {}, "Id");
    if (id === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `Permission set '${props.permissionSet}' was returned without an Id.`,
          status: 200,
          errorCode: undefined,
          method: "GET",
          path: "/query",
        }),
      );
    }
    const namespace = stringField(records[0] ?? {}, "NamespacePrefix") ?? null;
    return { id, namespace };
  });

const findPair = (connection: ResolvedConnection, assigneeId: string, permissionSetId: string) =>
  queryOne(
    connection,
    "SELECT Id, AssigneeId, PermissionSetId, Assignee.Username, PermissionSet.Name, PermissionSet.NamespacePrefix " +
      "FROM PermissionSetAssignment " +
      `WHERE AssigneeId = ${soqlString(assigneeId)} AND PermissionSetId = ${soqlString(permissionSetId)}`,
  );

const assignmentAttributes = (record: Record<string, unknown>, props: NormalizedAssignment) =>
  attributesFrom(record, props);

const lookupPair = (connection: ResolvedConnection, props: NormalizedAssignment) =>
  Effect.gen(function* () {
    const user = yield* requireUser(connection, props.username).pipe(
      Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
    );
    if (user === undefined) {
      return undefined;
    }
    const permissionSet = yield* requirePermissionSet(connection, props).pipe(
      Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
    );
    if (permissionSet === undefined) {
      return undefined;
    }
    const existing = yield* findPair(connection, user.id, permissionSet.id);
    if (existing === undefined) {
      return undefined;
    }
    return yield* assignmentAttributes(existing, props);
  });

/**
 * Assignments cannot be updated in place. Changing the user or the
 * permission set deletes the previous row before creating the new one.
 *
 * Nuke is skipped for the same reason as trusted sites: a permission set
 * assignment has no Alchemy ownership tag, and listing them is every
 * non-profile assignment in the org.
 */
export const PermissionSetAssignmentProvider = Provider.succeed(
  PermissionSetAssignment,
  PermissionSetAssignment.Provider.of({
    stables: ["id"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        const namespaceChanged = (input.news.namespace ?? null) !== (input.olds.namespace ?? null);
        if (
          input.news.username !== input.olds.username ||
          input.news.permissionSet !== input.olds.permissionSet ||
          namespaceChanged ||
          targetOrgChanged(input.olds.targetOrg, input.news.targetOrg)
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
            path: sobjectPath(connection.apiVersion, "PermissionSetAssignment", input.output.id),
          }).pipe(
            Effect.catchTag("SalesforceApiError", (error) =>
              isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          );
          if (
            loaded !== undefined &&
            loaded.body !== null &&
            typeof loaded.body === "object" &&
            !Array.isArray(loaded.body)
          ) {
            return yield* attributesFrom(loaded.body as Record<string, unknown>, {
              username: input.olds.username,
              permissionSet: input.olds.permissionSet,
              namespace: input.olds.namespace,
            });
          }
        }
        const props = yield* normalize(input.olds).pipe(
          Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
        );
        if (props === undefined) {
          return undefined;
        }
        return yield* lookupPair(connection, props);
      }),
    list: () =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(undefined);
        const records = yield* queryRecords(
          connection,
          "SELECT Id, AssigneeId, PermissionSetId, Assignee.Username, PermissionSet.Name, PermissionSet.NamespacePrefix " +
            "FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false",
        );
        return yield* Effect.forEach(records, (record) => attributesFrom(record));
      }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const props = yield* normalize(input.news);
        const user = yield* requireUser(connection, props.username);
        const permissionSet = yield* requirePermissionSet(connection, props);
        const existing = yield* findPair(connection, user.id, permissionSet.id);
        if (existing !== undefined) {
          return yield* assignmentAttributes(existing, props);
        }
        const created = yield* request(connection, {
          method: "POST",
          path: sobjectPath(connection.apiVersion, "PermissionSetAssignment"),
          body: { AssigneeId: user.id, PermissionSetId: permissionSet.id },
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
              path: sobjectPath(connection.apiVersion, "PermissionSetAssignment", id),
            });
            if (loaded.body !== null && typeof loaded.body === "object" && !Array.isArray(loaded.body)) {
              return yield* assignmentAttributes(loaded.body as Record<string, unknown>, props);
            }
          }
        }
        const again = yield* findPair(connection, user.id, permissionSet.id);
        if (again === undefined) {
          return yield* Effect.fail(
            new SalesforceApiError({
              message:
                `Permission set '${props.permissionSet}' was not assigned to '${props.username}' after create.`,
              status: 0,
              errorCode: undefined,
              method: "POST",
              path: "/sobjects/PermissionSetAssignment",
            }),
          );
        }
        return yield* assignmentAttributes(again, props);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const remove = (id: string) =>
          request(connection, {
            method: "DELETE",
            path: sobjectPath(connection.apiVersion, "PermissionSetAssignment", id),
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
        const user = yield* requireUser(connection, props.username).pipe(
          Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
        );
        const permissionSet = yield* requirePermissionSet(connection, props).pipe(
          Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
        );
        if (user === undefined || permissionSet === undefined) {
          return;
        }
        const existing = yield* findPair(connection, user.id, permissionSet.id);
        const fallback = existing === undefined ? undefined : stringField(existing, "Id");
        if (fallback !== undefined && fallback !== input.output.id) {
          yield* remove(fallback);
        }
      }),
  }),
);
