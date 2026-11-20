import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface FakeOrg {
  readonly id: string;
  readonly username: string;
  readonly instanceUrl: string;
  readonly accessToken: string;
  /** Set on scratch orgs only, like `sf org display`. */
  readonly devHubId?: string;
  readonly expirationDate?: string;
  readonly edition?: string;
  readonly status?: string;
  /** Simulates a scratch org deleted at expiry: display fails with a dead refresh token. */
  readonly deadAuth?: boolean;
}

interface FakeState {
  orgs: Record<string, FakeOrg>;
  /** Every org ever authorized, by username, so `org login jwt` can restore one. */
  known: Record<string, FakeOrg>;
  calls: string[][];
  sequence: number;
  instanceUrl: string;
  accessToken: string;
  failCreate: boolean;
}

/**
 * A stand-in `sf` binary. It answers `org display`, `org create scratch`,
 * `org delete scratch`, `org logout`, `org login jwt`, and `project deploy start` from a JSON
 * file, and records every call. Scratch orgs it creates point at the mock org's URL and token.
 */
const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_SF_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const ok = (result) => { save(); process.stdout.write(JSON.stringify({ status: 0, result })); process.exit(0); };
const fail = (name, message) => { save(); process.stdout.write(JSON.stringify({ status: 1, name, message })); process.exit(1); };
const command = args.slice(0, 3).join(" ");
const alias = flag("--target-org");
if (command.startsWith("org display")) {
  const org = state.orgs[alias];
  if (!org) fail("NamedOrgNotFoundError", "No authorization information found for " + alias + ".");
  if (org.deadAuth) fail("RefreshTokenAuthError", "Error authenticating with the refresh token due to: expired access/refresh token");
  const { deadAuth, ...shown } = org;
  ok({ ...shown, alias, apiVersion: "68.0", connectedStatus: "Connected" });
}
if (command === "org create scratch") {
  if (state.failCreate) fail("ScratchOrgInfoError", "LIMIT_EXCEEDED: The signup request failed because this organization has reached its active scratch org limit");
  if (!state.orgs[flag("--target-dev-hub")]) fail("NamedOrgNotFoundError", "No authorization information found for " + flag("--target-dev-hub") + ".");
  state.sequence += 1;
  const id = "00DSCRATCH" + String(state.sequence).padStart(5, "0");
  const newAlias = flag("--alias");
  state.orgs[newAlias] = state.known["test-" + state.sequence + "@example.com"] = {
    id,
    username: "test-" + state.sequence + "@example.com",
    instanceUrl: state.instanceUrl + "/",
    accessToken: state.accessToken,
    devHubId: state.orgs[flag("--target-dev-hub")].id,
    expirationDate: "2026-12-01",
    edition: flag("--edition") ? flag("--edition").replace(/^./, (c) => c.toUpperCase()) : "Developer",
    status: "Active",
  };
  ok({ orgId: id, username: state.orgs[newAlias].username, warnings: [] });
}
if (command === "org delete scratch") {
  if (!state.orgs[alias]) fail("NamedOrgNotFoundError", "No authorization information found for " + alias + ".");
  if (!state.orgs[alias].devHubId) fail("NotScratchOrgError", alias + " is not a scratch org.");
  const { id, username } = state.orgs[alias];
  delete state.orgs[alias];
  ok({ orgId: id, username });
}
if (command === "org login jwt") {
  const org = state.known[flag("--username")];
  if (!flag("--client-id") || !flag("--jwt-key-file")) fail("MissingFlags", "client id and key file are required");
  if (!org) fail("AuthCodeExchangeError", "user hasn't approved this consumer");
  state.orgs[flag("--alias")] = org;
  ok({ username: org.username, orgId: org.id, instanceUrl: org.instanceUrl });
}
if (command === "project deploy start") {
  if (!state.orgs[alias]) fail("NamedOrgNotFoundError", "No authorization information found for " + alias + ".");
  ok({ status: "Succeeded", success: true, numberComponentsDeployed: 1 });
}
if (command.startsWith("org logout")) {
  delete state.orgs[alias];
  ok([alias]);
}
fail("UnexpectedCommand", "fake sf does not handle: " + args.join(" "));
`;

export interface FakeSf {
  calls(): ReadonlyArray<ReadonlyArray<string>>;
  orgs(): Readonly<Record<string, FakeOrg>>;
  seed(alias: string, org: Partial<FakeOrg> & { readonly id: string }): void;
  update(alias: string, fields: Partial<FakeOrg>): void;
  setFailCreate(fail: boolean): void;
  /** Drop the local authorization only, as on a CI runner that did not create the org. */
  forgetLocal(alias: string): void;
  reset(): void;
  uninstall(): void;
}

/** Put a fake `sf` first on PATH. Call `uninstall` in `afterAll`. */
export const installFakeSf = (options: { readonly instanceUrl: string; readonly accessToken: string }): FakeSf => {
  const dir = mkdtempSync(join(tmpdir(), "fake-sf-"));
  const bin = join(dir, "sf");
  const stateFile = join(dir, "state.json");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_SF_STATE;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  process.env.FAKE_SF_STATE = stateFile;

  const read = (): FakeState => JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
  const write = (state: FakeState) => writeFileSync(stateFile, JSON.stringify(state));
  const reset = () =>
    write({
      orgs: {},
      known: {},
      calls: [],
      sequence: 0,
      instanceUrl: options.instanceUrl,
      accessToken: options.accessToken,
      failCreate: false,
    });
  reset();

  return {
    calls: () => read().calls,
    orgs: () => read().orgs,
    seed: (alias, org) => {
      const state = read();
      state.orgs[alias] = {
        username: `${alias}@example.com`,
        instanceUrl: options.instanceUrl,
        accessToken: options.accessToken,
        ...org,
      };
      write(state);
    },
    update: (alias, fields) => {
      const state = read();
      const current = state.orgs[alias];
      if (current === undefined) {
        throw new Error(`fake sf has no alias ${alias}`);
      }
      state.orgs[alias] = { ...current, ...fields };
      write(state);
    },
    forgetLocal: (alias) => {
      const state = read();
      delete state.orgs[alias];
      write(state);
    },
    setFailCreate: (fail) => {
      const state = read();
      state.failCreate = fail;
      write(state);
    },
    reset,
    uninstall: () => {
      process.env.PATH = previousPath;
      if (previousState === undefined) {
        delete process.env.FAKE_SF_STATE;
      } else {
        process.env.FAKE_SF_STATE = previousState;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
