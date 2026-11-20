import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { CspTrustedSite, CspTrustedSiteProvider } from "./CspTrustedSite.js";
import { OrgDirectoryLive } from "./connection.js";
import { ExternalCredential, ExternalCredentialProvider } from "./ExternalCredential.js";
import {
  ExternalCredentialPrincipalAccess,
  ExternalCredentialPrincipalAccessProvider,
} from "./ExternalCredentialPrincipalAccess.js";
import {
  ExternalCredentialSecretProvider,
  ExternalCredentialSecretResource,
} from "./ExternalCredentialSecret.js";
import { NamedCredential, NamedCredentialProvider } from "./NamedCredential.js";
import { Org, OrgProvider } from "./Org.js";
import { PermissionSetAssignment, PermissionSetAssignmentProvider } from "./PermissionSetAssignment.js";
import { RemoteSiteSetting, RemoteSiteSettingProvider } from "./RemoteSiteSetting.js";

/**
 * Same shape as Alchemy's built-in bundles (`Cloudflare.providers()`).
 * `OrgDirectoryLive` is in the output so every resource resolves its own
 * org at apply time. Tokens never enter resource state.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Salesforce") {}

export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Org,
      CspTrustedSite,
      PermissionSetAssignment,
      RemoteSiteSetting,
      ExternalCredential,
      NamedCredential,
      ExternalCredentialSecretResource,
      ExternalCredentialPrincipalAccess,
    ]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        OrgProvider,
        CspTrustedSiteProvider,
        PermissionSetAssignmentProvider,
        RemoteSiteSettingProvider,
        ExternalCredentialProvider,
        NamedCredentialProvider,
        ExternalCredentialSecretProvider,
        ExternalCredentialPrincipalAccessProvider,
      ),
    ),
    Layer.provideMerge(OrgDirectoryLive),
  );
