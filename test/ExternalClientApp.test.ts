import * as Test from "@alchemy.run/test/Vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Salesforce from "../src/salesforce/index.js";
import { certificateBody, clearExternalClientAppCertificates } from "../src/salesforce/ExternalClientApp.js";
import { redactSensitiveText } from "../src/salesforce/errors.js";
import { sha256Hex } from "../src/salesforce/hash.js";
import { clearMetadataDeployLocks } from "../src/salesforce/metadata.js";
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
  clearExternalClientAppCertificates();
  clearMetadataDeployLocks();
});

const CERT = ["-----BEGIN CERTIFICATE-----", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", "-----END CERTIFICATE-----"].join("\n");

const appProps = (overrides?: { readonly label?: string; readonly callbackUrl?: string; readonly certificate?: string }) => ({
  developerName: "PartnerApp",
  label: overrides?.label ?? "Partner App",
  contactEmail: "admin@example.com",
  oauth: {
    scopes: ["RefreshToken", "Api"] as const,
    callbackUrl: overrides?.callbackUrl ?? "https://example.com/callback",
    permittedUsers: { type: "AllSelfAuthorized" as const },
    ...(overrides?.certificate === undefined ? {} : { jwtBearer: { certificate: overrides.certificate } }),
  },
});

const program = (overrides?: Parameters<typeof appProps>[0]) =>
  Effect.gen(function* () {
    return yield* Salesforce.ExternalClientApp("PartnerApp", appProps(overrides));
  });

const deployPosts = () =>
  org.requests.filter((request) => request.resource === "deployRequest" && request.method === "POST");

const deployFiles = (body: unknown) => {
  const record = body as {
    checkOnly?: boolean;
    files?: ReadonlyArray<{ type?: string; fullName?: string; fields?: Record<string, unknown> }>;
    destructive?: ReadonlyArray<{ type?: string; fullName?: string }>;
  };
  return record;
};

const persistedText = (planned: { readonly resources: Record<string, { state?: unknown; props?: unknown }> }): string =>
  Object.values(planned.resources)
    .map((resource) => JSON.stringify({ props: resource.props, state: resource.state }))
    .join("\n");

describe("metadata redaction", () => {
  it("strips certificate blocks and supplied key material", () => {
    const key = "3MVG9mockConsumerKeyValue";
    const text = redactSensitiveText(`failed ${CERT} key ${key}`, [key]);
    expect(text).not.toContain("BEGIN CERTIFICATE");
    expect(text).not.toContain(key);
    expect(text).toContain("[redacted]");
  });
});

test.provider("adopts an equal external client app without deploying", (stack) =>
  Effect.gen(function* () {
    const seeded = org.seedExternalClientApp({
      developerName: "PartnerApp",
      label: "Partner App",
      contactEmail: "admin@example.com",
      scopes: "RefreshToken, Api",
      callbackUrl: "https://example.com/callback",
      policyFullName: "PartnerApp_defaultPolicy",
    });
    const adopted = yield* stack.deploy(program());
    expect(deployPosts()).toHaveLength(0);
    expect(adopted.id.startsWith("0xI")).toBe(true);
    expect(adopted.id).toBe(seeded.id);
    expect(adopted.consumerId.startsWith("888")).toBe(true);
    expect(adopted.consumerId).toBe(seeded.consumerId);
    expect(adopted.consumerKeySha256).toBe(sha256Hex(seeded.consumerKey));
    expect(adopted.certificateSha256).toBeNull();
    expect(adopted.policyFullName).toBe("PartnerApp_defaultPolicy");
    expect(adopted.globalSettingsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(adopted.targetOrg).toBeNull();
    expect(JSON.stringify(adopted)).not.toContain(seeded.consumerKey);

    const planned = yield* stack.plan(program());
    expect(Object.values(planned.resources).every((resource) => resource.action === "noop")).toBe(true);
    expect(persistedText(planned)).not.toContain(seeded.consumerKey);
    expect(deployPosts()).toHaveLength(0);
    yield* stack.destroy();
    expect(org.externalClientApp("PartnerApp")).toBeDefined();
    expect(deployPosts().some((request) => deployFiles(request.body).destructive?.length)).toBe(false);
  }),
);

test.provider("creates an app, keeps the key out of state, and skips a second plan", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const first = yield* Salesforce.ExternalClientApp("PartnerApp", appProps());
        const second = yield* Salesforce.ExternalClientApp("OtherApp", {
          ...appProps(),
          developerName: "OtherApp",
          label: "Other App",
        });
        return { first, second };
      }),
    );
    const live = org.externalClientApp("PartnerApp");
    expect(live).toBeDefined();
    expect(created.first.id.startsWith("0xI")).toBe(true);
    expect(created.first.consumerId.startsWith("888")).toBe(true);
    expect(created.first.policyFullName).toBe("PartnerApp_Plcy");
    expect(created.first.consumerKeySha256).toBe(sha256Hex(live?.consumerKey ?? ""));
    expect(JSON.stringify(created)).not.toContain(live?.consumerKey ?? "missing-key");
    expect(created.second.developerName).toBe("OtherApp");
    const posts = deployPosts();
    expect(posts.length).toBeGreaterThanOrEqual(4);
    expect(deployFiles(posts[0]?.body).checkOnly).toBe(true);
    expect(deployFiles(posts[1]?.body).checkOnly).toBe(false);
    const planned = yield* stack.plan(
      Effect.gen(function* () {
        const first = yield* Salesforce.ExternalClientApp("PartnerApp", appProps());
        const second = yield* Salesforce.ExternalClientApp("OtherApp", {
          ...appProps(),
          developerName: "OtherApp",
          label: "Other App",
        });
        return { first, second };
      }),
    );
    expect(Object.values(planned.resources).every((resource) => resource.action === "noop")).toBe(true);
    expect(persistedText(planned)).not.toContain(live?.consumerKey ?? "missing-key");
    yield* stack.destroy();
  }),
);

