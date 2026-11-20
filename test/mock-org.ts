import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly method: string;
  readonly resource: string;
  readonly id?: string;
  readonly body?: unknown;
  readonly soql?: string;
  /** Pathname plus query, so tests can assert Connect REST URLs. */
  readonly path?: string;
}

interface StoredSite {
  Id: string;
  DeveloperName: string;
  MasterLabel: string;
  EndpointUrl: string;
  IsActive: boolean;
  Context: string;
  Description: string | null;
  IsApplicableToConnectSrc: boolean;
  IsApplicableToFontSrc: boolean;
  IsApplicableToFrameSrc: boolean;
  IsApplicableToImgSrc: boolean;
  IsApplicableToMediaSrc: boolean;
  IsApplicableToStyleSrc: boolean;
}

interface StoredUser {
  Id: string;
  Username: string;
}

interface StoredPermissionSet {
  Id: string;
  Name: string;
  NamespacePrefix: string | null;
  IsOwnedByProfile: boolean;
}

interface StoredAssignment {
  Id: string;
  AssigneeId: string;
  PermissionSetId: string;
  PermissionSetGroupId: string | null;
}

interface StoredPermissionSetGroup {
  Id: string;
  DeveloperName: string;
  NamespacePrefix: string | null;
  Status: string;
}

interface StoredActiveScratchOrg {
  Id: string;
  ScratchOrg: string;
  SignupUsername: string;
  Status: string;
  ExpirationDate: string;
}

interface StoredCorsOrigin {
  Id: string;
  DeveloperName: string;
  MasterLabel: string;
  UrlPattern: string;
}

export interface MockOrg {
  readonly url: string;
  readonly requests: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
  setPageSize(size: number): void;
  seedUser(username: string, id?: string): string;
  seedPermissionSet(
    name: string,
    options?: { readonly namespace?: string | null; readonly id?: string; readonly ownedByProfile?: boolean },
  ): string;
  permissionSetId(name: string): string | undefined;
  seedTrustedSite(fields: { readonly DeveloperName: string; readonly EndpointUrl?: string; readonly IsActive?: boolean }): string;
  seedAssignment(assigneeId: string, permissionSetId: string): string;
  seedRemoteSite(fields: {
    readonly SiteName: string;
    readonly EndpointUrl?: string;
    readonly IsActive?: boolean;
    readonly DisableProtocolSecurity?: boolean;
  }): string;
  setRejectRemoteDelete(reject: boolean): void;
  seedPermissionSetGroup(
    developerName: string,
    options?: { readonly namespace?: string | null; readonly status?: string },
  ): string;
  seedGroupAssignment(assigneeId: string, permissionSetGroupId: string): string;
  seedCorsOrigin(fields: { readonly DeveloperName: string; readonly UrlPattern?: string }): string;
  /** Change a CORS row behind the provider's back, as an admin in Setup would. */
  editCorsOrigin(id: string, fields: Partial<Omit<StoredCorsOrigin, "Id">>): void;
  corsOrigins(): ReadonlyArray<StoredCorsOrigin>;
  /** Dev Hub record for a scratch org. `orgId` may be 15 or 18 characters. */
  seedActiveScratchOrg(fields: { readonly orgId: string; readonly username: string; readonly status?: string }): string;
  activeScratchOrgs(): ReadonlyArray<StoredActiveScratchOrg>;
  removeTrustedSites(): void;
  sites(): ReadonlyArray<StoredSite>;
  assignments(): ReadonlyArray<StoredAssignment>;
  remoteSites(): ReadonlyArray<StoredRemoteSite>;
  seedExternalCredential(fields: {
    readonly developerName: string;
    readonly masterLabel?: string;
    readonly authenticationProtocol?: string;
    readonly authenticationProtocolVariant?: string;
    readonly calloutUrl?: string;
    readonly principalName?: string;
  }): { readonly id: string; readonly principalId: string };
  seedNamedCredential(fields: {
    readonly developerName: string;
    readonly calloutUrl?: string;
    readonly externalCredential: string;
    readonly masterLabel?: string;
  }): string;
  seedCredential(fields: {
    readonly externalCredential: string;
    readonly principalName: string;
    readonly principalType?: string;
    readonly credentials: Readonly<Record<string, { readonly value: string; readonly encrypted: boolean }>>;
  }): void;
  seedSetupEntityAccess(parentId: string, setupEntityId: string): string;
  setEchoCredentialFailure(echo: boolean): void;
  /**
   * GET /credential reports a configured credential that is not stored, and
   * PUT returns Salesforce's "use POST" error. Exercises the update fallback.
   */
  setRejectUnstoredCredentialPut(reject: boolean): void;
  externalCredentials(): ReadonlyArray<{ readonly developerName: string; readonly id: string }>;
  namedCredentials(): ReadonlyArray<{ readonly developerName: string; readonly calloutUrl: string }>;
  credentialKeys(): ReadonlyArray<{ readonly externalCredential: string; readonly keys: ReadonlyArray<string> }>;
  setupEntityAccess(): ReadonlyArray<StoredSetupAccess>;
  removeExternalCredential(developerName: string): void;
  removeNamedCredential(developerName: string): void;
  removeCredentials(): void;
  removeSetupEntityAccess(): void;
}

export interface MockOrgOptions {
  readonly token?: string;
  readonly orgId?: string;
  readonly username?: string;
}

interface StoredRemoteSite {
  Id: string;
  SiteName: string;
  EndpointUrl: string;
  IsActive: boolean;
  ProtocolMismatch: boolean;
  Description: string | null;
}

interface StoredParameter {
  parameterName: string;
  parameterType: string;
  parameterValue: string;
}

interface StoredPrincipal {
  id: string;
  principalName: string;
  principalType: string;
  sequenceNumber: number;
  parameters: StoredParameter[];
}

interface StoredHeader {
  headerName: string;
  headerValue: string;
  sequenceNumber: number;
}

interface StoredExternalCredential {
  id: string;
  developerName: string;
  masterLabel: string;
  authenticationProtocol: string;
  authenticationProtocolVariant: string | null;
  parameters: StoredParameter[];
  principals: StoredPrincipal[];
  customHeaders: StoredHeader[];
}

interface StoredNamedCredential {
  id: string;
  developerName: string;
  masterLabel: string;
  type: string;
  calloutUrl: string;
  externalCredential: string;
  description: string | null;
  allowMergeFieldsInBody: boolean;
  allowMergeFieldsInHeader: boolean;
  generateAuthorizationHeader: boolean;
  customHeaders: StoredHeader[];
}

interface StoredCredential {
  externalCredential: string;
  principalName: string;
  principalType: string;
  credentials: Record<string, { value: string; encrypted: boolean }>;
}

interface StoredSetupAccess {
  Id: string;
  ParentId: string;
  SetupEntityId: string;
}

