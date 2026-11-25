import { Resource, type Input, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { queryRecords } from "./api.js";
import { assertOrgUrl } from "./connect.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import {
  deployMetadata,
  listMetadata,
  readMetadata,
  type MetadataComponent,
  type MetadataField,
  type MetadataFields,
  type MetadataFile,
} from "./metadata.js";
import { requireDeveloperName } from "./names.js";
import { soqlString } from "./soql.js";

/**
 * External Client App, Metadata API only.
 *
 * REST and Tooling sObject create/update/delete are not available. The app
 * is five metadata parts. `readMetadata` returns `consumerKey` in plaintext;
 * that response is never logged. State stores `consumerKeySha256` and, for a
 * JWT certificate, the certificate body's SHA-256. `consumerSecret` is never
 * read and never deployed.
 *
 * Generated fields `orgScopedExternalApp`, `oauthLink`, and `consumerKey` are
 * copied from the fresh read onto any file that is deployed. Stripping them
 * makes a check-only deploy report the component as changed and can rotate
 * the consumer key.
 */

export const IP_RELAXATIONS = ["Enforce", "Bypass", "Bypass_2factor", "Enforce_RelaxRefresh"] as const;
export type IpRelaxation = (typeof IP_RELAXATIONS)[number];

export const REFRESH_TOKEN_POLICIES = ["Infinite", "SpecificInactivity", "SpecificLifetime", "Zero"] as const;
export type RefreshTokenPolicy = (typeof REFRESH_TOKEN_POLICIES)[number];

export const REFRESH_TOKEN_UNITS = ["Days", "Hours", "Months"] as const;
export type RefreshTokenUnit = (typeof REFRESH_TOKEN_UNITS)[number];

export const SESSION_LEVELS = ["HIGH_ASSURANCE", "LOW", "STANDARD"] as const;
export type SessionLevel = (typeof SESSION_LEVELS)[number];

export const DELETION_POLICIES = ["retain", "delete"] as const;
export type DeletionPolicy = (typeof DELETION_POLICIES)[number];

export const OAUTH_SETTINGS_SUFFIX = "_Oauth";
export const GLOBAL_OAUTH_SUFFIX = "_GlblOauth";
export const OAUTH_POLICY_SUFFIX = "_OauthPlcy";
export const DEFAULT_POLICY_SUFFIX = "_Plcy";

const POLICY_TYPE = "ExtlClntAppConfigurablePolicies";
const OAUTH_SETTINGS_TYPE = "ExtlClntAppOauthSettings";
const GLOBAL_SETTINGS_TYPE = "ExtlClntAppGlobalOauthSettings";
const OAUTH_POLICY_TYPE = "ExtlClntAppOauthConfigurablePolicies";
const APPLICATION_TYPE = "ExternalClientApplication";

const PROTECTED_FIELDS = new Set(["orgScopedExternalApp", "oauthLink", "consumerKey"]);
const FORBIDDEN_PROPS = new Set([
  "shouldRotateConsumerKey",
  "shouldRotateConsumerSecret",
  "consumerSecret",
  "consumerKey",
]);

