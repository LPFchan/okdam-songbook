import type { SongStatus, UserRole } from "./schemas.js";

export type PermissionAction =
  | "song:create"
  | "song:update"
  | "song:markDeletionCandidate"
  | "song:softDelete"
  | "song:restore"
  | "song:hardDelete"
  | "performance:create"
  | "performance:cancel"
  | "changeLog:read"
  | "changeLog:restore"
  | "csv:import"
  | "csv:export"
  | "backup:json"
  | "settings:read";

const ownerOnly = new Set<PermissionAction>([
  "song:softDelete",
  "song:restore",
  "song:hardDelete",
  "changeLog:restore",
  "settings:read"
]);

const editorAllowed = new Set<PermissionAction>([
  "song:create",
  "song:update",
  "song:markDeletionCandidate",
  "performance:create",
  "performance:cancel",
  "changeLog:read",
  "csv:export"
]);

export function can(role: UserRole | null | undefined, action: PermissionAction): boolean {
  if (!role) return false;
  if (role === "owner") return true;
  if (ownerOnly.has(action)) return false;
  return editorAllowed.has(action);
}

export function isPublicSongStatus(status: SongStatus): boolean {
  return status !== "deletion_candidate" && status !== "deleted";
}
