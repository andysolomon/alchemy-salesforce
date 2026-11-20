import * as Test from "@alchemy.run/test/Vitest";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { interpolate } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { clearConnectionCache } from "../src/salesforce/connection.js";
import { clearCredentialSecrets } from "../src/salesforce/credentialSecrets.js";
import * as Salesforce from "../src/salesforce/index.js";
import { startMockOrg, type MockOrg } from "./mock-org.js";

const { test } = Test.make({ providers: Salesforce.providers() });

let hubOrg: MockOrg;
let banking: MockOrg;

const credentials = () =>
  JSON.stringify({
    hub: {
      instanceUrl: hubOrg.url,
      accessToken: "token-hub",
      orgId: "00DHUB000000001",
      username: "ada@hub.example",
      apiVersion: "68.0",
    },
    banking: {
      instanceUrl: banking.url,
      accessToken: "token-banking",
      orgId: "00DBANK00000001",
      username: "ada@bank.example",
      apiVersion: "68.0",
    },
  });

beforeAll(async () => {
  hubOrg = await startMockOrg({ token: "token-hub", orgId: "00DHUB000000001", username: "ada@hub.example" });
  banking = await startMockOrg({
    token: "token-banking",
    orgId: "00DBANK00000001",
    username: "ada@bank.example",
  });
});

afterAll(async () => {
  await hubOrg.close();
  await banking.close();
  delete process.env.SF_ORG_CREDENTIALS;
});

beforeEach(() => {
  hubOrg.reset();
  banking.reset();
  hubOrg.seedPermissionSet("Example_Access");
  clearCredentialSecrets();
  process.env.SF_ORG_CREDENTIALS = credentials();
  delete process.env.SF_INSTANCE_URL;
  delete process.env.SF_ACCESS_TOKEN;
  delete process.env.SALESFORCE_INSTANCE_URL;
  delete process.env.SALESFORCE_ACCESS_TOKEN;
  delete process.env.SF_TARGET_ORG;
  clearConnectionCache();
});

test.provider("routes external credentials, named credentials, secrets, and principal access by targetOrg", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const hub = yield* Salesforce.Org("Hub", { alias: "hub" });
        const bank = yield* Salesforce.Org("Banking", { alias: "banking" });
        const tokenUrl = interpolate`${bank.instanceUrl}/services/oauth2/token`;
        const external = yield* Salesforce.ExternalCredential("BankingExternal", {
          targetOrg: hub.alias,
          developerName: "Partner_EC",
          masterLabel: "Partner",
          authenticationProtocol: "OAuth",
          authenticationProtocolVariant: "ClientCredentialsClientSecretBasic",
          parameters: [
            { parameterName: "AuthProviderUrl", parameterType: "AuthProviderUrl", parameterValue: tokenUrl },
          ],
          principals: [
            { principalName: "PartnerPrincipal", principalType: "NamedPrincipal", sequenceNumber: 1 },
          ],
        });
        const named = yield* Salesforce.NamedCredential("BankingNamed", {
          targetOrg: bank.alias,
          developerName: "Hub_NC",
          masterLabel: "Hub Named Credential",
          calloutUrl: hub.instanceUrl,
          externalCredential: "Hub_EC",
        });
        const secret = yield* Salesforce.ExternalCredentialSecret("BankingSecret", {
          targetOrg: hub.alias,
          externalCredential: external.developerName,
          principalName: "PartnerPrincipal",
          credentials: {
            clientId: { value: "hub-consumer-key", encrypted: false },
            clientSecret: { value: Redacted.make("hub-consumer-secret-value"), encrypted: true },
          },
        });
        const access = yield* Salesforce.ExternalCredentialPrincipalAccess("BankingAccess", {
          targetOrg: hub.alias,
          permissionSetName: "Example_Access",
          externalCredential: external.developerName,
          principalName: "PartnerPrincipal",
        });
        return {
          tokenHost: bank.instanceUrl,
          calloutUrl: named.calloutUrl,
          graphqlCallout: named.graphqlCallout,
          secretStatus: secret.authenticationStatus,
          accessId: access.id,
        };
      }),
    );

    expect(created.calloutUrl).toBe(hubOrg.url);
    expect(created.graphqlCallout).toBe("callout:Hub_NC/services/data/v68.0/graphql");
    expect(created.secretStatus).toBe("Configured");
    expect(created.accessId).toMatch(/^0J0/);

    const hubExternal = hubOrg.requests.find(
      (request) => request.method === "POST" && request.resource === "external-credentials",
    );
    const body = hubExternal?.body as {
      parameters?: ReadonlyArray<{ parameterValue?: string }>;
    };
    expect(body.parameters?.[0]?.parameterValue).toBe(`${banking.url}/services/oauth2/token`);
    expect(hubOrg.requests.some((request) => request.resource === "named-credential-setup")).toBe(false);
    expect(banking.requests.some((request) => request.resource === "external-credentials")).toBe(false);
    expect(banking.requests.some((request) => request.resource === "credential")).toBe(false);
    expect(banking.requests.some((request) => request.resource === "SetupEntityAccess")).toBe(false);

    const bankingNamed = banking.requests.find(
      (request) => request.method === "POST" && request.resource === "named-credential-setup",
    );
    expect((bankingNamed?.body as { calloutUrl?: string }).calloutUrl).toBe(hubOrg.url);
    expect(bankingNamed?.path).toBe("/services/data/v68.0/named-credentials/named-credential-setup");
    expect(hubOrg.setupEntityAccess()).toHaveLength(1);
    expect(banking.setupEntityAccess()).toEqual([]);
    const secretPost = hubOrg.requests.find((request) => request.method === "POST" && request.resource === "credential");
    expect(JSON.stringify(secretPost?.body)).toContain("hub-consumer-secret-value");

    yield* stack.destroy();
    expect(hubOrg.externalCredentials()).toEqual([]);
    expect(banking.namedCredentials()).toEqual([]);
    expect(hubOrg.setupEntityAccess()).toEqual([]);
    expect(hubOrg.credentialKeys()).toEqual([]);
  }),
);
