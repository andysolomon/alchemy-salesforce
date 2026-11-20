import { Stage } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { errorMessage, SalesforceAuthError, SalesforceCliError } from "./errors.js";

/** Winter '27. Override with SF_API_VERSION or the org's reported apiVersion. */
export const DEFAULT_API_VERSION = "68.0";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner<R = never> = (
  args: ReadonlyArray<string>,
) => Effect.Effect<CommandResult, SalesforceCliError, R>;

/**
 * Process environment the resolver reads. Tests pass a plain object.
 * A real deploy reads `process.env`.
 */
export interface SalesforceEnv {
  readonly SF_INSTANCE_URL?: string | undefined;
  readonly SF_ACCESS_TOKEN?: string | undefined;
  readonly SALESFORCE_INSTANCE_URL?: string | undefined;
  readonly SALESFORCE_ACCESS_TOKEN?: string | undefined;
  readonly SF_TARGET_ORG?: string | undefined;
  readonly SALESFORCE_TARGET_ORG?: string | undefined;
  readonly SF_API_VERSION?: string | undefined;
  readonly ALCHEMY_STAGE?: string | undefined;
  /**
   * JSON object keyed by sf alias. Each entry is that org's own URL and
   * token. An explicit alias never falls through to `SF_ACCESS_TOKEN`.
   */
  readonly SF_ORG_CREDENTIALS?: string | undefined;
}

export interface OrgCredential {
  readonly instanceUrl: string;
  readonly accessToken: string;
  readonly orgId?: string | undefined;
  readonly username?: string | undefined;
  readonly apiVersion?: string | undefined;
}

export interface ResolvedConnection {
  readonly instanceUrl: string;
  readonly accessToken: Redacted.Redacted<string>;
  readonly apiVersion: string;
  readonly alias: string | undefined;
  readonly username: string | undefined;
  readonly orgId: string | undefined;
  readonly source: "env" | "cli" | "org-credentials";
}

const connectionCache = new Map<string, ResolvedConnection>();

/** Drop every cached org connection. Tests call this after changing env. */
export const clearConnectionCache = (): void => {
  connectionCache.clear();
};

/**
 * Drop cached connections for one alias. A scratch org that is deleted and
 * recreated under the same alias gets a new instance URL and token.
 */
export const forgetConnection = (alias: string): void => {
  const trimmed = alias.trim();
  for (const [key, connection] of connectionCache) {
    if (connection.alias === trimmed || key.startsWith(`${trimmed}\0`)) {
      connectionCache.delete(key);
    }
  }
};

export const graphqlEndpoint = (instanceUrl: string, apiVersion: string): string =>
  `${instanceUrl}/services/data/v${apiVersion}/graphql`;

export const targetOrgChanged = (previous: string | undefined, next: string | undefined): boolean =>
  (previous ?? "") !== (next ?? "");

const envValue = (env: SalesforceEnv, key: keyof SalesforceEnv): string | undefined => {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const targetOrgAlias = (env: SalesforceEnv, stage: string | undefined): string | undefined =>
  envValue(env, "SF_TARGET_ORG") ??
  envValue(env, "SALESFORCE_TARGET_ORG") ??
  (stage !== undefined && stage.trim().length > 0 ? stage.trim() : undefined) ??
  envValue(env, "ALCHEMY_STAGE");

export const isRedactedAccessToken = (token: string | undefined): boolean => {
  if (token === undefined) {
    return true;
  }
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return trimmed.includes("REDACTED") || trimmed.includes("show-access-token");
};

/** Remove access-token material before it can land in an error message. */
export const redactCliText = (text: string, secrets: ReadonlyArray<string> = []): string => {
  const embedded = [...text.matchAll(/"accessToken"\s*:\s*"([^"]*)"/g)].map((match) => match[1] ?? "");
  const secretsToScrub = [...secrets, ...embedded].filter(
    (secret) => secret.length >= 8 && !secret.includes("REDACTED") && !secret.includes("[redacted]"),
  );
  let redacted = text;
  for (const secret of secretsToScrub) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.replaceAll(/Bearer\s+\S+/g, "Bearer [redacted]");
};

export const normalizeInstanceUrl = (instanceUrl: string): string => instanceUrl.replace(/\/+$/, "");

const assertInstanceUrl = (instanceUrl: string): Effect.Effect<string, SalesforceAuthError> => {
  if (/^https?:\/\//i.test(instanceUrl)) {
    return Effect.succeed(normalizeInstanceUrl(instanceUrl));
  }
  return Effect.fail(
    new SalesforceAuthError({
      message: `Salesforce instance URL must be an http(s) URL, received '${instanceUrl}'.`,
    }),
  );
};

export const parseJsonObject = (
  stdout: string,
  secrets: ReadonlyArray<string>,
): Effect.Effect<Record<string, unknown>, SalesforceCliError> => {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    return Effect.fail(
      new SalesforceCliError({
        command: "sf",
        message: `Salesforce CLI did not return JSON. ${redactCliText(stdout, secrets)}`,
      }),
    );
  }
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Effect.fail(
        new SalesforceCliError({
          command: "sf",
          message: "Salesforce CLI JSON was not an object.",
        }),
      );
    }
    return Effect.succeed(parsed as Record<string, unknown>);
  } catch (cause) {
    return Effect.fail(
      new SalesforceCliError({
        command: "sf",
        message: `Salesforce CLI JSON could not be parsed: ${errorMessage(cause)}`,
      }),
    );
  }
};