const CONSUMER_ID = /888[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?/;

export interface RefreshTokenSettings {
  readonly policy: RefreshTokenPolicy;
  readonly period?: number;
  readonly unit?: RefreshTokenUnit;
}

export interface PermittedUsersAdmin {
  readonly type: "AdminApprovedPreAuthorized";
  readonly permissionSets?: ReadonlyArray<string>;
  readonly profiles?: ReadonlyArray<string>;
}

export type PermittedUsers = { readonly type: "AllSelfAuthorized" } | PermittedUsersAdmin;

/**
 * Constructor input. `certificate` is a public PEM. The resource props that
 * Alchemy persists store `certificateSha256` instead of the PEM.
 */
export interface ExternalClientAppInput {
  readonly targetOrg?: Input<string>;
  readonly developerName: Input<string>;
  readonly label: Input<string>;
  readonly contactEmail: Input<string>;
  readonly description?: Input<string>;
  readonly oauth: {
    readonly scopes: Input<ReadonlyArray<string>>;
    readonly callbackUrl: Input<string>;
    readonly clientCredentials?: Input<{ readonly runAsUsername: string }>;
    readonly jwtBearer?: { readonly certificate: Input<string> };
    readonly permittedUsers: Input<PermittedUsers>;
    readonly ipRelaxation?: Input<IpRelaxation>;
    readonly refreshToken?: Input<RefreshTokenSettings>;
    readonly pkceRequired?: Input<boolean>;
    readonly refreshTokenRotation?: Input<boolean>;
    readonly enforceRefreshTokenTTL?: Input<boolean>;
    readonly requiredSessionLevel?: Input<SessionLevel>;
  };
  readonly enabled?: Input<boolean>;
  readonly deletionPolicy?: Input<DeletionPolicy>;
  readonly allowReplace?: Input<boolean>;
}

export interface ExternalClientAppProps {
  readonly targetOrg?: string;
  readonly developerName: string;
  readonly label: string;
  readonly contactEmail: string;
  readonly description?: string;
  readonly oauth: {
    readonly scopes: ReadonlyArray<string>;
    readonly callbackUrl: string;
    readonly clientCredentials?: { readonly runAsUsername: string };
    readonly jwtBearer?: { readonly certificateSha256: string };
    readonly permittedUsers: PermittedUsers;
    readonly ipRelaxation?: IpRelaxation;
    readonly refreshToken?: RefreshTokenSettings;
    readonly pkceRequired?: boolean;
    readonly refreshTokenRotation?: boolean;
    readonly enforceRefreshTokenTTL?: boolean;
    readonly requiredSessionLevel?: SessionLevel;
  };
  readonly enabled?: boolean;
  readonly deletionPolicy?: DeletionPolicy;
  readonly allowReplace?: boolean;
}

export interface ExternalClientAppAttributes {
  /** `ExternalClientApplication` id (`0xI`). */
  readonly id: string;
  readonly developerName: string;
  /** OAuth consumer id (`888`). Never the consumer key. */
  readonly consumerId: string;
  /** SHA-256 of the consumer key. The key itself is not stored. */
  readonly consumerKeySha256: string;
  /** SHA-256 of the public certificate body, or null when JWT bearer is off. */
  readonly certificateSha256: string | null;
  /** Discovered `ExtlClntAppConfigurablePolicies` full name. */
  readonly policyFullName: string;
  /** Digest of non-secret global OAuth settings. Not the consumer key. */
  readonly globalSettingsDigest: string;
  readonly targetOrg: string | null;
}

export type ExternalClientAppResourceType = ResourceInstance<
  "Salesforce.ExternalClientApp",
  ExternalClientAppProps,
  ExternalClientAppAttributes
>;

export const ExternalClientAppResource = Resource<ExternalClientAppResourceType>("Salesforce.ExternalClientApp");

interface NormalizedApp {
  readonly targetOrg: string | undefined;
  readonly developerName: string;
  readonly label: string;
  readonly contactEmail: string;
  readonly description: string | undefined;
  readonly scopes: ReadonlyArray<string>;
  readonly callbackUrl: string;
  readonly runAsUsername: string | undefined;
  readonly certificateSha256: string | null;
  readonly permittedUsers: PermittedUsers;
  readonly permissionSets: ReadonlyArray<string>;
  readonly profiles: ReadonlyArray<string>;
  readonly ipRelaxation: IpRelaxation;
  readonly refreshToken: RefreshTokenSettings | undefined;
  readonly pkceRequired: boolean;
  readonly refreshTokenRotation: boolean;
  readonly enforceRefreshTokenTTL: boolean;
  readonly requiredSessionLevel: SessionLevel | undefined;
  readonly enabled: boolean;
  readonly deletionPolicy: DeletionPolicy;
  readonly allowReplace: boolean;
}

interface AppBundle {
  readonly id: string;
  readonly developerName: string;
  readonly consumerId: string | undefined;
  readonly consumerKey: string | undefined;
  readonly policyFullName: string | undefined;
  readonly application: MetadataComponent | undefined;
  readonly oauthSettings: MetadataComponent | undefined;
  readonly globalSettings: MetadataComponent | undefined;
  readonly oauthPolicy: MetadataComponent | undefined;
  readonly configurablePolicy: MetadataComponent | undefined;
}

const certificatesByLogicalId = new Map<string, string>();

/** Drop in-memory public certificates. Tests call this between cases. */
export const clearExternalClientAppCertificates = (): void => {
  certificatesByLogicalId.clear();
};

const rememberCertificate = (logicalId: string, pem: string | undefined): void => {
  if (pem === undefined) {
    certificatesByLogicalId.delete(logicalId);
    return;
  }
  certificatesByLogicalId.set(logicalId, pem);
};

export const certificateBody = (pem: string): string =>
  pem
    .replaceAll("\r\n", "\n")
    .replaceAll("-----BEGIN CERTIFICATE-----", "")
    .replaceAll("-----END CERTIFICATE-----", "")
    .replace(/\s+/g, "");

const normalizePem = (pem: string): string => pem.replaceAll("\r\n", "\n").trim();

const assertPublicCertificate = (pem: string): Effect.Effect<void, SalesforceValidationError> => {
  if (pem.includes("PRIVATE KEY")) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          "jwtBearer.certificate must be a public PEM certificate. A private key is rejected and is not stored.",
      }),
    );
  }
  if (!pem.includes("BEGIN CERTIFICATE") || certificateBody(pem).length < 16) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "jwtBearer.certificate must be a public PEM certificate (BEGIN CERTIFICATE).",
      }),
    );
  }
  if (pem.length > 16_384) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "jwtBearer.certificate is larger than 16 KB.",
      }),
    );
  }
  return Effect.void;
};

const concreteCertificate = (value: Input<string>): Effect.Effect<string, SalesforceValidationError> => {
  if (typeof value === "string") {
    return Effect.succeed(value);
  }
  if (Redacted.isRedacted(value)) {
    return Effect.succeed(Redacted.value(value as Redacted.Redacted<string>));
  }
  return Effect.fail(
    new SalesforceValidationError({
      message:
        "jwtBearer.certificate must be a public PEM string or Redacted.make(pem). " +
        "State stores only the SHA-256, so yield Config in the stack and pass the string.",
    }),
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const rejectForbidden = (value: unknown): Effect.Effect<void, SalesforceValidationError> => {
  if (Array.isArray(value)) {
    return Effect.forEach(value, rejectForbidden, { discard: true, concurrency: 1 });
  }
  if (!isPlainRecord(value)) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PROPS.has(key)) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message:
              `ExternalClientApp cannot set ${key}. Rotating the consumer key or secret creates new credentials. ` +
              "Deploys copy the existing consumer key and force shouldRotateConsumerKey and " +
              "shouldRotateConsumerSecret to false.",
          }),
        );
      }
      yield* rejectForbidden(child);
    }
  });
};

