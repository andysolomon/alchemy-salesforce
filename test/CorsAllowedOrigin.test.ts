import * as Test from "@alchemy.run/test/Vitest";
import { Drift } from "alchemy";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Salesforce from "../src/salesforce/index.js";
import { bindMockOrg } from "./harness.js";
import type { MockOrg } from "./mock-org.js";

const { test } = Test.make({ providers: Salesforce.providers() });

let org: MockOrg;

beforeAll(async () => {
  org = await bindMockOrg();
});

afterAll(async () => {
  await org.close();
});

beforeEach(() => {
  org.reset();
});

const writes = (method: string) =>
  org.requests.filter((request) => request.method === method && request.resource === "CorsWhitelistEntry");

const origin = (urlPattern: string) =>
  Effect.gen(function* () {
    return yield* Salesforce.CorsAllowedOrigin("Frontend", { name: "Frontend", urlPattern });
  });

test.provider("creates, updates in place, and deletes an allowed origin", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(origin("https://app.example.com/"));
    expect(created.id).toMatch(/^0vy/);
    expect(created.urlPattern).toBe("https://app.example.com");
    expect(created.label).toBe("Frontend");
    expect(writes("POST")).toHaveLength(1);
    expect(writes("POST")[0]?.body).toEqual({
      DeveloperName: "Frontend",
      MasterLabel: "Frontend",
      UrlPattern: "https://app.example.com",
    });

    const updated = yield* stack.deploy(origin("https://*.example.com"));
    expect(updated.id).toBe(created.id);
    expect(updated.urlPattern).toBe("https://*.example.com");
    expect(writes("PATCH")).toHaveLength(1);

    yield* stack.destroy();
    expect(org.corsOrigins()).toHaveLength(0);
  }),
);

test.provider("adopts an existing origin with the same developer name", (stack) =>
  Effect.gen(function* () {
    const existing = org.seedCorsOrigin({ DeveloperName: "Frontend", UrlPattern: "https://old.example.com" });
    const adopted = yield* stack.deploy(origin("https://app.example.com"));
    expect(adopted.id).toBe(existing);
    expect(adopted.urlPattern).toBe("https://app.example.com");
    expect(writes("POST")).toHaveLength(0);
    yield* stack.destroy();
  }),
);

test.provider("rejects a URL with a path, or plain HTTP off localhost, before calling Salesforce", (stack) =>
  Effect.gen(function* () {
    for (const bad of ["https://app.example.com/api", "http://app.example.com", "app.example.com"]) {
      const exit = yield* Effect.exit(stack.deploy(origin(bad)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("must be an origin");
      }
    }
    const local = yield* stack.deploy(origin("http://localhost:3000"));
    expect(local.urlPattern).toBe("http://localhost:3000");
    expect(writes("POST")).toHaveLength(1);
    yield* stack.destroy();
  }),
);

test.provider("drift detection reports an origin edited in Setup, and repair puts it back", (stack) =>
  Effect.gen(function* () {
    const deployed = yield* stack.deploy(origin("https://app.example.com"));
    const target = { name: stack.name, stage: stack.stage };

    const clean = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
    expect(Object.values(clean.resources).map((resource) => resource.action)).toEqual(["unchanged"]);

    org.editCorsOrigin(deployed.id, { UrlPattern: "https://evil.example.com" });
    const dirty = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
    const [drifted] = Object.values(dirty.resources);
    expect(drifted?.action).toBe("drifted");
    expect(drifted?.attr?.urlPattern).toBe("https://evil.example.com");

    yield* Drift.repair(target).pipe(Effect.provide(stack.state));
    expect(org.corsOrigins().map((row) => row.UrlPattern)).toEqual(["https://app.example.com"]);

    org.reset();
    const missing = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
    expect(Object.values(missing.resources).map((resource) => resource.action)).toEqual(["missing"]);
    yield* stack.destroy();
  }),
);

test.provider("treats an origin deleted out of band as already gone", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(origin("https://app.example.com"));
    org.reset();
    yield* stack.destroy();
    expect(org.corsOrigins()).toHaveLength(0);
  }),
);
