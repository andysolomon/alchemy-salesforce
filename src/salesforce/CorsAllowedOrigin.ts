import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { queryRecords, request, sobjectPath } from "./api.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { requireDeveloperName } from "./names.js";
import { soqlString } from "./soql.js";

export interface CorsAllowedOriginProps {
  /** sf alias of the org that owns this row. Omit for the default org. */
  readonly targetOrg?: string;
  /** `DeveloperName`. Stable API name, not the Alchemy logical id. */
  readonly name: string;
  /**
   * `UrlPattern`: an origin, not a URL with a path. HTTPS is required except
   * for localhost. A leading wildcard subdomain is allowed:
   * `https://*.example.com`, `https://app.example.com:8443`, `http://localhost:3000`.
   */
  readonly urlPattern: string;
  /** `MasterLabel`. Defaults to `name`. */
  readonly label?: string;
}

export interface CorsAllowedOriginAttributes {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly urlPattern: string;
}

export type CorsAllowedOrigin = ResourceInstance<
  "Salesforce.CorsAllowedOrigin",
  CorsAllowedOriginProps,
  CorsAllowedOriginAttributes
>;

export const CorsAllowedOrigin = Resource<CorsAllowedOrigin>("Salesforce.CorsAllowedOrigin");

/** Setup's "CORS Allowed Origin List" is the `CorsWhitelistEntry` sObject. */
const SOBJECT = "CorsWhitelistEntry";
const FIELDS = "Id, DeveloperName, MasterLabel, UrlPattern";

interface NormalizedOrigin {
  readonly name: string;
  readonly label: string;
  readonly urlPattern: string;
}

const ORIGIN = /^(https:\/\/(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*|http:\/\/localhost)(:\d{1,5})?$/;

export const normalizeCorsOrigin = (
  props: CorsAllowedOriginProps,
): Effect.Effect<NormalizedOrigin, SalesforceValidationError> =>
  Effect.gen(function* () {
    const name = yield* requireDeveloperName(props.name, "CorsAllowedOrigin name");
    const urlPattern = props.urlPattern.trim().replace(/\/+$/, "");
    if (!ORIGIN.test(urlPattern)) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `CorsAllowedOrigin urlPattern '${props.urlPattern}' must be an origin such as ` +
            "https://app.example.com, https://*.example.com, or http://localhost:3000. " +
            "Salesforce requires HTTPS except for localhost, and does not accept a path.",
        }),
      );
    }
    const label = (props.label ?? name).trim();
    if (label.length === 0 || label.length > 80) {
      return yield* Effect.fail(
        new SalesforceValidationError({ message: "CorsAllowedOrigin label must be 1 to 80 characters." }),
      );
    }
    return { name, label, urlPattern };
  });

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const apiError = (message: string, method: string, path: string, status = 0) =>
  new SalesforceApiError({ message, status, errorCode: undefined, method, path });

const attributesFrom = (
  record: Record<string, unknown>,
): Effect.Effect<CorsAllowedOriginAttributes, SalesforceApiError> => {
  const id = stringField(record, "Id");
  const name = stringField(record, "DeveloperName");
  const urlPattern = stringField(record, "UrlPattern");
  if (id === undefined || name === undefined || urlPattern === undefined) {
    return Effect.fail(apiError(`${SOBJECT} record was missing Id, DeveloperName, or UrlPattern.`, "GET", `/sobjects/${SOBJECT}`, 200));
  }
  return Effect.succeed({ id, name, label: stringField(record, "MasterLabel") ?? name, urlPattern });
};

const body = (origin: NormalizedOrigin): Record<string, unknown> => ({
  DeveloperName: origin.name,
  MasterLabel: origin.label,
  UrlPattern: origin.urlPattern,
});

const drifted = (record: Record<string, unknown>, origin: NormalizedOrigin): boolean =>
  stringField(record, "DeveloperName") !== origin.name ||
  (stringField(record, "MasterLabel") ?? "") !== origin.label ||
  stringField(record, "UrlPattern") !== origin.urlPattern;

const findByName = (connection: ResolvedConnection, name: string) =>
  Effect.map(
    queryRecords(connection, `SELECT ${FIELDS} FROM ${SOBJECT} WHERE DeveloperName = ${soqlString(name)}`),
    (records) => records[0],
  );

