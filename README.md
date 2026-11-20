# alchemy-salesforce

Alchemy provider for Salesforce org configuration. It manages CSP trusted sites, remote site settings, permission set assignments, external credentials, named credentials, credential secrets, and principal access.

The public surface matches Alchemy's built-in providers: an Effect `Layer` from `providers()`, and resource constructors you `yield*` inside a stack.

```ts
import { localState, Stack } from "alchemy";
import * as Salesforce from "alchemy-salesforce";

export default Stack("SalesforceOrg", {
  providers: Salesforce.providers(),
  state: localState(),
}, program);
```

Built for Alchemy v2 (`alchemy@2.0.0-beta.87`), Effect `4.1.4`, and Node.js `>=24.11.1`.

## Install

This package is not published. From an app that already depends on Alchemy:

```sh
npm install alchemy@2.0.0-beta.87 effect@4.1.4 @effect/platform-node@4.1.4
npm install git+https://github.com/andysolomon/alchemy-salesforce.git#<commit-sha>
```

`alchemy`, `effect`, and `@effect/platform-node` are peer dependencies. Keep them on these versions so resource identity and the Effect runtime match.

Pin a commit SHA. This package is private and unpublished. npm installs git dependencies by packing a tarball, and that pack runs `prepare`, not `prepack`. `prepare` compiles `src/` to `dist/` (the `files` list ships `dist/`, which is gitignored). Without `prepare`, the installed package has no `dist/index.js`.

npm fetches GitHub git dependencies over SSH (`git+ssh://git@github.com/...`), even when `package.json` says `git+https://`. An SSH key that can read this repository is enough for `npm ci`. If you authenticate with `gh` over HTTPS, point SSH at HTTPS before installing, then let `gh` supply the credential:

```sh
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
gh auth setup-git
```

In CI, `actions/checkout` only authenticates the workflow checkout. Set the same `insteadOf` globally and pass a token that can read this repository (`GITHUB_TOKEN` from another repo cannot).