const member = <T extends string>(value: string, allowed: ReadonlyArray<T>, label: string) => {
  if ((allowed as ReadonlyArray<string>).includes(value)) {
    return Effect.succeed(value as T);
  }
  return Effect.fail(
    new SalesforceValidationError({
      message: `${label} '${value}' is not supported. Use ${allowed.join(", ")}.`,
    }),
  );
};

const commaList = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .sort((left, right) => left.localeCompare(right));

const sameComma = (live: string | undefined, desired: ReadonlyArray<string>): boolean =>
  commaList(live).join("\0") ===
  [...desired]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .sort((left, right) => left.localeCompare(right))
    .join("\0");

const joinComma = (values: ReadonlyArray<string>): string =>
  [...values]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .sort((left, right) => left.localeCompare(right))
    .join(", ");

const textOf = (fields: MetadataFields | undefined, key: string): string | undefined => {
  const value = fields?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const boolOf = (fields: MetadataFields | undefined, key: string, fallback: boolean): boolean => {
  const value = fields?.[key];
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return fallback;
};

const blankToUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const uniqueNames = (
  values: ReadonlyArray<string> | undefined,
  label: string,
): Effect.Effect<ReadonlyArray<string>, SalesforceValidationError> =>
  Effect.gen(function* () {
    const names: string[] = [];
    for (const value of values ?? []) {
      const name = value.trim();
      if (name.length === 0 || name.length > 80) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `${label} names must be 1 to 80 characters.`,
          }),
        );
      }
      if (!names.includes(name)) {
        names.push(name);
      }
    }
    names.sort((left, right) => left.localeCompare(right));
    return names;
  });

const normalize = (props: ExternalClientAppProps): Effect.Effect<NormalizedApp, SalesforceValidationError> =>
  Effect.gen(function* () {
    yield* rejectForbidden(props);
    const developerName = yield* requireDeveloperName(props.developerName, "ExternalClientApp developerName");
    const label = props.label.trim();
    if (label.length === 0 || label.length > 80) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalClientApp label must be 1 to 80 characters.",
        }),
      );
    }
    const contactEmail = props.contactEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalClientApp contactEmail must be an email address.",
        }),
      );
    }
    const description = blankToUndefined(props.description);
    if (description !== undefined && description.length > 1000) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalClientApp description must be at most 1000 characters.",
        }),
      );
    }
    const callbackUrl = yield* assertOrgUrl(props.oauth.callbackUrl, "ExternalClientApp callbackUrl");
    const scopes: string[] = [];
    for (const scope of props.oauth.scopes) {
      const name = scope.trim();
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: `OAuth scope '${scope}' must be a Salesforce scope name such as Api or RefreshToken.`,
          }),
        );
      }
      if (!scopes.includes(name)) {
        scopes.push(name);
      }
    }
    if (scopes.length === 0) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "ExternalClientApp oauth.scopes requires at least one scope.",
        }),
      );
    }
    scopes.sort((left, right) => left.localeCompare(right));
    const permitted = props.oauth.permittedUsers;
    if (permitted.type !== "AllSelfAuthorized" && permitted.type !== "AdminApprovedPreAuthorized") {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "permittedUsers.type must be AllSelfAuthorized or AdminApprovedPreAuthorized.",
        }),
      );
    }
    const permissionSets =
      permitted.type === "AdminApprovedPreAuthorized"
        ? yield* uniqueNames(permitted.permissionSets, "Permission set")
        : [];
    const profiles =
      permitted.type === "AdminApprovedPreAuthorized" ? yield* uniqueNames(permitted.profiles, "Profile") : [];
    if (permitted.type === "AdminApprovedPreAuthorized" && permissionSets.length === 0 && profiles.length === 0) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "AdminApprovedPreAuthorized requires at least one permission set or profile. They are not created.",
        }),
      );
    }
    const ipRelaxation = yield* member(
      props.oauth.ipRelaxation ?? "Enforce",
      IP_RELAXATIONS,
      "ipRelaxation",
    );
    const refresh = props.oauth.refreshToken;
    if (refresh !== undefined) {
      yield* member(refresh.policy, REFRESH_TOKEN_POLICIES, "refreshToken.policy");
      const specific = refresh.policy === "SpecificLifetime" || refresh.policy === "SpecificInactivity";
      if (specific) {
        if (refresh.period === undefined || !Number.isInteger(refresh.period) || refresh.period < 1) {
          return yield* Effect.fail(
            new SalesforceValidationError({
              message: "refreshToken.period must be a positive integer for a specific lifetime or inactivity policy.",
            }),
          );
        }
        if (refresh.unit === undefined) {
          return yield* Effect.fail(
            new SalesforceValidationError({
              message: "refreshToken.unit is required for a specific lifetime or inactivity policy.",
            }),
          );
        }
        yield* member(refresh.unit, REFRESH_TOKEN_UNITS, "refreshToken.unit");
      } else if (refresh.period !== undefined || refresh.unit !== undefined) {
        return yield* Effect.fail(
          new SalesforceValidationError({
            message: "refreshToken.period and unit are only used with SpecificLifetime or SpecificInactivity.",
          }),
        );
      }
    }
    const requiredSessionLevel =
      props.oauth.requiredSessionLevel === undefined
        ? undefined
        : yield* member(props.oauth.requiredSessionLevel, SESSION_LEVELS, "requiredSessionLevel");
    const deletionPolicy = yield* member(props.deletionPolicy ?? "retain", DELETION_POLICIES, "deletionPolicy");
    const runAs = props.oauth.clientCredentials?.runAsUsername.trim();
    if (
      props.oauth.clientCredentials !== undefined &&
      (runAs === undefined || runAs.length === 0 || runAs.length > 80)
    ) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: "clientCredentials.runAsUsername must be 1 to 80 characters. The user is not created.",
        }),
      );
    }
    return {
      targetOrg: props.targetOrg,
      developerName,
      label,
      contactEmail,
      description,
      scopes,
      callbackUrl,
      runAsUsername: runAs,
      certificateSha256: props.oauth.jwtBearer?.certificateSha256 ?? null,
      permittedUsers:
        permitted.type === "AllSelfAuthorized"
          ? { type: "AllSelfAuthorized" }
          : { type: "AdminApprovedPreAuthorized", permissionSets, profiles },
      permissionSets,
      profiles,
      ipRelaxation,
      refreshToken: refresh,
      pkceRequired: props.oauth.pkceRequired ?? true,
      refreshTokenRotation: props.oauth.refreshTokenRotation ?? false,
      enforceRefreshTokenTTL: props.oauth.enforceRefreshTokenTTL ?? false,
      requiredSessionLevel,
      enabled: props.enabled ?? true,
      deletionPolicy,
      allowReplace: props.allowReplace ?? false,
    };
  });

