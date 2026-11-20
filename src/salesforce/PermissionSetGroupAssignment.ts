import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { queryRecords, request, sobjectPath } from "./api.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { requireUser } from "./PermissionSetAssignment.js";
import { soqlNamespace, soqlString } from "./soql.js";

export interface PermissionSetGroupAssignmentProps {
  /** sf alias of the org that owns this assignment. Omit for the default org. */
  readonly targetOrg?: string;
  /** `PermissionSetGroup.DeveloperName`, for example `Sales_Ops`. */
  readonly permissionSetGroup: string;
  /** Existing user. Matched with `User.Username`. */
  readonly username: string;
  /** `PermissionSetGroup.NamespacePrefix`. Omit for an unpackaged group. */
  readonly namespace?: string;
}

export interface PermissionSetGroupAssignmentAttributes {
  /** The `PermissionSetAssignment` row id. */
  readonly id: string;
  readonly assigneeId: string;
  readonly permissionSetGroupId: string;
  readonly username: string;
  readonly permissionSetGroup: string;
  readonly namespace: string | null;
}

export type PermissionSetGroupAssignment = ResourceInstance<
  "Salesforce.PermissionSetGroupAssignment",
  PermissionSetGroupAssignmentProps,
  PermissionSetGroupAssignmentAttributes
>;

export const PermissionSetGroupAssignment = Resource<PermissionSetGroupAssignment>(
  "Salesforce.PermissionSetGroupAssignment",
);

interface NormalizedGroupAssignment {
  readonly permissionSetGroup: string;
  readonly username: string;
  readonly namespace: string | undefined;
}

const ROW_FIELDS =
  "Id, AssigneeId, PermissionSetGroupId, Assignee.Username, " +
  "PermissionSetGroup.DeveloperName, PermissionSetGroup.NamespacePrefix";

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const nestedString = (record: Record<string, unknown>, parent: string, key: string): string | undefined => {
  const child = record[parent];
  if (child === null || typeof child !== "object" || Array.isArray(child)) {
    return undefined;
  }
  return stringField(child as Record<string, unknown>, key);
};

const normalize = (
  props: PermissionSetGroupAssignmentProps,
): Effect.Effect<NormalizedGroupAssignment, SalesforceValidationError> => {
  const username = props.username.trim();
  const permissionSetGroup = props.permissionSetGroup.trim();
  if (username.length === 0 || username.length > 80) {
    return Effect.fail(
      new SalesforceValidationError({ message: "PermissionSetGroupAssignment username must be 1 to 80 characters." }),
    );
  }
  if (permissionSetGroup.length === 0 || permissionSetGroup.length > 80) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "PermissionSetGroupAssignment permissionSetGroup must be 1 to 80 characters.",
      }),
    );
  }
  const namespace = props.namespace === undefined || props.namespace.length === 0 ? undefined : props.namespace;
  if (namespace !== undefined && !/^[A-Za-z][A-Za-z0-9]*$/.test(namespace)) {
    return Effect.fail(
      new SalesforceValidationError({
        message: `Permission set group namespace '${namespace}' is not a Salesforce namespace prefix.`,
      }),
    );
  }
  return Effect.succeed({ username, permissionSetGroup, namespace });
};

const attributesFrom = (
  record: Record<string, unknown>,
  fallback: NormalizedGroupAssignment,
): Effect.Effect<PermissionSetGroupAssignmentAttributes, SalesforceApiError> => {
  const id = stringField(record, "Id");
  const assigneeId = stringField(record, "AssigneeId");
  const permissionSetGroupId = stringField(record, "PermissionSetGroupId");
  if (id === undefined || assigneeId === undefined || permissionSetGroupId === undefined) {
    return Effect.fail(
      new SalesforceApiError({
        message: "PermissionSetAssignment record was missing Id, AssigneeId, or PermissionSetGroupId.",
        status: 200,
        errorCode: undefined,
        method: "GET",
        path: "/sobjects/PermissionSetAssignment",
      }),
    );
  }
  const namespace = nestedString(record, "PermissionSetGroup", "NamespacePrefix") ?? fallback.namespace ?? null;
  return Effect.succeed({
    id,
    assigneeId,
    permissionSetGroupId,
    username: nestedString(record, "Assignee", "Username") ?? fallback.username,
    permissionSetGroup: nestedString(record, "PermissionSetGroup", "DeveloperName") ?? fallback.permissionSetGroup,
    namespace: namespace === null || namespace.length === 0 ? null : namespace,
  });
};

/**
 * Look up the group. A group whose `Status` is `Failed` cannot be assigned,
 * so that is reported before any write.
 */
const requireGroup = (connection: ResolvedConnection, props: NormalizedGroupAssignment) =>
  Effect.gen(function* () {
    const records = yield* queryRecords(
      connection,
      "SELECT Id, DeveloperName, NamespacePrefix, Status FROM PermissionSetGroup " +
        `WHERE DeveloperName = ${soqlString(props.permissionSetGroup)} ` +
        `AND NamespacePrefix = ${soqlNamespace(props.namespace)}`,
    );
    const where =
      props.namespace === undefined
        ? `unpackaged permission set group '${props.permissionSetGroup}'`
        : `permission set group '${props.permissionSetGroup}' in namespace '${props.namespace}'`;
    if (records.length !== 1) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            records.length === 0
              ? `No ${where} in this org. This provider assigns an existing group and does not create one.`
              : `More than one ${where} matched.`,
        }),
      );
    }
    const record = records[0] ?? {};
    const id = stringField(record, "Id");
    if (id === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `Permission set group '${props.permissionSetGroup}' was returned without an Id.`,
          status: 200,
          errorCode: undefined,
          method: "GET",
          path: "/query",
        }),
      );
    }
    if (stringField(record, "Status") === "Failed") {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `The ${where} has Status 'Failed'. Fix the group in Setup ` +
            "(Permission Set Groups > Recalculate) before assigning it.",
        }),
      );
    }
    return { id };
  });

