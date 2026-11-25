import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import type { ResolvedConnection } from "./connection.js";
import { errorMessage, redactApiError, redactSensitiveText, SalesforceApiError } from "./errors.js";
import { escapeXml, findElements, parseXml, type XmlElement } from "./xml.js";
import { unzipStore, zipStore, type ZipEntry } from "./zip.js";

/**
 * Metadata API helper.
 *
 * readMetadata and listMetadata use SOAP `/services/Soap/m/<api>` with the
 * in-memory access token as `SessionHeader`. Deploy uses REST
 * `POST /services/data/vXX/metadata/deployRequest`: a multipart body whose
 * zip is built in memory and never written to disk. Every deploy runs
 * checkOnly, then the real deploy, and deploys to one org are serialized
 * because a Metadata deploy locks the org.
 *
 * readMetadata returns the External Client App consumer key in plaintext.
 * Responses are not logged. Error text is passed through `redactSensitiveText`.
 */

export type MetadataField =
  | string
  | boolean
  | readonly MetadataField[]
  | { readonly [key: string]: MetadataField };

export interface MetadataFields {
  readonly [key: string]: MetadataField;
}

export interface MetadataComponent {
  readonly type: string;
  readonly fullName: string;
  readonly fields: MetadataFields;
}

export interface ListedMetadata {
  readonly type: string;
  readonly fullName: string;
  readonly fileName: string | undefined;
  readonly id: string | undefined;
}

export interface DeployComponentDetail {
  readonly componentType: string;
  readonly fullName: string;
  readonly changed: boolean;
  readonly created: boolean;
  readonly deleted: boolean;
  readonly success: boolean;
  readonly problem: string | undefined;
}

export interface DeployResult {
  readonly id: string;
  readonly checkOnly: boolean;
  readonly status: string;
  readonly success: boolean;
  readonly components: readonly DeployComponentDetail[];
}

export interface MetadataFile {
  readonly type: string;
  readonly fullName: string;
  readonly fields: MetadataFields;
}

export interface DestructiveMember {
  readonly type: string;
  readonly fullName: string;
}

const FILE_LAYOUT: Readonly<Record<string, { readonly directory: string; readonly suffix: string }>> = {
  ExternalClientApplication: { directory: "externalClientApps", suffix: "eca" },
  ExtlClntAppOauthSettings: { directory: "extlClntAppOauthSettings", suffix: "ecaOauth" },
  ExtlClntAppGlobalOauthSettings: { directory: "extlClntAppGlobalOauthSets", suffix: "ecaGlblOauth" },
  ExtlClntAppOauthConfigurablePolicies: { directory: "extlClntAppOauthPolicies", suffix: "ecaOauthPlcy" },
  ExtlClntAppConfigurablePolicies: { directory: "extlClntAppPolicies", suffix: "ecaPlcy" },
};

const SENSITIVE_FIELD = new Set(["consumerKey", "consumerSecret", "certificate", "sessionId"]);

const deployGates = new Map<string, Semaphore.Semaphore>();

const gateFor = (instanceUrl: string): Semaphore.Semaphore => {
  const existing = deployGates.get(instanceUrl);
  if (existing !== undefined) {
    return existing;
  }
  const created = Semaphore.makeUnsafe(1);
  deployGates.set(instanceUrl, created);
  return created;
};

/** Test hook. Drops the per-org deploy locks. */
export const clearMetadataDeployLocks = (): void => {
  deployGates.clear();
};

const metadataPath = (apiVersion: string): string => `/services/data/v${apiVersion}/metadata/deployRequest`;

const soapPath = (apiVersion: string): string => `/services/Soap/m/${apiVersion}`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const booleanField = (value: unknown): boolean => value === true || value === "true";

const asList = (value: unknown): readonly unknown[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const collectedSecrets = (value: MetadataField | MetadataFields | undefined, into: string[]): void => {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (value.length >= 4) {
      into.push(value);
    }
    return;
  }
  if (typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectedSecrets(entry, into);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.has(key) || key === "certificate") {
      collectedSecrets(child, into);
    } else if (typeof child === "object") {
      collectedSecrets(child, into);
    }
  }
};

