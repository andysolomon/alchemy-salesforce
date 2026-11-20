import * as Test from "@alchemy.run/test/Vitest";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import * as Effect from "effect/Effect";
import { clearConnectionCache } from "../src/salesforce/connection.js";
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
  banking.seedUser("ada@bank.example");
  banking.seedPermissionSet("Integration_User");
  process.env.SF_ORG_CREDENTIALS = credentials();
  delete process.env.SF_INSTANCE_URL;
  delete process.env.SF_ACCESS_TOKEN;
  delete process.env.SALESFORCE_INSTANCE_URL;
  delete process.env.SALESFORCE_ACCESS_TOKEN;
  delete process.env.SF_TARGET_ORG;
  clearConnectionCache();
});

test.provider("wires org A's instance URL into resources on org B without sharing tokens", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const hub = yield* Salesforce.Org("Hub", { alias: "hub" });
        const bank = yield* Salesforce.Org("Banking", { alias: "banking" });
        const site = yield* Salesforce.CspTrustedSite("Partner", {
          targetOrg: hub.alias,
          name: "Partner",
          endpointUrl: bank.instanceUrl,
          isActive: true,
          directives: { connectSrc: true },
        });
        const remote = yield* Salesforce.RemoteSiteSetting("PartnerRemote", {
          targetOrg: hub.alias,
          siteName: "Partner",
          endpointUrl: bank.instanceUrl,
          isActive: true,
          disableProtocolSecurity: false,
        });
        const assignment = yield* Salesforce.PermissionSetAssignment("BankingIntegrationUser", {
          targetOrg: bank.alias,
          permissionSet: "Integration_User",
          username: bank.username,
        });
        return {
          hubUrl: hub.instanceUrl,
          bankUrl: bank.instanceUrl,
          graphqlUrl: bank.graphqlUrl,
          siteEndpoint: site.endpointUrl,
          remoteEndpoint: remote.endpointUrl,
          assignmentId: assignment.id,
        };
      }),
    );

    expect(created.hubUrl).toBe(hubOrg.url);
    expect(created.bankUrl).toBe(banking.url);
    expect(created.siteEndpoint).toBe(banking.url);
    expect(created.remoteEndpoint).toBe(banking.url);
    expect(created.graphqlUrl).toBe(`${banking.url}/services/data/v68.0/graphql`);
    expect(hubOrg.sites().map((site) => site.EndpointUrl)).toEqual([banking.url]);
    expect(hubOrg.remoteSites().map((site) => site.EndpointUrl)).toEqual([banking.url]);
    expect(banking.sites()).toEqual([]);
    expect(banking.remoteSites()).toEqual([]);
    expect(banking.assignments()).toHaveLength(1);
    expect(hubOrg.assignments()).toEqual([]);

    const hubPost = hubOrg.requests.find((request) => request.method === "POST" && request.resource === "CspTrustedSite");
    const remotePost = hubOrg.requests.find((request) => request.method === "POST" && request.resource === "RemoteProxy");
    const remoteBody = remotePost?.body as { FullName?: string; Metadata?: { url?: string }; EndpointUrl?: string };
    expect((hubPost?.body as { EndpointUrl?: string }).EndpointUrl).toBe(banking.url);
    expect(remoteBody.FullName).toBe("Partner");
    expect(remoteBody.Metadata?.url).toBe(banking.url);
    expect(remoteBody.EndpointUrl).toBeUndefined();
    expect(banking.requests.some((request) => request.resource === "CspTrustedSite")).toBe(false);

    yield* stack.destroy();
    expect(hubOrg.sites()).toEqual([]);
    expect(hubOrg.remoteSites()).toEqual([]);
    expect(banking.assignments()).toEqual([]);
  }),
);