To work on the provider itself:

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm test` talks to a local HTTP mock. It does not call Salesforce and it does not need the `sf` CLI.

## Auth and `Org` binding

Handlers resolve a connection the first time they call the API, then reuse it for the process. The access token is an Effect `Redacted` value. It is not written to Alchemy state and it is not passed on the `sf` command line.

Resolution order:

1. **Static credentials for the default org**, when both values are set. Either pair works: `SF_INSTANCE_URL` + `SF_ACCESS_TOKEN`, or `SALESFORCE_INSTANCE_URL` + `SALESFORCE_ACCESS_TOKEN`. Setting only one of the pair is an error. This path does not spawn `sf`.
2. **`SF_ORG_CREDENTIALS`**, a JSON object keyed by sf alias. Each entry has `instanceUrl` and `accessToken`, and may include `orgId`, `username`, and `apiVersion`. An explicit alias uses only its own entry.
3. **Salesforce CLI**, otherwise.
   - Alias: the resource's `targetOrg`, then `SF_TARGET_ORG`, then `SALESFORCE_TARGET_ORG`, then the Alchemy stage name, then `ALCHEMY_STAGE`.
   - `sf org display --target-org <alias> --json` supplies `instanceUrl`, `apiVersion`, `username`, and `id`.
   - Current CLI builds redact `accessToken` in that output. When the value is missing or contains `REDACTED`, the provider runs `sf org auth show-access-token --target-org <alias> --json --no-prompt`.
4. **API version**: `SF_API_VERSION`, then the version reported by `sf org display` or the credentials entry, then `68.0` (Winter '27).

An explicit `targetOrg` never falls through to the process-wide `SF_ACCESS_TOKEN`. Each alias has its own cached URL and token. Logs include the alias and instance URL, not the token.

Authorize an org once, then deploy with a stable stage so state does not follow a `live_$USER` stage name:

```sh
sf org login web --alias dev
npx alchemy plan --stage dev
npx alchemy deploy --stage dev --yes
```

For a sandbox, pass `--instance-url` to `sf org login web`. The alias is what later deploys use.

`Salesforce.Org` does not create or delete anything in Salesforce. It resolves an alias to `orgId`, `instanceUrl`, `username`, `apiVersion`, and `graphqlUrl` (`{instanceUrl}/services/data/v{apiVersion}/graphql`). Other resources take `targetOrg: org.alias` and endpoint URLs from `org.instanceUrl`, so stack files do not hard-code instance URLs. Changing the alias replaces the resource. `list` is empty and nuke is skipped: this provider will not log you out of orgs the stack does not own.

Omit `targetOrg` and the resource uses the default connection (`SF_TARGET_ORG`, otherwise the Alchemy stage).

See `examples/single-org.ts` and `examples/multi-org.ts`.

## Resources

| Resource | Create / update | Delete | Read / list |
| --- | --- | --- | --- |
| `Org` | No Salesforce write. Resolves an alias | No-op | The named alias. `list` is empty |
| `CspTrustedSite` | REST sObject `CspTrustedSite` | DELETE that row | SOQL / sObject retrieve |
| `PermissionSetAssignment` | POST an assignment of an existing permission set to an existing user | DELETE that row (unassign) | SOQL. A new user or permission set is a replace |
| `RemoteSiteSetting` | Tooling `RemoteProxy` via `FullName` + `Metadata` | DELETE, or deactivate when the API refuses DELETE | Tooling query on `SiteName` |
| `ExternalCredential` | Connect REST `POST` / `PUT /named-credentials/external-credentials` | DELETE that developer name (404 is already gone) | GET by developer name. `list` is the default org only |
| `NamedCredential` | Connect REST `POST` / `PUT /named-credentials/named-credential-setup` | DELETE that developer name | GET by developer name. `list` is the default org only |
| `ExternalCredentialSecret` | Connect REST `POST` when the principal has no credentials, otherwise `PUT /named-credentials/credential` | DELETE that principal's credential | GET. `list` is empty |
| `ExternalCredentialPrincipalAccess` | POST `SetupEntityAccess` (`ParentId` + `SetupEntityId`) | DELETE that row. The sObject is not updateable, so a new permission set or principal is a replace | SOQL on the pair. `list` is empty |

`alchemy unsafe nuke` is skipped on every resource. `alchemy destroy` deletes only rows recorded in this stack's state.

### `Org`

```ts
const org = yield* Salesforce.Org("Org", { alias: "dev" });
```

Outputs: `alias`, `orgId`, `instanceUrl`, `username`, `apiVersion`, `graphqlUrl`. A plan that is a noop because the alias did not change does not call `sf` again. `alchemy deploy --force` reconciles it.

### `CspTrustedSite`

REST sObject, not a metadata zip. At least one directive must be true. `isActive` is required so a deploy cannot quietly flip an existing site. Field changes, including the developer name, are patched in place. The Salesforce id is the stable attribute. An existing row with the same developer name is adopted and patched.

`context` is one of `All`, `Communities`, `FieldServiceMobileExtension`, `LEX`, `LightningOut`, `VisualForce`. The API spells `VisualForce` with a capital F.

```ts
const trustedSite = yield* Salesforce.CspTrustedSite("ExampleSite", {
  targetOrg: org.alias,
  name: "ExampleSite",
  label: "Example site",
  endpointUrl: "https://example.com",
  context: "All",
  isActive: false,
  directives: { connectSrc: true },
});
```

Camera and microphone permission-policy fields are not managed.

### `PermissionSetAssignment`

Assigns an **existing** permission set to an **existing** user. This does not create either record. The user is matched on `User.Username`. The permission set is matched on `Name` plus optional `NamespacePrefix`, with `IsOwnedByProfile = false`. Do not split the name on `__`. Pass `namespace` only for a namespaced permission set.

Changing the username or the permission set is a **replace**: Alchemy deletes the old row, then creates the new one. Assignment rows cannot be updated in place.

```ts
const assignment = yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
  targetOrg: org.alias,
  permissionSet: "Example_Access",
  username, // Config.NonEmptyString("SF_USERNAME")
});
```

### `RemoteSiteSetting`

Tooling API `RemoteProxy`. Create and update send only `FullName` and `Metadata` (`url`, `isActive`, `disableProtocolSecurity`, `description`). Top-level `SiteName` or `EndpointUrl` returns `FIELD_INTEGRITY_EXCEPTION`. Query reads `SiteName`, `EndpointUrl`, `IsActive`, `ProtocolMismatch` (that is `disableProtocolSecurity`), and `Description`.

Published REST methods are GET, HEAD, PATCH, POST, and Query. SOAP has no `delete()`. Destroy sends DELETE and, on HTTP 405 or `METHOD_NOT_ALLOWED`, PATCHes the row inactive instead of failing the stack. A live org may therefore keep the row and mark it inactive.

```ts
const remoteSite = yield* Salesforce.RemoteSiteSetting("ExampleRemote", {
  targetOrg: org.alias,
  siteName: "ExampleRemote",
  endpointUrl: org.instanceUrl,
  isActive: true,
  disableProtocolSecurity: false,
});
```

### `ExternalCredential`

Connect REST `/services/data/vXX.0/named-credentials/external-credentials`. Updates are PUT of the developer name. Tooling is not used: there, External Credential accepts only `FullName` and `Metadata`, and child parameters are not independently createable.

`authenticationProtocol` must be `"OAuth"` (capital A). Tooling's `"Oauth"` is rejected. Client-credentials variants:

| Variant | Where the client secret goes |
| --- | --- |
| `ClientCredentialsClientSecretBasic` | Authorization header |
| `ClientCredentialsClientSecret` | Request body |
| `ClientCredentialsJwtAssertion` | JWT client assertion |
| `JwtBearer` | JWT bearer flow |

OAuth client credentials need `{ parameterName: "AuthProviderUrl", parameterType: "AuthProviderUrl", parameterValue: "https://<my-domain>/services/oauth2/token" }`. That host is the **target** org's My Domain. `login.salesforce.com` and `test.salesforce.com` are rejected before a request is sent. A `NamedPrincipal` is required so a secret and a permission set can be attached.

Changing `targetOrg` or the developer name replaces the row (delete first). A second plan with the same props is a noop. Delete treats HTTP 404 as already gone.

`authenticationStatus` (and each principal's status) is observed, not configured. The credential is created before `ExternalCredentialSecret` binds values, so the first write often records `NotConfigured`. Binding the secret copies the live status back onto that snapshot. Later plans GET the credential and, when Salesforce now reports `Configured`, write that into state. The plan action stays **noop**. A status change does not PUT the credential. `ExternalCredentialSecret.authenticationStatus` is the status from the credential bind itself.

```ts
const external = yield* Salesforce.ExternalCredential("PartnerExternal", {
  targetOrg: caller.alias,
  developerName: "Partner_EC",
  masterLabel: "Partner",
  authenticationProtocol: "OAuth",
  authenticationProtocolVariant: "ClientCredentialsClientSecretBasic",
  parameters: [
    {
      parameterName: "AuthProviderUrl",
      parameterType: "AuthProviderUrl",
      parameterValue: tokenUrl, // `${target.instanceUrl}/services/oauth2/token`
    },
  ],
  principals: [
    { principalName: "PartnerPrincipal", principalType: "NamedPrincipal", sequenceNumber: 1 },
  ],
});
```

Developer names start with a letter, then letters, digits, or single underscores, at most 40 characters, with no trailing underscore and no double underscore.

### `NamedCredential`

Modern named credentials use `/named-credentials/named-credential-setup`. The path `/named-credentials/named-credentials` returns **404** on live orgs (confirmed on API 66 and 68). Updates are PUT. One external credential per named credential.

`calloutUrl` is the target origin. Outputs:

- `restBaseCallout` — `callout:<developerName>/services/data/v<apiVersion>`
- `graphqlCallout` — `callout:<developerName>/services/data/v<apiVersion>/graphql`

`named-credential-setup` does not read or delete legacy named credentials. Those rows are left alone.

```ts
const named = yield* Salesforce.NamedCredential("PartnerNamed", {
  targetOrg: caller.alias,
  developerName: "Partner_NC",
  masterLabel: "Partner Named Credential",
  type: "SecuredEndpoint",
  calloutUrl: target.instanceUrl,
  externalCredential: external.developerName,
  calloutOptions: {
    allowMergeFieldsInHeader: true,
    generateAuthorizationHeader: true,
  },
});
```

### `ExternalCredentialSecret`

See [Secret handling](#secret-handling) below.

```ts
yield* Salesforce.ExternalCredentialSecret("PartnerSecret", {
  targetOrg: caller.alias,
  externalCredential: external.developerName,
  principalName: "PartnerPrincipal",
  principalType: "NamedPrincipal",
  credentials: {
    clientId: { value: Redacted.make(clientId), encrypted: false },
    clientSecret: { value: Redacted.make(clientSecret), encrypted: true },
  },
});
```

On the target org, create an External Client App (or Connected App) that allows the OAuth client-credentials flow, has a Run As user, and includes the `api` scope. The token URL is that org's My Domain plus `/services/oauth2/token`.

Deploy without the secret first if you want. The external credential stays `NotConfigured` and the named credential still exists. Supply the credential values and deploy again to bind them. Removing the secret resource on a later deploy deletes that principal's credential.

### `ExternalCredentialPrincipalAccess`

Grants a permission set access to an external credential principal via `SetupEntityAccess`. `ParentId` is the permission set. `SetupEntityId` is the principal id (`0pu...`). The permission set must already exist. Pass `permissionSetName` (and optional `namespace`) or `permissionSetId`.

The sObject is not updateable. Changing either side deletes the old row and inserts a new one. `list` is empty because `SetupEntityAccess` also grants object, Apex, and tab access. A nuke that listed those rows would be able to delete grants this stack does not own.

```ts
yield* Salesforce.ExternalCredentialPrincipalAccess("PartnerPrincipalAccess", {
  targetOrg: caller.alias,
  permissionSetName: "Example_Access",
  externalCredential: external.developerName,
  principalName: "PartnerPrincipal",
});
```

## Secret handling

`ExternalCredentialSecret` accepts a string or `Redacted.make(value)` per credential key. Those values are held in process memory for the apply. They are **not** resource props.

Alchemy persists props. A `Redacted` value can still be written to state under a marker that keeps the plaintext, so secret values are stored in a process-local map instead of on the resource. State stores:

- `externalCredential`, `principalName`, `principalType`, `targetOrg`
- `credentialKeys` and `encryptedKeys` (names and the encrypted flag only)
- `credentialsDigest`, a SHA-256 of the names, flags, and values
- `authenticationStatus`

State does not store `clientSecret`, passwords, tokens, or any credential value. The digest detects rotation. It is not the secret and it is not reversible, but it is still material: do not publish state files.

Keys whose names match `secret`, `password`, `token`, or `session` are encrypted unless you set `encrypted` yourself. Error text is scrubbed if Salesforce echoes a value. Empty values and values that already look redacted are rejected before a request is sent.

`PUT /named-credentials/credential` replaces the map. Omitted keys are removed.

### POST when the principal has no credentials

A principal that has never had secrets still answers GET with **200**. The body is `authenticationStatus: "NotConfigured"` and `credentials: {}`, not 404. PUT against that principal fails and tells the caller to POST.

The provider treats "no stored credentials" as a create and **POSTs**. If a PUT still fails with a message such as "no existing authentication credentials" or "use the post method to create", it POSTs instead of failing the stack. A duplicate response is adopted. After the write, the provider reads the credential back and fails if Salesforce stored a different value. The failure message does not include the secret.

## Salesforce API gotchas

These showed up against live API 66 and 68 and are enforced in the provider:

- **Named credential path.** Use `named-credential-setup`. `named-credentials` (the plural collection under `/named-credentials/named-credentials`) returns 404.
- **Protocol enum.** Connect REST wants `"OAuth"`. Tooling's `"Oauth"` is a different, rejected value. Client-credentials variants are `ClientCredentialsClientSecretBasic` (header), `ClientCredentialsClientSecret` (body), `ClientCredentialsJwtAssertion`, and `JwtBearer`.
- **Credential verb.** GET of an unconfigured principal is 200 with an empty map. Create with POST. Update an existing map with PUT. PUT on a principal with no credentials fails.
- **Token host.** `AuthProviderUrl` must be `https://<my-domain>/services/oauth2/token`. `login.salesforce.com` and `test.salesforce.com` are rejected locally. Loopback `http://localhost` is allowed so tests can point at a mock.
- **Remote site body.** Tooling `RemoteProxy` create/update is `FullName` + `Metadata` only. Top-level `SiteName` / `EndpointUrl` is `FIELD_INTEGRITY_EXCEPTION`. DELETE may return 405; destroy then deactivates the row.
- **CSP.** At least one `IsApplicableTo*` directive must be true. Context `VisualForce` is spelled with a capital F.
- **Assignments and principal access** are insert/delete only. A changed user, permission set, or principal replaces the row.
- **CLI token.** `sf org display --json` often redacts `accessToken`. The provider then calls `sf org auth show-access-token --json --no-prompt`.
- **Alias isolation.** `targetOrg` does not reuse `SF_ACCESS_TOKEN` from a different org. Use `SF_ORG_CREDENTIALS` in CI when one process talks to several orgs.
- **List scope.** CSP, assignment, remote site, external credential, and named credential `list` read the **default** org only. Secret and principal-access `list` are empty. Nuke stays skipped so a mesh cannot wipe every credential in an org.
- **SOQL.** String literals are escaped, including quotes. This is not a general SOQL builder.
- **Permission set definitions** are not created here. Tooling `PermissionSet` does not support create. Deploy the definition with `sf project deploy`, and use this provider to assign it.