export const sensitiveMetadataValues = (
  files: ReadonlyArray<{ readonly fields: MetadataFields }>,
): string[] => {
  const secrets: string[] = [];
  for (const file of files) {
    for (const [key, value] of Object.entries(file.fields)) {
      if (SENSITIVE_FIELD.has(key)) {
        collectedSecrets(value, secrets);
      }
    }
  }
  return secrets;
};

const taggedXmlSecrets = (text: string): string[] => {
  const secrets: string[] = [];
  const pattern =
    /<(?:[\w.-]+:)?(consumerKey|consumerSecret|certificate|sessionId)>([^<]{4,})<\/(?:[\w.-]+:)?\1>/g;
  for (const match of text.matchAll(pattern)) {
    if (match[2] !== undefined) {
      secrets.push(match[2]);
    }
  }
  return secrets;
};

const redactText = (text: string, secrets: ReadonlyArray<string>): string =>
  redactSensitiveText(text, [...secrets, ...taggedXmlSecrets(text)]);

const apiError = (
  message: string,
  status: number,
  method: string,
  path: string,
  secrets: ReadonlyArray<string>,
  errorCode?: string,
): SalesforceApiError =>
  redactApiError(
    new SalesforceApiError({
      message: redactText(message, secrets),
      status,
      errorCode,
      method,
      path,
    }),
    secrets,
  );

const childField = (element: XmlElement): MetadataField | undefined => {
  if (element.attributes.nil === "true") {
    return undefined;
  }
  if (element.children.length > 0) {
    return fieldsFromElement(element);
  }
  if (element.text === "true" || element.text === "false") {
    return element.text === "true";
  }
  return element.text;
};

const fieldsFromElement = (element: XmlElement): MetadataFields => {
  const groups = new Map<string, XmlElement[]>();
  for (const child of element.children) {
    const group = groups.get(child.name) ?? [];
    group.push(child);
    groups.set(child.name, group);
  }
  const fields: Record<string, MetadataField> = {};
  for (const [name, group] of groups) {
    const values = group.flatMap((child) => {
      const value = childField(child);
      return value === undefined ? [] : [value];
    });
    if (values.length === 1 && values[0] !== undefined) {
      fields[name] = values[0];
    } else if (values.length > 1) {
      fields[name] = values;
    }
  }
  return fields;
};

const isMetadataRecord = (value: MetadataField): value is { readonly [key: string]: MetadataField } =>
  typeof value === "object" && !Array.isArray(value);

const writeField = (name: string, value: MetadataField, indent: string): string => {
  if (typeof value === "boolean" || typeof value === "string") {
    const text = typeof value === "boolean" ? (value ? "true" : "false") : escapeXml(value);
    return `${indent}<${name}>${text}</${name}>\n`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => writeField(name, entry, indent)).join("");
  }
  if (!isMetadataRecord(value)) {
    return "";
  }
  const nested = Object.keys(value)
    .sort()
    .map((key) => writeField(key, value[key]!, `${indent}    `))
    .join("");
  return `${indent}<${name}>\n${nested}${indent}</${name}>\n`;
};