const globalSettingsDigest = (app: NormalizedApp): string =>
  sha256Hex(
    JSON.stringify({
      callbackUrl: app.callbackUrl,
      certificateSha256: app.certificateSha256,
      clientCredentials: app.runAsUsername !== undefined,
      enforceRefreshTokenTTL: app.enforceRefreshTokenTTL,
      pkceRequired: app.pkceRequired,
      refreshTokenRotation: app.refreshTokenRotation,
    }),
  );

const consumerIdFrom = (oauthLink: string | undefined): string | undefined => {
  if (oauthLink === undefined) {
    return undefined;
  }
  return CONSUMER_ID.exec(oauthLink)?.[0];
};

const stringRecordField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const firstComponent = (connection: ResolvedConnection, type: string, fullName: string) =>
  Effect.gen(function* () {
    const records = yield* readMetadata(connection, type, [fullName]);
    return records.find((record) => record.fullName === fullName);
  });

const loadBundle = (connection: ResolvedConnection, developerName: string) =>
  Effect.gen(function* () {
    const rows = yield* queryRecords(
      connection,
      "SELECT Id, DeveloperName, MasterLabel, ContactEmail, Description " +
        `FROM ExternalClientApplication WHERE DeveloperName = ${soqlString(developerName)}`,
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const id = stringRecordField(row, "Id");
    if (id === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `ExternalClientApplication '${developerName}' was missing Id.`,
          status: 200,
          errorCode: undefined,
          method: "GET",
          path: "/query",
        }),
      );
    }
    const listed = yield* listMetadata(connection, POLICY_TYPE);
    const policies = yield* readMetadata(
      connection,
      POLICY_TYPE,
      listed.map((item) => item.fullName),
    );
    const matches = policies.filter(
      (policy) => textOf(policy.fields, "externalClientApplication") === developerName,
    );
    if (matches.length > 1) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message:
            `External Client App '${developerName}' has more than one ExtlClntAppConfigurablePolicies ` +
            `record (${matches.map((policy) => policy.fullName).join(", ")}).`,
        }),
      );
    }
    const oauthSettings = yield* firstComponent(
      connection,
      OAUTH_SETTINGS_TYPE,
      `${developerName}${OAUTH_SETTINGS_SUFFIX}`,
    );
    const globalSettings = yield* firstComponent(
      connection,
      GLOBAL_SETTINGS_TYPE,
      `${developerName}${GLOBAL_OAUTH_SUFFIX}`,
    );
    const oauthPolicy = yield* firstComponent(
      connection,
      OAUTH_POLICY_TYPE,
      `${developerName}${OAUTH_POLICY_SUFFIX}`,
    );
    const application = yield* firstComponent(connection, APPLICATION_TYPE, developerName);
    return {
      id,
      developerName,
      consumerId: consumerIdFrom(textOf(oauthSettings?.fields, "oauthLink")),
      consumerKey: textOf(globalSettings?.fields, "consumerKey"),
      policyFullName: matches[0]?.fullName,
      application,
      oauthSettings,
      globalSettings,
      oauthPolicy,
      configurablePolicy: matches[0],
    };
  });

