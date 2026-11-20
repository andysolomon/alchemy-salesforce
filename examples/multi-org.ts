import { localState, Stack, type Input } from "alchemy";
import { interpolate } from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Salesforce from "alchemy-salesforce";

/**
 * Two orgs in one Alchemy stage. The stage name is not an sf alias.
 * Each resource names its org with `targetOrg`. Endpoint URLs come from
 * `Salesforce.Org`, so this file does not contain instance URLs.
 *
 * Authorize both aliases first:
 *
 *   sf org login web --alias hub
 *   sf org login web --alias partner
 *
 *   npx alchemy deploy --config examples/multi-org.ts --stage mesh --yes
 *
 * Client credentials are optional. Set both `SF_PARTNER_CLIENT_ID` and
 * `SF_PARTNER_CLIENT_SECRET`, or neither. Without them the external
 * credential stays `NotConfigured` and the named credential still deploys.
 */

const optionalText = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) => {
      if (Option.isNone(value)) {
        return undefined;
      }
      const trimmed = value.value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }),
  );

const optionalSecret = (name: string) =>
  Config.option(Config.Redacted(name)).pipe(
    Config.map((value) => {
      if (Option.isNone(value)) {
        return undefined;
      }
      const trimmed = Redacted.value(value.value).trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }),
  );

const allow = (id: string, targetOrg: Input<string>, siteName: string, endpointUrl: Input<string>) =>
  Effect.gen(function* () {
    const trustedSite = yield* Salesforce.CspTrustedSite(`${id}Csp`, {
      targetOrg,
      name: siteName,
      label: siteName,
      endpointUrl,
      context: "All",
      isActive: true,
      description: `Allow calls to ${siteName}.`,
      directives: { connectSrc: true },
    });
    const remoteSite = yield* Salesforce.RemoteSiteSetting(`${id}Remote`, {
      targetOrg,
      siteName,
      endpointUrl,
      isActive: true,
      disableProtocolSecurity: false,
      description: `Remote site ${siteName}.`,
    });
    return { trustedSiteId: trustedSite.id, remoteSiteId: remoteSite.id };
  });

export default Stack(
  "SalesforceMesh",
  {
    providers: Salesforce.providers(),
    state: localState(),
  },
  Effect.gen(function* () {
    const hub = yield* Salesforce.Org("Hub", { alias: "hub" });
    const partner = yield* Salesforce.Org("Partner", { alias: "partner" });

    const hubToPartner = yield* allow("HubPartner", hub.alias, "Partner", partner.instanceUrl);
    const partnerToHub = yield* allow("PartnerHub", partner.alias, "Hub", hub.instanceUrl);

    const tokenUrl = interpolate`${partner.instanceUrl}/services/oauth2/token`;
    const external = yield* Salesforce.ExternalCredential("PartnerExternal", {
      targetOrg: hub.alias,
      developerName: "Partner_EC",
      masterLabel: "Partner",
      authenticationProtocol: "OAuth",
      authenticationProtocolVariant: "ClientCredentialsClientSecretBasic",
      parameters: [
        {
          parameterName: "AuthProviderUrl",
          parameterType: "AuthProviderUrl",
          parameterValue: tokenUrl,
        },
      ],
      principals: [
        { principalName: "PartnerPrincipal", principalType: "NamedPrincipal", sequenceNumber: 1 },
      ],
    });

    const named = yield* Salesforce.NamedCredential("PartnerNamed", {
      targetOrg: hub.alias,
      developerName: "Partner_NC",
      masterLabel: "Partner Named Credential",
      type: "SecuredEndpoint",
      calloutUrl: partner.instanceUrl,
      externalCredential: external.developerName,
      calloutOptions: {
        allowMergeFieldsInBody: false,
        allowMergeFieldsInHeader: true,
        generateAuthorizationHeader: true,
      },
    });

    const clientId = yield* optionalText("SF_PARTNER_CLIENT_ID");
    const clientSecret = yield* optionalSecret("SF_PARTNER_CLIENT_SECRET");
    if ((clientId === undefined) !== (clientSecret === undefined)) {
      return yield* Effect.die(
        "Set both SF_PARTNER_CLIENT_ID and SF_PARTNER_CLIENT_SECRET, or neither.",
      );
    }
    if (clientId !== undefined && clientSecret !== undefined) {
      yield* Salesforce.ExternalCredentialSecret("PartnerSecret", {
        targetOrg: hub.alias,
        externalCredential: external.developerName,
        principalName: "PartnerPrincipal",
        principalType: "NamedPrincipal",
        credentials: {
          clientId: { value: Redacted.make(clientId), encrypted: false },
          clientSecret: { value: Redacted.make(clientSecret), encrypted: true },
        },
      });
    }

    // Example_Access must already exist on the hub org.
    const access = yield* Salesforce.ExternalCredentialPrincipalAccess("PartnerPrincipalAccess", {
      targetOrg: hub.alias,
      permissionSetName: "Example_Access",
      externalCredential: external.developerName,
      principalName: "PartnerPrincipal",
    });

    return {
      orgs: {
        hub: {
          alias: hub.alias,
          orgId: hub.orgId,
          instanceUrl: hub.instanceUrl,
          username: hub.username,
          apiVersion: hub.apiVersion,
          graphqlUrl: hub.graphqlUrl,
        },
        partner: {
          alias: partner.alias,
          orgId: partner.orgId,
          instanceUrl: partner.instanceUrl,
          username: partner.username,
          apiVersion: partner.apiVersion,
          graphqlUrl: partner.graphqlUrl,
        },
      },
      hubToPartner,
      partnerToHub,
      externalCredential: external.developerName,
      restBaseCallout: named.restBaseCallout,
      graphqlCallout: named.graphqlCallout,
      authenticationStatus: external.authenticationStatus,
      principalAccessId: access.id,
    };
  }),
);
