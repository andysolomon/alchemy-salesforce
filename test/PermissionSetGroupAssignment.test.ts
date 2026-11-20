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
});

const groupRows = () => org.assignments().filter((row) => row.PermissionSetGroupId !== null);
const posts = () =>
  org.requests.filter((request) => request.method === "POST" && request.resource === "PermissionSetAssignment");

const assign = (permissionSetGroup: string, username = "ada@example.com") =>
  Effect.gen(function* () {
    return yield* Salesforce.PermissionSetGroupAssignment("SalesOps", { permissionSetGroup, username });
  });

test.provider("assigns an existing group to an existing user, then unassigns it", (stack) =>
  Effect.gen(function* () {
    const userId = org.seedUser("ada@example.com");
    const groupId = org.seedPermissionSetGroup("Sales_Ops");

    const assigned = yield* stack.deploy(assign("Sales_Ops"));
    expect(assigned.assigneeId).toBe(userId);
    expect(assigned.permissionSetGroupId).toBe(groupId);
    expect(assigned.permissionSetGroup).toBe("Sales_Ops");
    expect(assigned.namespace).toBeNull();
    expect(posts()[0]?.body).toEqual({ AssigneeId: userId, PermissionSetGroupId: groupId });

    const again = yield* stack.deploy(assign("Sales_Ops"));
    expect(again.id).toBe(assigned.id);
    expect(posts()).toHaveLength(1);

    yield* stack.destroy();
    expect(groupRows()).toHaveLength(0);
  }),
);

test.provider("adopts an existing group assignment instead of inserting a duplicate", (stack) =>
  Effect.gen(function* () {
    const userId = org.seedUser("ada@example.com");
    const groupId = org.seedPermissionSetGroup("Sales_Ops");
    const existing = org.seedGroupAssignment(userId, groupId);
    const adopted = yield* stack.deploy(assign("Sales_Ops"));
    expect(adopted.id).toBe(existing);
    expect(posts()).toHaveLength(0);
    yield* stack.destroy();
    expect(groupRows()).toHaveLength(0);
  }),
);

test.provider("replaces the row when the group changes", (stack) =>
  Effect.gen(function* () {
    org.seedUser("ada@example.com");
    org.seedPermissionSetGroup("Sales_Ops");
    const supportId = org.seedPermissionSetGroup("Support");
    yield* stack.deploy(assign("Sales_Ops"));
    const replaced = yield* stack.deploy(assign("Support"));
    expect(replaced.permissionSetGroupId).toBe(supportId);
    expect(groupRows().map((row) => row.PermissionSetGroupId)).toEqual([supportId]);
    yield* stack.destroy();
  }),
);

test.provider("fails clearly for a missing group or a failed group, without writing", (stack) =>
  Effect.gen(function* () {
    org.seedUser("ada@example.com");
    const missing = yield* Effect.exit(stack.deploy(assign("Nope")));
    expect(Exit.isFailure(missing)).toBe(true);
    if (Exit.isFailure(missing)) {
      expect(String(missing.cause)).toContain("does not create one");
    }

    org.seedPermissionSetGroup("Broken", { status: "Failed" });
    const failed = yield* Effect.exit(stack.deploy(assign("Broken")));
    expect(Exit.isFailure(failed)).toBe(true);
    if (Exit.isFailure(failed)) {
      expect(String(failed.cause)).toContain("Status 'Failed'");
    }
    expect(posts()).toHaveLength(0);
  }),
);

test.provider("does not touch plain permission set assignments for the same user", (stack) =>
  Effect.gen(function* () {
    const userId = org.seedUser("ada@example.com");
    const permissionSetId = org.seedPermissionSet("Example_Access");
    org.seedAssignment(userId, permissionSetId);
    org.seedPermissionSetGroup("Sales_Ops");
    yield* stack.deploy(assign("Sales_Ops"));
    yield* stack.destroy();
    expect(org.assignments().map((row) => row.PermissionSetId)).toEqual([permissionSetId]);
  }),
);
