import type { UserRole } from "@songbook/shared";
import {
  applyImport,
  exportRollback,
  exportSheetCsv,
  prepareImport,
  reconcileImport,
  type ImportOptions,
  type ImportResult,
  type ImportSource,
  type ImportPlan,
  type ReconciliationReport,
  type SheetName
} from "@songbook/server-core";
import type { SongbookDatabase } from "@songbook/server-core";

export const adminPackage = "@songbook/admin" as const;

export interface AdminActor {
  email: string;
  role: UserRole;
}

export class AdminAuthorizationError extends Error {
  readonly code = "FORBIDDEN" as const;
  constructor(message = "An allowlisted user is required for this operation.") {
    super(message);
    this.name = "AdminAuthorizationError";
  }
}

function requireAllowed(actor: AdminActor): void {
  if (actor.role !== "allowed") throw new AdminAuthorizationError();
}

/** Allowlisted operational data tools. Dry-run import never mutates the database. */
export interface SongbookAdmin {
  importDryRun(source: ImportSource, options?: ImportOptions): ImportPlan;
  importApply(source: ImportSource, options?: ImportOptions): ImportResult;
  reconcile(source: ImportSource, options?: ImportOptions): ReconciliationReport;
  exportCsv(sheet: SheetName): string;
  rollbackExport(): ReturnType<typeof exportRollback>;
}

export function createSongbookAdmin(database: SongbookDatabase, actor: AdminActor): SongbookAdmin {
  return {
    importDryRun: (source, options) => { requireAllowed(actor); return prepareImport(database, source, options); },
    importApply: (source, options) => { requireAllowed(actor); return applyImport(database, source, options); },
    reconcile: (source, options) => { requireAllowed(actor); return reconcileImport(database, source, options); },
    exportCsv: (sheet) => { requireAllowed(actor); return exportSheetCsv(database, sheet); },
    rollbackExport: () => { requireAllowed(actor); return exportRollback(database); }
  };
}
