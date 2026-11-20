import { Resource, type Resource as ResourceInstance } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { queryRecords, request, sobjectPath } from "./api.js";
import { connectionFor, targetOrgChanged, type ResolvedConnection } from "./connection.js";
import { isNotFound, SalesforceApiError, SalesforceValidationError } from "./errors.js";
import { soqlString } from "./soql.js";

/**
 * CSP directive scope. `VisualForce` is Salesforce's API value (capital F).
 * Object reference, API 68.0:
 * https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_csptrustedsite.htm
 */
export const CSP_CONTEXTS = [
  "All",
  "Communities",
  "FieldServiceMobileExtension",
  "LEX",
  "LightningOut",
  "VisualForce",
] as const;

export type CspContext = (typeof CSP_CONTEXTS)[number];

/** Maps to `IsApplicableTo*` on `CspTrustedSite`. At least one must be true. */
export interface CspDirectives {
  readonly connectSrc?: boolean;
  readonly fontSrc?: boolean;
  readonly frameSrc?: boolean;
  readonly imgSrc?: boolean;
  readonly mediaSrc?: boolean;
  readonly styleSrc?: boolean;
}

export interface CspTrustedSiteProps {
  /**
   * sf alias of the org that owns this row. Omit to use the default org
   * (`SF_TARGET_ORG`, otherwise the Alchemy stage). An `Org` alias output
   * wires the dependency.
   */
  readonly targetOrg?: string;
  /** `DeveloperName`. Stable API name, not the Alchemy logical id. */
  readonly name: string;
  readonly endpointUrl: string;
  /** Required so a deploy cannot silently activate or deactivate a URL. */
  readonly isActive: boolean;
  readonly context?: CspContext;
  /** `MasterLabel`. Defaults to `name`. */
  readonly label?: string;
  /**
   * When omitted, an existing description is left alone.
   * Salesforce's limit is 255 characters.
   */
  readonly description?: string;
  readonly directives: CspDirectives;
}

export interface CspTrustedSiteAttributes {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly endpointUrl: string;
  readonly isActive: boolean;
  readonly context: CspContext;
  readonly description: string | null;
  readonly directives: Required<CspDirectives>;
}

export type CspTrustedSite = ResourceInstance<
  "Salesforce.CspTrustedSite",
  CspTrustedSiteProps,
  CspTrustedSiteAttributes
>;

export const CspTrustedSite = Resource<CspTrustedSite>("Salesforce.CspTrustedSite");

const SITE_FIELDS = [
  "Id",
  "DeveloperName",
  "MasterLabel",
  "EndpointUrl",
  "IsActive",
  "Context",
  "Description",
  "IsApplicableToConnectSrc",
  "IsApplicableToFontSrc",
  "IsApplicableToFrameSrc",
  "IsApplicableToImgSrc",
  "IsApplicableToMediaSrc",
  "IsApplicableToStyleSrc",
].join(", ");

interface NormalizedSite {
  readonly name: string;
  readonly label: string;
  readonly endpointUrl: string;
  readonly isActive: boolean;
  readonly context: CspContext;
  readonly description: string | undefined;
  readonly directives: Required<CspDirectives>;
}

const isContext = (value: string): value is CspContext =>
  (CSP_CONTEXTS as ReadonlyArray<string>).includes(value);

const isDeveloperName = (name: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !name.includes("__") && !name.endsWith("_") && name.length <= 40;

export const normalizeTrustedSite = (
  props: CspTrustedSiteProps,
): Effect.Effect<NormalizedSite, SalesforceValidationError> => {
  const name = props.name.trim();
  if (!isDeveloperName(name)) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          `CspTrustedSite name '${props.name}' must be a Salesforce developer name: ` +
          "start with a letter, use only letters, numbers, and single underscores, " +
          "and be at most 40 characters.",
      }),
    );
  }
  const endpointUrl = props.endpointUrl.trim();
  if (endpointUrl.length === 0 || endpointUrl.length > 255) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "CspTrustedSite endpointUrl must be 1 to 255 characters.",
      }),
    );
  }
  const label = (props.label ?? name).trim();
  if (label.length === 0 || label.length > 80) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "CspTrustedSite label must be 1 to 80 characters.",
      }),
    );
  }
  if (props.description !== undefined && props.description.length > 255) {
    return Effect.fail(
      new SalesforceValidationError({
        message: "CspTrustedSite description must be at most 255 characters.",
      }),
    );
  }
  if (props.context !== undefined && !isContext(props.context)) {
    return Effect.fail(
      new SalesforceValidationError({
        message: `CspTrustedSite context '${props.context}' is not a supported value.`,
      }),
    );
  }
  const directives: Required<CspDirectives> = {
    connectSrc: props.directives.connectSrc ?? false,
    fontSrc: props.directives.fontSrc ?? false,
    frameSrc: props.directives.frameSrc ?? false,
    imgSrc: props.directives.imgSrc ?? false,
    mediaSrc: props.directives.mediaSrc ?? false,
    styleSrc: props.directives.styleSrc ?? false,
  };
  if (!Object.values(directives).some(Boolean)) {
    return Effect.fail(
      new SalesforceValidationError({
        message:
          "Salesforce requires at least one CspTrustedSite directive (IsApplicableTo*) to be true. " +
          "Set directives.connectSrc (or another directive) to true. " +
          "Keep isActive false when the URL should not be enforced.",
      }),
    );
  }
  return Effect.succeed({
    name,
    label,
    endpointUrl,
    isActive: props.isActive,
    context: props.context ?? "All",
    description: props.description,
    directives,
  });
};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const directivesFrom = (record: Record<string, unknown>): Required<CspDirectives> => ({
  connectSrc: record.IsApplicableToConnectSrc === true,
  fontSrc: record.IsApplicableToFontSrc === true,
  frameSrc: record.IsApplicableToFrameSrc === true,
  imgSrc: record.IsApplicableToImgSrc === true,
  mediaSrc: record.IsApplicableToMediaSrc === true,
  styleSrc: record.IsApplicableToStyleSrc === true,
});

