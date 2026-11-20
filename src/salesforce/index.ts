export {
  CSP_CONTEXTS,
  CspTrustedSite,
  type CspContext,
  type CspDirectives,
  type CspTrustedSiteAttributes,
  type CspTrustedSiteProps,
} from "./CspTrustedSite.js";
export {
  CorsAllowedOrigin,
  type CorsAllowedOriginAttributes,
  type CorsAllowedOriginProps,
} from "./CorsAllowedOrigin.js";
export {
  AUTHENTICATION_PROTOCOLS,
  ExternalCredential,
  OAUTH_PROTOCOL_VARIANTS,
  PRINCIPAL_TYPES,
  type AuthenticationProtocol,
  type ExternalCredentialAttributes,
  type ExternalCredentialParameter,
  type ExternalCredentialPrincipalAttributes,
  type ExternalCredentialProps,
  type OAuthProtocolVariant,
  type PrincipalType,
} from "./ExternalCredential.js";
export {
  ExternalCredentialPrincipalAccess,
  type ExternalCredentialPrincipalAccessAttributes,
  type ExternalCredentialPrincipalAccessProps,
} from "./ExternalCredentialPrincipalAccess.js";
export {
  ExternalCredentialSecret,
  type ExternalCredentialSecretAttributes,
  type ExternalCredentialSecretInput,
  type ExternalCredentialSecretProps,
} from "./ExternalCredentialSecret.js";
export {
  NamedCredential,
  type NamedCredentialAttributes,
  type NamedCredentialProps,
} from "./NamedCredential.js";
export { Org, type OrgAttributes, type OrgProps } from "./Org.js";
export {
  PermissionSetAssignment,
  type PermissionSetAssignmentAttributes,
  type PermissionSetAssignmentProps,
} from "./PermissionSetAssignment.js";
export {
  PermissionSetGroupAssignment,
  type PermissionSetGroupAssignmentAttributes,
  type PermissionSetGroupAssignmentProps,
} from "./PermissionSetGroupAssignment.js";
export { Providers, providers } from "./Providers.js";
export {
  RemoteSiteSetting,
  type RemoteSiteSettingAttributes,
  type RemoteSiteSettingProps,
} from "./RemoteSiteSetting.js";
export {
  SCRATCH_EDITIONS,
  ScratchOrg,
  type ScratchEdition,
  type ScratchOrgAttributes,
  type ScratchOrgProps,
} from "./ScratchOrg.js";
export {
  SalesforceApiError,
  SalesforceAuthError,
  SalesforceCliError,
  SalesforceValidationError,
  isNotFound,
} from "./errors.js";
