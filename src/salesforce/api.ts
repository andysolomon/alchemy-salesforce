import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { ResolvedConnection } from "./connection.js";
import { errorMessage, SalesforceApiError } from "./errors.js";

export interface ApiRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Absolute path (`/services/data/...`) or an absolute URL. */
  readonly path: string;
  readonly body?: unknown;
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

interface QueryPage {
  readonly done?: boolean;
  readonly nextRecordsUrl?: string;
  readonly records?: ReadonlyArray<Record<string, unknown>>;
}

const pathnameOf = (path: string): string => {
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
};

const absoluteUrl = (connection: ResolvedConnection, path: string): string => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${connection.instanceUrl}${path.startsWith("/") ? "" : "/"}${path}`;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const errorFromBody = (
  body: unknown,
): { readonly message: string; readonly errorCode: string | undefined } => {
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === undefined) {
      continue;
    }
    const message = typeof record.message === "string" ? record.message : undefined;
    const errorCode = typeof record.errorCode === "string" ? record.errorCode : undefined;
    if (message !== undefined || errorCode !== undefined) {
      return {
        message: message ?? errorCode ?? "Salesforce request failed",
        errorCode,
      };
    }
  }
  return { message: "Salesforce request failed", errorCode: undefined };
};

const readBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, SalesforceApiError> => {
  if (response.status === 204 || response.status === 205) {
    return Effect.succeed(undefined);
  }
  return response.json.pipe(
    Effect.mapError(
      (cause) =>
        new SalesforceApiError({
          message: `Salesforce response was not JSON: ${errorMessage(cause)}`,
          status: response.status,
          errorCode: undefined,
          method: response.request.method,
          path: pathnameOf(response.request.url),
        }),
    ),
  );
};

/**
 * One authenticated REST call. The bearer token is attached inside the
 * HTTP client and is not included in errors.
 */
export const request = (connection: ResolvedConnection, input: ApiRequest) =>
  Effect.gen(function* () {
    const url = absoluteUrl(connection, input.path);
    const client = yield* HttpClient.HttpClient;
    const built = HttpClientRequest.make(input.method)(url).pipe(
      HttpClientRequest.bearerToken(connection.accessToken),
      HttpClientRequest.acceptJson,
    );
    const httpRequest =
      input.body === undefined
        ? built
        : yield* HttpClientRequest.bodyJson(built, input.body).pipe(
            Effect.mapError(
              (cause) =>
                new SalesforceApiError({
                  message: `Could not encode the Salesforce request body: ${errorMessage(cause)}`,
                  status: 0,
                  errorCode: undefined,
                  method: input.method,
                  path: pathnameOf(input.path),
                }),
            ),
          );
    const response = yield* client.execute(httpRequest).pipe(
      Effect.mapError(
        (cause) =>
          new SalesforceApiError({
            message: `Salesforce request failed before a response: ${errorMessage(cause)}`,
            status: 0,
            errorCode: undefined,
            method: input.method,
            path: pathnameOf(input.path),
          }),
      ),
    );
    const body = yield* readBody(response);
    if (response.status < 200 || response.status >= 300) {
      const parsed = errorFromBody(body);
      return yield* Effect.fail(
        new SalesforceApiError({
          message: parsed.message,
          status: response.status,
          errorCode: parsed.errorCode,
          method: input.method,
          path: pathnameOf(input.path),
        }),
      );
    }
    return { status: response.status, body };
  });

const isQueryPage = (body: unknown): body is QueryPage => asRecord(body) !== undefined;

/**
 * Follow `nextRecordsUrl` until `done` is true. A repeated locator fails
 * instead of looping forever.
 */
export const queryAll = (
  connection: ResolvedConnection,
  soql: string,
  api: "data" | "tooling" = "data",
) =>
  Effect.gen(function* () {
    const records: Array<Record<string, unknown>> = [];
    const root = api === "tooling" ? "tooling/query" : "query";
    let path: string | undefined =
      `/services/data/v${connection.apiVersion}/${root}?q=${encodeURIComponent(soql)}`;
    const seen = new Set<string>();
    while (path !== undefined) {
      if (seen.has(path)) {
        return yield* Effect.fail(
          new SalesforceApiError({
            message: "Salesforce query pagination repeated a locator.",
            status: 0,
            errorCode: undefined,
            method: "GET",
            path: pathnameOf(path),
          }),
        );
      }
      seen.add(path);
      const page: ApiResult = yield* request(connection, { method: "GET", path });
      if (!isQueryPage(page.body)) {
        return yield* Effect.fail(
          new SalesforceApiError({
            message: "Salesforce query response did not include records.",
            status: page.status,
            errorCode: undefined,
            method: "GET",
            path: pathnameOf(path),
          }),
        );
      }
      for (const record of page.body.records ?? []) {
        records.push(record);
      }
      const next = page.body.nextRecordsUrl;
      path = page.body.done === false && typeof next === "string" && next.length > 0 ? next : undefined;
    }
    return records;
  });

export const queryRecords = (
  connection: ResolvedConnection,
  soql: string,
  api: "data" | "tooling" = "data",
) =>
  Effect.gen(function* () {
    return yield* queryAll(connection, soql, api).pipe(
      Effect.mapError((cause) =>
        cause._tag === "SalesforceApiError"
          ? new SalesforceApiError({
              ...cause,
              message: `SOQL failed (${soql}): ${cause.message}`,
            })
          : cause,
      ),
    );
  });

export const sobjectPath = (
  apiVersion: string,
  objectName: string,
  id?: string,
  api: "data" | "tooling" = "data",
): string => {
  const root = api === "tooling" ? "tooling/sobjects" : "sobjects";
  return `/services/data/v${apiVersion}/${root}/${objectName}${id === undefined ? "" : `/${id}`}`;
};

export const userInfo = (connection: ResolvedConnection) =>
  request(connection, { method: "GET", path: "/services/oauth2/userinfo" });
