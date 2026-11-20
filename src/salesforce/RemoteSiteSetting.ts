import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { queryRecords, request, sobjectPath } from "./api.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { soqlString } from "./soql.js";

/**
 * Tooling API `RemoteProxy` (Remote Site Setting), API 68.0.
 *
 * Create and update accept only `FullName` and `Metadata`. Top-level
 * `SiteName`, `EndpointUrl`, `IsActive`, and `ProtocolMismatch` are rejected
 * with FIELD_INTEGRITY_EXCEPTION. `ProtocolMismatch` is the query name for
 * Metadata `disableProtocolSecurity`.
 *
 * Published REST methods are GET, HEAD, PATCH, POST, and Query. SOAP has no
 * `delete()`. Destroy tries DELETE, and if Salesforce refuses the method it
 * deactivates the row instead of failing the stack.
 */
export interface RemoteSiteSettingProps {
  readonly targetOrg?: string;
  /** `SiteName` / `FullName`. */
  readonly siteName: string;
  /** Metadata `url`. */
  readonly endpointUrl: string;
  readonly isActive: boolean;
  /** Metadata `disableProtocolSecurity`. Defaults to false. */
  readonly disableProtocolSecurity?: boolean;
  readonly description?: string;
}

export interface RemoteSiteSettingAttributes {
  readonly id: string;
  readonly siteName: string;
  readonly endpointUrl: string;
  readonly isActive: boolean;
  readonly disableProtocolSecurity: boolean;
  readonly description: string | null;
}

export type RemoteSiteSetting = ResourceInstance<
  "Salesforce.RemoteSiteSetting",
  RemoteSiteSettingProps,
  RemoteSiteSettingAttributes
>;

export const RemoteSiteSetting = Resource<RemoteSiteSetting>("Salesforce.RemoteSiteSetting");

const QUERY_FIELDS = "Id, SiteName, EndpointUrl, IsActive, ProtocolMismatch, Description";

interface NormalizedRemoteSite {
  readonly siteName: string;
  readonly endpointUrl: string;
  readonly isActive: boolean;
  readonly disableProtocolSecurity: boolean;
  readonly description: string | undefined;
}

const isSiteName = (name: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !name.includes("__") && !name.endsWith("_") && name.length <= 40;

const normalize = (
  props: RemoteSiteSettingProps,
): Effect.Effect<NormalizedRemoteSite, SalesforceValidationError> => {
  const siteName = props.siteName.trim();
  if (!isSiteName(siteName)) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `Remote site name '${props.siteName}' must be a Salesforce developer name ` +
          "(letter, then letters, numbers, or single underscores, at most 40 characters).",
      }),
    );
  }
  const endpointUrl = props.endpointUrl.trim();
  if (endpointUrl.length === 0 || endpointUrl.length > 255) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "Remote site endpointUrl must be 1 to 255 characters.",
      }),
    );
  }
  if (props.description !== undefined && props.description.length > 255) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "Remote site description must be at most 255 characters.",
      }),
    );
  }
  return Effect.succeed({
    siteName,
    endpointUrl,
    isActive: props.isActive,
    disableProtocolSecurity: props.disableProtocolSecurity ?? false,
    description: props.description,
  });
};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const metadata = (site: NormalizedRemoteSite): Record<string, unknown> => ({
  disableProtocolSecurity: site.disableProtocolSecurity,
  isActive: site.isActive,
  url: site.endpointUrl,
  description: site.description ?? null,
});

const attributesFrom = (
  record: Record<string, unknown>,
): Effect.Effect<RemoteSiteSettingAttributes, SalesforceApiError> => {
  const id = stringField(record, "Id");
  const siteName = stringField(record, "SiteName");
  const endpointUrl = stringField(record, "EndpointUrl");
  if (id === undefined || siteName === undefined || endpointUrl === undefined) {
    return Effect.fail(
      new SalesforceApiError({
        message: "RemoteProxy record was missing Id, SiteName, or EndpointUrl.",
        status: 200,
        errorCode: undefined,
        method: "GET",
        path: "/tooling/sobjects/RemoteProxy",
      }),
    );
  }
  const description = record.Description;
  return Effect.succeed({
    id,
    siteName,
    endpointUrl,
    isActive: record.IsActive === true,
    disableProtocolSecurity: record.ProtocolMismatch === true,
    description: typeof description === "string" ? description : null,
  });
};

const drifted = (record: Record<string, unknown>, site: NormalizedRemoteSite): boolean => {
  const description = typeof record.Description === "string" ? record.Description : null;
  const desiredDescription = site.description === undefined ? null : site.description;
  return (
    stringField(record, "EndpointUrl") !== site.endpointUrl ||
    (record.IsActive === true) !== site.isActive ||
    (record.ProtocolMismatch === true) !== site.disableProtocolSecurity ||
    description !== desiredDescription
  );
};

const createdId = (body: unknown): string | undefined => {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
};

const findByName = (connection: ResolvedConnection, siteName: string) =>
  Effect.gen(function* () {
    const records = yield* queryRecords(
      connection,
      `SELECT ${QUERY_FIELDS} FROM RemoteProxy WHERE SiteName = ${soqlString(siteName)}`,
      "tooling",
    );
    return records[0];
  });