## When to use `sf project deploy` instead

Use `sf project deploy` for metadata that belongs in a Salesforce project: Apex, LWC, objects, the permission set definition, and a trusted site whose XML should be reviewed with the rest of the source. A trusted site that ships inside the package should stay a metadata file, or the two tools will fight over the same developer name.

Use this provider when the same org configuration is applied to several orgs, each with its own credentials and Alchemy state, when `plan` should show the diff, or when destroy must remove one row. Assigning a permission set to a user is a `PermissionSetAssignment` row. `sf project deploy` does not do that.

## State

`localState()` writes one JSON file per resource under `.alchemy/state/<stack>/<stage>/`. Files hold the resource type, the props you passed, and the output attributes. They do not hold the access token. They do hold the credential digest described above. The directory is gitignored. Two stages never share a directory.

When the alias and the stage name differ, set `SF_TARGET_ORG` and still pass a stable `--stage`.

## Limitations

- The resolved token is cached for the process, per alias. A deploy does not refresh a token mid-run. Start a new command after `sf` re-authenticates.
- `list` does not enumerate every alias. Secret and principal-access `list` are empty on purpose.
- Remote-site DELETE is not in the published Tooling API. Destroy may deactivate instead of delete. The mock covers that fallback.
- Credential values exist only in process memory for the apply. A crash before the write leaves Salesforce unchanged and leaves nothing secret on disk. A crash after the write still has only the digest in state.
- This package does not deploy Apex, permission set definitions, or legacy named credentials.
