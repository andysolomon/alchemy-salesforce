import * as Test from "@alchemy.run/test/Vitest";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Salesforce from "../src/salesforce/index.js";
import { clearCredentialSecrets } from "../src/salesforce/credentialSecrets.js";
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
  clearCredentialSecrets();
});

const TOKEN = "https://partner.example.my.salesforce.com/services/oauth2/token";

const external = (masterLabel = "Partner") => ({
  developerName: "Partner_EC",
  masterLabel,
  authenticationProtocol: "OAuth" as const,
  authenticationProtocolVariant: "ClientCredentialsClientSecretBasic" as const,
  parameters: [
    {
      parameterName: "AuthProviderUrl",
      parameterType: "AuthProviderUrl",
      parameterValue: TOKEN,
    },
  ],
  principals: [
    { principalName: "PartnerPrincipal", principalType: "NamedPrincipal" as const, sequenceNumber: 1 },
  ],
});

const posts = () => org.requests.filter((request) => request.method === "POST" && request.resource === "external-credentials");
const puts = () => org.requests.filter((request) => request.method === "PUT" && request.resource === "external-credentials");

test.provider("creates an OAuth external credential with PUT updates and a noop second plan", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredential("Banking", external());
      }),
    );
    expect(created.id).toMatch(/^0pt/);
    expect(created.authenticationProtocol).toBe("OAuth");
    expect(created.authenticationProtocolVariant).toBe("ClientCredentialsClientSecretBasic");
    expect(created.authenticationStatus).toBe("NotConfigured");
    expect(created.principals[0]?.id).toMatch(/^0pu/);
    expect(created.principals[0]?.principalName).toBe("PartnerPrincipal");
    expect(posts()).toHaveLength(1);
    const body = posts()[0]?.body as {
      authenticationProtocol?: string;
      authenticationProtocolVariant?: string;
      parameters?: ReadonlyArray<{ parameterName?: string; parameterValue?: string }>;
    };
    expect(body.authenticationProtocol).toBe("OAuth");
    expect(body.authenticationProtocolVariant).toBe("ClientCredentialsClientSecretBasic");
    expect(body.parameters?.[0]?.parameterValue).toBe(TOKEN);
    expect(posts()[0]?.path).toBe("/services/data/v68.0/named-credentials/external-credentials");

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredential("Banking", external("Partner Next"));
      }),
    );
    expect(updated.id).toBe(created.id);
    expect(updated.masterLabel).toBe("Partner Next");
    expect(updated.principals[0]?.id).toBe(created.principals[0]?.id);
    expect(posts()).toHaveLength(1);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.path).toBe("/services/data/v68.0/named-credentials/external-credentials/Partner_EC");
    expect(org.requests.some((request) => request.method === "PATCH" && request.resource === "external-credentials")).toBe(
      false,
    );

    const before = org.requests.length;
    const planned = yield* stack.plan(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredential("Banking", external("Partner Next"));
      }),
    );
    expect(Object.values(planned.resources).every((resource) => resource.action === "noop")).toBe(true);
    expect(org.requests.length).toBe(before);

    yield* stack.destroy();
    expect(org.externalCredentials()).toEqual([]);
  }),
);

test.provider("adopts an external credential with the same developer name", (stack) =>
  Effect.gen(function* () {
    const seeded = org.seedExternalCredential({
      developerName: "Partner_EC",
      masterLabel: "Partner",
      calloutUrl: "https://partner.example.my.salesforce.com",
    });
    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredential("Banking", external());
      }),
    );
    expect(adopted.id).toBe(seeded.id);
    expect(adopted.principals[0]?.id).toBe(seeded.principalId);
    expect(posts()).toHaveLength(0);
    expect(puts()).toHaveLength(0);
    yield* stack.destroy();
  }),
);

test.provider("treats a missing external credential as already deleted", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredential("Banking", external());
      }),
    );
    org.removeExternalCredential("Partner_EC");
    yield* stack.destroy();
    expect(org.externalCredentials()).toEqual([]);
  }),
);

test.provider("refuses login.salesforce.com and a developer name Salesforce would reject", (stack) =>
  Effect.gen(function* () {
    const login = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.ExternalCredential("Banking", {
            ...external(),
            parameters: [
              {
                parameterName: "AuthProviderUrl",
                parameterType: "AuthProviderUrl",
                parameterValue: "https://login.salesforce.com/services/oauth2/token",
              },
            ],
          });
        }),
      ),
    );
    expect(Exit.isFailure(login)).toBe(true);
    if (Exit.isFailure(login)) {
      expect(String(login.cause)).toContain("My Domain");
    }

    const name = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.ExternalCredential("Banking", {
            ...external(),
            developerName: "Bad__Name",
          });
        }),
      ),
    );
    expect(Exit.isFailure(name)).toBe(true);
    if (Exit.isFailure(name)) {
      expect(String(name.cause)).toContain("developer name");
    }

    const protocol = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.ExternalCredential("Banking", {
            ...external(),
            authenticationProtocol: "Oauth" as "OAuth",
          });
        }),
      ),
    );
    expect(Exit.isFailure(protocol)).toBe(true);
    if (Exit.isFailure(protocol)) {
      expect(String(protocol.cause)).toContain("OAuth");
    }
    expect(posts()).toHaveLength(0);
  }),
);

test.provider("replaces the credential when the developer name changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredential("Banking", external());
      }),
    );
    const planned = yield* stack.plan(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredential("Banking", {
          ...external(),
          developerName: "Satellite_EC",
          parameters: [
            {
              parameterName: "AuthProviderUrl",
              parameterType: "AuthProviderUrl",
              parameterValue: "https://satellite.example.my.salesforce.com/services/oauth2/token",
            },
          ],
        });
      }),
    );
    const replacement = Object.values(planned.resources).find((resource) => resource.action === "replace");
    expect(replacement?.action).toBe("replace");
    if (replacement?.action === "replace") {
      expect(replacement.deleteFirst).toBe(true);
    }
  }),
);

test.provider("lists external credentials and opts out of nuke", (stack) =>
  Effect.gen(function* () {
    org.seedExternalCredential({ developerName: "Partner_EC" });
    org.seedExternalCredential({ developerName: "Satellite_EC" });
    const provider = yield* Salesforce.ExternalCredential.Provider;
    expect(provider.nuke?.skip).toBe(true);
    const listed = yield* provider.list();
    expect(listed.map((credential) => credential.developerName).sort()).toEqual([
      "Partner_EC",
      "Satellite_EC",
    ]);
    yield* stack.destroy();
  }),
);