const DEFAULT_TOKEN = "test-token";

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const send = (response: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const fail = (response: ServerResponse, status: number, message: string, errorCode: string): void => {
  send(response, status, [{ message, errorCode }]);
};

const unescapeSoql = (value: string): string =>
  value.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\'", "'").replaceAll("\\\\", "\\");

interface Condition {
  readonly field: string;
  readonly value: string | boolean | null;
}

const parseWhere = (soql: string): Condition[] => {
  const whereIndex = soql.search(/\bWHERE\b/i);
  if (whereIndex < 0) {
    return [];
  }
  const where = soql.slice(whereIndex + "WHERE".length);
  return where
    .split(/\bAND\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = part.match(/^([\w.]+)\s*=\s*(null|true|false|'(?:\\'|[^'])*')$/i);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new Error(`Mock SOQL could not parse condition: ${part}`);
      }
      const raw = match[2];
      let value: string | boolean | null;
      if (/^null$/i.test(raw)) {
        value = null;
      } else if (/^true$/i.test(raw)) {
        value = true;
      } else if (/^false$/i.test(raw)) {
        value = false;
      } else {
        value = unescapeSoql(raw.slice(1, -1));
      }
      return { field: match[1], value };
    });
};

const objectName = (soql: string): string => {
  const match = soql.match(/\bFROM\s+(\w+)/i);
  if (match === null || match[1] === undefined) {
    throw new Error(`Mock SOQL is missing FROM: ${soql}`);
  }
  return match[1];
};

