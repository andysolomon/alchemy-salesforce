# GitHub Actions for Salesforce stacks

Copy these into your project's `.github/workflows/`.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`plan.yml`](plan.yml) | Pull request | `alchemy plan` for uat and prod, written to the job summary |
| [`deploy.yml`](deploy.yml) + [`salesforce-deploy-stage.yml`](salesforce-deploy-stage.yml) | Push to `main` | Deploy uat, then prod. Add required reviewers to the `prod` environment to gate it |
| [`drift.yml`](drift.yml) | Nightly | `alchemy drift` without repair. Drift opens or updates an issue and fails the run |
| [`scratch-org-preview.yml`](scratch-org-preview.yml) | Pull request opened, pushed, or closed | A scratch org named `pr-<number>`, deleted when the pull request closes |

## The stack they expect

`plan`, `deploy`, and `drift` run `alchemy.run.ts` with `--stage uat` or `--stage prod`. Each job logs in with the stage name as the sf alias, so resources without `targetOrg` use that org. The preview workflow runs `alchemy.preview.ts`; start from [`../scratch-org.ts`](../scratch-org.ts).

**State must be remote.** Every run starts on a clean runner, so `localState()` would plan everything as new and lose track of the scratch org between pushes. The workflows assume `Cloudflare.state()`:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare";

export default Stack("SalesforceOrg", {
  providers: Salesforce.providers(),
  state: Cloudflare.state(),
}, program);
```

Any remote Alchemy state store works. Drop the `CLOUDFLARE_*` variables if you use another.

## Settings

Create one GitHub environment per stage (`uat`, `prod`) and one named `devhub` for previews.

| Name | Kind | Where | Value |
| --- | --- | --- | --- |
| `SF_JWT_KEY` | secret | each environment | Private key (PEM) of the connected app used for JWT login |
| `SF_CLIENT_ID` | variable | each environment | That connected app's consumer key |
| `SF_USERNAME` | variable | `uat`, `prod` | Integration user that deploys |
| `SF_LOGIN_URL` | variable | `uat`, `prod` | `https://test.salesforce.com` for sandboxes. Defaults to `https://login.salesforce.com` |
| `SF_DEVHUB_USERNAME` | variable | `devhub` | Dev Hub user |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secret | repository | For `Cloudflare.state()` |

If `prod` requires reviewers, the prod plan and drift jobs wait for approval too. To avoid that, create a `prod-readonly` environment with a read-only user and point those jobs at it.

## Scratch orgs across runs

A later run of the preview workflow lands on a new runner with no login for `pr-<number>`. `ScratchOrg` handles both directions:

- **Push:** it finds the org through the Dev Hub and logs back in with `sf org login jwt`, using `SF_JWT_CLIENT_ID` and `SF_JWT_KEY_FILE` (the workflow sets both). Scratch orgs accept the Dev Hub connected app for their own users.
- **Close:** it deletes the Dev Hub's `ActiveScratchOrg` row, which deletes the org. No scratch org login is needed.

Pull requests from forks get no secrets, so the preview job skips them.
