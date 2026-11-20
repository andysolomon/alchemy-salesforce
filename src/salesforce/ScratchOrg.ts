import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { queryRecords, request, sobjectPath } from "./api.js";
import {
  connectionFor,
  DEFAULT_API_VERSION,
  forgetConnection,
  graphqlEndpoint,
  normalizeInstanceUrl,
  parseJsonObject,
  redactCliText,
  resultRecord,
  runSf,
  type CommandResult,
} from "./connection.js";
import { isNotFound, SalesforceAuthError, SalesforceCliError, SalesforceValidationError } from "./errors.js";
import { soqlString } from "./soql.js";

/** `sf org create scratch --edition` values. */
export const SCRATCH_EDITIONS = [
  "developer",
  "enterprise",
  "group",
  "professional",
  "partner-developer",
  "partner-enterprise",
  "partner-group",
  "partner-professional",
] as const;

export type ScratchEdition = (typeof SCRATCH_EDITIONS)[number];

export interface ScratchOrgProps {
  /**
   * sf alias for the new org, for example `pr-42`. Other resources pass
   * `targetOrg: scratch.alias`, which also orders them after the org exists.
   */
  readonly alias: string;
  /** sf alias of an authorized Dev Hub. */
  readonly devHub: string;
  /**
   * Scratch org definition file, for example `config/project-scratch-def.json`.
   * Relative paths resolve against the directory `alchemy` runs in.
   */
  readonly definitionFile?: string;
  /**
   * Edition. Defaults to `developer` when there is no definition file, and
   * overrides the file's `edition` when both are set.
   */
  readonly edition?: ScratchEdition;
  /** 1 to 30. Defaults to 7. */
  readonly durationDays?: number;
  /** Minutes `sf` waits for the org to be ready. Defaults to 10. Not a replacement trigger. */
  readonly waitMinutes?: number;
  /** Create the org without the Dev Hub project's namespace. */
  readonly noNamespace?: boolean;
}

export interface ScratchOrgAttributes {
  readonly alias: string;
  readonly orgId: string;
  readonly instanceUrl: string;
  readonly username: string;
  readonly apiVersion: string;
  /** `{instanceUrl}/services/data/v{apiVersion}/graphql`. */
  readonly graphqlUrl: string;
  readonly devHub: string;
  /** `YYYY-MM-DD`, as reported by `sf org display`. */
  readonly expirationDate: string | null;
  readonly edition: string | null;
}

export type ScratchOrg = ResourceInstance<"Salesforce.ScratchOrg", ScratchOrgProps, ScratchOrgAttributes>;

export const ScratchOrg = Resource<ScratchOrg>("Salesforce.ScratchOrg");

interface NormalizedScratchOrg {
  readonly alias: string;
  readonly devHub: string;
  readonly definitionFile: string | undefined;
  readonly edition: ScratchEdition | undefined;
  readonly durationDays: number;
  readonly waitMinutes: number;
  readonly noNamespace: boolean;
}

const isEdition = (value: string): value is ScratchEdition =>
  (SCRATCH_EDITIONS as ReadonlyArray<string>).includes(value);

const invalid = (message: string) => Effect.fail(new SalesforceValidationError({ message }));

export const normalizeScratchOrg = (
  props: ScratchOrgProps,
): Effect.Effect<NormalizedScratchOrg, SalesforceValidationError> => {
  const alias = props.alias.trim();
  const devHub = props.devHub.trim();
  if (alias.length === 0 || /\s/.test(alias)) {
    return invalid(`ScratchOrg alias '${props.alias}' must be non-empty and contain no whitespace.`);
  }
  if (devHub.length === 0 || /\s/.test(devHub)) {
    return invalid(`ScratchOrg devHub '${props.devHub}' must be non-empty and contain no whitespace.`);
  }
  if (alias === devHub) {
    return invalid(`ScratchOrg alias '${alias}' is the Dev Hub alias. Pick a different alias for the scratch org.`);
  }
  const definitionFile = props.definitionFile?.trim() || undefined;
  if (props.edition !== undefined && !isEdition(props.edition)) {
    return invalid(`ScratchOrg edition '${props.edition}' is not one of ${SCRATCH_EDITIONS.join(", ")}.`);
  }
  const durationDays = props.durationDays ?? 7;
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 30) {
    return invalid("ScratchOrg durationDays must be a whole number from 1 to 30.");
  }
  const waitMinutes = props.waitMinutes ?? 10;
  if (!Number.isInteger(waitMinutes) || waitMinutes < 1) {
    return invalid("ScratchOrg waitMinutes must be a whole number of at least 1.");
  }
  return Effect.succeed({
    alias,
    devHub,
    definitionFile,
    edition: props.edition ?? (definitionFile === undefined ? "developer" : undefined),
    durationDays,
    waitMinutes,
    noNamespace: props.noNamespace ?? false,
  });
};