export const resultRecord = (payload: Record<string, unknown>): Record<string, unknown> | undefined => {
  const result = payload.result ?? payload;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return undefined;
};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const failCli = (
  command: string,
  result: CommandResult,
  secrets: ReadonlyArray<string>,
): SalesforceCliError =>
  new SalesforceCliError({
    command,
    message: redactCliText(
      `Salesforce CLI exited ${result.code}. ${result.stderr}\n${result.stdout}`.trim(),
      secrets,
    ),
  });

export const runChecked = <R>(
  run: CommandRunner<R>,
  args: ReadonlyArray<string>,
  secrets: ReadonlyArray<string>,
): Effect.Effect<Record<string, unknown>, SalesforceCliError, R> =>
  Effect.gen(function* () {
    const command = ["sf", ...args].join(" ");
    const result = yield* run(args).pipe(
      Effect.mapError(
        (cause) =>
          new SalesforceCliError({
            command,
            message: redactCliText(cause.message, secrets),
          }),
      ),
    );
    if (result.code !== 0) {
      return yield* Effect.fail(failCli(command, result, secrets));
    }
    return yield* parseJsonObject(result.stdout, secrets).pipe(
      Effect.mapError(
        (cause) =>
          new SalesforceCliError({
            command,
            message: redactCliText(cause.message, secrets),
          }),
      ),
    );
  });

const tokenFromPayload = (payload: Record<string, unknown>): string | undefined => {
  const record = resultRecord(payload);
  if (record === undefined) {
    return undefined;
  }
  const token = stringField(record, "accessToken");
  if (token !== undefined) {
    return token;
  }
  const nested = record.result;
  return typeof nested === "string" ? nested : undefined;
};

export const parseOrgCredentials = (
  raw: string | undefined,
): Effect.Effect<Readonly<Record<string, OrgCredential>>, SalesforceAuthError> => {
  if (raw === undefined || raw.trim().length === 0) {
    return Effect.succeed({});
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Effect.fail(
        new SalesforceAuthError({
          message: "SF_ORG_CREDENTIALS must be a JSON object keyed by sf alias.",
        }),
      );
    }
    return Effect.succeed(parsed as Record<string, OrgCredential>);
  } catch {
    return Effect.fail(
      new SalesforceAuthError({
        message: "SF_ORG_CREDENTIALS is not valid JSON.",
      }),
    );
  }
};

const connectionFromCredential = (
  alias: string,
  credential: OrgCredential,
  apiVersionOverride: string | undefined,
): Effect.Effect<ResolvedConnection, SalesforceAuthError> =>
  Effect.gen(function* () {
    if (
      typeof credential?.instanceUrl !== "string" ||
      typeof credential?.accessToken !== "string" ||
      credential.instanceUrl.trim().length === 0 ||
      credential.accessToken.trim().length === 0
    ) {
      return yield* Effect.fail(
        new SalesforceAuthError({
          message: `SF_ORG_CREDENTIALS entry '${alias}' needs instanceUrl and accessToken.`,
        }),
      );
    }
    return {
      instanceUrl: yield* assertInstanceUrl(credential.instanceUrl),
      accessToken: Redacted.make(credential.accessToken),
      apiVersion: apiVersionOverride ?? credential.apiVersion ?? DEFAULT_API_VERSION,
      alias,
      username: credential.username,
      orgId: credential.orgId,
      source: "org-credentials" as const,
    };
  });