const missingCredential = (developerName: string, which: "consumer id" | "consumer key") =>
  new SalesforceApiError({
    message:
      `External Client App '${developerName}' did not return a ${which} from Metadata readMetadata. ` +
      "Enable 'Allow access to OAuth consumer secrets via Metadata API' to read global OAuth settings. " +
      "The consumer key is not included in this error, and readMetadata responses must not be logged.",
    status: 200,
    errorCode: undefined,
    method: "POST",
    path: "/services/Soap/m",
  });

const attributesFrom = (
  bundle: AppBundle,
  app: NormalizedApp,
): Effect.Effect<ExternalClientAppAttributes, SalesforceApiError> => {
  if (bundle.consumerId === undefined) {
    return Effect.fail(missingCredential(app.developerName, "consumer id"));
  }
  if (bundle.consumerKey === undefined) {
    return Effect.fail(missingCredential(app.developerName, "consumer key"));
  }
  const policyFullName = bundle.policyFullName ?? `${app.developerName}${DEFAULT_POLICY_SUFFIX}`;
  return Effect.succeed({
    id: bundle.id,
    developerName: app.developerName,
    consumerId: bundle.consumerId,
    consumerKeySha256: sha256Hex(bundle.consumerKey),
    certificateSha256: app.certificateSha256,
    policyFullName,
    globalSettingsDigest: globalSettingsDigest(app),
    targetOrg: app.targetOrg ?? null,
  });
};

const overlay = (
  base: MetadataFields | undefined,
  updates: Readonly<Record<string, MetadataField | undefined>>,
): MetadataFields => {
  const next: Record<string, MetadataField> = { ...(base ?? {}) };
  delete next.fullName;
  delete next.consumerSecret;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      if (!PROTECTED_FIELDS.has(key)) {
        delete next[key];
      }
      continue;
    }
    next[key] = value;
  }
  delete next.consumerSecret;
  return next;
};

const applicationChanged = (bundle: AppBundle | undefined, app: NormalizedApp): boolean => {
  const fields = bundle?.application?.fields;
  if (fields === undefined) {
    return true;
  }
  return (
    textOf(fields, "label") !== app.label ||
    textOf(fields, "contactEmail") !== app.contactEmail ||
    blankToUndefined(textOf(fields, "description")) !== app.description
  );
};

const oauthSettingsChanged = (bundle: AppBundle | undefined, app: NormalizedApp): boolean => {
  const fields = bundle?.oauthSettings?.fields;
  if (fields === undefined) {
    return true;
  }
  return (
    !sameComma(textOf(fields, "commaSeparatedOauthScopes"), app.scopes) ||
    textOf(fields, "externalClientApplication") !== app.developerName
  );
};

const certificateChanged = (livePem: string | undefined, desiredPem: string | undefined): boolean =>
  certificateBody(livePem ?? "") !== certificateBody(desiredPem ?? "");

const globalChanged = (bundle: AppBundle | undefined, app: NormalizedApp, pem: string | undefined): boolean => {
  const fields = bundle?.globalSettings?.fields;
  if (fields === undefined) {
    return true;
  }
  const specificClient = app.runAsUsername !== undefined;
  return (
    textOf(fields, "callbackUrl") !== app.callbackUrl ||
    certificateChanged(textOf(fields, "certificate"), pem) ||
    boolOf(fields, "isPkceRequired", true) !== app.pkceRequired ||
    boolOf(fields, "isRefreshTokenRotationEnabled", false) !== app.refreshTokenRotation ||
    boolOf(fields, "isEnforceRefreshTokenTTL", false) !== app.enforceRefreshTokenTTL ||
    boolOf(fields, "isClientCredentialsFlowEnabled", false) !== specificClient
  );
};

const refreshChanged = (fields: MetadataFields, app: NormalizedApp): boolean => {
  if (app.refreshToken === undefined) {
    return false;
  }
  if (textOf(fields, "refreshTokenPolicyType") !== app.refreshToken.policy) {
    return true;
  }
  const specific = app.refreshToken.policy === "SpecificLifetime" || app.refreshToken.policy === "SpecificInactivity";
  if (!specific) {
    return (
      textOf(fields, "refreshTokenValidityPeriod") !== undefined ||
      textOf(fields, "refreshTokenValidityUnit") !== undefined
    );
  }
  return (
    textOf(fields, "refreshTokenValidityPeriod") !== String(app.refreshToken.period) ||
    textOf(fields, "refreshTokenValidityUnit") !== app.refreshToken.unit
  );
};

const oauthPolicyChanged = (bundle: AppBundle | undefined, app: NormalizedApp): boolean => {
  const fields = bundle?.oauthPolicy?.fields;
  if (fields === undefined) {
    return true;
  }
  const sessionDiffers =
    app.requiredSessionLevel !== undefined && textOf(fields, "requiredSessionLevel") !== app.requiredSessionLevel;
  return (
    textOf(fields, "externalClientApplication") !== app.developerName ||
    textOf(fields, "permittedUsersPolicyType") !== app.permittedUsers.type ||
    textOf(fields, "ipRelaxationPolicyType") !== app.ipRelaxation ||
    boolOf(fields, "isClientCredentialsFlowEnabled", false) !== (app.runAsUsername !== undefined) ||
    (textOf(fields, "clientCredentialsFlowUser") ?? undefined) !== app.runAsUsername ||
    !sameComma(textOf(fields, "commaSeparatedPermissionSet"), app.permissionSets) ||
    !sameComma(textOf(fields, "commaSeparatedProfile"), app.profiles) ||
    refreshChanged(fields, app) ||
    sessionDiffers
  );
};