/** Props that `sf` only reads at creation. Changing one replaces the org. */
const creationKey = (props: NormalizedScratchOrg): string =>
  JSON.stringify([
    props.alias,
    props.devHub,
    props.definitionFile ?? null,
    props.edition ?? null,
    props.durationDays,
    props.noNamespace,
  ]);

type Observed =
  | { readonly kind: "missing" }
  | { readonly kind: "expired"; readonly orgId: string | undefined }
  | { readonly kind: "found"; readonly record: Record<string, unknown> };

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const NOT_FOUND = /NamedOrgNotFound|NoAuthInfoFound|AuthInfo.*not ?found|No authorization information found|No org configuration found|not found|does not exist/i;

/** A scratch org deleted at expiry leaves a local authorization whose refresh token is dead. */
const DEAD_AUTH = /expired access\/refresh token|invalid_grant|INVALID_SESSION_ID|org has been deleted/i;

const outputText = (result: CommandResult): string => `${result.stdout}\n${result.stderr}`;

const cliFailure = (command: ReadonlyArray<string>, result: CommandResult): SalesforceCliError =>
  new SalesforceCliError({
    command: ["sf", ...command].join(" "),
    message: redactCliText(`Salesforce CLI exited ${result.code}. ${outputText(result)}`.trim()),
  });

const scrubCliError = (command: ReadonlyArray<string>) => (error: SalesforceCliError) =>
  new SalesforceCliError({ command: ["sf", ...command].join(" "), message: redactCliText(error.message) });

/** A scratch org reports its Dev Hub and expiry. A production org or sandbox does not. */
const isScratch = (record: Record<string, unknown>): boolean =>
  stringField(record, "devHubId") !== undefined || stringField(record, "expirationDate") !== undefined;

const observe = (alias: string) =>
  Effect.gen(function* () {
    const args = ["org", "display", "--target-org", alias, "--json"];
    const result = yield* runSf(args).pipe(Effect.mapError(scrubCliError(args)));
    if (result.code !== 0) {
      if (DEAD_AUTH.test(outputText(result))) {
        return { kind: "expired", orgId: undefined } as Observed;
      }
      if (NOT_FOUND.test(outputText(result))) {
        return { kind: "missing" } as Observed;
      }
      return yield* Effect.fail(cliFailure(args, result));
    }
    const payload = yield* parseJsonObject(result.stdout, []).pipe(Effect.mapError(scrubCliError(args)));
    const record = resultRecord(payload);
    if (record === undefined) {
      return yield* Effect.fail(
        new SalesforceCliError({ command: ["sf", ...args].join(" "), message: "sf org display returned no result object." }),
      );
    }
    const status = stringField(record, "status");
    if (status !== undefined && /^(expired|deleted)$/i.test(status)) {
      return { kind: "expired", orgId: stringField(record, "id") } as Observed;
    }
    return { kind: "found", record } as Observed;
  });

const attributesFrom = (
  alias: string,
  devHub: string,
  record: Record<string, unknown>,
): Effect.Effect<ScratchOrgAttributes, SalesforceCliError | SalesforceValidationError> => {
  if (!isScratch(record)) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `Alias '${alias}' points at an org that is not a scratch org (no devHubId or expirationDate). ` +
          "ScratchOrg will not adopt, or later delete, a sandbox or production org. Use Salesforce.Org for those.",
      }),
    );
  }
  const orgId = stringField(record, "id");
  const username = stringField(record, "username");
  const instanceUrl = stringField(record, "instanceUrl");
  if (orgId === undefined || username === undefined || instanceUrl === undefined) {
    return Effect.fail(
      new SalesforceCliError({
        command: `sf org display --target-org ${alias} --json`,
        message: "sf org display did not include id, username, and instanceUrl.",
      }),
    );
  }
  const override = process.env.SF_API_VERSION?.trim();
  const apiVersion =
    override !== undefined && override.length > 0
      ? override
      : (stringField(record, "apiVersion") ?? DEFAULT_API_VERSION);
  const normalizedUrl = normalizeInstanceUrl(instanceUrl);
  return Effect.succeed({
    alias,
    orgId,
    instanceUrl: normalizedUrl,
    username,
    apiVersion,
    graphqlUrl: graphqlEndpoint(normalizedUrl, apiVersion),
    devHub,
    expirationDate: stringField(record, "expirationDate") ?? null,
    edition: stringField(record, "edition") ?? null,
  });
};

