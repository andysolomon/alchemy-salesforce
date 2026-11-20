import * as Test from "@alchemy.run/test/Vitest";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Salesforce from "../src/salesforce/index.js";
import { bindMockOrg } from "./harness.js";
import type { MockOrg } from "./mock-org.js";

const { test } = Test.make({ providers: Salesforce.providers() });

let org: MockOrg;

beforeAll(async () => {
  org = await bindMockOrg();
});

afterAll(async () => {
  await org.close();
});

beforeEach(() => {
  org.reset();
  org.seedUser("ada@example.com");
  org.seedUser("grace@example.com");
  org.seedUser("o'hara@example.com");
  org.seedPermissionSet("Example_Access");
});

const posts = () =>
  org.requests.filter((request) => request.method === "POST" && request.resource === "PermissionSetAssignment");

test.provider("assigns an existing permission set and does not create a second row", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
          permissionSet: "Example_Access",
          username: "ada@example.com",
        });
      }),
    );
    expect(created.id).toMatch(/^0Pa/);
    expect(created.username).toBe("ada@example.com");
    expect(created.permissionSet).toBe("Example_Access");
    expect(created.namespace).toBeNull();
    expect(posts()).toHaveLength(1);

    const again = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
          permissionSet: "Example_Access",
          username: "ada@example.com",
        });
      }),
    );
    expect(again.id).toBe(created.id);
    expect(posts()).toHaveLength(1);
    expect(org.assignments()).toHaveLength(1);

    yield* stack.destroy();
    expect(org.assignments()).toHaveLength(0);
  }),
);

test.provider("replaces the assignment when the username changes", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
          permissionSet: "Example_Access",
          username: "ada@example.com",
        });
      }),
    );
    const planned = yield* stack.plan(
      Effect.gen(function* () {
        return yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
          permissionSet: "Example_Access",
          username: "grace@example.com",
        });
      }),
    );
    const replacement = Object.values(planned.resources).find((resource) => resource.action === "replace");
    expect(replacement?.action).toBe("replace");
    if (replacement?.action === "replace") {
      expect(replacement.deleteFirst).toBe(true);
    }

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
          permissionSet: "Example_Access",
          username: "grace@example.com",
        });
      }),
    );
    expect(updated.id).not.toBe(created.id);
    expect(updated.username).toBe("grace@example.com");
    expect(org.assignments()).toHaveLength(1);
    yield* stack.destroy();
  }),
);

test.provider("does not assign a missing user or a missing permission set", (stack) =>
  Effect.gen(function* () {
    const missingUser = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.PermissionSetAssignment("ExampleAccess", {
            permissionSet: "Example_Access",
            username: "missing@example.com",
          });
        }),
      ),
    );
    expect(Exit.isFailure(missingUser)).toBe(true);
    if (Exit.isFailure(missingUser)) {
      expect(String(missingUser.cause)).toContain("missing@example.com");
    }
    expect(posts()).toHaveLength(0);

    const missingSet = yield* Effect.exit(
      stack.deploy(
        Effect.gen(function* () {
          return yield* Salesforce.PermissionSetAssignment("Other", {
            permissionSet: "DoesNotExist",
            username: "ada@example.com",
          });
        }),
      ),
    );
    expect(Exit.isFailure(missingSet)).toBe(true);
    expect(posts()).toHaveLength(0);
  }),
);

test.provider("escapes quotes in usernames and skips profile-owned permission sets", (stack) =>
  Effect.gen(function* () {
    const profileId = org.seedPermissionSet("Example_Access", {
      ownedByProfile: true,
      namespace: "prof",
      id: "0PSprofile0001",
    });
    org.seedAssignment(org.seedUser("profile-user@example.com"), profileId);

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Salesforce.PermissionSetAssignment("Quoted", {
          permissionSet: "Example_Access",
          username: "o'hara@example.com",
        });
      }),
    );
    expect(created.username).toBe("o'hara@example.com");
    const userQuery = org.requests.find((request) => request.soql?.includes("FROM User"));
    expect(userQuery?.soql).toContain("o\\'hara@example.com");

    org.setPageSize(1);
    const provider = yield* Salesforce.PermissionSetAssignment.Provider;
    expect(provider.nuke?.skip).toBe(true);
    const listed = yield* provider.list();
    const usernames = listed.map((assignment) => assignment.username).sort();
    expect(usernames).toEqual(["o'hara@example.com"]);
    expect(usernames).not.toContain("profile-user@example.com");
    yield* stack.destroy();
  }),
);