export const metadataXml = (type: string, fields: MetadataFields): string => {
  const body = Object.keys(fields)
    .filter((key) => key !== "fullName")
    .sort()
    .map((key) => writeField(key, fields[key]!, "    "))
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}</${type}>\n`
  );
};

const packageXml = (
  apiVersion: string,
  members: ReadonlyArray<{ readonly type: string; readonly fullName: string }>,
  root: "Package" | "PackageWithDestructive" = "Package",
): string => {
  const byType = new Map<string, string[]>();
  for (const member of members) {
    const names = byType.get(member.type) ?? [];
    names.push(member.fullName);
    byType.set(member.type, names);
  }
  const types = [...byType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, names]) => {
      const unique = [...new Set(names)].sort();
      const lines = unique.map((name) => `        <members>${escapeXml(name)}</members>`).join("\n");
      return `    <types>\n${lines}\n        <name>${type}</name>\n    </types>`;
    })
    .join("\n");
  const element = root === "Package" ? "Package" : "Package";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${element} xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `${types.length === 0 ? "" : `${types}\n`}` +
    `    <version>${escapeXml(apiVersion)}</version>\n` +
    `</${element}>\n`
  );
};

const fileNameFor = (type: string, fullName: string): string => {
  const layout = FILE_LAYOUT[type];
  if (layout === undefined) {
    return `${type}/${fullName}.xml`;
  }
  return `${layout.directory}/${fullName}.${layout.suffix}-meta.xml`;
};

const buildZip = (
  apiVersion: string,
  files: ReadonlyArray<MetadataFile>,
  destructive: ReadonlyArray<DestructiveMember>,
): Uint8Array => {
  const entries: ZipEntry[] = [
    {
      name: "package.xml",
      data: Buffer.from(packageXml(apiVersion, files), "utf8"),
    },
  ];
  if (destructive.length > 0) {
    entries.push({
      name: "destructiveChanges.xml",
      data: Buffer.from(packageXml(apiVersion, destructive), "utf8"),
    });
  }
  for (const file of files) {
    entries.push({
      name: fileNameFor(file.type, file.fullName),
      data: Buffer.from(metadataXml(file.type, file.fields), "utf8"),
    });
  }
  return zipStore(entries);
};

const membersFromPackage = (element: XmlElement): DestructiveMember[] => {
  const packages = element.name === "Package" ? [element] : findElements(element, "Package");
  const members: DestructiveMember[] = [];
  for (const packaged of packages) {
    for (const types of packaged.children.filter((child) => child.name === "types")) {
      const typeName = types.children.find((child) => child.name === "name")?.text;
      if (typeName === undefined || typeName.length === 0) {
        continue;
      }
      for (const member of types.children.filter((child) => child.name === "members")) {
        if (member.text.length > 0 && member.text !== "*") {
          members.push({ type: typeName, fullName: member.text });
        }
      }
    }
  }
  return members;
};

/** Parse a metadata zip. Exported for the mock org. The archive stays in memory. */
export const readMetadataZip = (
  archive: Uint8Array,
): { readonly files: readonly MetadataFile[]; readonly destructive: readonly DestructiveMember[] } => {
  const entries = unzipStore(archive);
  const files: MetadataFile[] = [];
  let destructive: DestructiveMember[] = [];
  for (const entry of entries) {
    const text = Buffer.from(entry.data).toString("utf8");
    if (entry.name === "destructiveChanges.xml") {
      destructive = membersFromPackage(parseXml(text));
      continue;
    }
    if (entry.name === "package.xml" || entry.name.endsWith("/")) {
      continue;
    }
    const root = parseXml(text);
    const base = entry.name.split("/").pop() ?? entry.name;
    const fullName = base.replace(/\.[A-Za-z0-9]+-meta\.xml$/, "");
    files.push({ type: root.name, fullName, fields: fieldsFromElement(root) });
  }
  return { files, destructive };
};

const canonicalValue = (value: MetadataField): string => {
  if (typeof value === "boolean") {
    return value ? "b:true" : "b:false";
  }
  if (typeof value === "string") {
    if (value === "true" || value === "false") {
      return `b:${value}`;
    }
    return `s:${value}`;
  }
  if (Array.isArray(value)) {
    return `a:${value.map((entry) => canonicalValue(entry)).join(",")}`;
  }
  if (!isMetadataRecord(value)) {
    return "o:";
  }
  const keys = Object.keys(value).sort();
  return `o:${keys.map((key) => `${key}=${canonicalValue(value[key]!)}`).join(";")}`;
};

/** Semantic equality of metadata fields. Boolean text matches real booleans. */
export const metadataFieldsEqual = (left: MetadataFields, right: MetadataFields): boolean => {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === undefined || rightValue === undefined) {
      return leftValue === rightValue;
    }
    return canonicalValue(leftValue) === canonicalValue(rightValue);
  });
};

const soapEnvelope = (sessionId: string, body: string): string => {
  const session = `<met:sessionId>${escapeXml(sessionId)}</met:sessionId>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:met="http://soap.sforce.com/2006/04/metadata">` +
    `<soapenv:Header><met:SessionHeader>${session}</met:SessionHeader></soapenv:Header>` +
    `<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`
  );
};

const executeHttp = (
  method: "GET" | "POST",
  url: string,
  path: string,
  build: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  secrets: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const httpRequest = build(HttpClientRequest.make(method)(url));
    const response = yield* client.execute(httpRequest).pipe(
      Effect.mapError(
        (cause) =>
          apiError(
            `Salesforce metadata request failed before a response: ${errorMessage(cause)}`,
            0,
            method,
            path,
            secrets,
          ),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          apiError(
            `Salesforce metadata response could not be read: ${errorMessage(cause)}`,
            response.status,
            method,
            path,
            secrets,
          ),
      ),
    );
    return { status: response.status, text };
  });

const soapRequest = (
  connection: ResolvedConnection,
  operation: string,
  innerXml: string,
  secrets: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const token = Redacted.value(connection.accessToken);
    const path = soapPath(connection.apiVersion);
    const url = `${connection.instanceUrl}${path}`;
    const allSecrets = [token, ...secrets];
    const envelope = soapEnvelope(token, innerXml);
    const response = yield* executeHttp(
      "POST",
      url,
      path,
      (request) =>
        request.pipe(
          HttpClientRequest.bodyText(envelope, "text/xml; charset=UTF-8"),
          HttpClientRequest.setHeader("SOAPAction", '""'),
          HttpClientRequest.setHeader("Accept", "text/xml"),
        ),
      allSecrets,
    );
    let root: XmlElement;
    try {
      root = parseXml(response.text);
    } catch (cause) {
      return yield* Effect.fail(
        apiError(
          `Salesforce metadata response was not usable XML (${operation}): ${errorMessage(cause)}`,
          response.status,
          "POST",
          path,
          allSecrets,
        ),
      );
    }
    const fault = findElements(root, "Fault")[0];
    if (fault !== undefined || response.status < 200 || response.status >= 300) {
      const faultString = fault?.children.find((child) => child.name === "faultstring")?.text;
      const faultCode = fault?.children.find((child) => child.name === "faultcode")?.text;
      return yield* Effect.fail(
        apiError(
          faultString ?? `Salesforce metadata ${operation} failed.`,
          response.status === 0 ? 500 : response.status,
          "POST",
          path,
          allSecrets,
          faultCode,
        ),
      );
    }
    return root;
  });

const componentFromRecord = (type: string, record: XmlElement): MetadataComponent | undefined => {
  if (record.attributes.nil === "true") {
    return undefined;
  }
  const fields = fieldsFromElement(record);
  const fullName = fields.fullName;
  if (typeof fullName !== "string" || fullName.length === 0) {
    return undefined;
  }
  const rest: Record<string, MetadataField> = { ...fields };
  delete rest.fullName;
  return { type, fullName, fields: rest };
};

/** SOAP readMetadata. Unknown names are omitted. The body is not logged. */
export const readMetadata = (
  connection: ResolvedConnection,
  type: string,
  fullNames: ReadonlyArray<string>,
  secrets: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    if (fullNames.length === 0) {
      return [] as readonly MetadataComponent[];
    }
    const names = fullNames
      .map((fullName) => `<met:fullNames>${escapeXml(fullName)}</met:fullNames>`)
      .join("");
    const root = yield* soapRequest(
      connection,
      "readMetadata",
      `<met:readMetadata><met:type>${escapeXml(type)}</met:type>${names}</met:readMetadata>`,
      secrets,
    );
    const records = findElements(root, "records");
    const components: MetadataComponent[] = [];
    for (const record of records) {
      const component = componentFromRecord(type, record);
      if (component !== undefined) {
        components.push(component);
      }
    }
    return components;
  });

/** SOAP listMetadata for one metadata type. */
export const listMetadata = (connection: ResolvedConnection, type: string) =>
  Effect.gen(function* () {
    const root = yield* soapRequest(
      connection,
      "listMetadata",
      `<met:listMetadata><met:queries><met:type>${escapeXml(type)}</met:type></met:queries>` +
        `<met:asOfVersion>${escapeXml(connection.apiVersion)}</met:asOfVersion></met:listMetadata>`,
      [],
    );
    const results = findElements(root, "result").filter((element) =>
      element.children.some((child) => child.name === "fullName"),
    );
    const listed: ListedMetadata[] = [];
    for (const result of results) {
      const fields = fieldsFromElement(result);
      const fullName = fields.fullName;
      if (typeof fullName !== "string" || fullName.length === 0) {
        continue;
      }
      listed.push({
        type: typeof fields.type === "string" ? fields.type : type,
        fullName,
        fileName: typeof fields.fileName === "string" ? fields.fileName : undefined,
        id: typeof fields.id === "string" ? fields.id : undefined,
      });
    }
    return listed;
  });

const parseDeployResult = (
  body: unknown,
  secrets: ReadonlyArray<string>,
  method: string,
  path: string,
): Effect.Effect<DeployResult, SalesforceApiError> => {
  const root = asRecord(body);
  const result = asRecord(root?.deployResult) ?? root;
  if (result === undefined) {
    return Effect.fail(
      apiError("Salesforce deploy response did not include deployResult.", 200, method, path, secrets),
    );
  }
  const id = (root === undefined ? undefined : stringField(root, "id")) ?? stringField(result, "id");
  if (id === undefined) {
    return Effect.fail(apiError("Salesforce deploy response did not include an id.", 200, method, path, secrets));
  }
  const details = asRecord(result.details);
  const successes = asList(details?.componentSuccesses);
  const failures = asList(details?.componentFailures);
  const components: DeployComponentDetail[] = [];
  const push = (entry: unknown, failed: boolean): void => {
    const record = asRecord(entry);
    if (record === undefined) {
      return;
    }
    const componentType = stringField(record, "componentType") ?? "";
    const fullName = stringField(record, "fullName") ?? "";
    if (componentType === "Package" || fullName === "package.xml") {
      return;
    }
    const problemValue = record.problem;
    const problem = typeof problemValue === "string" && problemValue.length > 0 ? problemValue : undefined;
    components.push({
      componentType,
      fullName,
      changed: booleanField(record.changed),
      created: booleanField(record.created),
      deleted: booleanField(record.deleted),
      success: failed ? false : record.success !== false,
      problem,
    });
  };
  for (const entry of successes) {
    push(entry, false);
  }
  for (const entry of failures) {
    push(entry, true);
  }
  return Effect.succeed({
    id,
    checkOnly: booleanField(result.checkOnly),
    status: stringField(result, "status") ?? "",
    success: result.success === true || result.status === "Succeeded",
    components,
  });
};

const TERMINAL = new Set(["Succeeded", "SucceededPartial", "Failed", "Canceled", "FinalizingDeployFailed"]);

const pollDeploy = (
  connection: ResolvedConnection,
  id: string,
  secrets: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const path = `${metadataPath(connection.apiVersion)}/${encodeURIComponent(id)}`;
    const url = `${connection.instanceUrl}${path}?includeDetails=true`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = yield* executeHttp(
        "GET",
        url,
        path,
        (request) =>
          request.pipe(HttpClientRequest.bearerToken(connection.accessToken), HttpClientRequest.acceptJson),
        secrets,
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          apiError(
            `Salesforce deploy status failed: ${redactText(response.text, secrets)}`,
            response.status,
            "GET",
            path,
            secrets,
          ),
        );
      }
      let parsed: unknown;
      try {
        parsed = response.text.length === 0 ? undefined : JSON.parse(response.text);
      } catch {
        return yield* Effect.fail(
          apiError("Salesforce deploy status was not JSON.", response.status, "GET", path, secrets),
        );
      }
      const result = yield* parseDeployResult(parsed, secrets, "GET", path);
      const root = asRecord(parsed);
      const deployResult = asRecord(root?.deployResult) ?? root;
      const done = deployResult?.done === true || TERMINAL.has(result.status);
      if (!done) {
        yield* Effect.sleep("25 millis");
        continue;
      }
      return result;
    }
    return yield* Effect.fail(apiError(`Salesforce deploy '${id}' did not finish.`, 0, "GET", path, secrets));
  });

const postDeploy = (
  connection: ResolvedConnection,
  archive: Uint8Array,
  checkOnly: boolean,
  secrets: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const path = metadataPath(connection.apiVersion);
    const url = `${connection.instanceUrl}${path}`;
    const options = {
      deployOptions: {
        allowMissingFiles: false,
        autoUpdatePackage: false,
        checkOnly,
        ignoreWarnings: false,
        performRetrieve: false,
        purgeOnDelete: false,
        rollbackOnError: true,
        singlePackage: true,
        testLevel: "NoTestRun",
      },
    };
    let boundary = `AlchemyMetadata${randomBytes(16).toString("hex")}`;
    const zip = Buffer.from(archive);
    while (zip.includes(boundary)) {
      boundary = `AlchemyMetadata${randomBytes(16).toString("hex")}`;
    }
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="json"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${JSON.stringify(options)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="deploy.zip"\r\n` +
        `Content-Type: application/zip\r\n\r\n`,
      "utf8",
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([preamble, zip, closing]);
    const response = yield* executeHttp(
      "POST",
      url,
      path,
      (request) =>
        request.pipe(
          HttpClientRequest.bodyUint8Array(body, `multipart/form-data; boundary=${boundary}`),
          HttpClientRequest.bearerToken(connection.accessToken),
          HttpClientRequest.acceptJson,
        ),
      secrets,
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        apiError(
          `Salesforce metadata deploy failed: ${redactText(response.text, secrets)}`,
          response.status,
          "POST",
          path,
          secrets,
        ),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      return yield* Effect.fail(
        apiError("Salesforce deploy response was not JSON.", response.status, "POST", path, secrets),
      );
    }
    const accepted = yield* parseDeployResult(parsed, secrets, "POST", path);
    return yield* pollDeploy(connection, accepted.id, secrets);
  });