test.provider("updates a label without sending global oauth settings", (stack) =>
  Effect.gen(function* () {
    org.seedExternalClientApp({
      developerName: "PartnerApp",
      label: "Partner App",
      contactEmail: "admin@example.com",
      scopes: "RefreshToken, Api",
      callbackUrl: "https://example.com/callback",
    });
    yield* stack.deploy(program());
    expect(deployPosts()).toHaveLength(0);
    const updated = yield* stack.deploy(program({ label: "Partner App Updated" }));
    expect(updated.developerName).toBe("PartnerApp");
    const posts = deployPosts();
    expect(posts).toHaveLength(2);
    expect(posts.map((request) => deployFiles(request.body).checkOnly)).toEqual([true, false]);
    for (const request of posts) {
      const files = deployFiles(request.body).files ?? [];
      expect(files.map((file) => file.type)).toEqual(["ExternalClientApplication"]);
      expect(files.some((file) => file.type === "ExtlClntAppGlobalOauthSettings")).toBe(false);
    }
    expect(org.externalClientApp("PartnerApp")?.parts.find((part) => part.type === "ExternalClientApplication")?.fields.label).toBe(
      "Partner App Updated",
    );
    yield* stack.destroy();
  }),
);

test.provider("sends the read consumer key when global settings change and never a secret", (stack) =>
  Effect.gen(function* () {
    const seeded = org.seedExternalClientApp({
      developerName: "PartnerApp",
      label: "Partner App",
      contactEmail: "admin@example.com",
      scopes: "Api, RefreshToken",
      callbackUrl: "https://example.com/callback",
      certificate: CERT,
    });
    yield* stack.deploy(program({ certificate: CERT }));
    expect(deployPosts()).toHaveLength(0);
    const preview = yield* stack.plan(program({ certificate: CERT }));
    expect(persistedText(preview)).not.toContain("BEGIN CERTIFICATE");
    expect(persistedText(preview)).not.toContain(seeded.consumerKey);
    const updated = yield* stack.deploy(program({ certificate: CERT, callbackUrl: "https://example.com/oauth/callback" }));
    expect(updated.certificateSha256).toBe(sha256Hex(certificateBody(CERT)));
    expect(updated.consumerKeySha256).toBe(sha256Hex(seeded.consumerKey));
    const real = deployPosts().filter((request) => deployFiles(request.body).checkOnly === false);
    expect(real).toHaveLength(1);
    const globalFile = (deployFiles(real[0]?.body).files ?? []).find(
      (file) => file.type === "ExtlClntAppGlobalOauthSettings",
    );
    expect(globalFile?.fields?.consumerKey).toBe(seeded.consumerKey);
    expect(globalFile?.fields?.consumerSecret).toBeUndefined();
    expect(globalFile?.fields?.shouldRotateConsumerKey).toBe(false);
    expect(globalFile?.fields?.shouldRotateConsumerSecret).toBe(false);
    expect(globalFile?.fields?.callbackUrl).toBe("https://example.com/oauth/callback");
    expect(String(globalFile?.fields?.certificate)).toContain("BEGIN CERTIFICATE");
    expect(org.externalClientApp("PartnerApp")?.consumerKey).toBe(seeded.consumerKey);
    yield* stack.destroy();
  }),
);

