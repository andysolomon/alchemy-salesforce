import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  isRedactedAccessToken,
  redactCliText,
  resolveSalesforceConnection,
  targetOrgAlias,
  type CommandResult,
  type SalesforceEnv,
} from "../src/salesforce/connection.js";

const runWith = (handler: (args: ReadonlyArray<string>) => CommandResult) => {
  const calls: string[][] = [];
  const run = (args: ReadonlyArray<string>) => {
    calls.push([...args]);
    return Effect.succeed(handler(args));
  };
  return { calls, run };
};

const env = (values: SalesforceEnv): SalesforceEnv => values;

describe("Salesforce connection", () => {
  it("prefers an explicit alias over the Alchemy stage", () => {
    expect(targetOrgAlias(env({ SF_TARGET_ORG: "hub" }), "sandbox")).toBe("hub");
    expect(targetOrgAlias(env({ SALESFORCE_TARGET_ORG: "sandbox" }), "hub")).toBe("sandbox");
    expect(targetOrgAlias(env({}), "hub")).toBe("hub");
    expect(targetOrgAlias(env({ ALCHEMY_STAGE: "prod" }), undefined)).toBe("prod");
    expect(targetOrgAlias(env({}), undefined)).toBeUndefined();
  });

  it("treats a redacted CLI token as missing", () => {
    expect(isRedactedAccessToken(undefined)).toBe(true);
    expect(isRedactedAccessToken("")).toBe(true);
    expect(isRedactedAccessToken("[REDACTED] Use 'sf org auth show-access-token'")).toBe(true);
    expect(isRedactedAccessToken("00DrealTokenValue")).toBe(false);
  });

  it("scrubs access tokens out of CLI errors", () => {
    const text = redactCliText(
      '{"accessToken":"00Dsupersecretvalue!!"} Bearer 00Dsupersecretvalue!!',
      ["00Dsupersecretvalue!!"],
    );
    expect(text).not.toContain("00Dsupersecretvalue!!");
    expect(text).toContain("[redacted]");
  });

  it("uses env credentials and does not spawn sf", async () => {
    const { calls, run } = runWith(() => {
      throw new Error("sf should not run");
    });
    const connection = await Effect.runPromise(
      resolveSalesforceConnection({
        env: env({
          SF_INSTANCE_URL: "https://example.my.salesforce.com/",
          SF_ACCESS_TOKEN: "env-token-value",
          SF_API_VERSION: "67.0",
        }),
        stage: "hub",
        run,
      }),
    );
    expect(calls).toEqual([]);
    expect(connection.source).toBe("env");
    expect(connection.instanceUrl).toBe("https://example.my.salesforce.com");
    expect(connection.apiVersion).toBe("67.0");
    expect(connection.alias).toBe("hub");
    expect(Redacted.value(connection.accessToken)).toBe("env-token-value");
  });

  it("rejects a half-specified env credential pair", async () => {
    const { run } = runWith(() => ({ code: 0, stdout: "", stderr: "" }));
    const error = await Effect.runPromise(
      resolveSalesforceConnection({
        env: env({ SF_INSTANCE_URL: "https://example.my.salesforce.com" }),
        stage: "hub",
        run,
      }).pipe(Effect.flip),
    );
    expect(error._tag).toBe("SalesforceAuthError");
    expect(error.message).toContain("both SF_INSTANCE_URL and SF_ACCESS_TOKEN");
  });

  it("reads a non-redacted display token without a second command", async () => {
    const { calls, run } = runWith(() => ({
      code: 0,
      stdout: JSON.stringify({
        status: 0,
        result: {
          accessToken: "00Dfromdisplaytoken",
          instanceUrl: "https://hub.example.my.salesforce.com",
          apiVersion: "68.0",
          username: "dev@example.com",
        },
      }),
      stderr: "",
    }));
    const connection = await Effect.runPromise(
      resolveSalesforceConnection({
        env: env({}),
        stage: "hub",
        run,
      }),
    );
    expect(calls).toEqual([["org", "display", "--target-org", "hub", "--json"]]);
    expect(connection.source).toBe("cli");
    expect(connection.alias).toBe("hub");
    expect(connection.username).toBe("dev@example.com");
    expect(connection.apiVersion).toBe("68.0");
    expect(Redacted.value(connection.accessToken)).toBe("00Dfromdisplaytoken");
  });

  it("asks show-access-token when org display redacts the token", async () => {
    const { calls, run } = runWith((args) => {
      if (args[1] === "display") {
        return {
          code: 0,
          stdout: JSON.stringify({
            status: 0,
            result: {
              accessToken: "[REDACTED] Use 'sf org auth show-access-token' to view",
              instanceUrl: "https://hub.example.my.salesforce.com/",
              apiVersion: "66.0",
              username: "dev@example.com",
            },
          }),
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ status: 0, result: { accessToken: "00Dshownaccesstoken" } }),
        stderr: "",
      };
    });
    const connection = await Effect.runPromise(
      resolveSalesforceConnection({
        env: env({ SF_TARGET_ORG: "hub" }),
        stage: "live_someone",
        run,
      }),
    );
    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      ["org", "display", "--target-org"],
      ["org", "auth", "show-access-token"],
    ]);
    expect(calls[1]).toContain("--no-prompt");
    expect(calls[0]).toContain("hub");
    expect(connection.instanceUrl).toBe("https://hub.example.my.salesforce.com");
    expect(connection.apiVersion).toBe("66.0");
    expect(Redacted.value(connection.accessToken)).toBe("00Dshownaccesstoken");
  });

  it("lets SF_API_VERSION override the org's reported version", async () => {
    const { run } = runWith(() => ({
      code: 0,
      stdout: JSON.stringify({
        result: {
          accessToken: "00Dfromdisplaytoken",
          instanceUrl: "https://hub.example.my.salesforce.com",
          apiVersion: "68.0",
        },
      }),
      stderr: "",
    }));
    const connection = await Effect.runPromise(
      resolveSalesforceConnection({
        env: env({ SF_API_VERSION: "62.0" }),
        stage: "hub",
        run,
      }),
    );
    expect(connection.apiVersion).toBe("62.0");
  });

  it("fails closed when no alias and no static credentials are available", async () => {
    const { calls, run } = runWith(() => ({ code: 0, stdout: "", stderr: "" }));
    const error = await Effect.runPromise(
      resolveSalesforceConnection({ env: env({}), stage: undefined, run }).pipe(Effect.flip),
    );
    expect(calls).toEqual([]);
    expect(error._tag).toBe("SalesforceAuthError");
    expect(error.message).toContain("--stage");
  });

  it("keeps an explicit alias off the process-wide access token", async () => {
    const { calls, run } = runWith((args) => ({
      code: 0,
      stdout: JSON.stringify({
        result: {
          accessToken: args.includes("banking") ? "token-banking-value" : "token-hub-value",
          instanceUrl: args.includes("banking") ? "https://banking.example" : "https://hub.example",
          apiVersion: "68.0",
          id: args.includes("banking") ? "00DBANK000000001" : "00DHUB0000000001",
          username: "user@example.com",
        },
      }),
      stderr: "",
    }));
    const shared = env({
      SF_INSTANCE_URL: "https://wrong.example",
      SF_ACCESS_TOKEN: "global-token-should-not-apply",
    });
    const hubConn = await Effect.runPromise(
      resolveSalesforceConnection({ env: shared, stage: "mesh", alias: "hub", run }),
    );
    const banking = await Effect.runPromise(
      resolveSalesforceConnection({ env: shared, stage: "mesh", alias: "banking", run }),
    );
    expect(Redacted.value(hubConn.accessToken)).toBe("token-hub-value");
    expect(Redacted.value(banking.accessToken)).toBe("token-banking-value");
    expect(hubConn.instanceUrl).toBe("https://hub.example");
    expect(banking.instanceUrl).toBe("https://banking.example");
    expect(hubConn.orgId).toBe("00DHUB0000000001");
    expect(banking.orgId).toBe("00DBANK000000001");
    expect(calls.filter((args) => args[1] === "display").map((args) => args[3])).toEqual(["hub", "banking"]);
  });

  it("resolves SF_ORG_CREDENTIALS per alias and does not spawn sf", async () => {
    const { calls, run } = runWith(() => {
      throw new Error("sf should not run");
    });
    const banking = await Effect.runPromise(
      resolveSalesforceConnection({
        env: env({
          SF_INSTANCE_URL: "https://hub.example",
          SF_ACCESS_TOKEN: "hub-token-value",
          SF_ORG_CREDENTIALS: JSON.stringify({
            banking: {
              instanceUrl: "https://banking.example/",
              accessToken: "banking-token-value",
              orgId: "00DBANK000000001",
              username: "bank@example.com",
              apiVersion: "68.0",
            },
          }),
        }),
        stage: "mesh",
        alias: "banking",
        run,
      }),
    );
    expect(calls).toEqual([]);
    expect(banking.source).toBe("org-credentials");
    expect(banking.instanceUrl).toBe("https://banking.example");
    expect(banking.username).toBe("bank@example.com");
    expect(banking.orgId).toBe("00DBANK000000001");
    expect(Redacted.value(banking.accessToken)).toBe("banking-token-value");
  });

  it("redacts a token that the CLI wrote into a failed display", async () => {
    const secret = "00Dleakedaccesstokenvalue";
    const { run } = runWith(() => ({
      code: 1,
      stdout: JSON.stringify({ result: { accessToken: secret } }),
      stderr: `auth failed ${secret}`,
    }));
    const error = await Effect.runPromise(
      resolveSalesforceConnection({ env: env({}), stage: "hub", run }).pipe(Effect.flip),
    );
    expect(error._tag).toBe("SalesforceCliError");
    expect(error.message).not.toContain(secret);
  });
});
