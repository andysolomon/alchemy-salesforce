import * as Test from "@alchemy.run/test/Vitest";
import { Drift } from "alchemy";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { clearConnectionCache } from "../src/salesforce/connection.js";
import * as Salesforce from "../src/salesforce/index.js";
import { installFakeSf, type FakeSf } from "./fake-sf.js";
import { bindMockOrg } from "./harness.js";
import { TEST_TOKEN, type MockOrg } from "./mock-org.js";

const { test } = Test.make({ providers: Salesforce.providers() });

let org: MockOrg;
let sf: FakeSf;

beforeAll(async () => {
  org = await bindMockOrg();
  sf = installFakeSf({ instanceUrl: org.url, accessToken: TEST_TOKEN });
});

afterAll(async () => {
  sf.uninstall();
  await org.close();
});

beforeEach(() => {
  org.reset();
  sf.reset();
  sf.seed("hub", { id: "00DHUB000000001" });
  clearConnectionCache();
});

const commands = () => sf.calls().map((args) => args.slice(0, 3).join(" "));
const creates = () => sf.calls().filter((args) => args.slice(0, 3).join(" ") === "org create scratch");
const deletes = () => sf.calls().filter((args) => args.slice(0, 3).join(" ") === "org delete scratch");

const scratch = (props: Partial<Salesforce.ScratchOrgProps> = {}) =>
  Effect.gen(function* () {
    return yield* Salesforce.ScratchOrg("Scratch", { alias: "pr-42", devHub: "hub", durationDays: 3, ...props });
  });

test.provider("creates a scratch org, configures it, and deletes both on destroy", (stack) =>
  Effect.gen(function* () {
    const out = yield* stack.deploy(
      Effect.gen(function* () {
        const created = yield* Salesforce.ScratchOrg("Scratch", { alias: "pr-42", devHub: "hub", durationDays: 3 });
        const site = yield* Salesforce.CspTrustedSite("Site", {
          targetOrg: created.alias,
          name: "PreviewApp",
          endpointUrl: "https://preview.example.com",
          isActive: true,
          directives: { connectSrc: true },
        });
        return { created, site };
      }),
    );
    expect(out.created.alias).toBe("pr-42");
    expect(out.created.orgId).toBe("00DSCRATCH00001");
    expect(out.created.devHub).toBe("hub");
    expect(out.created.instanceUrl).toBe(org.url);
    expect(out.created.graphqlUrl).toBe(`${org.url}/services/data/v68.0/graphql`);
    expect(out.created.expirationDate).toBe("2026-12-01");
    expect(out.created.edition).toBe("Developer");
    expect(creates()).toEqual([
      [
        "org", "create", "scratch",
        "--target-dev-hub", "hub",
        "--alias", "pr-42",
        "--duration-days", "3",
        "--wait", "10",
        "--edition", "developer",
        "--json",
      ],
    ]);
    expect(org.sites().map((site) => site.DeveloperName)).toEqual(["PreviewApp"]);

    yield* stack.deploy(scratch());
    expect(creates()).toHaveLength(1);
    expect(org.sites()).toHaveLength(0);

    yield* stack.destroy();
    expect(deletes()).toEqual([["org", "delete", "scratch", "--target-org", "pr-42", "--no-prompt", "--json"]]);
    expect(sf.orgs()["pr-42"]).toBeUndefined();
  }),
);

test.provider("passes a definition file, edition override, and --no-namespace through to sf", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(
      scratch({ definitionFile: "config/project-scratch-def.json", edition: "enterprise", noNamespace: true }),
    );
    const args = creates()[0] ?? [];
    expect(args).toContain("--definition-file");
    expect(args[args.indexOf("--definition-file") + 1]).toBe("config/project-scratch-def.json");
    expect(args[args.indexOf("--edition") + 1]).toBe("enterprise");
    expect(args).toContain("--no-namespace");
    yield* stack.destroy();
  }),
);

test.provider("adopts a live scratch org already authorized under the alias", (stack) =>
  Effect.gen(function* () {
    sf.seed("pr-42", { id: "00DEXISTING0001", devHubId: "00DHUB000000001", expirationDate: "2026-11-30", status: "Active" });
    const adopted = yield* stack.deploy(scratch());
    expect(adopted.orgId).toBe("00DEXISTING0001");
    expect(creates()).toHaveLength(0);
    yield* stack.destroy();
  }),
);

test.provider("refuses to adopt an alias that points at a sandbox or production org", (stack) =>
  Effect.gen(function* () {
    sf.seed("prod", { id: "00DPROD00000001" });
    const exit = yield* Effect.exit(stack.deploy(scratch({ alias: "prod" })));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("not a scratch org");
    }
    expect(commands()).not.toContain("org create scratch");
    expect(commands()).not.toContain("org delete scratch");
    expect(sf.orgs().prod).toBeDefined();
  }),
);

test.provider("recreates a scratch org that expired, or whose auth died with it", (stack) =>
  Effect.gen(function* () {
    sf.seed("pr-42", { id: "00DOLD000000001", devHubId: "00DHUB000000001", status: "Expired" });
    const fresh = yield* stack.deploy(scratch());
    expect(fresh.orgId).toBe("00DSCRATCH00001");
    expect(commands()).toContain("org logout --target-org");
    yield* stack.destroy();

    sf.reset();
    sf.seed("hub", { id: "00DHUB000000001" });
    sf.seed("pr-42", { id: "00DOLD000000002", devHubId: "00DHUB000000001", deadAuth: true });
    clearConnectionCache();
    const again = yield* stack.deploy(scratch());
    expect(again.orgId).toBe("00DSCRATCH00001");
    yield* stack.destroy();
  }),
);