/**
 * Resolve one org connection.
 *
 * An explicit `alias` is isolated: it uses `SF_ORG_CREDENTIALS[alias]` or
 * `sf org display --target-org <alias>`, and never the process-wide
 * `SF_ACCESS_TOKEN`. The default org (no alias) still prefers
 * `SF_INSTANCE_URL` + `SF_ACCESS_TOKEN`, then the stage / `SF_TARGET_ORG`.
 *
 * Current `sf org display --json` redacts `accessToken`. When that happens
 * the token comes from `sf org auth show-access-token --json --no-prompt`.
 */
export const resolveSalesforceConnection = <R>(input: {
  readonly env: SalesforceEnv;
  readonly stage: string | undefined;
  readonly run: CommandRunner<R>;
  readonly alias?: string | undefined;
}): Effect.Effect<ResolvedConnection, SalesforceAuthError | SalesforceCliError, R> =>
  Effect.gen(function* () {
    const requested = input.alias?.trim() || undefined;
    const credentials = yield* parseOrgCredentials(envValue(input.env, "SF_ORG_CREDENTIALS"));
    const apiVersionOverride = envValue(input.env, "SF_API_VERSION");
    const fromCli = (alias: string) => cliConnection(input.run, alias, apiVersionOverride);

    if (requested !== undefined) {
      const credential = credentials[requested];
      if (credential !== undefined) {
        return yield* connectionFromCredential(requested, credential, apiVersionOverride);
      }
      return yield* fromCli(requested);
    }

    const instanceUrl = envValue(input.env, "SF_INSTANCE_URL") ?? envValue(input.env, "SALESFORCE_INSTANCE_URL");
    const accessToken = envValue(input.env, "SF_ACCESS_TOKEN") ?? envValue(input.env, "SALESFORCE_ACCESS_TOKEN");

    if (instanceUrl !== undefined || accessToken !== undefined) {
      if (instanceUrl === undefined || accessToken === undefined) {
        return yield* Effect.fail(
          new SalesforceAuthError({
            message:
              "Set both SF_INSTANCE_URL and SF_ACCESS_TOKEN, or neither. " +
              "When neither is set, the provider uses the Salesforce CLI.",
          }),
        );
      }
      return {
        instanceUrl: yield* assertInstanceUrl(instanceUrl),
        accessToken: Redacted.make(accessToken),
        apiVersion: apiVersionOverride ?? DEFAULT_API_VERSION,
        alias: targetOrgAlias(input.env, input.stage),
        username: undefined,
        orgId: undefined,
        source: "env" as const,
      };
    }

    const alias = targetOrgAlias(input.env, input.stage);
    if (alias !== undefined && credentials[alias] !== undefined) {
      return yield* connectionFromCredential(alias, credentials[alias], apiVersionOverride);
    }
    if (alias === undefined) {
      return yield* Effect.fail(
        new SalesforceAuthError({
          message:
            "No Salesforce org selected. Pass --stage <sf-alias> " +
            "(the stage name is the alias), or set SF_TARGET_ORG. " +
            "For CI, set SF_INSTANCE_URL and SF_ACCESS_TOKEN, or SF_ORG_CREDENTIALS.",
        }),
      );
    }
    return yield* fromCli(alias);
  });

