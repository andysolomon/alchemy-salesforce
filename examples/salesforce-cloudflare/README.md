# Salesforce and Cloudflare in one stack

[`alchemy.run.ts`](alchemy.run.ts) deploys a Cloudflare Worker ([`src/worker.ts`](src/worker.ts)) and the Salesforce configuration that calls it:

1. The Worker, with a shared secret as a Cloudflare secret binding.
2. An External Credential (`Custom` protocol) that stores the same secret and sends `Authorization: Bearer <secret>` on every callout.
3. The credential secret, and access to it for an existing permission set.
4. A Named Credential whose URL is the Worker's URL output.

One `alchemy deploy` creates both sides. One `alchemy destroy` removes both. The Worker URL and the secret are never copied by hand, and Apex never sees the secret:

```apex
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:Enrichment_Worker/enrich?domain=acme.com');
req.setMethod('GET');
HttpResponse res = new Http().send(req);
```

## Run it in your own project

```sh
npm install alchemy@2.0.0-beta.87 @alchemy.run/cloudflare@2.0.0-beta.87 effect@4.1.4 @effect/platform-node@4.1.4
npm install github:andysolomon/alchemy-salesforce

sf org login web --alias dev
export WORKER_SHARED_SECRET="$(openssl rand -hex 32)"
export SF_PERMISSION_SET=Example_Access     # must already exist in the org
npx alchemy deploy --stage dev
```

To rotate the secret, export a new `WORKER_SHARED_SECRET` and deploy again. On the Salesforce side, `ExternalCredentialSecret` sees the change through its credential digest and writes the new value. The Worker's secret binding comes from the same value.

## In this repository

This folder is typechecked in CI against the provider's source, not the published package. Its `package.json` installs only `@alchemy.run/cloudflare`, and `.npmrc` sets `legacy-peer-deps` so `alchemy` and `effect` resolve from the repo root. A second copy of `effect` would make identical types incompatible. Keeping it out of the root `package.json` keeps installs from GitHub small: npm installs devDependencies for git dependencies, and the Cloudflare toolchain is several hundred megabytes.

```sh
npm ci                         # at the repo root
cd examples/salesforce-cloudflare
npm ci
npm run typecheck
```
