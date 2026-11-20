import { localState, Stack } from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Salesforce from "alchemy-salesforce";

/**
 * One org per Alchemy stage.
 *
 * The stage name is the sf CLI alias unless `SF_TARGET_ORG` is set.
 * `SF_USERNAME` is the existing user who receives `Example_Access`.
 * That permission set must already exist; this stack assigns it, it does
 * not deploy the permission set definition.
 *
 *   sf org login web --alias dev
 *   SF_USERNAME='user@example.com' npx alchemy deploy --stage dev --yes
 */
export default Stack(
  "SalesforceOrg",
  {
    providers: Salesforce.providers(),
    state: localState(),
  },
  Effect.gen(function* () {
    const username = yield* Config.NonEmptyString("SF_USERNAME");
    const org = yield* Salesforce.Org("Org", { alias: "dev" });

    // Inactive, so the directive is not enforced. Salesforce still requires
    // at least one IsApplicableTo* field to be true.
    const trustedSite = yield* Salesforce.CspTrustedSite("ExampleSite", {
      targetOrg: org.alias,
      name: "ExampleSite",
      label: "Example site",
      endpointUrl: "https://example.com",
      context: "All",
      isActive: false,
      description: "Inactive trusted URL for https://example.com.",
      directives: {
        connectSrc: true,
      },
    });

    const remoteSite = yield* Salesforce.RemoteSiteSetting("ExampleRemote", {
      targetOrg: org.alias,
      siteName: "ExampleRemote",
      endpointUrl: "https://example.com",
      isActive: false,
      disableProtocolSecurity: false,
      description: "Inactive remote site for https://example.com.",
    });

    const assignment = yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
      targetOrg: org.alias,
      permissionSet: "Example_Access",
      username,
    });

    return {
      orgId: org.orgId,
      instanceUrl: org.instanceUrl,
      graphqlUrl: org.graphqlUrl,
      trustedSiteId: trustedSite.id,
      remoteSiteId: remoteSite.id,
      assignmentId: assignment.id,
    };
  }),
);
