import { describe, expect, it } from "vitest";
import { can, type PermissionAction } from "../src/permissions.js";

const actions: PermissionAction[] = [
  "song:create",
  "song:update",
  "song:markDeletionCandidate",
  "song:delete",
  "performance:create",
  "performance:cancel",
  "changeLog:read",
  "changeLog:restore",
  "csv:import",
  "csv:export",
  "backup:json",
  "settings:read"
];

describe("allowlist permissions", () => {
  it("allows every existing action for an allowlisted actor", () => {
    for (const action of actions) expect(can("allowed", action)).toBe(true);
  });

  it("denies every action without an allowlisted actor", () => {
    for (const action of actions) expect(can(null, action)).toBe(false);
  });
});