const attributesFrom = (
  record: Record<string, unknown>,
): Effect.Effect<CspTrustedSiteAttributes, SalesforceApiError> => {
  const id = stringField(record, "Id");
  const name = stringField(record, "DeveloperName");
  const endpointUrl = stringField(record, "EndpointUrl");
  const label = stringField(record, "MasterLabel") ?? name;
  if (id === undefined || name === undefined || endpointUrl === undefined || label === undefined) {
    return Effect.fail(
      new SalesforceApiError({
        message: "CspTrustedSite record was missing Id, DeveloperName, or EndpointUrl.",
        status: 200,
        errorCode: undefined,
        method: "GET",
        path: "/sobjects/CspTrustedSite",
      }),
    );
  }
  const rawContext = stringField(record, "Context") ?? "All";
  if (!isContext(rawContext)) {
    return Effect.fail(
      new SalesforceApiError({
        message: `CspTrustedSite ${id} returned unsupported Context '${rawContext}'.`,
        status: 200,
        errorCode: undefined,
        method: "GET",
        path: `/sobjects/CspTrustedSite/${id}`,
      }),
    );
  }
  const description = record.Description;
  return Effect.succeed({
    id,
    name,
    label,
    endpointUrl,
    isActive: record.IsActive === true,
    context: rawContext,
    description: typeof description === "string" ? description : null,
    directives: directivesFrom(record),
  });
};

const siteBody = (site: NormalizedSite): Record<string, unknown> => ({
  DeveloperName: site.name,
  MasterLabel: site.label,
  EndpointUrl: site.endpointUrl,
  IsActive: site.isActive,
  Context: site.context,
  IsApplicableToConnectSrc: site.directives.connectSrc,
  IsApplicableToFontSrc: site.directives.fontSrc,
  IsApplicableToFrameSrc: site.directives.frameSrc,
  IsApplicableToImgSrc: site.directives.imgSrc,
  IsApplicableToMediaSrc: site.directives.mediaSrc,
  IsApplicableToStyleSrc: site.directives.styleSrc,
  ...(site.description === undefined ? {} : { Description: site.description }),
});

const drifted = (record: Record<string, unknown>, site: NormalizedSite): boolean => {
  const description = typeof record.Description === "string" ? record.Description : null;
  const desiredDescription = site.description === undefined ? undefined : site.description;
  const directives = directivesFrom(record);
  return (
    stringField(record, "DeveloperName") !== site.name ||
    (stringField(record, "MasterLabel") ?? "") !== site.label ||
    stringField(record, "EndpointUrl") !== site.endpointUrl ||
    (record.IsActive === true) !== site.isActive ||
    (stringField(record, "Context") ?? "All") !== site.context ||
    directives.connectSrc !== site.directives.connectSrc ||
    directives.fontSrc !== site.directives.fontSrc ||
    directives.frameSrc !== site.directives.frameSrc ||
    directives.imgSrc !== site.directives.imgSrc ||
    directives.mediaSrc !== site.directives.mediaSrc ||
    directives.styleSrc !== site.directives.styleSrc ||
    (desiredDescription !== undefined && description !== desiredDescription)
  );
};

const createdId = (body: unknown): string | undefined => {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
};

const findByName = (connection: ResolvedConnection, name: string) =>
  Effect.gen(function* () {
    const records = yield* queryRecords(
      connection,
      `SELECT ${SITE_FIELDS} FROM CspTrustedSite WHERE DeveloperName = ${soqlString(name)}`,
    );
    return records[0];
  });