const findById = (connection: ResolvedConnection, id: string) =>
  Effect.gen(function* () {
    const result = yield* request(connection, {
      method: "GET",
      path: sobjectPath(connection.apiVersion, "RemoteProxy", id, "tooling"),
    }).pipe(
      Effect.catchTag("SalesforceApiError", (error) =>
        isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (result === undefined || result.body === null || typeof result.body !== "object" || Array.isArray(result.body)) {
      return undefined;
    }
    return result.body as Record<string, unknown>;
  });

const isDuplicate = (error: SalesforceApiError): boolean =>
  error.errorCode === "DUPLICATE_VALUE" || error.errorCode === "DUPLICATE_DEVELOPER_NAME";

const deleteRefused = (error: SalesforceApiError): boolean =>
  error.status === 405 || error.errorCode === "METHOD_NOT_ALLOWED" || error.errorCode === "NOT_IMPLEMENTED";

const ensureSite = (
  connection: ResolvedConnection,
  site: NormalizedRemoteSite,
  current: Record<string, unknown> | undefined,
) =>
  Effect.gen(function* () {
    if (current !== undefined) {
      return current;
    }
    const created = yield* request(connection, {
      method: "POST",
      path: sobjectPath(connection.apiVersion, "RemoteProxy", undefined, "tooling"),
      body: { FullName: site.siteName, Metadata: metadata(site) },
    }).pipe(
      Effect.catchTag("SalesforceApiError", (error) =>
        isDuplicate(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (created !== undefined) {
      const id = createdId(created.body);
      if (id !== undefined) {
        const loaded = yield* findById(connection, id);
        if (loaded !== undefined) {
          return loaded;
        }
      }
    }
    const existing = yield* findByName(connection, site.siteName);
    if (existing === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `Remote site '${site.siteName}' was not found after create.`,
          status: 0,
          errorCode: undefined,
          method: "POST",
          path: "/tooling/sobjects/RemoteProxy",
        }),
      );
    }
    return existing;
  });

const loadSite = (
  connection: ResolvedConnection,
  input: { readonly id: string | undefined; readonly siteName: string | undefined },
) =>
  Effect.gen(function* () {
    const byId = input.id === undefined ? undefined : yield* findById(connection, input.id);
    const record = byId ?? (input.siteName === undefined ? undefined : yield* findByName(connection, input.siteName));
    if (record === undefined) {
      return undefined;
    }
    return yield* attributesFrom(record);
  });

export const RemoteSiteSettingProvider = Provider.succeed(
  RemoteSiteSetting,
  RemoteSiteSetting.Provider.of({
    stables: ["id"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (
          targetOrgChanged(input.olds.targetOrg, input.news.targetOrg) ||
          input.olds.siteName !== input.news.siteName
        ) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        return yield* loadSite(connection, { id: input.output?.id, siteName: input.olds.siteName });
      }),
    observe: (input) =>
      Effect.gen(function* () {
        const siteName = input.news?.siteName;
        if (typeof siteName !== "string") {
          return undefined;
        }
        const targetOrg = typeof input.news.targetOrg === "string" ? input.news.targetOrg : undefined;
        const connection = yield* connectionFor(targetOrg);
        return yield* loadSite(connection, { id: undefined, siteName });
      }),
    list: () =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(undefined);
        const records = yield* queryRecords(connection, `SELECT ${QUERY_FIELDS} FROM RemoteProxy`, "tooling");
        return yield* Effect.forEach(records, attributesFrom);
      }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const site = yield* normalize(input.news);
        const byId = input.output?.id === undefined ? undefined : yield* findById(connection, input.output.id);
        const current = byId ?? (yield* findByName(connection, site.siteName));
        const ensured = yield* ensureSite(connection, site, current);
        const id = stringField(ensured, "Id");
        if (id === undefined) {
          return yield* Effect.fail(
            new SalesforceApiError({
              message: `Remote site '${site.siteName}' has no Id.`,
              status: 0,
              errorCode: undefined,
              method: "GET",
              path: "/tooling/sobjects/RemoteProxy",
            }),
          );
        }
        if (drifted(ensured, site)) {
          yield* request(connection, {
            method: "PATCH",
            path: sobjectPath(connection.apiVersion, "RemoteProxy", id, "tooling"),
            body: { Metadata: metadata(site) },
          });
          const reloaded = yield* findById(connection, id);
          if (reloaded === undefined) {
            return yield* Effect.fail(
              new SalesforceApiError({
                message: `Remote site ${id} disappeared after update.`,
                status: 404,
                errorCode: "NOT_FOUND",
                method: "GET",
                path: `/tooling/sobjects/RemoteProxy/${id}`,
              }),
            );
          }
          return yield* attributesFrom(reloaded);
        }
        return yield* attributesFrom(ensured);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const site = yield* normalize(input.olds);
        const deactivate = (id: string) =>
          request(connection, {
            method: "PATCH",
            path: sobjectPath(connection.apiVersion, "RemoteProxy", id, "tooling"),
            body: { Metadata: metadata({ ...site, isActive: false }) },
          });
        const remove = (id: string) =>
          request(connection, {
            method: "DELETE",
            path: sobjectPath(connection.apiVersion, "RemoteProxy", id, "tooling"),
          }).pipe(
            Effect.as("deleted" as const),
            Effect.catchTag("SalesforceApiError", (error) => {
              if (isNotFound(error)) {
                return Effect.succeed("missing" as const);
              }
              if (deleteRefused(error)) {
                return Effect.succeed("refused" as const);
              }
              return Effect.fail(error);
            }),
          );
        const outcome = yield* remove(input.output.id);
        if (outcome === "deleted") {
          return;
        }
        if (outcome === "refused") {
          yield* deactivate(input.output.id);
          return;
        }
        const named = yield* findByName(connection, input.olds.siteName);
        const fallback = named === undefined ? undefined : stringField(named, "Id");
        if (fallback === undefined || fallback === input.output.id) {
          return;
        }
        const second = yield* remove(fallback);
        if (second === "refused") {
          yield* deactivate(fallback);
        }
      }),
  }),
);
