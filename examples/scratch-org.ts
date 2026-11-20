import { localState, Stack, Stage } from "alchemy";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Salesforce from "alchemy-salesforce";

/**
 * A disposable, fully configured scratch org per stage, for example one per
 * pull request. Run this from the root of a Salesforce DX project:
 *
 *   sf org login web --alias devhub --set-default-dev-hub
 *   npx alchemy deploy --config alchemy-salesforce/examples/scratch-org.ts --stage pr-42 --yes
 *   npx alchemy destroy --config alchemy-salesforce/examples/scratch-org.ts --stage pr-42 --yes
 *
 * Deploy creates the org, pushes the project's metadata into it, assigns the
 * app's permission set group to the scratch admin, and allows a local dev
 * server to call the org's APIs. Destroy deletes the org. The stage name is
 * the scratch org's sf alias.
 *
 * `examples/github-actions/scratch-org-preview.yml` runs this per pull request.
 */
export default Stack(
  "SalesforcePreview",
  {
    providers: Layer.mergeAll(Salesforce.providers(), Command.providers()),
    state: localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const devHub = yield* Config.String("SF_DEV_HUB").pipe(Config.withDefault("devhub"));
    const permissionSetGroup = yield* Config.String("SF_PERMISSION_SET_GROUP").pipe(
      Config.withDefault("App_Admin"),
    );

    const scratch = yield* Salesforce.ScratchOrg("Scratch", {
      alias: stage,
      devHub,
      definitionFile: "config/project-scratch-def.json",
      durationDays: 3,
    });

    // Push the project's source. Re-runs only when these files change.
    const source = yield* Command.Exec("DeploySource", {
      command: 'sf project deploy start --target-org "$SF_TARGET_ORG" --wait 30',
      shell: true,
      env: { SF_TARGET_ORG: scratch.alias },
      memo: { include: ["force-app/**", "sfdx-project.json"] },
      timeout: "35 minutes",
    });

    // The group only exists after the source deploy. Reading the deploy's
    // output here makes Alchemy wait for it before assigning.
    const deployedOrg = Output.all(scratch.alias, source.hash).pipe(Output.map(([alias]) => alias));

    yield* Salesforce.PermissionSetGroupAssignment("AdminAccess", {
      targetOrg: deployedOrg,
      permissionSetGroup,
      username: scratch.username,
    });

    // Let a local Vite dev server call this org's REST API from the browser.
    yield* Salesforce.CorsAllowedOrigin("LocalDev", {
      targetOrg: scratch.alias,
      name: "Local_Dev_Server",
      urlPattern: "http://localhost:5173",
    });

    return {
      alias: scratch.alias,
      orgId: scratch.orgId,
      username: scratch.username,
      instanceUrl: scratch.instanceUrl,
      expirationDate: scratch.expirationDate,
      open: Output.interpolate`sf org open --target-org ${scratch.alias}`,
    };
  }),
);