/** Remove a dead local authorization so the alias can be reused. Failures are ignored. */
const logout = (alias: string) =>
  runSf(["org", "logout", "--target-org", alias, "--no-prompt", "--json"]).pipe(
    Effect.ignore,
    Effect.tap(() => Effect.sync(() => forgetConnection(alias))),
  );

/**
 * The Dev Hub's record of a scratch org. It is the source of truth when this
 * machine has no local authorization for the alias, which is normal on a CI
 * runner that did not create the org. `ScratchOrg` holds the 15-character org id.
 */
const findActiveScratchOrg = (devHub: string, orgId: string) =>
  Effect.gen(function* () {
    const connection = yield* connectionFor(devHub);
    const records = yield* queryRecords(
      connection,
      "SELECT Id, ScratchOrg, SignupUsername, Status, ExpirationDate FROM ActiveScratchOrg " +
        `WHERE ScratchOrg = ${soqlString(orgId.slice(0, 15))}`,
    );
    const record = records.find((candidate) => stringField(candidate, "Status") !== "Deleted");
    const id = record === undefined ? undefined : stringField(record, "Id");
    return id === undefined ? undefined : { id, connection };
  });

const JWT_HINT =
  "Set SF_JWT_CLIENT_ID and SF_JWT_KEY_FILE (the Dev Hub connected app's consumer key and private key) " +
  "so ScratchOrg can re-authorize it, or run `sf org login jwt` for that username before deploying.";

/**
 * Re-authorize an existing scratch org on a machine that did not create it,
 * using the Dev Hub's JWT connected app. Scratch orgs accept the Dev Hub's
 * consumer key for their own users.
 */
const reauthorize = (alias: string, output: ScratchOrgAttributes) =>
  Effect.gen(function* () {
    const clientId = process.env.SF_JWT_CLIENT_ID?.trim();
    const keyFile = process.env.SF_JWT_KEY_FILE?.trim();
    if (!clientId || !keyFile) {
      return yield* Effect.fail(
        new SalesforceAuthError({
          message:
            `Scratch org ${output.orgId} (${output.username}) is still active on Dev Hub '${output.devHub}', ` +
            `but alias '${alias}' is not authorized on this machine. ${JWT_HINT}`,
        }),
      );
    }
    const instanceUrl = process.env.SF_JWT_INSTANCE_URL?.trim() || "https://test.salesforce.com";
    const args = [
      "org", "login", "jwt",
      "--username", output.username,
      "--client-id", clientId,
      "--jwt-key-file", keyFile,
      "--instance-url", instanceUrl,
      "--alias", alias,
      "--json",
    ];
    yield* Effect.logInfo(`Re-authorizing scratch org '${alias}' (${output.username}) with JWT.`);
    const result = yield* runSf(args).pipe(Effect.mapError(scrubCliError(args)));
    if (result.code !== 0) {
      return yield* Effect.fail(cliFailure(args, result));
    }
    forgetConnection(alias);
    const observed = yield* observe(alias);
    if (observed.kind !== "found") {
      return yield* Effect.fail(
        new SalesforceAuthError({ message: `JWT login for '${alias}' succeeded, but sf still cannot display the org.` }),
      );
    }
    return observed.record;
  });

const createArgs = (props: NormalizedScratchOrg): ReadonlyArray<string> => [
  "org",
  "create",
  "scratch",
  "--target-dev-hub",
  props.devHub,
  "--alias",
  props.alias,
  "--duration-days",
  String(props.durationDays),
  "--wait",
  String(props.waitMinutes),
  ...(props.definitionFile === undefined ? [] : ["--definition-file", props.definitionFile]),
  ...(props.edition === undefined ? [] : ["--edition", props.edition]),
  ...(props.noNamespace ? ["--no-namespace"] : []),
  "--json",
];

const create = (props: NormalizedScratchOrg) =>
  Effect.gen(function* () {
    const args = createArgs(props);
    yield* Effect.logInfo(`Creating scratch org '${props.alias}' from Dev Hub '${props.devHub}'.`);
    const result = yield* runSf(args).pipe(Effect.mapError(scrubCliError(args)));
    if (result.code !== 0) {
      return yield* Effect.fail(cliFailure(args, result));
    }
    forgetConnection(props.alias);
    const observed = yield* observe(props.alias);
    if (observed.kind !== "found") {
      return yield* Effect.fail(
        new SalesforceCliError({
          command: ["sf", ...args].join(" "),
          message: `sf reported success, but alias '${props.alias}' is not usable afterwards.`,
        }),
      );
    }
    return yield* attributesFrom(props.alias, props.devHub, observed.record);
  });

