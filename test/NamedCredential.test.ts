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

const named = (calloutUrl = "https://partner.example.my.salesforce.com") => ({
  developerName: "Partner_NC",
  masterLabel: "Partner Named Credential",
  type: "SecuredEndpoint" as const,
  calloutUrl,
  externalCredential: "Partner_EC",
  calloutOptions: {
    allowMergeFieldsInBody: false,
    allowMergeFieldsInHeader: true,
    generateAuthorizationHeader: true,
  },
});

const posts = () =>
  org.requests.filter((request) => request.method === "POST" && request.resource === "named-credential-setup");

test.provider("creates a named credential on named-credential-setup and exposes callout URLs", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.NamedCredential("Banking", named());
      }),
    );
    expect(created.id).toMatch(/^0XA/);
    expect(created.calloutUrl).toBe("https://partner.example.my.salesforce.com");
    expect(created.externalCredential).toBe("Partner_EC");
    expect(created.restBaseCallout).toBe("callout:Partner_NC/services/data/v68.0");
    expect(created.graphqlCallout).toBe("callout:Partner_NC/services/data/v68.0/graphql");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.path).toBe("/services/data/v68.0/named-credentials/named-credential-setup");
    const body = posts()[0]?.body as {
      type?: string;
      calloutUrl?: string;
      externalCredentials?: ReadonlyArray<{ developerName?: string }>;
      calloutOptions?: { generateAuthorizationHeader?: boolean };
    };
    expect(body.type).toBe("SecuredEndpoint");
    expect(body.calloutUrl).toBe("https://partner.example.my.salesforce.com");
    expect(body.externalCredentials).toEqual([{ developerName: "Partner_EC" }]);
    expect(body.calloutOptions?.generateAuthorizationHeader).toBe(true);
    expect(
      org.requests.some((request) => /\/named-credentials\/named-credentials(?:\/|$)/.test(request.path ?? "")),
    ).toBe(false);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.NamedCredential("Banking", named("https://satellite.example.my.salesforce.com"));
      }),
    );
    expect(updated.id).toBe(created.id);
    expect(updated.calloutUrl).toBe("https://satellite.example.my.salesforce.com");
    expect(posts()).toHaveLength(1);
    expect(
      org.requests.some(
        (request) =>
          request.method === "PUT" &&
          request.path === "/services/data/v68.0/named-credentials/named-credential-setup/Partner_NC",
      ),
    ).toBe(true);

    const before = org.requests.length;
    const planned = yield* stack.plan(
      Effect.gen(function* () {
        return yield* Salesforce.NamedCredential("Banking", named("https://satellite.example.my.salesforce.com"));
      }),
    );
    expect(Object.values(planned.resources).every((resource) => resource.action === "noop")).toBe(true);
    expect(org.requests.length).toBe(before);

    yield* stack.destroy();
    expect(org.namedCredentials()).toEqual([]);
  }),
);

test.provider("adopts a named credential and deletes it when the row is already gone", (stack) =>
  Effect.gen(function* () {
    const existing = org.seedNamedCredential({
      developerName: "Partner_NC",
      externalCredential: "Partner_EC",
      calloutUrl: "https://partner.example.my.salesforce.com",
      masterLabel: "Partner Named Credential",
    });
    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.NamedCredential("Banking", named());
      }),
    );
    expect(adopted.id).toBe(existing);
    expect(posts()).toHaveLength(0);

    org.removeNamedCredential("Partner_NC");
    yield* stack.destroy();
    expect(org.namedCredentials()).toEqual([]);
  }),
);

test.provider("lists named credentials from named-credential-setup and opts out of nuke", (stack) =>
  Effect.gen(function* () {
    org.seedNamedCredential({ developerName: "Partner_NC", externalCredential: "Partner_EC" });
    org.seedNamedCredential({ developerName: "Satellite_NC", externalCredential: "Satellite_EC" });
    const provider = yield* Salesforce.NamedCredential.Provider;
    expect(provider.nuke?.skip).toBe(true);
    const listed = yield* provider.list();
    expect(listed.map((credential) => credential.developerName).sort()).toEqual([
      "Partner_NC",
      "Satellite_NC",
    ]);
    expect(
      org.requests.some((request) => request.path === "/services/data/v68.0/named-credentials/named-credential-setup"),
    ).toBe(true);
    yield* stack.destroy();
  }),
);