const findPair = (connection: ResolvedConnection, assigneeId: string, groupId: string) =>
  Effect.map(
    queryRecords(
      connection,
      `SELECT ${ROW_FIELDS} FROM PermissionSetAssignment ` +
        `WHERE AssigneeId = ${soqlString(assigneeId)} AND PermissionSetGroupId = ${soqlString(groupId)}`,
    ),
    (records) => records[0],
  );

const tolerateMissing = <A, R>(effect: Effect.Effect<A, SalesforceValidationError | SalesforceApiError, R>) =>
  effect.pipe(Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)));

const lookupPair = (connection: ResolvedConnection, props: NormalizedGroupAssignment) =>
  Effect.gen(function* () {
    const user = yield* tolerateMissing(requireUser(connection, props.username));
    const group = yield* tolerateMissing(requireGroup(connection, props));
    if (user === undefined || group === undefined) {
      return undefined;
    }
    return yield* findPair(connection, user.id, group.id);
  });

const fetchRow = (connection: ResolvedConnection, id: string) =>
  Effect.gen(function* () {
    const loaded = yield* request(connection, {
      method: "GET",
      path: sobjectPath(connection.apiVersion, "PermissionSetAssignment", id),
    }).pipe(
      Effect.catchTag("SalesforceApiError", (error) =>
        isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (loaded === undefined || loaded.body === null || typeof loaded.body !== "object" || Array.isArray(loaded.body)) {
      return undefined;
    }
    const record = loaded.body as Record<string, unknown>;
    return typeof record.PermissionSetGroupId === "string" ? record : undefined;
  });

/**
 * Assigns an existing permission set group to an existing user. This is a
 * `PermissionSetAssignment` row with `PermissionSetGroupId` set. Rows cannot
 * be updated, so a new user or group is a replace.
 *
 * `list` is empty and nuke is skipped: the rows carry no Alchemy ownership tag.
 */
export const PermissionSetGroupAssignmentProvider = Provider.succeed(
  PermissionSetGroupAssignment,
  PermissionSetGroupAssignment.Provider.of({
    stables: ["id"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (
          input.news.username.trim() !== input.olds.username.trim() ||
          input.news.permissionSetGroup.trim() !== input.olds.permissionSetGroup.trim() ||
          (input.news.namespace || null) !== (input.olds.namespace || null) ||
          targetOrgChanged(input.olds.targetOrg, input.news.targetOrg)
        ) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const props = yield* tolerateMissing(normalize(input.olds));
        if (props === undefined) {
          return undefined;
        }
        const byId = input.output?.id === undefined ? undefined : yield* fetchRow(connection, input.output.id);
        const record = byId ?? (yield* lookupPair(connection, props));
        return record === undefined ? undefined : yield* attributesFrom(record, props);
      }),
    list: () => Effect.succeed([]),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const props = yield* normalize(input.news);
        const user = yield* requireUser(connection, props.username);
        const group = yield* requireGroup(connection, props);
        const existing = yield* findPair(connection, user.id, group.id);
        if (existing !== undefined) {
          return yield* attributesFrom(existing, props);
        }
        yield* request(connection, {
          method: "POST",
          path: sobjectPath(connection.apiVersion, "PermissionSetAssignment"),
          body: { AssigneeId: user.id, PermissionSetGroupId: group.id },
        }).pipe(
          Effect.catchTag("SalesforceApiError", (error) =>
            error.errorCode === "DUPLICATE_VALUE" ? Effect.void : Effect.fail(error),
          ),
        );
        const created = yield* findPair(connection, user.id, group.id);
        if (created === undefined) {
          return yield* Effect.fail(
            new SalesforceApiError({
              message:
                `Permission set group '${props.permissionSetGroup}' was not assigned to '${props.username}' after create.`,
              status: 0,
              errorCode: undefined,
              method: "POST",
              path: "/sobjects/PermissionSetAssignment",
            }),
          );
        }
        return yield* attributesFrom(created, props);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const remove = (id: string) =>
          request(connection, {
            method: "DELETE",
            path: sobjectPath(connection.apiVersion, "PermissionSetAssignment", id),
          }).pipe(
            Effect.as("deleted" as const),
            Effect.catchTag("SalesforceApiError", (error) =>
              isNotFound(error) ? Effect.succeed("missing" as const) : Effect.fail(error),
            ),
          );
        if ((yield* remove(input.output.id)) === "deleted") {
          return;
        }
        const props = yield* tolerateMissing(normalize(input.olds));
        if (props === undefined) {
          return;
        }
        const existing = yield* lookupPair(connection, props);
        const fallback = existing === undefined ? undefined : stringField(existing, "Id");
        if (fallback !== undefined && fallback !== input.output.id) {
          yield* remove(fallback);
        }
      }),
  }),
);
