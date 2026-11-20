import * as Test from "@alchemy.run/test/Vitest";
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

const trustedSite = (endpointUrl: string, name = "ExampleSite") => ({
  name,
  label: "Example site",
  endpointUrl,
  isActive: false as const,
  context: "All" as const,
  description: "Alchemy spike",
  directives: {
    connectSrc: true,
    fontSrc: false,
    frameSrc: false,
    imgSrc: false,
    mediaSrc: false,
    styleSrc: false,
  },
});

const posts = () => org.requests.filter((request) => request.method === "POST" && request.resource === "CspTrustedSite");
const patches = () => org.requests.filter((request) => request.method === "PATCH" && request.resource === "CspTrustedSite");

test.provider("creates, updates in place, and deletes a trusted site", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.CspTrustedSite("ExampleSite", trustedSite("https://example.com"));
      }),
    );
    expect(created.id).toMatch(/^0CS/);
    expect(created.isActive).toBe(false);
    expect(created.endpointUrl).toBe("https://example.com");
    expect(created.directives.connectSrc).toBe(true);
    expect(posts()).toHaveLength(1);
    const createBody = posts()[0]?.body as { IsActive?: boolean; EndpointUrl?: string; IsApplicableToConnectSrc?: boolean };
    expect(createBody.IsActive).toBe(false);
    expect(createBody.EndpointUrl).toBe("https://example.com");
    expect(createBody.IsApplicableToConnectSrc).toBe(true);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.CspTrustedSite("ExampleSite", trustedSite("https://example.org"));
      }),
    );
    expect(updated.id).toBe(created.id);
    expect(updated.endpointUrl).toBe("https://example.org");
    expect(posts()).toHaveLength(1);
    expect(patches()).toHaveLength(1);

    yield* stack.destroy();
    expect(org.sites()).toHaveLength(0);
  }),
);

test.provider("adopts an existing trusted site with the same developer name", (stack) =>
  Effect.gen(function* () {
    const existingId = org.seedTrustedSite({
      DeveloperName: "ExampleSite",
      EndpointUrl: "https://old.example",
      IsActive: true,
    });
    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.CspTrustedSite("ExampleSite", trustedSite("https://example.com"));
      }),
    );
    expect(adopted.id).toBe(existingId);
    expect(adopted.isActive).toBe(false);
    expect(adopted.endpointUrl).toBe("https://example.com");
    expect(posts()).toHaveLength(0);
    expect(patches()).toHaveLength(1);
    yield* stack.destroy();
  }),
);

test.provider("refuses to call Salesforce when every directive is false", (stack) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.CspTrustedSite("ExampleSite", {
            ...trustedSite("https://example.com"),
            directives: {
              connectSrc: false,
              fontSrc: false,
              frameSrc: false,
              imgSrc: false,
              mediaSrc: false,
              styleSrc: false,
            },
          });
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("directive");
    }
    expect(posts()).toHaveLength(0);
  }),
);

test.provider("treats a missing trusted site as already deleted", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.CspTrustedSite("ExampleSite", trustedSite("https://example.com"));
      }),
    );
    org.removeTrustedSites();
    yield* stack.destroy();
    expect(org.sites()).toHaveLength(0);
  }),
);

test.provider("lists every trusted site across query pages and opts out of nuke", (stack) =>
  Effect.gen(function* () {
    org.setPageSize(1);
    org.seedTrustedSite({ DeveloperName: "One", EndpointUrl: "https://one.example" });
    org.seedTrustedSite({ DeveloperName: "Two", EndpointUrl: "https://two.example" });
    const provider = yield* Salesforce.CspTrustedSite.Provider;
    expect(provider.nuke?.skip).toBe(true);
    const listed = yield* provider.list();
    expect(listed.map((site) => site.name).sort()).toEqual(["One", "Two"]);
    yield* stack.destroy();
  }),
);