const policyChanged = (bundle: AppBundle | undefined, app: NormalizedApp): boolean => {
  const fields = bundle?.configurablePolicy?.fields;
  if (fields === undefined) {
    return true;
  }
  return (
    textOf(fields, "externalClientApplication") !== app.developerName ||
    boolOf(fields, "isEnabled", true) !== app.enabled ||
    boolOf(fields, "isOauthPluginEnabled", true) !== true
  );
};

const refreshUpdates = (app: NormalizedApp): Record<string, MetadataField | undefined> => {
  if (app.refreshToken === undefined) {
    return {};
  }
  const specific = app.refreshToken.policy === "SpecificLifetime" || app.refreshToken.policy === "SpecificInactivity";
  return {
    refreshTokenPolicyType: app.refreshToken.policy,
    refreshTokenValidityPeriod: specific ? String(app.refreshToken.period) : undefined,
    refreshTokenValidityUnit: specific ? app.refreshToken.unit : undefined,
  };
};

const changedFiles = (
  bundle: AppBundle | undefined,
  app: NormalizedApp,
  pem: string | undefined,
): MetadataFile[] => {
  const files: MetadataFile[] = [];
  if (applicationChanged(bundle, app)) {
    const fields = bundle?.application?.fields;
    files.push({
      type: APPLICATION_TYPE,
      fullName: app.developerName,
      fields: overlay(fields, {
        contactEmail: app.contactEmail,
        description: app.description,
        distributionState: textOf(fields, "distributionState") ?? "Local",
        label: app.label,
      }),
    });
  }
  if (oauthSettingsChanged(bundle, app)) {
    const fields = bundle?.oauthSettings?.fields;
    files.push({
      type: OAUTH_SETTINGS_TYPE,
      fullName: `${app.developerName}${OAUTH_SETTINGS_SUFFIX}`,
      fields: overlay(fields, {
        commaSeparatedOauthScopes: joinComma(app.scopes),
        externalClientApplication: app.developerName,
        label: textOf(fields, "label") ?? `${app.label} OAuth`,
      }),
    });
  }
  if (globalChanged(bundle, app, pem)) {
    const fields = bundle?.globalSettings?.fields;
    const consumerKey = textOf(fields, "consumerKey");
    files.push({
      type: GLOBAL_SETTINGS_TYPE,
      fullName: `${app.developerName}${GLOBAL_OAUTH_SUFFIX}`,
      fields: overlay(fields, {
        callbackUrl: app.callbackUrl,
        certificate: pem === undefined ? undefined : normalizePem(pem),
        externalClientApplication: app.developerName,
        isClientCredentialsFlowEnabled: app.runAsUsername !== undefined,
        isEnforceRefreshTokenTTL: app.enforceRefreshTokenTTL,
        isPkceRequired: app.pkceRequired,
        isRefreshTokenRotationEnabled: app.refreshTokenRotation,
        label: textOf(fields, "label") ?? app.developerName,
        shouldRotateConsumerKey: false,
        shouldRotateConsumerSecret: false,
        ...(consumerKey === undefined ? {} : { consumerKey }),
      }),
    });
  }
  if (oauthPolicyChanged(bundle, app)) {
    const fields = bundle?.oauthPolicy?.fields;
    files.push({
      type: OAUTH_POLICY_TYPE,
      fullName: `${app.developerName}${OAUTH_POLICY_SUFFIX}`,
      fields: overlay(fields, {
        clientCredentialsFlowUser: app.runAsUsername,
        commaSeparatedPermissionSet: app.permissionSets.length === 0 ? undefined : joinComma(app.permissionSets),
        commaSeparatedProfile: app.profiles.length === 0 ? undefined : joinComma(app.profiles),
        externalClientApplication: app.developerName,
        ipRelaxationPolicyType: app.ipRelaxation,
        isClientCredentialsFlowEnabled: app.runAsUsername !== undefined,
        label: textOf(fields, "label") ?? `${app.label} OAuth Policy`,
        permittedUsersPolicyType: app.permittedUsers.type,
        ...(app.requiredSessionLevel === undefined ? {} : { requiredSessionLevel: app.requiredSessionLevel }),
        ...refreshUpdates(app),
      }),
    });
  }
  if (policyChanged(bundle, app)) {
    const fields = bundle?.configurablePolicy?.fields;
    const fullName = bundle?.policyFullName ?? `${app.developerName}${DEFAULT_POLICY_SUFFIX}`;
    files.push({
      type: POLICY_TYPE,
      fullName,
      fields: overlay(fields, {
        externalClientApplication: app.developerName,
        isEnabled: app.enabled,
        isOauthPluginEnabled: true,
        label: textOf(fields, "label") ?? `${app.label} Policy`,
      }),
    });
  }
  return files;
};