/**
 * A scratch org created from a Dev Hub with the Salesforce CLI.
 *
 * Reconcile adopts a live scratch org already authorized under `alias`, and
 * recreates one that has expired. It refuses to adopt an alias that points at
 * a sandbox or production org. Delete runs `sf org delete scratch` only when
 * the alias still resolves to the org id recorded in state, so a reused alias
 * is never deleted by mistake.
 *
 * On a machine that did not create the org (a new CI runner), the alias is
 * not authorized. Delete then removes the Dev Hub's `ActiveScratchOrg` record,
 * which deletes the org. Reconcile re-authorizes with JWT when
 * `SF_JWT_CLIENT_ID` and `SF_JWT_KEY_FILE` are set, and otherwise fails
 * rather than creating a second org.
 *
 * `list` is empty and nuke is skipped: enumerating every scratch org on the
 * machine and deleting them would remove orgs this stack does not own.
 */
export const ScratchOrgProvider = Provider.succeed(
  ScratchOrg,
  ScratchOrg.Provider.of({
    stables: ["orgId", "username", "instanceUrl"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        const news = yield* normalizeScratchOrg(input.news);
        const olds = yield* normalizeScratchOrg(input.olds).pipe(
          Effect.catchTag("SalesforceValidationError", () => Effect.succeed(undefined)),
        );
        if (olds === undefined || creationKey(news) !== creationKey(olds)) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const alias = input.olds.alias.trim();
        const observed = yield* observe(alias);
        if (observed.kind === "missing" && input.output !== undefined) {
          // Not authorized here. The Dev Hub still knows whether the org exists.
          const active = yield* findActiveScratchOrg(input.output.devHub, input.output.orgId);
          return active === undefined ? undefined : input.output;
        }
        if (observed.kind !== "found" || !isScratch(observed.record)) {
          return undefined;
        }
        return yield* attributesFrom(alias, input.olds.devHub.trim(), observed.record);
      }),
    list: () => Effect.succeed([]),
    reconcile: (input) =>
      Effect.gen(function* () {
        const props = yield* normalizeScratchOrg(input.news);
        const observed = yield* observe(props.alias);
        if (observed.kind === "found") {
          return yield* attributesFrom(props.alias, props.devHub, observed.record);
        }
        const previous = input.output;
        if (observed.kind === "missing" && previous !== undefined) {
          // A fresh CI runner has no local auth for an org an earlier run created.
          // Creating another would leak the first, so log back in to it instead.
          const active = yield* findActiveScratchOrg(previous.devHub, previous.orgId);
          if (active !== undefined) {
            const record = yield* reauthorize(props.alias, previous);
            return yield* attributesFrom(props.alias, props.devHub, record);
          }
        }
        if (observed.kind === "expired") {
          yield* Effect.logInfo(`Scratch org '${props.alias}' has expired. Creating a new one.`);
          yield* logout(props.alias);
        }
        return yield* create(props);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const alias = input.olds.alias.trim();
        const observed = yield* observe(alias);
        if (observed.kind === "missing") {
          // Not authorized here: delete through the Dev Hub, which needs no scratch org login.
          forgetConnection(alias);
          const active = yield* findActiveScratchOrg(input.output.devHub, input.output.orgId);
          if (active === undefined) {
            return;
          }
          yield* Effect.logInfo(`Deleting scratch org ${input.output.orgId} through Dev Hub '${input.output.devHub}'.`);
          yield* request(active.connection, {
            method: "DELETE",
            path: sobjectPath(active.connection.apiVersion, "ActiveScratchOrg", active.id),
          }).pipe(
            Effect.catchTag("SalesforceApiError", (error) => (isNotFound(error) ? Effect.void : Effect.fail(error))),
          );
          return;
        }
        if (observed.kind === "expired") {
          yield* logout(alias);
          return;
        }
        const liveId = stringField(observed.record, "id");
        if (liveId !== input.output.orgId) {
          yield* Effect.logWarning(
            `Alias '${alias}' now points at org ${liveId ?? "(unknown)"}, not ${input.output.orgId}. ` +
              "Leaving it alone.",
          );
          return;
        }
        const args = ["org", "delete", "scratch", "--target-org", alias, "--no-prompt", "--json"];
        const result = yield* runSf(args).pipe(Effect.mapError(scrubCliError(args)));
        if (result.code !== 0 && !NOT_FOUND.test(outputText(result))) {
          return yield* Effect.fail(cliFailure(args, result));
        }
        forgetConnection(alias);
      }),
  }),
);