const cliConnection = <R>(
  run: CommandRunner<R>,
  alias: string,
  apiVersionOverride: string | undefined,
): Effect.Effect<ResolvedConnection, SalesforceAuthError | SalesforceCliError, R> =>
  Effect.gen(function* () {
    const display = yield* runChecked(
      run,
      ["org", "display", "--target-org", alias, "--json"],
      [],
    );
    const displayed = resultRecord(display);
    if (displayed === undefined) {
      return yield* Effect.fail(
        new SalesforceCliError({
          command: `sf org display --target-org ${alias} --json`,
          message: "Salesforce CLI org display did not include a result object.",
        }),
      );
    }
    const displayedUrl = stringField(displayed, "instanceUrl");
    if (displayedUrl === undefined) {
      return yield* Effect.fail(
        new SalesforceAuthError({
          message: `sf org display for alias '${alias}' did not include instanceUrl.`,
        }),
      );
    }

    const displayedToken = stringField(displayed, "accessToken");
    let token = displayedToken;
    if (isRedactedAccessToken(displayedToken)) {
      const shown = yield* runChecked(
        run,
        ["org", "auth", "show-access-token", "--target-org", alias, "--json", "--no-prompt"],
        [],
      );
      token = tokenFromPayload(shown);
    }
    if (token === undefined || isRedactedAccessToken(token)) {
      return yield* Effect.fail(
        new SalesforceAuthError({
          message:
            `Could not read an access token for Salesforce alias '${alias}'. ` +
            "Authorize the org with `sf org login web --alias " +
            alias +
            "`, then retry. Current CLI builds hide the token from `sf org display`; " +
            "this provider also runs `sf org auth show-access-token --json --no-prompt`.",
        }),
      );
    }

    const reportedVersion = stringField(displayed, "apiVersion");
    return {
      instanceUrl: yield* assertInstanceUrl(displayedUrl),
      accessToken: Redacted.make(token),
      apiVersion: apiVersionOverride ?? reportedVersion ?? DEFAULT_API_VERSION,
      alias,
      username: stringField(displayed, "username"),
      orgId: stringField(displayed, "id"),
      source: "cli" as const,
    };
  });

const liveRunner =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): CommandRunner =>
  (args) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("sf", args, { stdin: "ignore" }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { code: Number(code), stdout, stderr };
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SalesforceCliError({
            command: ["sf", ...args].join(" "),
            message:
              "Failed to run the Salesforce CLI (`sf`). Install it and authorize an org " +
              `with \`sf org login web\`. ${errorMessage(cause)}`,
          }),
      ),
    );

const cacheKey = (env: SalesforceEnv, stage: string | undefined, alias: string | undefined): string =>
  [
    alias ?? "",
    envValue(env, "SF_INSTANCE_URL") ?? "",
    envValue(env, "SALESFORCE_INSTANCE_URL") ?? "",
    envValue(env, "SF_ACCESS_TOKEN") ?? "",
    envValue(env, "SALESFORCE_ACCESS_TOKEN") ?? "",
    envValue(env, "SF_TARGET_ORG") ?? "",
    envValue(env, "SALESFORCE_TARGET_ORG") ?? "",
    envValue(env, "SF_API_VERSION") ?? "",
    envValue(env, "SF_ORG_CREDENTIALS") ?? "",
    stage ?? "",
    envValue(env, "ALCHEMY_STAGE") ?? "",
  ].join("\0");

export class OrgDirectory extends Context.Service<
  OrgDirectory,
  {
    readonly resolve: (
      targetOrg: string | undefined,
    ) => Effect.Effect<ResolvedConnection, SalesforceAuthError | SalesforceCliError>;
    /** Run `sf <args>`. Resources that drive the CLI (scratch orgs) use this. */
    readonly run: CommandRunner;
  }
>()("salesforce/OrgDirectory") {}

/**
 * One directory for every org in the process. Each alias has its own cache
 * entry, URL, and token. Logs include the alias and instance URL only.
 */
export const OrgDirectoryLive = Layer.effect(
  OrgDirectory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = liveRunner(spawner);
    return {
      run,
      resolve: (targetOrg) =>
        Effect.gen(function* () {
          const stage = Option.getOrUndefined(yield* Effect.serviceOption(Stage));
          const env = process.env as SalesforceEnv;
          const alias = targetOrg?.trim() || undefined;
          const key = cacheKey(env, stage, alias);
          const cached = connectionCache.get(key);
          if (cached !== undefined) {
            return cached;
          }
          const connection = yield* resolveSalesforceConnection({ env, stage, run, alias });
          connectionCache.set(key, connection);
          yield* Effect.logInfo(
            `Salesforce connection via ${connection.source}` +
              ` alias=${connection.alias ?? "(default)"}` +
              ` instance=${connection.instanceUrl} api=${connection.apiVersion}`,
          );
          return connection;
        }),
    };
  }),
);

/** Run `sf <args>` through the process's CLI runner. */
export const runSf = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const directory = yield* OrgDirectory;
    return yield* directory.run(args);
  });

/** Resolve the default org, or `targetOrg` when a resource names one. */
export const connectionFor = (targetOrg: string | undefined) =>
  Effect.gen(function* () {
    const directory = yield* OrgDirectory;
    return yield* directory.resolve(targetOrg);
  });