const assertExists = (connection: ResolvedConnection, soql: string, label: string) =>
  Effect.gen(function* () {
    const rows = yield* queryRecords(connection, soql);
    if (rows.length !== 1) {
      return yield* Effect.fail(
        new SalesforceValidationError({
          message: `${label} was not found. ExternalClientApp does not create it.`,
        }),
      );
    }
  });

const validateReferences = (connection: ResolvedConnection, app: NormalizedApp) =>
  Effect.gen(function* () {
    if (app.runAsUsername !== undefined) {
      yield* assertExists(
        connection,
        `SELECT Id FROM User WHERE Username = ${soqlString(app.runAsUsername)}`,
        `Run As user '${app.runAsUsername}'`,
      );
    }
    for (const name of app.permissionSets) {
      yield* assertExists(
        connection,
        "SELECT Id FROM PermissionSet " +
          `WHERE Name = ${soqlString(name)} AND IsOwnedByProfile = false`,
        `Permission set '${name}'`,
      );
    }
    for (const name of app.profiles) {
      yield* assertExists(
        connection,
        `SELECT Id FROM Profile WHERE Name = ${soqlString(name)}`,
        `Profile '${name}'`,
      );
    }
  });

const requireCertificate = (
  logicalId: string,
  app: NormalizedApp,
): Effect.Effect<string | undefined, SalesforceValidationError> => {
  if (app.certificateSha256 === null) {
    return Effect.succeed(undefined);
  }
  const pem = certificatesByLogicalId.get(logicalId);
  if (pem === undefined) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `Public certificate for '${app.developerName}' is not in this process. ` +
          "Pass the PEM to Salesforce.ExternalClientApp. State stores only the SHA-256.",
      }),
    );
  }
  if (sha256Hex(certificateBody(pem)) !== app.certificateSha256) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `Public certificate for '${app.developerName}' does not match the SHA-256 in state. ` +
          "The certificate is not included in this error.",
      }),
    );
  }
  return assertPublicCertificate(pem).pipe(Effect.as(pem));
};

const credentialsUnchanged = (
  before: AppBundle | undefined,
  after: AppBundle,
  developerName: string,
): Effect.Effect<void, SalesforceApiError> => {
  if (after.consumerId === undefined) {
    return Effect.fail(missingCredential(developerName, "consumer id"));
  }
  if (after.consumerKey === undefined) {
    return Effect.fail(missingCredential(developerName, "consumer key"));
  }
  const idChanged = before?.consumerId !== undefined && before.consumerId !== after.consumerId;
  const keyChanged =
    before?.consumerKey !== undefined && sha256Hex(before.consumerKey) !== sha256Hex(after.consumerKey);
  if (idChanged || keyChanged) {
    return Effect.fail(
      new SalesforceApiError({
        message:
          `External Client App '${developerName}' changed its consumer id or consumer key during deploy. ` +
          "The key is not included in this error. Updates copy the existing consumer key and force " +
          "shouldRotateConsumerKey and shouldRotateConsumerSecret to false. " +
          "A changed hash means the org rotated the consumer.",
        status: 200,
        errorCode: "CONSUMER_KEY_CHANGED",
        method: "POST",
        path: "/services/data/metadata/deployRequest",
      }),
    );
  }
  return Effect.void;
};

const declareApp = (id: string, props: ExternalClientAppInput) =>
  Effect.gen(function* () {
    yield* rejectForbidden(props);
    const certificate = props.oauth.jwtBearer?.certificate;
    let certificateSha256: string | undefined;
    if (certificate !== undefined) {
      const pem = yield* concreteCertificate(certificate);
      yield* assertPublicCertificate(pem);
      certificateSha256 = sha256Hex(certificateBody(pem));
      rememberCertificate(id, pem);
    } else {
      rememberCertificate(id, undefined);
    }
    const { jwtBearer: _jwtBearer, ...oauthRest } = props.oauth;
    return yield* ExternalClientAppResource(id, {
      ...(props.targetOrg === undefined ? {} : { targetOrg: props.targetOrg }),
      developerName: props.developerName,
      label: props.label,
      contactEmail: props.contactEmail,
      ...(props.description === undefined ? {} : { description: props.description }),
      oauth: {
        ...oauthRest,
        ...(certificateSha256 === undefined ? {} : { jwtBearer: { certificateSha256 } }),
      },
      ...(props.enabled === undefined ? {} : { enabled: props.enabled }),
      ...(props.deletionPolicy === undefined ? {} : { deletionPolicy: props.deletionPolicy }),
      ...(props.allowReplace === undefined ? {} : { allowReplace: props.allowReplace }),
    });
  });

export const ExternalClientApp = Object.assign(declareApp, {
  Type: ExternalClientAppResource.Type,
  Provider: ExternalClientAppResource.Provider,
});

/**
 * Nuke is skipped. External Client Apps are not tagged with an Alchemy owner,
 * and a stack must not delete every app in the org.
 */
