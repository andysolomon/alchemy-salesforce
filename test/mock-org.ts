import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { metadataFieldsEqual, readMetadataZip, type MetadataField, type MetadataFields } from "../src/salesforce/metadata.js";
import { escapeXml } from "../src/salesforce/xml.js";

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
  seedProfile(name: string, id?: string): string;
  seedExternalClientApp(fields: {
    readonly developerName: string;
    readonly label?: string;
    readonly contactEmail?: string;
    readonly description?: string | null;
    readonly scopes?: string;
    readonly callbackUrl?: string;
    readonly certificate?: string | null;
    readonly pkceRequired?: boolean;
    readonly clientCredentials?: boolean;
    readonly runAsUsername?: string;
    readonly permittedUsers?: "AllSelfAuthorized" | "AdminApprovedPreAuthorized";
    readonly permissionSets?: string;
    readonly ipRelaxation?: string;
    readonly enabled?: boolean;
    readonly policyFullName?: string;
  }): { readonly id: string; readonly consumerId: string; readonly consumerKey: string };
  externalClientApp(developerName: string):
    | {
        readonly id: string;
        readonly consumerId: string;
        readonly consumerKey: string;
        readonly policyFullName: string | undefined;
        readonly parts: ReadonlyArray<{ readonly type: string; readonly fullName: string; readonly fields: MetadataFields }>;
      }
    | undefined;
  setRotateConsumerKeyOnDeploy(rotate: boolean): void;
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