const assertDeploySucceeded = (
  result: DeployResult,
  secrets: ReadonlyArray<string>,
  path: string,
): Effect.Effect<DeployResult, SalesforceApiError> => {
  const problems = result.components.filter((component) => !component.success || component.problem !== undefined);
  if (!result.success || result.status === "Failed" || result.status === "SucceededPartial" || problems.length > 0) {
    const detail = problems
      .map((component) => `${component.componentType} ${component.fullName}: ${component.problem ?? "failed"}`)
      .join("; ");
    return Effect.fail(
      apiError(
        (
          `Salesforce metadata deploy ${result.checkOnly ? "check" : "apply"} ` +
          `${result.status || "failed"}. ${detail}`
        ).trim(),
        400,
        "POST",
        path,
        secrets,
      ),
    );
  }
  return Effect.succeed(result);
};

export interface MetadataDeployInput {
  readonly files?: ReadonlyArray<MetadataFile>;
  readonly destructive?: ReadonlyArray<DestructiveMember>;
  readonly sensitive?: ReadonlyArray<string>;
}

/**
 * Check-only deploy, then the real deploy, under a per-org lock.
 * Zip bytes exist only in memory.
 */
export const deployMetadata = (connection: ResolvedConnection, input: MetadataDeployInput) => {
  const files = input.files ?? [];
  const destructive = input.destructive ?? [];
  const secrets = [
    Redacted.value(connection.accessToken),
    ...sensitiveMetadataValues(files),
    ...(input.sensitive ?? []),
  ];
  const run = Effect.gen(function* () {
    if (files.length === 0 && destructive.length === 0) {
      return yield* Effect.fail(
        apiError("Metadata deploy has no components.", 0, "POST", metadataPath(connection.apiVersion), secrets),
      );
    }
    const archive = buildZip(connection.apiVersion, files, destructive);
    const path = metadataPath(connection.apiVersion);
    const check = yield* postDeploy(connection, archive, true, secrets);
    yield* assertDeploySucceeded(check, secrets, path);
    const deployed = yield* postDeploy(connection, archive, false, secrets);
    yield* assertDeploySucceeded(deployed, secrets, path);
    return { check, deploy: deployed };
  });
  return gateFor(connection.instanceUrl).withPermits(1)(run);
};