export const ExternalClientAppProvider = Provider.succeed(
  ExternalClientAppResource,
  ExternalClientAppResource.Provider.of({
    stables: ["id", "consumerId"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        const replacing =
          targetOrgChanged(input.olds.targetOrg, input.news.targetOrg) ||
          input.olds.developerName !== input.news.developerName;
        if (!replacing) {
          return undefined;
        }
        if (input.news.allowReplace !== true) {
          return yield* Effect.fail(
            new SalesforceValidationError({
              message:
                `Changing developerName or targetOrg replaces External Client App '${input.olds.developerName}' ` +
                "and creates a new consumer key and secret. Set allowReplace: true to allow that replacement.",
            }),
          );
        }
        return { action: "replace" as const, deleteFirst: true };
      }),
    read: (input) =>
      Effect.gen(function* () {
        const app = yield* normalize(input.olds);
        const connection = yield* connectionFor(app.targetOrg);
        const bundle = yield* loadBundle(connection, app.developerName);
        if (bundle === undefined) {
          return undefined;
        }
        return yield* attributesFrom(bundle, app);
      }),
    observe: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news)) {
          return undefined;
        }
        const app = yield* normalize(input.news);
        const connection = yield* connectionFor(app.targetOrg);
        const bundle = yield* loadBundle(connection, app.developerName);
        if (bundle === undefined) {
          return undefined;
        }
        return yield* attributesFrom(bundle, app);
      }),
    list: () =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(undefined);
        const rows = yield* queryRecords(
          connection,
          "SELECT Id, DeveloperName FROM ExternalClientApplication",
        );
        const attributes: ExternalClientAppAttributes[] = [];
        for (const row of rows) {
          const developerName = stringRecordField(row, "DeveloperName");
          if (developerName === undefined) {
            continue;
          }
          const bundle = yield* loadBundle(connection, developerName);
          if (bundle?.consumerId === undefined || bundle.consumerKey === undefined) {
            continue;
          }
          const fields = bundle.globalSettings?.fields;
          const certificate = textOf(fields, "certificate");
          const certificateSha256 = certificate === undefined ? null : sha256Hex(certificateBody(certificate));
          attributes.push({
            id: bundle.id,
            developerName,
            consumerId: bundle.consumerId,
            consumerKeySha256: sha256Hex(bundle.consumerKey),
            certificateSha256,
            policyFullName: bundle.policyFullName ?? `${developerName}${DEFAULT_POLICY_SUFFIX}`,
            globalSettingsDigest: sha256Hex(
              JSON.stringify({
                callbackUrl: textOf(fields, "callbackUrl") ?? "",
                certificateSha256,
                clientCredentials: boolOf(fields, "isClientCredentialsFlowEnabled", false),
                enforceRefreshTokenTTL: boolOf(fields, "isEnforceRefreshTokenTTL", false),
                pkceRequired: boolOf(fields, "isPkceRequired", true),
                refreshTokenRotation: boolOf(fields, "isRefreshTokenRotationEnabled", false),
              }),
            ),
            targetOrg: null,
          });
        }
        return attributes;
      }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const app = yield* normalize(input.news);
        const pem = yield* requireCertificate(input.id, app);
        const connection = yield* connectionFor(app.targetOrg);
        const bundle = yield* loadBundle(connection, app.developerName);
        const files = changedFiles(bundle, app, pem);
        yield* validateReferences(connection, app);
        if (files.length === 0 && bundle !== undefined) {
          return yield* attributesFrom(bundle, app);
        }
        const sensitive = [bundle?.consumerKey, pem].filter(
          (value): value is string => value !== undefined && value.length >= 4,
        );
        if (files.length > 0) {
          yield* deployMetadata(connection, { files, sensitive });
        }
        const after = yield* loadBundle(connection, app.developerName);
        if (after === undefined) {
          return yield* Effect.fail(
            new SalesforceApiError({
              message: `External Client App '${app.developerName}' was not found after deploy.`,
              status: 404,
              errorCode: "NOT_FOUND",
              method: "GET",
              path: "/query",
            }),
          );
        }
        yield* credentialsUnchanged(bundle, after, app.developerName);
        return yield* attributesFrom(after, app);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        if ((input.olds.deletionPolicy ?? "retain") !== "delete") {
          return;
        }
        const connection = yield* connectionFor(input.olds.targetOrg);
        const developerName = input.olds.developerName;
        const listed = yield* listMetadata(connection, POLICY_TYPE);
        const policies = yield* readMetadata(
          connection,
          POLICY_TYPE,
          listed.map((item) => item.fullName),
        );
        const policyNames = new Set<string>(
          [
            input.output.policyFullName,
            ...policies
              .filter((policy) => textOf(policy.fields, "externalClientApplication") === developerName)
              .map((policy) => policy.fullName),
          ].filter((name) => name.length > 0),
        );
        const destructive = [
          { type: OAUTH_SETTINGS_TYPE, fullName: `${developerName}${OAUTH_SETTINGS_SUFFIX}` },
          { type: GLOBAL_SETTINGS_TYPE, fullName: `${developerName}${GLOBAL_OAUTH_SUFFIX}` },
          { type: OAUTH_POLICY_TYPE, fullName: `${developerName}${OAUTH_POLICY_SUFFIX}` },
          ...[...policyNames].map((fullName) => ({ type: POLICY_TYPE, fullName })),
          { type: APPLICATION_TYPE, fullName: developerName },
        ];
        yield* deployMetadata(connection, {
          destructive,
          sensitive: [],
        });
      }),
  }),
);
