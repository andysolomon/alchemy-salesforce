import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack } from "alchemy";
import * as Output from "alchemy/Output";
import * as Salesforce from "alchemy-salesforce";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * A Cloudflare Worker and the Salesforce configuration that calls it, in one
 * stack. `alchemy deploy` creates the Worker, then points a Named Credential
 * at its URL and stores the shared secret on both sides. `alchemy destroy`
 * removes both. Nobody copies a URL or a secret between two consoles.
 *
 *   sf org login web --alias dev
 *   export WORKER_SHARED_SECRET="$(openssl rand -hex 32)"
 *   export SF_PERMISSION_SET=Example_Access   # an existing permission set
 *   npx alchemy deploy --stage dev
 *
 * Apex then calls the Worker without handling the secret:
 *
 *   HttpRequest req = new HttpRequest();
 *   req.setEndpoint('callout:Enrichment_Worker/enrich?domain=acme.com');
 *   req.setMethod('GET');
 *   HttpResponse res = new Http().send(req);
 */
export default Stack(
  "SalesforceEdge",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Salesforce.providers()),
    // Shared state, so CI and laptops see the same deployment.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const sharedSecret = yield* Config.Redacted("WORKER_SHARED_SECRET");
    const permissionSet = yield* Config.NonEmptyString("SF_PERMISSION_SET");
    const alias = yield* Config.String("SF_TARGET_ORG").pipe(Config.withDefault("dev"));

    const org = yield* Salesforce.Org("Org", { alias });

    const worker = yield* Cloudflare.Worker("Enrichment", {
      main: "./src/worker.ts",
      // A Redacted value becomes a Worker secret, not a plain-text variable.
      env: { SHARED_SECRET: sharedSecret },
    });
    const workerUrl = worker.url.pipe(
      Output.map((url) => {
        if (url === undefined) {
          throw new Error("The Enrichment Worker has no URL. Keep workers.dev enabled or add a domain.");
        }
        return url;
      }),
    );

    // The External Credential holds the secret and adds the Authorization header.
    const external = yield* Salesforce.ExternalCredential("WorkerAuth", {
      targetOrg: org.alias,
      developerName: "Enrichment_Worker_Auth",
      masterLabel: "Enrichment Worker auth",
      authenticationProtocol: "Custom",
      principals: [{ principalName: "Worker", principalType: "NamedPrincipal", sequenceNumber: 1 }],
      customHeaders: [
        {
          headerName: "Authorization",
          headerValue: "{!'Bearer ' & $Credential.Enrichment_Worker_Auth.token}",
        },
      ],
    });

    yield* Salesforce.ExternalCredentialSecret("WorkerSecret", {
      targetOrg: org.alias,
      externalCredential: external.developerName,
      principalName: "Worker",
      principalType: "NamedPrincipal",
      credentials: { token: { value: sharedSecret, encrypted: true } },
    });

    // Users with this permission set can make callouts through the principal.
    yield* Salesforce.ExternalCredentialPrincipalAccess("WorkerAccess", {
      targetOrg: org.alias,
      permissionSetName: permissionSet,
      externalCredential: external.developerName,
      principalName: "Worker",
    });

    const named = yield* Salesforce.NamedCredential("WorkerEndpoint", {
      targetOrg: org.alias,
      developerName: "Enrichment_Worker",
      masterLabel: "Enrichment Worker",
      type: "SecuredEndpoint",
      calloutUrl: workerUrl,
      externalCredential: external.developerName,
      calloutOptions: {
        allowMergeFieldsInBody: false,
        allowMergeFieldsInHeader: false,
        generateAuthorizationHeader: false,
      },
    });

    return {
      workerUrl,
      orgId: org.orgId,
      callout: Output.interpolate`callout:${named.developerName}/enrich?domain=acme.com`,
      authenticationStatus: external.authenticationStatus,
    };
  }),
);