const findById = (connection: ResolvedConnection, id: string) =>
  Effect.gen(function* () {
    const result = yield* request(connection, {
      method: "GET",
      path: sobjectPath(connection.apiVersion, "CspTrustedSite", id),
    }).pipe(
      Effect.catchTag("SalesforceApiError", (error) =>
        isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (result === undefined || result.body === null || typeof result.body !== "object" || Array.isArray(result.body)) {
      return undefined;
    }
    return result.body as Record<string, unknown>;
  });

const isDuplicate = (error: SalesforceApiError): boolean =>
  error.errorCode === "DUPLICATE_DEVELOPER_NAME" || error.errorCode === "DUPLICATE_VALUE";

const ensureSite = (
  connection: ResolvedConnection,
  site: NormalizedSite,
  current: Record<string, unknown> | undefined,
) =>
  Effect.gen(function* () {
    if (current !== undefined) {
      return current;
    }
    const created = yield* request(connection, {
      method: "POST",
      path: sobjectPath(connection.apiVersion, "CspTrustedSite"),
      body: siteBody(site),
    }).pipe(
      Effect.catchTag("SalesforceApiError", (error) =>
        isDuplicate(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (created !== undefined) {
      const id = createdId(created.body);
      if (id !== undefined) {
        const loaded = yield* findById(connection, id);
        if (loaded !== undefined) {
          return loaded;
        }
      }
    }
    const existing = yield* findByName(connection, site.name);
    if (existing === undefined) {
      return yield* Effect.fail(
        new SalesforceApiError({
          message: `CspTrustedSite '${site.name}' was not found after create.`,
          status: 0,
          errorCode: undefined,
          method: "POST",
          path: "/sobjects/CspTrustedSite",
        }),
      );
    }
    return existing;
  });

const loadSite = (
  connection: ResolvedConnection,
  input: { readonly name: string | undefined; readonly id: string | undefined },
) =>
  Effect.gen(function* () {
    const byId = input.id === undefined ? undefined : yield* findById(connection, input.id);
    const record = byId ?? (input.name === undefined ? undefined : yield* findByName(connection, input.name));
    if (record === undefined) {
      return undefined;
    }
    return yield* attributesFrom(record);
  });

/**
 * `list` is real, but nuke is skipped. Trusted URLs are not tagged with an
 * Alchemy owner, so `alchemy unsafe nuke` would delete every CSP trusted
 * site in the org. `alchemy destroy` still deletes sites this stack created.
 */
export const CspTrustedSiteProvider = Provider.succeed(
  CspTrustedSite,
  CspTrustedSite.Provider.of({
    stables: ["id"],
    nuke: { skip: true },
    diff: (input) =>
      Effect.gen(function* () {
        if (!isResolved(input.news) || input.olds === undefined) {
          return undefined;
        }
        if (targetOrgChanged(input.olds.targetOrg, input.news.targetOrg)) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        return yield* loadSite(connection, {
          id: input.output?.id,
          name: input.olds.name,
        });
      }),
    observe: (input) =>
      Effect.gen(function* () {
        const name = input.news?.name;
        if (typeof name !== "string") {
          return undefined;
        }
        const targetOrg = typeof input.news.targetOrg === "string" ? input.news.targetOrg : undefined;
        const connection = yield* connectionFor(targetOrg);
        return yield* loadSite(connection, { id: undefined, name });
      }),
    list: () =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(undefined);
        const records = yield* queryRecords(connection, `SELECT ${SITE_FIELDS} FROM CspTrustedSite`);
        return yield* Effect.forEach(records, attributesFrom);
      }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.news.targetOrg);
        const site = yield* normalizeTrustedSite(input.news);
        const byId = input.output?.id === undefined ? undefined : yield* findById(connection, input.output.id);
        const current = byId ?? (yield* findByName(connection, site.name));
        const ensured = yield* ensureSite(connection, site, current);
        const id = stringField(ensured, "Id");
        if (id === undefined) {
          return yield* Effect.fail(
            new SalesforceApiError({
              message: `CspTrustedSite '${site.name}' has no Id.`,
              status: 0,
              errorCode: undefined,
              method: "GET",
              path: "/sobjects/CspTrustedSite",
            }),
          );
        }
        if (drifted(ensured, site)) {
          yield* request(connection, {
            method: "PATCH",
            path: sobjectPath(connection.apiVersion, "CspTrustedSite", id),
            body: siteBody(site),
          });
          const reloaded = yield* findById(connection, id);
          if (reloaded === undefined) {
            return yield* Effect.fail(
              new SalesforceApiError({
                message: `CspTrustedSite ${id} disappeared after update.`,
                status: 404,
                errorCode: "NOT_FOUND",
                method: "GET",
                path: `/sobjects/CspTrustedSite/${id}`,
              }),
            );
          }
          return yield* attributesFrom(reloaded);
        }
        return yield* attributesFrom(ensured);
      }),
    delete: (input) =>
      Effect.gen(function* () {
        const connection = yield* connectionFor(input.olds.targetOrg);
        const remove = (id: string) =>
          request(connection, {
            method: "DELETE",
            path: sobjectPath(connection.apiVersion, "CspTrustedSite", id),
          }).pipe(
            Effect.as("deleted" as const),
            Effect.catchTag("SalesforceApiError", (error) =>
              isNotFound(error) ? Effect.succeed("missing" as const) : Effect.fail(error),
            ),
          );
        const outcome = yield* remove(input.output.id);
        if (outcome === "deleted") {
          return;
        }
        const named = yield* findByName(connection, input.olds.name);
        const fallback = named === undefined ? undefined : stringField(named, "Id");
        if (fallback !== undefined && fallback !== input.output.id) {
          yield* remove(fallback);
        }
      }),
  }),
);
