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
  org.seedPermissionSet("Example_Access");
  org.seedPermissionSet("Platform_Core_Consumer");
});

const TOKEN = "https://partner.example.my.salesforce.com/services/oauth2/token";

const external = () => ({
  developerName: "Partner_EC",
  masterLabel: "Partner",
  authenticationProtocol: "OAuth" as const,
  authenticationProtocolVariant: "ClientCredentialsClientSecretBasic" as const,
  parameters: [
    { parameterName: "AuthProviderUrl", parameterType: "AuthProviderUrl", parameterValue: TOKEN },
  ],
  principals: [
    { principalName: "PartnerPrincipal", principalType: "NamedPrincipal" as const, sequenceNumber: 1 },
  ],
});

const posts = () =>
  org.requests.filter((request) => request.method === "POST" && request.resource === "SetupEntityAccess");

test.provider("grants a permission set access to an external credential principal", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const credential = yield* Salesforce.ExternalCredential("Banking", external());
        const access = yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
          permissionSetName: "Example_Access",
          externalCredential: credential.developerName,
          principalName: "PartnerPrincipal",
        });
        return { credential, access };
      }),
    );
    expect(created.access.id).toMatch(/^0J0/);
    expect(created.access.setupEntityId).toBe(created.credential.principals[0]?.id);
    expect(created.access.permissionSetName).toBe("Example_Access");
    expect(created.access.namespace).toBeNull();
    expect(posts()).toHaveLength(1);
    const body = posts()[0]?.body as { ParentId?: string; SetupEntityId?: string };
    expect(body.SetupEntityId).toBe(created.credential.principals[0]?.id);
    expect(body.ParentId).toMatch(/^0PS/);

    const again = yield* stack.deploy(
      Effect.gen(function* () {
        const credential = yield* Salesforce.ExternalCredential("Banking", external());
        return yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
          permissionSetName: "Example_Access",
          externalCredential: credential.developerName,
          principalName: "PartnerPrincipal",
        });
      }),
    );
    expect(again.id).toBe(created.access.id);
    expect(posts()).toHaveLength(1);

    const before = org.requests.length;
    const planned = yield* stack.plan(
      Effect.gen(function* () {
        const credential = yield* Salesforce.ExternalCredential("Banking", external());
        return yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
          permissionSetName: "Example_Access",
          externalCredential: credential.developerName,
          principalName: "PartnerPrincipal",
        });
      }),
    );
    expect(Object.values(planned.resources).every((resource) => resource.action === "noop")).toBe(true);
    expect(org.requests.length).toBe(before);

    yield* stack.destroy();
    expect(org.setupEntityAccess()).toEqual([]);
  }),
);

test.provider("adopts an existing SetupEntityAccess row and replaces it when the permission set changes", (stack) =>
  Effect.gen(function* () {
    const seeded = org.seedExternalCredential({
      developerName: "Partner_EC",
      masterLabel: "Partner",
      calloutUrl: "https://partner.example.my.salesforce.com",
    });
    const permissionSetId = org.permissionSetId("Example_Access");
    if (permissionSetId === undefined) {
      throw new Error("Example_Access was not seeded");
    }
    const existing = org.seedSetupEntityAccess(permissionSetId, seeded.principalId);
    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
          permissionSetName: "Example_Access",
          externalCredential: "Partner_EC",
          principalName: "PartnerPrincipal",
        });
      }),
    );
    expect(adopted.id).toBe(existing);
    expect(posts()).toHaveLength(0);

    const planned = yield* stack.plan(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
          permissionSetName: "Platform_Core_Consumer",
          externalCredential: "Partner_EC",
          principalName: "PartnerPrincipal",
        });
      }),
    );
    const replacement = Object.values(planned.resources).find((resource) => resource.action === "replace");
    expect(replacement?.action).toBe("replace");
    if (replacement?.action === "replace") {
      expect(replacement.deleteFirst).toBe(true);
    }

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
          permissionSetName: "Platform_Core_Consumer",
          externalCredential: "Partner_EC",
          principalName: "PartnerPrincipal",
        });
      }),
    );
    expect(replaced.id).not.toBe(existing);
    expect(replaced.permissionSetName).toBe("Platform_Core_Consumer");
    expect(org.setupEntityAccess()).toHaveLength(1);
    expect(org.setupEntityAccess()[0]?.SetupEntityId).toBe(seeded.principalId);

    org.removeSetupEntityAccess();
    yield* stack.destroy();
    expect(org.setupEntityAccess()).toEqual([]);
  }),
);

test.provider("does not grant access when the permission set is missing", (stack) =>
  Effect.gen(function* () {
    org.seedExternalCredential({ developerName: "Partner_EC", principalName: "PartnerPrincipal" });
    const exit = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
            permissionSetName: "DoesNotExist",
            externalCredential: "Partner_EC",
            principalName: "PartnerPrincipal",
          });
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("DoesNotExist");
    }
    expect(posts()).toHaveLength(0);
  }),
);

test.provider("opts out of nuke because SetupEntityAccess is shared with every grant", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Salesforce.ExternalCredentialPrincipalAccess.Provider;
    expect(provider.nuke?.skip).toBe(true);
    expect(yield* provider.list()).toEqual([]);
    yield* stack.destroy();
  }),
);