export const startMockOrg = async (options: MockOrgOptions = {}): Promise<MockOrg> => {
  const token = options.token ?? DEFAULT_TOKEN;
  const sites = new Map<string, StoredSite>();
  const remoteSites = new Map<string, StoredRemoteSite>();
  const externalCredentials = new Map<string, StoredExternalCredential>();
  const namedCredentials = new Map<string, StoredNamedCredential>();
  const credentialSecrets = new Map<string, StoredCredential>();
  const setupAccess = new Map<string, StoredSetupAccess>();
  let rejectRemoteDelete = false;
  let echoCredentialFailure = false;
  let rejectUnstoredCredentialPut = false;
  const users = new Map<string, StoredUser>();
  const permissionSets = new Map<string, StoredPermissionSet>();
  const assignments = new Map<string, StoredAssignment>();
  const permissionSetGroups = new Map<string, StoredPermissionSetGroup>();
  const corsOrigins = new Map<string, StoredCorsOrigin>();
  const activeScratchOrgs = new Map<string, StoredActiveScratchOrg>();
  const requests: RecordedRequest[] = [];
  const pages = new Map<string, ReadonlyArray<Record<string, unknown>>>();
  let pageSize = 200;
  let sequence = 0;

  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}${String(sequence).padStart(12, "0")}`;
  };

  const reset = (): void => {
    sites.clear();
    users.clear();
    permissionSets.clear();
    assignments.clear();
    permissionSetGroups.clear();
    corsOrigins.clear();
    activeScratchOrgs.clear();
    remoteSites.clear();
    externalCredentials.clear();
    namedCredentials.clear();
    credentialSecrets.clear();
    setupAccess.clear();
    requests.length = 0;
    pages.clear();
    pageSize = 200;
    rejectRemoteDelete = false;
    echoCredentialFailure = false;
    rejectUnstoredCredentialPut = false;
  };

  const siteRecord = (site: StoredSite): Record<string, unknown> => ({ ...site });

  const assignmentRecord = (assignment: StoredAssignment): Record<string, unknown> => {
    const user = [...users.values()].find((candidate) => candidate.Id === assignment.AssigneeId);
    const permissionSet = [...permissionSets.values()].find(
      (candidate) => candidate.Id === assignment.PermissionSetId,
    );
    const group =
      assignment.PermissionSetGroupId === null ? undefined : permissionSetGroups.get(assignment.PermissionSetGroupId);
    return {
      Id: assignment.Id,
      AssigneeId: assignment.AssigneeId,
      PermissionSetId: assignment.PermissionSetId,
      PermissionSetGroupId: assignment.PermissionSetGroupId,
      PermissionSetGroup:
        group === undefined ? null : { DeveloperName: group.DeveloperName, NamespacePrefix: group.NamespacePrefix },
      Assignee: user === undefined ? null : { Username: user.Username },
      PermissionSet:
        permissionSet === undefined
          ? null
          : {
              Name: permissionSet.Name,
              NamespacePrefix: permissionSet.NamespacePrefix,
              IsOwnedByProfile: permissionSet.IsOwnedByProfile,
            },
    };
  };

  const fieldOf = (record: Record<string, unknown>, field: string): unknown => {
    const [head, ...rest] = field.split(".");
    if (head === undefined) {
      return undefined;
    }
    const value = record[head];
    if (rest.length === 0) {
      return value;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return fieldOf(value as Record<string, unknown>, rest.join("."));
  };

  const matches = (record: Record<string, unknown>, conditions: ReadonlyArray<Condition>): boolean =>
    conditions.every((condition) => fieldOf(record, condition.field) === condition.value);

  const queryRows = (soql: string): Record<string, unknown>[] => {
    const name = objectName(soql);
    const conditions = parseWhere(soql);
    if (name === "CspTrustedSite") {
      return [...sites.values()].map(siteRecord).filter((record) => matches(record, conditions));
    }
    if (name === "User") {
      return [...users.values()].map((user) => ({ ...user })).filter((record) => matches(record, conditions));
    }
    if (name === "PermissionSet") {
      return [...permissionSets.values()]
        .map((permissionSet) => ({ ...permissionSet }))
        .filter((record) => matches(record, conditions));
    }
    if (name === "PermissionSetAssignment") {
      return [...assignments.values()]
        .map(assignmentRecord)
        .filter((record) => matches(record, conditions));
    }
    if (name === "PermissionSetGroup") {
      return [...permissionSetGroups.values()].map((group) => ({ ...group })).filter((record) => matches(record, conditions));
    }
    if (name === "ActiveScratchOrg") {
      return [...activeScratchOrgs.values()].map((row) => ({ ...row })).filter((record) => matches(record, conditions));
    }
    if (name === "CorsWhitelistEntry") {
      return [...corsOrigins.values()].map((origin) => ({ ...origin })).filter((record) => matches(record, conditions));
    }
    if (name === "RemoteProxy") {
      return [...remoteSites.values()].map((site) => ({ ...site })).filter((record) => matches(record, conditions));
    }
    if (name === "SetupEntityAccess") {
      return [...setupAccess.values()].map((row) => ({ ...row })).filter((record) => matches(record, conditions));
    }
    throw new Error(`Mock SOQL does not know ${name}`);
  };

  const writePage = (response: ServerResponse, rows: ReadonlyArray<Record<string, unknown>>): void => {
    const page = rows.slice(0, pageSize);
    const rest = rows.slice(pageSize);
    let nextRecordsUrl: string | undefined;
    if (rest.length > 0) {
      const locator = nextId("01g");
      pages.set(locator, rest);
      nextRecordsUrl = `/services/data/v68.0/query/${locator}`;
    }
    send(response, 200, {
      totalSize: rows.length,
      done: rest.length === 0,
      ...(nextRecordsUrl === undefined ? {} : { nextRecordsUrl }),
      records: page,
    });
  };

  const directiveTrue = (body: Record<string, unknown>): boolean =>
    [
      "IsApplicableToConnectSrc",
      "IsApplicableToFontSrc",
      "IsApplicableToFrameSrc",
      "IsApplicableToImgSrc",
      "IsApplicableToMediaSrc",
      "IsApplicableToStyleSrc",
    ].some((field) => body[field] === true);

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.headers.authorization !== `Bearer ${token}`) {
          fail(response, 401, "Session expired or invalid", "INVALID_SESSION_ID");
          return;
        }
        if (request.method === "GET" && url.pathname === "/services/oauth2/userinfo") {
          send(response, 200, {
            organization_id: options.orgId ?? "00DMOCK000000001",
            preferred_username: options.username ?? "user@example.com",
          });
          return;
        }
        const locator = url.pathname.match(/\/query\/([^/]+)$/);
        if (request.method === "GET" && locator !== null && locator[1] !== undefined) {
          const rows = pages.get(locator[1]);
          if (rows === undefined) {
            fail(response, 404, "Query locator not found", "NOT_FOUND");
            return;
          }
          pages.delete(locator[1]);
          writePage(response, rows);
          return;
        }
        if (request.method === "GET" && url.pathname.endsWith("/query")) {
          const soql = url.searchParams.get("q");
          if (soql === null) {
            fail(response, 400, "Missing q", "MALFORMED_QUERY");
            return;
          }
          requests.push({ method: "GET", resource: "query", soql, path: `${url.pathname}${url.search}` });
          writePage(response, queryRows(soql));
          return;
        }

        const namedCredentialsRoute = url.pathname.match(
          /^\/services\/data\/v[\d.]+\/named-credentials\/(.+)$/,
        );
        if (namedCredentialsRoute !== null && namedCredentialsRoute[1] !== undefined) {
          const tail = decodeURIComponent(namedCredentialsRoute[1]);
          const raw = await readBody(request);
          const body = raw.length === 0 ? undefined : (JSON.parse(raw) as Record<string, unknown>);
          const path = `${url.pathname}${url.search}`;
          const recordRequest = (resource: string, id?: string) => {
            requests.push({
              method: request.method ?? "GET",
              resource,
              path,
              ...(id === undefined ? {} : { id }),
              ...(body === undefined ? {} : { body }),
            });
          };
          if (/^named-credentials(?:\/|$)/.test(tail)) {
            recordRequest("named-credentials");
            fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
            return;
          }

          const credentialKey = (externalCredential: string, principalName: string, principalType: string) =>
            `${externalCredential}\0${principalName}\0${principalType}`;

          const parametersOf = (value: unknown): StoredParameter[] => {
            if (!Array.isArray(value)) {
              return [];
            }
            return value.flatMap((entry) => {
              if (entry === null || typeof entry !== "object") {
                return [];
              }
              const parameter = entry as Record<string, unknown>;
              if (
                typeof parameter.parameterName !== "string" ||
                typeof parameter.parameterType !== "string" ||
                typeof parameter.parameterValue !== "string"
              ) {
                return [];
              }
              return [
                {
                  parameterName: parameter.parameterName,
                  parameterType: parameter.parameterType,
                  parameterValue: parameter.parameterValue,
                },
              ];
            });
          };

          const headersOf = (value: unknown): StoredHeader[] => {
            if (!Array.isArray(value)) {
              return [];
            }
            return value.flatMap((entry, index) => {
              if (entry === null || typeof entry !== "object") {
                return [];
              }
              const header = entry as Record<string, unknown>;
              if (typeof header.headerName !== "string" || typeof header.headerValue !== "string") {
                return [];
              }
              return [
                {
                  headerName: header.headerName,
                  headerValue: header.headerValue,
                  sequenceNumber: typeof header.sequenceNumber === "number" ? header.sequenceNumber : index + 1,
                },
              ];
            });
          };

          const externalView = (credential: StoredExternalCredential): Record<string, unknown> => {
            const configured = [...credentialSecrets.values()].some(
              (secret) => secret.externalCredential === credential.developerName,
            );
            return {
              id: credential.id,
              developerName: credential.developerName,
              masterLabel: credential.masterLabel,
              authenticationProtocol: credential.authenticationProtocol,
              authenticationProtocolVariant: credential.authenticationProtocolVariant,
              authenticationStatus: configured ? "Configured" : "NotConfigured",
              parameters: credential.parameters.map((parameter) => ({ ...parameter, id: `0pe${parameter.parameterName}` })),
              principals: credential.principals.map((principal) => ({
                id: principal.id,
                principalName: principal.principalName,
                principalType: principal.principalType,
                sequenceNumber: principal.sequenceNumber,
                authenticationStatus: [...credentialSecrets.values()].some(
                  (secret) =>
                    secret.externalCredential === credential.developerName &&
                    secret.principalName === principal.principalName,
                )
                  ? "Configured"
                  : "NotConfigured",
                parameters: principal.parameters,
              })),
              customHeaders: credential.customHeaders,
              url: `/services/data/v68.0/named-credentials/external-credentials/${credential.developerName}`,
            };
          };

          const namedView = (credential: StoredNamedCredential): Record<string, unknown> => ({
            id: credential.id,
            developerName: credential.developerName,
            masterLabel: credential.masterLabel,
            type: credential.type,
            calloutUrl: credential.calloutUrl,
            calloutStatus: "Enabled",
            description: credential.description,
            externalCredentials: [{ developerName: credential.externalCredential }],
            customHeaders: credential.customHeaders,
            calloutOptions: {
              allowMergeFieldsInBody: credential.allowMergeFieldsInBody,
              allowMergeFieldsInHeader: credential.allowMergeFieldsInHeader,
              generateAuthorizationHeader: credential.generateAuthorizationHeader,
            },
            url: `/services/data/v68.0/named-credentials/named-credential-setup/${credential.developerName}`,
          });

          const credentialView = (secret: StoredCredential): Record<string, unknown> => ({
            externalCredential: secret.externalCredential,
            principalName: secret.principalName,
            principalType: secret.principalType,
            authenticationStatus: "Configured",
            credentials: Object.fromEntries(
              Object.entries(secret.credentials).map(([key, spec]) => [
                key,
                { value: spec.value, encrypted: spec.encrypted },
              ]),
            ),
          });

          const parseCredentialBody = (): StoredCredential | undefined => {
            if (body === undefined) {
              return undefined;
            }
            const externalCredential =
              typeof body.externalCredential === "string" ? body.externalCredential : undefined;
            const principalName = typeof body.principalName === "string" ? body.principalName : undefined;
            const principalType = typeof body.principalType === "string" ? body.principalType : undefined;
            const credentials = body.credentials;
            if (
              externalCredential === undefined ||
              principalName === undefined ||
              principalType === undefined ||
              credentials === null ||
              typeof credentials !== "object" ||
              Array.isArray(credentials)
            ) {
              return undefined;
            }
            const parsed: Record<string, { value: string; encrypted: boolean }> = {};
            for (const [key, spec] of Object.entries(credentials as Record<string, unknown>)) {
              if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
                return undefined;
              }
              const value = (spec as Record<string, unknown>).value;
              if (typeof value !== "string") {
                return undefined;
              }
              parsed[key] = { value, encrypted: (spec as Record<string, unknown>).encrypted === true };
            }
            return { externalCredential, principalName, principalType, credentials: parsed };
          };

          if (tail === "external-credentials" || tail.startsWith("external-credentials/")) {
            const developerName =
              tail === "external-credentials" ? undefined : tail.slice("external-credentials/".length);
            recordRequest("external-credentials", developerName);
            const find = (name: string) =>
              [...externalCredentials.values()].find((credential) => credential.developerName === name);
            if (request.method === "GET" && developerName === undefined) {
              send(response, 200, {
                externalCredentials: [...externalCredentials.values()].map(externalView),
              });
              return;
            }
            if (request.method === "POST" && developerName === undefined) {
              const name = typeof body?.developerName === "string" ? body.developerName : undefined;
              if (name === undefined || typeof body?.authenticationProtocol !== "string") {
                fail(response, 400, "developerName and authenticationProtocol are required", "REQUIRED_FIELD_MISSING");
                return;
              }
              if (find(name) !== undefined) {
                fail(response, 400, "duplicate developer name", "DUPLICATE_DEVELOPER_NAME");
                return;
              }
              const id = nextId("0pt");
              const principals = Array.isArray(body.principals) ? body.principals : [];
              externalCredentials.set(id, {
                id,
                developerName: name,
                masterLabel: typeof body.masterLabel === "string" ? body.masterLabel : name,
                authenticationProtocol: body.authenticationProtocol,
                authenticationProtocolVariant:
                  typeof body.authenticationProtocolVariant === "string" ? body.authenticationProtocolVariant : null,
                parameters: parametersOf(body.parameters),
                principals: principals.flatMap((entry, index) => {
                  if (entry === null || typeof entry !== "object") {
                    return [];
                  }
                  const principal = entry as Record<string, unknown>;
                  if (typeof principal.principalName !== "string" || typeof principal.principalType !== "string") {
                    return [];
                  }
                  return [
                    {
                      id: nextId("0pu"),
                      principalName: principal.principalName,
                      principalType: principal.principalType,
                      sequenceNumber:
                        typeof principal.sequenceNumber === "number" ? principal.sequenceNumber : index + 1,
                      parameters: parametersOf(principal.parameters),
                    },
                  ];
                }),
                customHeaders: headersOf(body.customHeaders),
              });
              const stored = externalCredentials.get(id);
              send(response, 201, stored === undefined ? { id } : externalView(stored));
              return;
            }
            if (developerName === undefined) {
              fail(response, 400, "developerName is required", "REQUIRED_FIELD_MISSING");
              return;
            }
            const current = find(developerName);
            if (current === undefined) {
              fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
              return;
            }
            if (request.method === "GET") {
              send(response, 200, externalView(current));
              return;
            }
            if (request.method === "PUT" && body !== undefined) {
              const principals = Array.isArray(body.principals) ? body.principals : [];
              const nextPrincipals = principals.flatMap((entry, index) => {
                if (entry === null || typeof entry !== "object") {
                  return [];
                }
                const principal = entry as Record<string, unknown>;
                if (typeof principal.principalName !== "string" || typeof principal.principalType !== "string") {
                  return [];
                }
                const existing = current.principals.find(
                  (candidate) =>
                    candidate.principalName === principal.principalName &&
                    candidate.principalType === principal.principalType,
                );
                return [
                  {
                    id: existing?.id ?? nextId("0pu"),
                    principalName: principal.principalName,
                    principalType: principal.principalType,
                    sequenceNumber: typeof principal.sequenceNumber === "number" ? principal.sequenceNumber : index + 1,
                    parameters: parametersOf(principal.parameters),
                  },
                ];
              });
              const updated: StoredExternalCredential = {
                ...current,
                masterLabel: typeof body.masterLabel === "string" ? body.masterLabel : current.masterLabel,
                authenticationProtocol:
                  typeof body.authenticationProtocol === "string"
                    ? body.authenticationProtocol
                    : current.authenticationProtocol,
                authenticationProtocolVariant:
                  typeof body.authenticationProtocolVariant === "string"
                    ? body.authenticationProtocolVariant
                    : current.authenticationProtocolVariant,
                parameters: parametersOf(body.parameters),
                principals: nextPrincipals,
                customHeaders: headersOf(body.customHeaders),
              };
              externalCredentials.set(current.id, updated);
              send(response, 200, externalView(updated));
              return;
            }
            if (request.method === "DELETE") {
              externalCredentials.delete(current.id);
              send(response, 204);
              return;
            }
            fail(response, 405, `Unsupported ${request.method} external-credentials`, "METHOD_NOT_ALLOWED");
            return;
          }

          if (tail === "named-credential-setup" || tail.startsWith("named-credential-setup/")) {
            const developerName =
              tail === "named-credential-setup" ? undefined : tail.slice("named-credential-setup/".length);
            recordRequest("named-credential-setup", developerName);
            const find = (name: string) =>
              [...namedCredentials.values()].find((credential) => credential.developerName === name);
            const fromBody = (name: string, id: string, previous?: StoredNamedCredential): StoredNamedCredential | undefined => {
              const linked = Array.isArray(body?.externalCredentials) ? body.externalCredentials[0] : undefined;
              const linkedName =
                linked !== null && typeof linked === "object" && typeof (linked as Record<string, unknown>).developerName === "string"
                  ? ((linked as Record<string, unknown>).developerName as string)
                  : previous?.externalCredential;
              const calloutUrl = typeof body?.calloutUrl === "string" ? body.calloutUrl : previous?.calloutUrl;
              if (linkedName === undefined || calloutUrl === undefined) {
                return undefined;
              }
              const options =
                body?.calloutOptions !== null && typeof body?.calloutOptions === "object"
                  ? (body.calloutOptions as Record<string, unknown>)
                  : undefined;
              return {
                id,
                developerName: name,
                masterLabel: typeof body?.masterLabel === "string" ? body.masterLabel : (previous?.masterLabel ?? name),
                type: typeof body?.type === "string" ? body.type : (previous?.type ?? "SecuredEndpoint"),
                calloutUrl,
                externalCredential: linkedName,
                description: typeof body?.description === "string" ? body.description : (previous?.description ?? null),
                allowMergeFieldsInBody:
                  typeof options?.allowMergeFieldsInBody === "boolean"
                    ? options.allowMergeFieldsInBody
                    : (previous?.allowMergeFieldsInBody ?? false),
                allowMergeFieldsInHeader:
                  typeof options?.allowMergeFieldsInHeader === "boolean"
                    ? options.allowMergeFieldsInHeader
                    : (previous?.allowMergeFieldsInHeader ?? true),
                generateAuthorizationHeader:
                  typeof options?.generateAuthorizationHeader === "boolean"
                    ? options.generateAuthorizationHeader
                    : (previous?.generateAuthorizationHeader ?? true),
                customHeaders: headersOf(body?.customHeaders),
              };
            };
            if (request.method === "GET" && developerName === undefined) {
              send(response, 200, { namedCredentials: [...namedCredentials.values()].map(namedView) });
              return;
            }
            if (request.method === "POST" && developerName === undefined) {
              const name = typeof body?.developerName === "string" ? body.developerName : undefined;
              if (name === undefined) {
                fail(response, 400, "developerName is required", "REQUIRED_FIELD_MISSING");
                return;
              }
              if (find(name) !== undefined) {
                fail(response, 400, "duplicate developer name", "DUPLICATE_DEVELOPER_NAME");
                return;
              }
              const id = nextId("0XA");
              const stored = fromBody(name, id);
              if (stored === undefined) {
                fail(response, 400, "calloutUrl and externalCredentials are required", "REQUIRED_FIELD_MISSING");
                return;
              }
              namedCredentials.set(id, stored);
              send(response, 201, namedView(stored));
              return;
            }
            if (developerName === undefined) {
              fail(response, 400, "developerName is required", "REQUIRED_FIELD_MISSING");
              return;
            }
            const current = find(developerName);
            if (current === undefined) {
              fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
              return;
            }
            if (request.method === "GET") {
              send(response, 200, namedView(current));
              return;
            }
            if (request.method === "PUT") {
              const stored = fromBody(current.developerName, current.id, current);
              if (stored === undefined) {
                fail(response, 400, "calloutUrl and externalCredentials are required", "REQUIRED_FIELD_MISSING");
                return;
              }
              namedCredentials.set(current.id, stored);
              send(response, 200, namedView(stored));
              return;
            }
            if (request.method === "DELETE") {
              namedCredentials.delete(current.id);
              send(response, 204);
              return;
            }
            fail(response, 405, `Unsupported ${request.method} named-credential-setup`, "METHOD_NOT_ALLOWED");
            return;
          }

          if (tail === "credential") {
            recordRequest("credential");
            const queryExternal = url.searchParams.get("externalCredential") ?? undefined;
            const queryPrincipal = url.searchParams.get("principalName") ?? undefined;
            const queryType = url.searchParams.get("principalType") ?? undefined;
            if (request.method === "GET" || request.method === "DELETE") {
              if (queryExternal === undefined || queryPrincipal === undefined || queryType === undefined) {
                fail(response, 400, "externalCredential, principalName, and principalType are required", "REQUIRED_FIELD_MISSING");
                return;
              }
              const key = credentialKey(queryExternal, queryPrincipal, queryType);
              const secret = credentialSecrets.get(key);
              const principalKnown = [...externalCredentials.values()].some(
                (credential) =>
                  credential.developerName === queryExternal &&
                  credential.principals.some((principal) => principal.principalName === queryPrincipal),
              );
              if (secret === undefined) {
                if (request.method === "GET" && (principalKnown || rejectUnstoredCredentialPut)) {
                  send(response, 200, {
                    externalCredential: queryExternal,
                    principalName: queryPrincipal,
                    principalType: queryType,
                    authenticationStatus: rejectUnstoredCredentialPut ? "Configured" : "NotConfigured",
                    credentials: rejectUnstoredCredentialPut
                      ? {
                          clientId: { encrypted: false, value: "stale-client-id" },
                          clientSecret: { encrypted: true, value: "stale-client-secret" },
                        }
                      : {},
                  });
                  return;
                }
                fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
                return;
              }
              if (request.method === "DELETE") {
                credentialSecrets.delete(key);
                send(response, 204);
                return;
              }
              send(response, 200, credentialView(secret));
              return;
            }
            const parsed = parseCredentialBody();
            if (parsed === undefined) {
              fail(response, 400, "credential identity and values are required", "REQUIRED_FIELD_MISSING");
              return;
            }
            if (echoCredentialFailure) {
              const echoed = Object.values(parsed.credentials).find((spec) => spec.encrypted)?.value ?? "";
              fail(response, 400, `rejected credential ${echoed}`, "FIELD_INTEGRITY_EXCEPTION");
              return;
            }
            const key = credentialKey(parsed.externalCredential, parsed.principalName, parsed.principalType);
            if (request.method === "POST") {
              if (credentialSecrets.has(key)) {
                fail(response, 400, "duplicate credential", "DUPLICATE_VALUE");
                return;
              }
              credentialSecrets.set(key, parsed);
              send(response, 201, credentialView(parsed));
              return;
            }
            if (request.method === "PUT") {
              if (!credentialSecrets.has(key)) {
                fail(
                  response,
                  400,
                  `There are no existing authentication credentials to update for the principal "${parsed.principalName}". Use the POST method to create them.`,
                  "INVALID_INPUT",
                );
                return;
              }
              credentialSecrets.set(key, parsed);
              send(response, 200, credentialView(parsed));
              return;
            }
            fail(response, 405, `Unsupported ${request.method} credential`, "METHOD_NOT_ALLOWED");
            return;
          }

          fail(response, 404, `No route ${url.pathname}`, "NOT_FOUND");
          return;
        }

        const sobject = url.pathname.match(/\/sobjects\/(\w+)(?:\/([A-Za-z0-9]+))?$/);
        if (sobject === null || sobject[1] === undefined) {
          fail(response, 404, `No route ${url.pathname}`, "NOT_FOUND");
          return;
        }
        const resource = sobject[1];
        const id = sobject[2];
        const raw = await readBody(request);
        const body = raw.length === 0 ? undefined : (JSON.parse(raw) as Record<string, unknown>);
        requests.push({
          method: request.method ?? "GET",
          resource,
          ...(id === undefined ? {} : { id }),
          ...(body === undefined ? {} : { body }),
        });

        if (resource === "RemoteProxy") {
          if (!url.pathname.includes("/tooling/")) {
            fail(response, 404, "RemoteProxy is a Tooling API object", "NOT_FOUND");
            return;
          }
          if (request.method === "POST") {
            if (
              body !== undefined &&
              ("EndpointUrl" in body || "SiteName" in body || "IsActive" in body || "ProtocolMismatch" in body)
            ) {
              fail(
                response,
                400,
                "Only the Metadata and FullName fields may be specified on RemoteProxy",
                "FIELD_INTEGRITY_EXCEPTION",
              );
              return;
            }
            const fullName = typeof body?.FullName === "string" ? body.FullName : undefined;
            const metadata = body?.Metadata;
            const meta =
              metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
                ? (metadata as Record<string, unknown>)
                : undefined;
            const endpoint = typeof meta?.url === "string" ? meta.url : undefined;
            if (fullName === undefined || endpoint === undefined) {
              fail(response, 400, "You must provide a valid Metadata field for RemoteProxy", "REQUIRED_FIELD_MISSING");
              return;
            }
            if ([...remoteSites.values()].some((site) => site.SiteName === fullName)) {
              fail(response, 400, "duplicate remote site", "DUPLICATE_VALUE");
              return;
            }
            const remoteId = nextId("0rp");
            remoteSites.set(remoteId, {
              Id: remoteId,
              SiteName: fullName,
              EndpointUrl: endpoint,
              IsActive: meta?.isActive === true,
              ProtocolMismatch: meta?.disableProtocolSecurity === true,
              Description: typeof meta?.description === "string" ? meta.description : null,
            });
            send(response, 201, { id: remoteId, success: true, errors: [] });
            return;
          }
          if (id === undefined) {
            fail(response, 400, "Id required", "REQUIRED_FIELD_MISSING");
            return;
          }
          const remote = remoteSites.get(id);
          if (remote === undefined) {
            fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
            return;
          }
          if (request.method === "GET") {
            send(response, 200, remote);
            return;
          }
          if (request.method === "PATCH") {
            const metadata = body?.Metadata;
            const meta =
              metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
                ? (metadata as Record<string, unknown>)
                : undefined;
            if (meta === undefined) {
              fail(response, 400, "Only the Metadata field may be updated on RemoteProxy", "FIELD_INTEGRITY_EXCEPTION");
              return;
            }
            remoteSites.set(id, {
              ...remote,
              EndpointUrl: typeof meta.url === "string" ? meta.url : remote.EndpointUrl,
              IsActive: typeof meta.isActive === "boolean" ? meta.isActive : remote.IsActive,
              ProtocolMismatch:
                typeof meta.disableProtocolSecurity === "boolean"
                  ? meta.disableProtocolSecurity
                  : remote.ProtocolMismatch,
              Description:
                meta.description === null
                  ? null
                  : typeof meta.description === "string"
                    ? meta.description
                    : remote.Description,
            });
            send(response, 204);
            return;
          }
          if (request.method === "DELETE") {
            if (rejectRemoteDelete) {
              fail(response, 405, "HTTP Method 'DELETE' not allowed", "METHOD_NOT_ALLOWED");
              return;
            }
            remoteSites.delete(id);
            send(response, 204);
            return;
          }
        }

        if (resource === "CspTrustedSite") {
          if (request.method === "POST") {
            const name = typeof body?.DeveloperName === "string" ? body.DeveloperName : undefined;
            if (name === undefined || typeof body?.EndpointUrl !== "string" || typeof body.MasterLabel !== "string") {
              fail(response, 400, "Required fields missing", "REQUIRED_FIELD_MISSING");
              return;
            }
            if ([...sites.values()].some((site) => site.DeveloperName === name)) {
              fail(response, 400, "duplicate developer name", "DUPLICATE_DEVELOPER_NAME");
              return;
            }
            if (!directiveTrue(body)) {
              fail(response, 400, "at least one directive is required", "FIELD_INTEGRITY_EXCEPTION");
              return;
            }
            const siteId = nextId("0CS");
            sites.set(siteId, {
              Id: siteId,
              DeveloperName: name,
              MasterLabel: body.MasterLabel,
              EndpointUrl: body.EndpointUrl,
              IsActive: body.IsActive === true,
              Context: typeof body.Context === "string" ? body.Context : "All",
              Description: typeof body.Description === "string" ? body.Description : null,
              IsApplicableToConnectSrc: body.IsApplicableToConnectSrc === true,
              IsApplicableToFontSrc: body.IsApplicableToFontSrc === true,
              IsApplicableToFrameSrc: body.IsApplicableToFrameSrc === true,
              IsApplicableToImgSrc: body.IsApplicableToImgSrc === true,
              IsApplicableToMediaSrc: body.IsApplicableToMediaSrc === true,
              IsApplicableToStyleSrc: body.IsApplicableToStyleSrc === true,
            });
            send(response, 201, { id: siteId, success: true, errors: [] });
            return;
          }
          if (id === undefined) {
            fail(response, 400, "Id required", "REQUIRED_FIELD_MISSING");
            return;
          }
          const site = sites.get(id);
          if (site === undefined) {
            fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
            return;
          }
          if (request.method === "GET") {
            send(response, 200, site);
            return;
          }
          if (request.method === "PATCH" && body !== undefined) {
            const next = { ...site };
            for (const [key, value] of Object.entries(body)) {
              (next as Record<string, unknown>)[key] = value;
            }
            sites.set(id, next);
            send(response, 204);
            return;
          }
          if (request.method === "DELETE") {
            sites.delete(id);
            send(response, 204);
            return;
          }
        }

        if (resource === "ActiveScratchOrg") {
          const row = id === undefined ? undefined : activeScratchOrgs.get(id);
          if (id === undefined || row === undefined) {
            fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
            return;
          }
          if (request.method === "GET") {
            send(response, 200, { ...row });
            return;
          }
          if (request.method === "DELETE") {
            activeScratchOrgs.delete(id);
            send(response, 204);
            return;
          }
        }

        if (resource === "CorsWhitelistEntry") {
          if (request.method === "POST") {
            const name = typeof body?.DeveloperName === "string" ? body.DeveloperName : undefined;
            if (name === undefined || typeof body?.UrlPattern !== "string" || typeof body.MasterLabel !== "string") {
              fail(response, 400, "Required fields missing", "REQUIRED_FIELD_MISSING");
              return;
            }
            if ([...corsOrigins.values()].some((origin) => origin.DeveloperName === name)) {
              fail(response, 400, "duplicate developer name", "DUPLICATE_DEVELOPER_NAME");
              return;
            }
            const originId = nextId("0vy");
            corsOrigins.set(originId, {
              Id: originId,
              DeveloperName: name,
              MasterLabel: body.MasterLabel,
              UrlPattern: body.UrlPattern,
            });
            send(response, 201, { id: originId, success: true, errors: [] });
            return;
          }
          const origin = id === undefined ? undefined : corsOrigins.get(id);
          if (id === undefined || origin === undefined) {
            fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
            return;
          }
          if (request.method === "GET") {
            send(response, 200, { ...origin });
            return;
          }
          if (request.method === "PATCH" && body !== undefined) {
            corsOrigins.set(id, { ...origin, ...(body as Partial<StoredCorsOrigin>), Id: id });
            send(response, 204);
            return;
          }
          if (request.method === "DELETE") {
            corsOrigins.delete(id);
            send(response, 204);
            return;
          }
        }

        if (resource === "PermissionSetAssignment") {
          if (request.method === "POST") {
            const assigneeId = typeof body?.AssigneeId === "string" ? body.AssigneeId : undefined;
            const groupId = typeof body?.PermissionSetGroupId === "string" ? body.PermissionSetGroupId : undefined;
            if (groupId !== undefined) {
              const group = permissionSetGroups.get(groupId);
              if (assigneeId === undefined || group === undefined) {
                fail(response, 400, "invalid cross reference id", "INVALID_CROSS_REFERENCE_KEY");
                return;
              }
              if (group.Status === "Updating") {
                fail(response, 400, "permission set group is being recalculated", "FIELD_INTEGRITY_EXCEPTION");
                return;
              }
              if (
                [...assignments.values()].some(
                  (assignment) => assignment.AssigneeId === assigneeId && assignment.PermissionSetGroupId === groupId,
                )
              ) {
                fail(response, 400, "duplicate assignment", "DUPLICATE_VALUE");
                return;
              }
              const groupAssignmentId = nextId("0Pa");
              // Salesforce points PermissionSetId at the group's aggregate permission set.
              assignments.set(groupAssignmentId, {
                Id: groupAssignmentId,
                AssigneeId: assigneeId,
                PermissionSetId: `0PSG${groupId.slice(4)}`,
                PermissionSetGroupId: groupId,
              });
              send(response, 201, { id: groupAssignmentId, success: true, errors: [] });
              return;
            }
            const permissionSetId = typeof body?.PermissionSetId === "string" ? body.PermissionSetId : undefined;
            if (assigneeId === undefined || permissionSetId === undefined) {
              fail(response, 400, "Required fields missing", "REQUIRED_FIELD_MISSING");
              return;
            }
            const duplicate = [...assignments.values()].some(
              (assignment) =>
                assignment.AssigneeId === assigneeId && assignment.PermissionSetId === permissionSetId,
            );
            if (duplicate) {
              fail(response, 400, "duplicate assignment", "DUPLICATE_VALUE");
              return;
            }
            const assignmentId = nextId("0Pa");
            assignments.set(assignmentId, {
              Id: assignmentId,
              AssigneeId: assigneeId,
              PermissionSetId: permissionSetId,
              PermissionSetGroupId: null,
            });
            send(response, 201, { id: assignmentId, success: true, errors: [] });
            return;
          }
          if (id === undefined) {
            fail(response, 400, "Id required", "REQUIRED_FIELD_MISSING");
            return;
          }
          const assignment = assignments.get(id);
          if (assignment === undefined) {
            fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
            return;
          }
          if (request.method === "GET") {
            send(response, 200, assignmentRecord(assignment));
            return;
          }
          if (request.method === "DELETE") {
            assignments.delete(id);
            send(response, 204);
            return;
          }
        }

        if (resource === "SetupEntityAccess") {
          if (request.method === "POST") {
            const parentId = typeof body?.ParentId === "string" ? body.ParentId : undefined;
            const setupEntityId = typeof body?.SetupEntityId === "string" ? body.SetupEntityId : undefined;
            if (parentId === undefined || setupEntityId === undefined) {
              fail(response, 400, "ParentId and SetupEntityId are required", "REQUIRED_FIELD_MISSING");
              return;
            }
            const duplicate = [...setupAccess.values()].some(
              (row) => row.ParentId === parentId && row.SetupEntityId === setupEntityId,
            );
            if (duplicate) {
              fail(response, 400, "duplicate setup entity access", "DUPLICATE_VALUE");
              return;
            }
            const accessId = nextId("0J0");
            setupAccess.set(accessId, { Id: accessId, ParentId: parentId, SetupEntityId: setupEntityId });
            send(response, 201, { id: accessId, success: true, errors: [] });
            return;
          }
          if (request.method === "PATCH") {
            fail(response, 405, "SetupEntityAccess cannot be updated", "METHOD_NOT_ALLOWED");
            return;
          }
          if (id === undefined) {
            fail(response, 400, "Id required", "REQUIRED_FIELD_MISSING");
            return;
          }
          const row = setupAccess.get(id);
          if (row === undefined) {
            fail(response, 404, "The requested resource does not exist", "NOT_FOUND");
            return;
          }
          if (request.method === "GET") {
            send(response, 200, row);
            return;
          }
          if (request.method === "DELETE") {
            setupAccess.delete(id);
            send(response, 204);
            return;
          }
        }

        fail(response, 405, `Unsupported ${request.method} ${resource}`, "METHOD_NOT_ALLOWED");
      } catch (cause) {
        fail(response, 500, cause instanceof Error ? cause.message : String(cause), "UNKNOWN_EXCEPTION");
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    reset: () => {
      reset();
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    setPageSize: (size) => {
      pageSize = size;
    },
    seedUser: (username, id) => {
      const userId = id ?? nextId("005");
      users.set(userId, { Id: userId, Username: username });
      return userId;
    },
    seedPermissionSet: (name, options) => {
      const permissionSetId = options?.id ?? nextId("0PS");
      permissionSets.set(permissionSetId, {
        Id: permissionSetId,
        Name: name,
        NamespacePrefix: options?.namespace ?? null,
        IsOwnedByProfile: options?.ownedByProfile ?? false,
      });
      return permissionSetId;
    },
    permissionSetId: (name) => [...permissionSets.values()].find((permissionSet) => permissionSet.Name === name)?.Id,
    seedTrustedSite: (fields) => {
      const siteId = nextId("0CS");
      sites.set(siteId, {
        Id: siteId,
        DeveloperName: fields.DeveloperName,
        MasterLabel: fields.DeveloperName,
        EndpointUrl: fields.EndpointUrl ?? "https://seed.example",
        IsActive: fields.IsActive ?? true,
        Context: "All",
        Description: null,
        IsApplicableToConnectSrc: true,
        IsApplicableToFontSrc: false,
        IsApplicableToFrameSrc: false,
        IsApplicableToImgSrc: false,
        IsApplicableToMediaSrc: false,
        IsApplicableToStyleSrc: false,
      });
      return siteId;
    },
    seedAssignment: (assigneeId, permissionSetId) => {
      const assignmentId = nextId("0Pa");
      assignments.set(assignmentId, {
        Id: assignmentId,
        AssigneeId: assigneeId,
        PermissionSetId: permissionSetId,
        PermissionSetGroupId: null,
      });
      return assignmentId;
    },
    seedPermissionSetGroup: (developerName, options) => {
      const groupId = nextId("0PG");
      permissionSetGroups.set(groupId, {
        Id: groupId,
        DeveloperName: developerName,
        NamespacePrefix: options?.namespace ?? null,
        Status: options?.status ?? "Updated",
      });
      return groupId;
    },
    seedGroupAssignment: (assigneeId, permissionSetGroupId) => {
      const assignmentId = nextId("0Pa");
      assignments.set(assignmentId, {
        Id: assignmentId,
        AssigneeId: assigneeId,
        PermissionSetId: `0PSG${permissionSetGroupId.slice(4)}`,
        PermissionSetGroupId: permissionSetGroupId,
      });
      return assignmentId;
    },
    seedCorsOrigin: (fields) => {
      const originId = nextId("0vy");
      corsOrigins.set(originId, {
        Id: originId,
        DeveloperName: fields.DeveloperName,
        MasterLabel: fields.DeveloperName,
        UrlPattern: fields.UrlPattern ?? "https://seed.example",
      });
      return originId;
    },
    editCorsOrigin: (id, fields) => {
      const origin = corsOrigins.get(id);
      if (origin === undefined) {
        throw new Error(`No CORS origin ${id}`);
      }
      corsOrigins.set(id, { ...origin, ...fields, Id: id });
    },
    corsOrigins: () => [...corsOrigins.values()],
    seedActiveScratchOrg: (fields) => {
      const rowId = nextId("2SR");
      activeScratchOrgs.set(rowId, {
        Id: rowId,
        ScratchOrg: fields.orgId.slice(0, 15),
        SignupUsername: fields.username,
        Status: fields.status ?? "Active",
        ExpirationDate: "2026-12-01",
      });
      return rowId;
    },
    activeScratchOrgs: () => [...activeScratchOrgs.values()],
    seedRemoteSite: (fields) => {
      const remoteId = nextId("0rp");
      remoteSites.set(remoteId, {
        Id: remoteId,
        SiteName: fields.SiteName,
        EndpointUrl: fields.EndpointUrl ?? "https://seed.example",
        IsActive: fields.IsActive ?? true,
        ProtocolMismatch: fields.DisableProtocolSecurity ?? false,
        Description: null,
      });
      return remoteId;
    },
    setRejectRemoteDelete: (reject) => {
      rejectRemoteDelete = reject;
    },
    removeTrustedSites: () => {
      sites.clear();
    },
    sites: () => [...sites.values()],
    assignments: () => [...assignments.values()],
    remoteSites: () => [...remoteSites.values()],
    seedExternalCredential: (fields) => {
      const id = nextId("0pt");
      const principalId = nextId("0pu");
      const principalName = fields.principalName ?? "PartnerPrincipal";
      const calloutUrl = fields.calloutUrl ?? "https://target.example.my.salesforce.com";
      externalCredentials.set(id, {
        id,
        developerName: fields.developerName,
        masterLabel: fields.masterLabel ?? fields.developerName,
        authenticationProtocol: fields.authenticationProtocol ?? "OAuth",
        authenticationProtocolVariant: fields.authenticationProtocolVariant ?? "ClientCredentialsClientSecretBasic",
        parameters: [
          {
            parameterName: "AuthProviderUrl",
            parameterType: "AuthProviderUrl",
            parameterValue: `${calloutUrl}/services/oauth2/token`,
          },
        ],
        principals: [
          {
            id: principalId,
            principalName,
            principalType: "NamedPrincipal",
            sequenceNumber: 1,
            parameters: [],
          },
        ],
        customHeaders: [],
      });
      return { id, principalId };
    },
    seedNamedCredential: (fields) => {
      const id = nextId("0XA");
      namedCredentials.set(id, {
        id,
        developerName: fields.developerName,
        masterLabel: fields.masterLabel ?? fields.developerName,
        type: "SecuredEndpoint",
        calloutUrl: fields.calloutUrl ?? "https://target.example.my.salesforce.com",
        externalCredential: fields.externalCredential,
        description: null,
        allowMergeFieldsInBody: false,
        allowMergeFieldsInHeader: true,
        generateAuthorizationHeader: true,
        customHeaders: [],
      });
      return id;
    },
    seedCredential: (fields) => {
      const principalType = fields.principalType ?? "NamedPrincipal";
      credentialSecrets.set(`${fields.externalCredential}\0${fields.principalName}\0${principalType}`, {
        externalCredential: fields.externalCredential,
        principalName: fields.principalName,
        principalType,
        credentials: Object.fromEntries(
          Object.entries(fields.credentials).map(([key, spec]) => [key, { value: spec.value, encrypted: spec.encrypted }]),
        ),
      });
    },
    seedSetupEntityAccess: (parentId, setupEntityId) => {
      const id = nextId("0J0");
      setupAccess.set(id, { Id: id, ParentId: parentId, SetupEntityId: setupEntityId });
      return id;
    },
    setEchoCredentialFailure: (echo) => {
      echoCredentialFailure = echo;
    },
    setRejectUnstoredCredentialPut: (reject) => {
      rejectUnstoredCredentialPut = reject;
    },
    externalCredentials: () =>
      [...externalCredentials.values()].map((credential) => ({
        developerName: credential.developerName,
        id: credential.id,
      })),
    namedCredentials: () =>
      [...namedCredentials.values()].map((credential) => ({
        developerName: credential.developerName,
        calloutUrl: credential.calloutUrl,
      })),
    credentialKeys: () =>
      [...credentialSecrets.values()].map((secret) => ({
        externalCredential: secret.externalCredential,
        keys: Object.keys(secret.credentials).sort(),
      })),
    setupEntityAccess: () => [...setupAccess.values()],
    removeExternalCredential: (developerName) => {
      for (const [id, credential] of externalCredentials) {
        if (credential.developerName === developerName) {
          externalCredentials.delete(id);
        }
      }
    },
    removeNamedCredential: (developerName) => {
      for (const [id, credential] of namedCredentials) {
        if (credential.developerName === developerName) {
          namedCredentials.delete(id);
        }
      }
    },
    removeCredentials: () => {
      credentialSecrets.clear();
    },
    removeSetupEntityAccess: () => {
      setupAccess.clear();
    },
  };
};

export const TEST_TOKEN = DEFAULT_TOKEN;