const readBuffer = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const readBody = (request: IncomingMessage): Promise<string> => readBuffer(request).then((body) => body.toString("utf8"));

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
  const profiles = new Map<string, { Id: string; Name: string }>();
  const metadataComponents = new Map<string, { type: string; fullName: string; fields: Record<string, MetadataField> }>();
  const clientApps = new Map<string, { id: string; developerName: string; consumerId: string; consumerKey: string }>();
  const deployResults = new Map<string, Record<string, unknown>>();
  let rotateConsumerKeyOnDeploy = false;
  const orgId = options.orgId ?? "00DMOCK000000001";
  let rejectRemoteDelete = false;
  let echoCredentialFailure = false;
  let rejectUnstoredCredentialPut = false;
  const users = new Map<string, StoredUser>();
  const permissionSets = new Map<string, StoredPermissionSet>();
  const assignments = new Map<string, StoredAssignment>();
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
    remoteSites.clear();
    externalCredentials.clear();
    namedCredentials.clear();
    credentialSecrets.clear();
    setupAccess.clear();
    profiles.clear();
    metadataComponents.clear();
    clientApps.clear();
    deployResults.clear();
    rotateConsumerKeyOnDeploy = false;
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
    return {
      Id: assignment.Id,
      AssigneeId: assignment.AssigneeId,
      PermissionSetId: assignment.PermissionSetId,
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
    if (name === "RemoteProxy") {
      return [...remoteSites.values()].map((site) => ({ ...site })).filter((record) => matches(record, conditions));
    }
    if (name === "SetupEntityAccess") {
      return [...setupAccess.values()].map((row) => ({ ...row })).filter((record) => matches(record, conditions));
    }
    if (name === "Profile") {
      return [...profiles.values()].map((profile) => ({ ...profile })).filter((record) => matches(record, conditions));
    }
    if (name === "ExternalClientApplication") {
      return [...clientApps.values()]
        .map((app) => {
          const component = metadataComponents.get(`ExternalClientApplication\0${app.developerName}`);
          return {
            Id: app.id,
            DeveloperName: app.developerName,
            MasterLabel: component?.fields.label ?? app.developerName,
            ContactEmail: component?.fields.contactEmail ?? null,
            Description: component?.fields.description ?? null,
          };
        })
        .filter((record) => matches(record, conditions));
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

  const componentKey = (type: string, fullName: string): string => `${type}\0${fullName}`;

  const putComponent = (type: string, fullName: string, fields: Record<string, MetadataField>): void => {
    metadataComponents.set(componentKey(type, fullName), {
      type,
      fullName,
      fields: structuredClone(fields),
    });
  };

  const developerNameOf = (file: { type: string; fullName: string; fields: MetadataFields }): string | undefined => {
    if (file.type === "ExternalClientApplication") {
      return file.fullName;
    }
    const linked = file.fields.externalClientApplication;
    return typeof linked === "string" ? linked : undefined;
  };

  const xmlFields = (fullName: string, fields: MetadataFields): string => {
    const parts = [`<fullName>${escapeXml(fullName)}</fullName>`];
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "string") {
        parts.push(`<${key}>${escapeXml(value)}</${key}>`);
      } else if (typeof value === "boolean") {
        parts.push(`<${key}>${value ? "true" : "false"}</${key}>`);
      }
    }
    return parts.join("");
  };

  const applyMetadataDeploy = (
    files: ReadonlyArray<{ type: string; fullName: string; fields: MetadataFields }>,
    destructive: ReadonlyArray<{ type: string; fullName: string }>,
    checkOnly: boolean,
  ) => {
    const components: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const stored = metadataComponents.get(componentKey(file.type, file.fullName));
      const changed = stored === undefined || !metadataFieldsEqual(stored.fields, file.fields);
      components.push({
        componentType: file.type,
        fullName: file.fullName,
        changed,
        created: stored === undefined,
        deleted: false,
        success: true,
        problem: null,
        problemType: null,
        fileName: file.fullName,
      });
      if (checkOnly) {
        continue;
      }
      const fields: Record<string, MetadataField> = { ...file.fields };
      delete fields.consumerSecret;
      if (file.type === "ExternalClientApplication" && typeof fields.orgScopedExternalApp !== "string") {
        fields.orgScopedExternalApp = `${orgId}:${file.fullName}`;
      }
      if (file.type === "ExternalClientApplication" && !clientApps.has(file.fullName)) {
        clientApps.set(file.fullName, {
          id: nextId("0xI"),
          developerName: file.fullName,
          consumerId: nextId("888"),
          consumerKey: "",
        });
      }
      if (file.type === "ExtlClntAppGlobalOauthSettings") {
        const name =
          typeof fields.externalClientApplication === "string"
            ? fields.externalClientApplication
            : file.fullName.replace(/_GlblOauth$/, "");
        let app = clientApps.get(name);
        if (app === undefined) {
          app = { id: nextId("0xI"), developerName: name, consumerId: nextId("888"), consumerKey: "" };
          clientApps.set(name, app);
        }
        const sentKey = typeof fields.consumerKey === "string" ? fields.consumerKey : undefined;
        const rotate =
          fields.shouldRotateConsumerKey === true ||
          (app.consumerKey.length > 0 && sentKey === undefined);
        if (sentKey === undefined || rotate) {
          app.consumerKey = `3MVG9mock${app.consumerId}${nextId("k")}`;
        } else {
          app.consumerKey = sentKey;
        }
        fields.consumerKey = app.consumerKey;
        fields.shouldRotateConsumerKey = false;
        fields.shouldRotateConsumerSecret = false;
      }
      if (file.type === "ExtlClntAppOauthSettings") {
        const name =
          typeof fields.externalClientApplication === "string"
            ? fields.externalClientApplication
            : file.fullName.replace(/_Oauth$/, "");
        const app = clientApps.get(name);
        if (app !== undefined && typeof fields.oauthLink !== "string") {
          fields.oauthLink = `${orgId}:${app.consumerId}`;
        }
      }
      putComponent(file.type, file.fullName, fields);
    }
    for (const member of destructive) {
      const stored = metadataComponents.get(componentKey(member.type, member.fullName));
      components.push({
        componentType: member.type,
        fullName: member.fullName,
        changed: stored !== undefined,
        created: false,
        deleted: stored !== undefined,
        success: true,
        problem: null,
        problemType: null,
        fileName: member.fullName,
      });
      if (!checkOnly && stored !== undefined) {
        metadataComponents.delete(componentKey(member.type, member.fullName));
        if (member.type === "ExternalClientApplication") {
          clientApps.delete(member.fullName);
        }
      }
    }
    if (!checkOnly && rotateConsumerKeyOnDeploy) {
      const names = new Set<string>();
      for (const file of files) {
        const name = developerNameOf(file);
        if (name !== undefined) {
          names.add(name);
        }
      }
      for (const name of names) {
        const app = clientApps.get(name);
        const globalComponent = metadataComponents.get(componentKey("ExtlClntAppGlobalOauthSettings", `${name}_GlblOauth`));
        if (app === undefined || globalComponent === undefined) {
          continue;
        }
        app.consumerKey = `${app.consumerKey}rotated`;
        globalComponent.fields = { ...globalComponent.fields, consumerKey: app.consumerKey };
      }
    }
    return components;
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname.startsWith("/services/Soap/m/")) {
          const raw = await readBody(request);
          const session = raw.match(/<(?:[\w.-]+:)?sessionId>([^<]*)<\/(?:[\w.-]+:)?sessionId>/);
          if (session?.[1] !== token) {
            response.writeHead(500, { "content-type": "text/xml; charset=UTF-8" });
            response.end(
              `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>INVALID_SESSION_ID</faultcode><faultstring>Session expired or invalid</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
            );
            return;
          }
          const xmlValue = (tag: string): string[] =>
            [...raw.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tag}>([^<]*)</(?:[\\w.-]+:)?${tag}>`, "g"))].flatMap(
              (match) => (match[1] === undefined ? [] : [match[1]]),
            );
          if (raw.includes("readMetadata")) {
            const type = xmlValue("type")[0] ?? "";
            const fullNames = xmlValue("fullNames");
            requests.push({ method: "POST", resource: "readMetadata", body: { type, fullNames }, path: url.pathname });
            const records = fullNames
              .map((fullName) => {
                const stored = metadataComponents.get(componentKey(type, fullName));
                if (stored === undefined) {
                  return `<records xsi:nil="true"/>`;
                }
                const fields = { ...stored.fields };
                delete fields.consumerSecret;
                return `<records>${xmlFields(stored.fullName, fields)}</records>`;
              })
              .join("");
            response.writeHead(200, { "content-type": "text/xml; charset=UTF-8" });
            response.end(
              `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body><readMetadataResponse><result>${records}</result></readMetadataResponse></soapenv:Body></soapenv:Envelope>`,
            );
            return;
          }
          if (raw.includes("listMetadata")) {
            const type = xmlValue("type")[0] ?? "";
            requests.push({ method: "POST", resource: "listMetadata", body: { type }, path: url.pathname });
            const results = [...metadataComponents.values()]
              .filter((component) => component.type === type)
              .map(
                (component) =>
                  `<result><fullName>${escapeXml(component.fullName)}</fullName><type>${escapeXml(component.type)}</type><fileName>${escapeXml(component.fullName)}</fileName></result>`,
              )
              .join("");
            response.writeHead(200, { "content-type": "text/xml; charset=UTF-8" });
            response.end(
              `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><listMetadataResponse>${results}</listMetadataResponse></soapenv:Body></soapenv:Envelope>`,
            );
            return;
          }
          response.writeHead(500, { "content-type": "text/xml; charset=UTF-8" });
          response.end(
            `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>UNKNOWN</faultcode><faultstring>Unsupported metadata operation</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
          );
          return;
        }
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
        const deployRoute = url.pathname.match(/^\/services\/data\/v[\d.]+\/metadata\/deployRequest(?:\/([^/]+))?$/);
        if (deployRoute !== null) {
          const deployId = deployRoute[1];
          if (request.method === "GET" && deployId !== undefined) {
            const stored = deployResults.get(deployId);
            if (stored === undefined) {
              fail(response, 404, "Deploy request was not found", "NOT_FOUND");
              return;
            }
            requests.push({ method: "GET", resource: "deployRequest", id: deployId, path: `${url.pathname}${url.search}` });
            send(response, 200, stored);
            return;
          }
          if (request.method === "POST" && deployId === undefined) {
            const raw = await readBuffer(request);
            const contentType = request.headers["content-type"] ?? "";
            const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
            const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2])?.trim();
            if (boundary === undefined) {
              fail(response, 400, "Metadata deploy requires multipart/form-data", "INVALID_INPUT");
              return;
            }
            const marker = Buffer.from(`--${boundary}`);
            const parts: Buffer[] = [];
            let offset = raw.indexOf(marker);
            while (offset >= 0) {
              const next = raw.indexOf(marker, offset + marker.length);
              if (next < 0) {
                break;
              }
              parts.push(raw.subarray(offset + marker.length, next));
              offset = next;
            }
            let checkOnly = false;
            let archive: Buffer | undefined;
            for (const part of parts) {
              const separator = part.indexOf(Buffer.from("\r\n\r\n"));
              if (separator < 0) {
                continue;
              }
              const headers = part.subarray(0, separator).toString("utf8");
              let body = part.subarray(separator + 4);
              if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
                body = body.subarray(0, body.length - 2);
              }
              if (headers.includes(`name="json"`)) {
                const parsed = JSON.parse(body.toString("utf8")) as { deployOptions?: { checkOnly?: boolean } };
                checkOnly = parsed.deployOptions?.checkOnly === true;
              } else if (headers.includes(`name="file"`)) {
                archive = body;
              }
            }
            if (archive === undefined) {
              fail(response, 400, "Metadata deploy is missing the zip", "INVALID_INPUT");
              return;
            }
            let unpacked: ReturnType<typeof readMetadataZip>;
            try {
              unpacked = readMetadataZip(archive);
            } catch {
              fail(response, 400, "Metadata zip could not be read", "INVALID_INPUT");
              return;
            }
            const components = applyMetadataDeploy(unpacked.files, unpacked.destructive, checkOnly);
            const id = nextId("0Af");
            const result = {
              id,
              deployResult: {
                id,
                done: true,
                success: true,
                status: "Succeeded",
                checkOnly,
                details: { componentSuccesses: components, componentFailures: [] },
              },
            };
            deployResults.set(id, result);
            requests.push({
              method: "POST",
              resource: "deployRequest",
              id,
              path: url.pathname,
              body: {
                checkOnly,
                files: unpacked.files,
                destructive: unpacked.destructive,
              },
            });
            send(response, 201, {
              id,
              deployResult: { id, done: false, success: false, status: "Pending", checkOnly },
            });
            return;
          }
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

        if (resource === "PermissionSetAssignment") {
          if (request.method === "POST") {
            const assigneeId = typeof body?.AssigneeId === "string" ? body.AssigneeId : undefined;
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
            assignments.set(assignmentId, { Id: assignmentId, AssigneeId: assigneeId, PermissionSetId: permissionSetId });
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
      assignments.set(assignmentId, { Id: assignmentId, AssigneeId: assigneeId, PermissionSetId: permissionSetId });
      return assignmentId;
    },
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
    seedProfile: (name, id) => {
      const profileId = id ?? nextId("00e");
      profiles.set(profileId, { Id: profileId, Name: name });
      return profileId;
    },
    seedExternalClientApp: (fields) => {
      const developerName = fields.developerName;
      const id = nextId("0xI");
      const consumerId = nextId("888");
      const consumerKey = `3MVG9mock${consumerId}`;
      const label = fields.label ?? developerName;
      const contactEmail = fields.contactEmail ?? "admin@example.com";
      const policyFullName = fields.policyFullName ?? `${developerName}_defaultPolicy`;
      clientApps.set(developerName, { id, developerName, consumerId, consumerKey });
      const application: Record<string, MetadataField> = {
        contactEmail,
        distributionState: "Local",
        label,
        orgScopedExternalApp: `${orgId}:${developerName}`,
      };
      if (fields.description !== undefined && fields.description !== null && fields.description.length > 0) {
        application.description = fields.description;
      }
      putComponent("ExternalClientApplication", developerName, application);
      putComponent("ExtlClntAppOauthSettings", `${developerName}_Oauth`, {
        commaSeparatedOauthScopes: fields.scopes ?? "Api, RefreshToken",
        externalClientApplication: developerName,
        label: `${label} OAuth`,
        oauthLink: `${orgId}:${consumerId}`,
      });
      const globalFields: Record<string, MetadataField> = {
        callbackUrl: fields.callbackUrl ?? "https://example.com/callback",
        consumerKey,
        externalClientApplication: developerName,
        isClientCredentialsFlowEnabled: fields.clientCredentials === true,
        isEnforceRefreshTokenTTL: false,
        isPkceRequired: fields.pkceRequired ?? true,
        isRefreshTokenRotationEnabled: false,
        label,
        shouldRotateConsumerKey: false,
        shouldRotateConsumerSecret: false,
      };
      if (fields.certificate !== undefined && fields.certificate !== null && fields.certificate.length > 0) {
        globalFields.certificate = fields.certificate;
      }
      putComponent("ExtlClntAppGlobalOauthSettings", `${developerName}_GlblOauth`, globalFields);
      const policyFields: Record<string, MetadataField> = {
        externalClientApplication: developerName,
        ipRelaxationPolicyType: fields.ipRelaxation ?? "Enforce",
        isClientCredentialsFlowEnabled: fields.clientCredentials === true,
        label: `${label} OAuth Policy`,
        permittedUsersPolicyType: fields.permittedUsers ?? "AllSelfAuthorized",
      };
      if (fields.runAsUsername !== undefined) {
        policyFields.clientCredentialsFlowUser = fields.runAsUsername;
      }
      if (fields.permissionSets !== undefined && fields.permissionSets.length > 0) {
        policyFields.commaSeparatedPermissionSet = fields.permissionSets;
      }
      putComponent("ExtlClntAppOauthConfigurablePolicies", `${developerName}_OauthPlcy`, policyFields);
      putComponent("ExtlClntAppConfigurablePolicies", policyFullName, {
        externalClientApplication: developerName,
        isEnabled: fields.enabled ?? true,
        isOauthPluginEnabled: true,
        label: `${label} Policy`,
      });
      return { id, consumerId, consumerKey };
    },
    externalClientApp: (developerName) => {
      const app = clientApps.get(developerName);
      if (app === undefined) {
        return undefined;
      }
      const parts = [...metadataComponents.values()].filter((part) => {
        if (part.type === "ExternalClientApplication") {
          return part.fullName === developerName;
        }
        return part.fields.externalClientApplication === developerName;
      });
      return {
        id: app.id,
        consumerId: app.consumerId,
        consumerKey: app.consumerKey,
        policyFullName: parts.find((part) => part.type === "ExtlClntAppConfigurablePolicies")?.fullName,
        parts: parts.map((part) => ({
          type: part.type,
          fullName: part.fullName,
          fields: part.fields,
        })),
      };
    },
    setRotateConsumerKeyOnDeploy: (rotate) => {
      rotateConsumerKeyOnDeploy = rotate;
    },
  };
};

export const TEST_TOKEN = DEFAULT_TOKEN;