test.provider("fails when the consumer key hash changes during deploy", (stack) =>
  Effect.gen(function* () {
    const seeded = org.seedExternalClientApp({
      developerName: "PartnerApp",
      label: "Partner App",
      contactEmail: "admin@example.com",
      scopes: "Api, RefreshToken",
      callbackUrl: "https://example.com/callback",
    });
    yield* stack.deploy(program());
    org.setRotateConsumerKeyOnDeploy(true);
    const exit = yield* Effect.exit(stack.deploy(program({ label: "Partner App Updated" })));
    expect(Exit.isFailure(exit)).toBe(true);
    const after = org.externalClientApp("PartnerApp")?.consumerKey ?? "";
    expect(after).not.toBe(seeded.consumerKey);
    if (Exit.isFailure(exit)) {
      const text = String(exit.cause);
      expect(text).toContain("consumer key");
      expect(text).not.toContain(seeded.consumerKey);
      expect(text).not.toContain(after);
    }
  }),
);

test.provider("refuses to replace an app unless allowReplace is set", (stack) =>
  Effect.gen(function* () {
    org.seedExternalClientApp({
      developerName: "PartnerApp",
      label: "Partner App",
      contactEmail: "admin@example.com",
      scopes: "Api, RefreshToken",
      callbackUrl: "https://example.com/callback",
    });
    yield* stack.deploy(program());
    const exit = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.ExternalClientApp("PartnerApp", {
            ...appProps(),
            developerName: "PartnerAppNext",
          });
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const text = String(exit.cause);
      expect(text).toContain("allowReplace");
      expect(text).toContain("consumer key");
    }
    expect(org.externalClientApp("PartnerApp")).toBeDefined();
    expect(org.externalClientApp("PartnerAppNext")).toBeUndefined();
    expect(deployPosts()).toHaveLength(0);
  }),
);

test.provider("retain delete leaves the org app in place", (stack) =>
  Effect.gen(function* () {
    org.seedExternalClientApp({
      developerName: "PartnerApp",
      label: "Partner App",
      contactEmail: "admin@example.com",
      scopes: "Api, RefreshToken",
      callbackUrl: "https://example.com/callback",
    });
    yield* stack.deploy(program());
    yield* stack.destroy();
    expect(org.externalClientApp("PartnerApp")).toBeDefined();
    expect(deployPosts()).toHaveLength(0);
  }),
);

test.provider("deletionPolicy delete removes the app with destructive changes", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.ExternalClientApp("PartnerApp", {
          ...appProps(),
          deletionPolicy: "delete",
        });
      }),
    );
    expect(created.policyFullName).toBe("PartnerApp_Plcy");
    const before = deployPosts().length;
    yield* stack.destroy();
    const destructive = deployPosts().slice(before);
    expect(destructive.map((request) => deployFiles(request.body).checkOnly)).toEqual([true, false]);
    const members = deployFiles(destructive[1]?.body).destructive ?? [];
    expect(members.map((member) => member.fullName)).toContain("PartnerApp_Plcy");
    expect(members.map((member) => member.fullName)).toContain("PartnerApp");
    expect(org.externalClientApp("PartnerApp")).toBeUndefined();
  }),
);

test.provider("rejects a private key and a missing run-as user before deploy", (stack) =>
  Effect.gen(function* () {
    const privateKey = ["-----BEGIN PRIVATE KEY-----", "AAAA", "-----END PRIVATE KEY-----"].join("\n");
    const rejected = yield* Effect.exit(stack.deploy(program({ certificate: privateKey })));
    expect(Exit.isFailure(rejected)).toBe(true);
    if (Exit.isFailure(rejected)) {
      const text = String(rejected.cause);
      expect(text).toContain("public PEM");
      expect(text).not.toContain("BEGIN PRIVATE KEY");
      expect(text).not.toContain("AAAA");
    }
    expect(org.requests).toHaveLength(0);

    const missingUser = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.ExternalClientApp("PartnerApp", {
            ...appProps(),
            oauth: {
              ...appProps().oauth,
              clientCredentials: { runAsUsername: "missing@example.com" },
            },
          });
        }),
      ),
    );
    expect(Exit.isFailure(missingUser)).toBe(true);
    if (Exit.isFailure(missingUser)) {
      expect(String(missingUser.cause)).toContain("does not create");
    }
    expect(deployPosts()).toHaveLength(0);
  }),
);

test.provider("lists apps without the consumer key and opts out of nuke", (stack) =>
  Effect.gen(function* () {
    const seeded = org.seedExternalClientApp({
      developerName: "PartnerApp",
      label: "Partner App",
      contactEmail: "admin@example.com",
    });
    const provider = yield* Salesforce.ExternalClientApp.Provider;
    expect(provider.nuke?.skip).toBe(true);
    const listed = yield* provider.list();
    expect(listed.map((app) => app.developerName)).toEqual(["PartnerApp"]);
    expect(JSON.stringify(listed)).not.toContain(seeded.consumerKey);
    expect(listed[0]?.consumerKeySha256).toBe(sha256Hex(seeded.consumerKey));
    yield* stack.destroy();
  }),
);