const findById = (connection: ResolvedConnection, id: string) =>
  Effect.gen(function* () {
    const result = yield* request(connection, {
      method: "GET",
      path: sobjectPath(connection.apiVersion, SOBJECT, id),
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

const locate = (connection: ResolvedConnection, input: { readonly id: string | undefined; readonly name: string }) =>
  Effect.gen(function* () {
    const byId = input.id === undefined ? undefined : yield* findById(connection, input.id);
    return byId ?? (yield* findByName(connection, input.name));
  });

const isDuplicate = (error: SalesforceApiError): boolean =>
  error.errorCode === "DUPLICATE_DEVELOPER_NAME" || error.errorCode === "DUPLICATE_VALUE";

/**
 * One row in Setup > CORS > Allowed Origins, which lets browser JavaScript
 * on that origin call the org's REST APIs. An existing row with the same
 * developer name is adopted and patched.
 *
 * `list` reads the default org. Nuke is skipped because the rows carry no
 * Alchemy ownership tag.
 */
export const CorsAllowedOriginProvider = Provider.succeed(
  CorsAllowedOrigin,
  CorsAllowedOrigin.Provider.of({
    stables: ["id"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (targetOrgChanged(input.olds.targetOrg, input.news.targetOrg)) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const record = yield* locate(connection, { id: input.output?.id, name: input.olds.name.trim() });
        return record === undefined ? undefined : yield* attributesFrom(record);
      }),
    observe: (input) =>
      Effect.gen(function* () {
        const name = input.news?.name;
        if (typeof name !== "string") {
          return undefined;
        }
        const targetOrg = typeof input.news.targetOrg === "string" ? input.news.targetOrg : undefined;
        const connection = yield* connectionFor(targetOrg);
        const record = yield* findByName(connection, name.trim());
        return record === undefined ? undefined : yield* attributesFrom(record);
      }),
    list: () =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(undefined);
        const records = yield* queryRecords(connection, `SELECT ${FIELDS} FROM ${SOBJECT}`);
        return yield* Effect.forEach(records, attributesFrom);
      }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const origin = yield* normalizeCorsOrigin(input.news);
        let current = yield* locate(connection, { id: input.output?.id, name: origin.name });
        if (current === undefined) {
          const created = yield* request(connection, {
            method: "POST",
            path: sobjectPath(connection.apiVersion, SOBJECT),
            body: body(origin),
          }).pipe(
            Effect.catchTag("SalesforceApiError", (error) =>
              isDuplicate(error) ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          );
          const createdId =
            created?.body !== null && typeof created?.body === "object" && !Array.isArray(created.body)
              ? stringField(created.body as Record<string, unknown>, "id")
              : undefined;
          current = yield* locate(connection, { id: createdId, name: origin.name });
          if (current === undefined) {
            return yield* Effect.fail(apiError(`${SOBJECT} '${origin.name}' was not found after create.`, "POST", `/sobjects/${SOBJECT}`));
          }
        }
        const id = stringField(current, "Id");
        if (id === undefined) {
          return yield* Effect.fail(apiError(`${SOBJECT} '${origin.name}' has no Id.`, "GET", `/sobjects/${SOBJECT}`));
        }
        if (!drifted(current, origin)) {
          return yield* attributesFrom(current);
        }
        yield* request(connection, {
          method: "PATCH",
          path: sobjectPath(connection.apiVersion, SOBJECT, id),
          body: body(origin),
        });
        const reloaded = yield* findById(connection, id);
        if (reloaded === undefined) {
          return yield* Effect.fail(apiError(`${SOBJECT} ${id} disappeared after update.`, "GET", `/sobjects/${SOBJECT}/${id}`, 404));
        }
        return yield* attributesFrom(reloaded);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const remove = (id: string) =>
          request(connection, {
            method: "DELETE",
            path: sobjectPath(connection.apiVersion, SOBJECT, id),
          }).pipe(
            Effect.as("deleted" as const),
            Effect.catchTag("SalesforceApiError", (error) =>
              isNotFound(error) ? Effect.succeed("missing" as const) : Effect.fail(error),
            ),
          );
        if ((yield* remove(input.output.id)) === "deleted") {
          return;
        }
        const named = yield* findByName(connection, input.olds.name.trim());
        const fallback = named === undefined ? undefined : stringField(named, "Id");
        if (fallback !== undefined && fallback !== input.output.id) {
          yield* remove(fallback);
        }
      }),
  }),
);
