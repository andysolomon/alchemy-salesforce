import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { userInfo } from "./api.js";
import { connectionFor, graphqlEndpoint, targetOrgChanged } from "./connection.js";
import { SalesforceApiError, SalesforceValidationError } from "./errors.js";

export interface OrgProps {
  /** sf CLI alias, for example `hub` or `partner`. */
  readonly alias: string;
}

export interface OrgAttributes {
  readonly alias: string;
  readonly orgId: string;
  readonly instanceUrl: string;
  readonly username: string;
  readonly apiVersion: string;
  /** `{instanceUrl}/services/data/v{apiVersion}/graphql`. Not a Salesforce row. */
  readonly graphqlUrl: string;
}

export type Org = ResourceInstance<"Salesforce.Org", OrgProps, OrgAttributes>;

export const Org = Resource<Org>("Salesforce.Org");

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Discover an already-authorized org. This does not create, mutate, or
 * delete anything in Salesforce. The access token stays in the process
 * connection directory and is not an output.
 *
 * `list` is empty and nuke is skipped: enumerating every CLI authorization
 * and deleting it would log the operator out of orgs this stack does not own.
 */
export const OrgProvider = Provider.succeed(
  Org,
  Org.Provider.of({
    stables: ["orgId"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (targetOrgChanged(input.olds.alias, input.news.alias)) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) => describe(input.olds.alias),
    list: () => Effect.succeed([]),
    reconcile: (input) => describe(input.news.alias),
    delete: () => Effect.void,
  }),
);

const describe = (alias: string) =>
  Effect.gen(function* () {
    const trimmed = alias.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new SalesforceValidationError({ message: "Salesforce.Org alias must not be empty." }),
      );
    }
    const connection = yield* connectionFor(trimmed);
    let orgId = connection.orgId;
    let username = connection.username;
    if (orgId === undefined || username === undefined) {
      const identity = yield* userInfo(connection);
      const body =
        identity.body !== null && typeof identity.body === "object" && !Array.isArray(identity.body)
          ? (identity.body as Record<string, unknown>)
          : undefined;
      orgId = orgId ?? (body === undefined ? undefined : stringField(body, "organization_id"));
      username = username ?? (body === undefined ? undefined : stringField(body, "preferred_username"));
    }
    if (orgId === undefined || username === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message:
            `Org '${trimmed}' did not report an org id and username. ` +
            "sf org display should include result.id and result.username.",
          status: 0,
          errorCode: undefined,
          method: "GET",
          path: "/services/oauth2/userinfo",
        }),
      );
    }
    return {
      alias: trimmed,
      orgId,
      instanceUrl: connection.instanceUrl,
      username,
      apiVersion: connection.apiVersion,
      graphqlUrl: graphqlEndpoint(connection.instanceUrl, connection.apiVersion),
    };
  });
