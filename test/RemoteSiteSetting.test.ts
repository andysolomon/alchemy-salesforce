import * as Test from "@alchemy.run/test/Vitest";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import * as Effect from "effect/Effect";
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

const posts = () => org.requests.filter((request) => request.method === "POST" && request.resource === "RemoteProxy");

test.provider("creates, updates, and deletes a remote site", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.RemoteSiteSetting("HubSite", {
          siteName: "HubSite",
          endpointUrl: "https://hub.example",
          isActive: true,
          disableProtocolSecurity: false,
          description: "mesh",
        });
      }),
    );
    expect(created.id).toMatch(/^0rp/);
    expect(created.endpointUrl).toBe("https://hub.example");
    expect(created.disableProtocolSecurity).toBe(false);
    expect(posts()).toHaveLength(1);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.RemoteSiteSetting("HubSite", {
          siteName: "HubSite",
          endpointUrl: "https://hub-next.example",
          isActive: true,
          disableProtocolSecurity: false,
          description: "mesh",
        });
      }),
    );
    expect(updated.id).toBe(created.id);
    expect(updated.endpointUrl).toBe("https://hub-next.example");
    expect(posts()).toHaveLength(1);
    expect(org.requests.some((request) => request.method === "PATCH" && request.resource === "RemoteProxy")).toBe(
      true,
    );

    yield* stack.destroy();
    expect(org.remoteSites()).toEqual([]);
  }),
);

test.provider("adopts a remote site with the same SiteName", (stack) =>
  Effect.gen(function* () {
    const existing = org.seedRemoteSite({
      SiteName: "HubSite",
      EndpointUrl: "https://old.example",
      IsActive: false,
    });
    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.RemoteSiteSetting("HubSite", {
          siteName: "HubSite",
          endpointUrl: "https://hub.example",
          isActive: true,
        });
      }),
    );
    expect(adopted.id).toBe(existing);
    expect(adopted.isActive).toBe(true);
    expect(posts()).toHaveLength(0);
    yield* stack.destroy();
  }),
);

test.provider("deactivates a remote site when tooling refuses DELETE", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.RemoteSiteSetting("HubSite", {
          siteName: "HubSite",
          endpointUrl: "https://hub.example",
          isActive: true,
        });
      }),
    );
    org.setRejectRemoteDelete(true);
    yield* stack.destroy();
    expect(org.remoteSites()).toHaveLength(1);
    expect(org.remoteSites()[0]?.IsActive).toBe(false);
    expect(org.remoteSites()[0]?.SiteName).toBe("HubSite");
  }),
);