test.provider("does not delete an org when the alias was reassigned to a different org", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(scratch());
    sf.update("pr-42", { id: "00DSOMEONEELSE1" });
    yield* stack.destroy();
    expect(deletes()).toHaveLength(0);
    expect(sf.orgs()["pr-42"]?.id).toBe("00DSOMEONEELSE1");
  }),
);

test.provider("replaces the org when a creation-time prop changes, but not for waitMinutes", (stack) =>
  Effect.gen(function* () {
    const first = yield* stack.deploy(scratch());
    const waited = yield* stack.deploy(scratch({ waitMinutes: 30 }));
    expect(waited.orgId).toBe(first.orgId);
    expect(creates()).toHaveLength(1);

    const longer = yield* stack.deploy(scratch({ durationDays: 14, waitMinutes: 30 }));
    expect(longer.orgId).not.toBe(first.orgId);
    expect(deletes()).toHaveLength(1);
    expect(commands().lastIndexOf("org delete scratch")).toBeLessThan(commands().lastIndexOf("org create scratch"));
    yield* stack.destroy();
  }),
);

test.provider("surfaces a Dev Hub failure without leaking the token", (stack) =>
  Effect.gen(function* () {
    sf.setFailCreate(true);
    const limit = yield* Effect.exit(stack.deploy(scratch()));
    expect(Exit.isFailure(limit)).toBe(true);
    if (Exit.isFailure(limit)) {
      expect(String(limit.cause)).toContain("LIMIT_EXCEEDED");
      expect(String(limit.cause)).not.toContain(TEST_TOKEN);
    }
    yield* stack.destroy();
  }),
);

test.provider("validates props before creating anything", (stack) =>
  Effect.gen(function* () {
    for (const props of [{ durationDays: 31 }, { durationDays: 1.5 }, { alias: "hub" }, { alias: "has space" }]) {
      const exit = yield* Effect.exit(stack.deploy(scratch(props)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("SalesforceValidationError");
      }
    }
    expect(creates()).toHaveLength(0);
    yield* stack.destroy();
  }),
);

test.provider("drift detection reports a scratch org deleted out of band as missing", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(scratch());
    const target = { name: stack.name, stage: stack.stage };
    const clean = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
    expect(Object.values(clean.resources).map((resource) => resource.action)).toEqual(["unchanged"]);

    sf.update("pr-42", { status: "Deleted" });
    const gone = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
    expect(Object.values(gone.resources).map((resource) => resource.action)).toEqual(["missing"]);
    yield* stack.destroy();
  }),
);

// A later CI run lands on a new runner: the Dev Hub is authorized, the scratch org is not.
const onFreshRunner = (alias: string, orgId: string, username: string, status = "Active") => {
  sf.forgetLocal(alias);
  clearConnectionCache();
  org.seedActiveScratchOrg({ orgId, username, status });
};

const withJwtEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.SF_JWT_CLIENT_ID = "3MVG9fakeconsumerkey";
      process.env.SF_JWT_KEY_FILE = "/tmp/server.key";
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        delete process.env.SF_JWT_CLIENT_ID;
        delete process.env.SF_JWT_KEY_FILE;
      }),
  );

test.provider("on a fresh runner, destroy deletes the org through the Dev Hub", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(scratch());
    onFreshRunner("pr-42", created.orgId, created.username);
    yield* stack.destroy();
    expect(deletes()).toHaveLength(0);
    expect(org.activeScratchOrgs()).toHaveLength(0);
    expect(
      org.requests.some((request) => request.method === "DELETE" && request.resource === "ActiveScratchOrg"),
    ).toBe(true);
  }),
);

test.provider("on a fresh runner, redeploy refuses to create a duplicate without JWT settings", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(scratch());
    onFreshRunner("pr-42", created.orgId, created.username);
    const exit = yield* Effect.exit(stack.deploy(scratch({ waitMinutes: 20 })));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("SF_JWT_CLIENT_ID");
    }
    expect(creates()).toHaveLength(1);
  }),
);

test.provider("on a fresh runner, redeploy re-authorizes with JWT and keeps the same org", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(scratch());
    onFreshRunner("pr-42", created.orgId, created.username);
    const resumed = yield* withJwtEnv(
      stack.deploy(
        Effect.gen(function* () {
          const again = yield* Salesforce.ScratchOrg("Scratch", {
            alias: "pr-42",
            devHub: "hub",
            durationDays: 3,
            waitMinutes: 20,
          });
          yield* Salesforce.CorsAllowedOrigin("Local", {
            targetOrg: again.alias,
            name: "Local_Dev",
            urlPattern: "http://localhost:5173",
          });
          return again;
        }),
      ),
    );
    expect(resumed.orgId).toBe(created.orgId);
    expect(creates()).toHaveLength(1);
    const login = sf.calls().find((args) => args.slice(0, 3).join(" ") === "org login jwt") ?? [];
    expect(login[login.indexOf("--username") + 1]).toBe(created.username);
    expect(login[login.indexOf("--instance-url") + 1]).toBe("https://test.salesforce.com");
    expect(org.corsOrigins()).toHaveLength(1);
    yield* stack.destroy();
  }),
);

test.provider("on a fresh runner, an org the Dev Hub no longer lists is created again", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(scratch());
    sf.forgetLocal("pr-42");
    clearConnectionCache();
    const fresh = yield* stack.deploy(scratch({ waitMinutes: 20 }));
    expect(fresh.orgId).not.toBe(created.orgId);
    expect(creates()).toHaveLength(2);
    yield* stack.destroy();
  }),
);
