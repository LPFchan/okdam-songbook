import type { SongStatus, UserRole } from "./schemas.js";

export type PermissionAction =
  | "song:create"
  | "song:update"
  | "song:markDeletionCandidate"
  | "song:delete"
  | "performance:create"
  | "performance:cancel"
  | "changeLog:read"
  | "changeLog:restore"
  | "csv:import"
  | "csv:export"
  | "backup:json"
  | "settings:read";

const allActions = new Set<PermissionAction>([
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
]);

export function can(role: UserRole | null | undefined, action: PermissionAction): boolean {
  return role === "allowed" && allActions.has(action);
}

export function isPublicSongStatus(status: SongStatus): boolean {
  return status !== "deletion_candidate" && status !== "deleted";
}
