import type { UserRole } from "@songbook/shared";

export interface RequestActor {
  email: string;
  displayName?: string;
}

export interface ResolvedActor {
  email: string;
  displayName: string;
  role: UserRole;
}

/** Resolve against the current allowlist/role data for every protected call. */
export interface RoleResolver {
  resolve(actor: RequestActor): ResolvedActor | null;
}

/** The safe default for callers that have not wired admission configuration yet. */
export const denyAllRoleResolver: RoleResolver = {
  resolve: () => null
};
