import * as Test from "@alchemy.run/test/Vitest";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
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

const CLIENT_ID = "banking-consumer-key";
const CLIENT_SECRET = "super-secret-value-xyz";

const secretProps = (clientSecret = CLIENT_SECRET) => ({
  externalCredential: "Partner_EC",
  principalName: "PartnerPrincipal",
  principalType: "NamedPrincipal" as const,
  credentials: {
    clientId: { value: Redacted.make(CLIENT_ID), encrypted: false },
    clientSecret: { value: Redacted.make(clientSecret), encrypted: true },
  },
});

const program = (clientSecret = CLIENT_SECRET) =>
  Effect.gen(function* () {
    return yield* Salesforce.ExternalCredentialSecret("BankingSecret", secretProps(clientSecret));
  });

const writes = () => org.requests.filter((request) => request.resource === "credential" && request.method !== "GET");

const persistedText = (planned: { readonly resources: Record<string, { state?: unknown; props?: unknown }> }): string =>
  Object.values(planned.resources)
    .map((resource) => JSON.stringify({ props: resource.props, state: resource.state }))
    .join("\n");

test.provider("posts credential values and keeps them out of state", (stack) =>
  Effect.gen(function* () {
    const preview = yield* stack.plan(program());
    expect(persistedText(preview)).not.toContain(CLIENT_SECRET);
    expect(persistedText(preview)).not.toContain(CLIENT_ID);

    const created = yield* stack.deploy(program());
    expect(created.credentialKeys).toEqual(["clientId", "clientSecret"]);
    expect(created.encryptedKeys).toEqual(["clientSecret"]);
    expect(created.authenticationStatus).toBe("Configured");
    expect(created.externalCredential).toBe("Partner_EC");
    expect(JSON.stringify(created)).not.toContain(CLIENT_SECRET);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.method).toBe("POST");
    expect(writes()[0]?.path).toBe("/services/data/v68.0/named-credentials/credential");
    const body = writes()[0]?.body as {
      externalCredential?: string;
      principalName?: string;
      principalType?: string;
      credentials?: {
        clientId?: { value?: string; encrypted?: boolean };
        clientSecret?: { value?: string; encrypted?: boolean };
      };
    };
    expect(body.externalCredential).toBe("Partner_EC");
    expect(body.principalType).toBe("NamedPrincipal");
    expect(body.credentials?.clientId).toEqual({ value: CLIENT_ID, encrypted: false });
    expect(body.credentials?.clientSecret).toEqual({ value: CLIENT_SECRET, encrypted: true });

    const planned = yield* stack.plan(program());
    expect(Object.values(planned.resources).every((resource) => resource.action === "noop")).toBe(true);
    expect(persistedText(planned)).not.toContain(CLIENT_SECRET);
    expect(persistedText(planned)).toContain("credentialsDigest");
    expect(writes()).toHaveLength(1);

    const rotated = yield* stack.deploy(program("rotated-secret-value-xyz"));
    expect(rotated.credentialsDigest).not.toBe(created.credentialsDigest);
    expect(writes().map((request) => request.method)).toEqual(["POST", "PUT"]);
    expect(JSON.stringify(rotated)).not.toContain("rotated-secret-value-xyz");

    org.removeCredentials();
    yield* stack.destroy();
    expect(org.credentialKeys()).toEqual([]);
  }),
);

test.provider("adopts a matching credential without rewriting it", (stack) =>
  Effect.gen(function* () {
    org.seedCredential({
      externalCredential: "Partner_EC",
      principalName: "PartnerPrincipal",
      credentials: {
        clientId: { value: CLIENT_ID, encrypted: false },
        clientSecret: { value: CLIENT_SECRET, encrypted: true },
      },
    });
    const adopted = yield* stack.deploy(program());
    expect(adopted.authenticationStatus).toBe("Configured");
    expect(writes()).toHaveLength(0);
    expect(JSON.stringify(adopted)).not.toContain(CLIENT_SECRET);
    yield* stack.destroy();
  }),
);

test.provider("redacts secret values echoed by Salesforce", (stack) =>
  Effect.gen(function* () {
    org.setEchoCredentialFailure(true);
    const exit = yield* Effect.exit(stack.deploy(program()));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const text = String(exit.cause);
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).toContain("[redacted]");
    }
  }),
);

test.provider("rejects an empty credential map before calling Salesforce", (stack) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.ExternalCredentialSecret("BankingSecret", {
            externalCredential: "Partner_EC",
            principalName: "PartnerPrincipal",
            credentials: {},
          });
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("at least one credential");
    }
    expect(org.requests.filter((request) => request.resource === "credential")).toHaveLength(0);
  }),
);

test.provider("creates credentials when the principal is NotConfigured with an empty map", (stack) =>
  Effect.gen(function* () {
    org.seedExternalCredential({
      developerName: "Partner_EC",
      masterLabel: "Partner",
      principalName: "PartnerPrincipal",
    });
    const planned = yield* stack.plan(program());
    const actions = Object.values(planned.resources).map((resource) => resource.action);
    expect(actions).toEqual(["create"]);
    expect(persistedText(planned)).not.toContain(CLIENT_SECRET);
    expect(persistedText(planned)).not.toContain(CLIENT_ID);

    const created = yield* stack.deploy(program());
    expect(created.authenticationStatus).toBe("Configured");
    expect(writes().map((request) => request.method)).toEqual(["POST"]);
    expect(JSON.stringify(created)).not.toContain(CLIENT_SECRET);
    expect(org.credentialKeys()).toEqual([
      { externalCredential: "Partner_EC", keys: ["clientId", "clientSecret"] },
    ]);
    yield* stack.destroy();
  }),
);

test.provider("posts when an update is rejected because the principal has no credentials", (stack) =>
  Effect.gen(function* () {
    org.setRejectUnstoredCredentialPut(true);
    const created = yield* stack.deploy(program());
    expect(writes().map((request) => request.method)).toEqual(["PUT", "POST"]);
    const text = JSON.stringify(created);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain("stale-client-secret");
    expect(created.authenticationStatus).toBe("Configured");
    yield* stack.destroy();
  }),
);

test.provider("lists nothing and opts out of nuke", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Salesforce.ExternalCredentialSecret.Provider;
    expect(provider.nuke?.skip).toBe(true);
    expect(yield* provider.list()).toEqual([]);
    yield* stack.destroy();
  }),
);
