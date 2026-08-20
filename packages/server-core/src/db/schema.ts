import { integer, primaryKey, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

const jsonText = (name: string) => text(name, { mode: "text" });

export const songs = sqliteTable("songs", {
  id: text("id").primaryKey(),
  tjNumber: text("tj_number").unique(),
  title: text("title").notNull(),
  titleReadingKo: text("title_reading_ko").notNull().default(""),
  titleRomanized: text("title_romanized").notNull().default(""),
  titleAliasesJson: jsonText("title_aliases_json").notNull().default("[]"),
  artist: text("artist").notNull(),
  artistReadingKo: text("artist_reading_ko").notNull().default(""),
  artistAliasesJson: jsonText("artist_aliases_json").notNull().default("[]"),
  country: text("country").notNull().default(""),
  genresJson: jsonText("genres_json").notNull().default("[]"),
  originalWork: text("original_work").notNull().default(""),
  keyCandidatesJson: jsonText("key_candidates_json").notNull().default("[]"),
  performerIdsJson: jsonText("performer_ids_json").notNull().default("[]"),
  memo: text("memo").notNull().default(""),
  status: text("status").notNull().default("active"),
  youtubeUrl: text("youtube_url").notNull().default(""),
  youtubeVideoId: text("youtube_video_id").notNull().default(""),
  isOfficialTjVideo: integer("is_official_tj_video", { mode: "boolean" }),
  sourceType: text("source_type").notNull().default(""),
  sourceReference: text("source_reference").notNull().default(""),
  createdByEmail: text("created_by_email").notNull().default(""),
  createdByName: text("created_by_name").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedByEmail: text("updated_by_email").notNull().default(""),
  updatedByName: text("updated_by_name").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  deletedByEmail: text("deleted_by_email"),
  version: integer("version").notNull().default(1)
}, (table) => ({
  status: index("songs_status_idx").on(table.status),
  updatedAt: index("songs_updated_at_idx").on(table.updatedAt)
}));

export const performances = sqliteTable("performances", {
  id: text("id").primaryKey(),
  songId: text("song_id").notNull().references(() => songs.id, { onDelete: "restrict", onUpdate: "cascade" }),
  performedAt: text("performed_at").notNull(),
  keySelectionJson: jsonText("key_selection_json"),
  memo: text("memo").notNull().default(""),
  createdByEmail: text("created_by_email").notNull().default(""),
  createdByName: text("created_by_name").notNull().default(""),
  createdAt: text("created_at").notNull(),
  cancelledAt: text("cancelled_at"),
  cancelledByEmail: text("cancelled_by_email"),
  clientRequestId: text("client_request_id").notNull().unique(),
  version: integer("version").notNull().default(1)
}, (table) => ({
  songActive: index("performances_song_cancelled_idx").on(table.songId, table.cancelledAt),
  performedAt: index("performances_performed_at_idx").on(table.performedAt)
}));

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  beforeJson: jsonText("before_json"),
  afterJson: jsonText("after_json"),
  actorEmail: text("actor_email").notNull().default(""),
  actorName: text("actor_name").notNull().default(""),
  actorRole: text("actor_role"),
  createdAt: text("created_at").notNull(),
  clientRequestId: text("client_request_id"),
  entityVersionBefore: integer("entity_version_before"),
  entityVersionAfter: integer("entity_version_after")
}, (table) => ({
  entity: index("audit_events_entity_idx").on(table.entityType, table.entityId),
  createdAt: index("audit_events_created_at_idx").on(table.createdAt),
  request: index("audit_events_request_idx").on(table.clientRequestId)
}));

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  actorEmail: text("actor_email").notNull().default(""),
  operation: text("operation").notNull(),
  requestHash: text("request_hash").notNull(),
  responseJson: jsonText("response_json"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull()
}, (table) => ({
  expiry: index("idempotency_keys_expiry_idx").on(table.expiresAt),
  actorOperation: index("idempotency_keys_actor_operation_idx").on(table.actorEmail, table.operation)
}));

export const tjMirrorSongs = sqliteTable("tj_mirror_songs", {
  tjNumber: text("tj_number").primaryKey(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  lyricist: text("lyricist").notNull().default(""),
  composer: text("composer").notNull().default(""),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull()
});

export const tjMirrorQueries = sqliteTable("tj_mirror_queries", {
  queryKey: text("query_key").primaryKey(),
  query: text("query").notNull(),
  searchType: text("search_type").notNull(),
  nation: text("nation").notNull().default(""),
  page: integer("page").notNull(),
  pageSize: integer("page_size").notNull(),
  hasMore: integer("has_more", { mode: "boolean" }).notNull().default(false),
  sourceUrl: text("source_url").notNull(),
  checkedAt: text("checked_at").notNull(),
  lastAttemptedAt: text("last_attempted_at").notNull(),
  lastErrorCode: text("last_error_code"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0)
});

export const tjMirrorQueryResults = sqliteTable("tj_mirror_query_results", {
  queryKey: text("query_key").notNull().references(() => tjMirrorQueries.queryKey, { onDelete: "cascade", onUpdate: "cascade" }),
  tjNumber: text("tj_number").notNull().references(() => tjMirrorSongs.tjNumber, { onDelete: "restrict", onUpdate: "cascade" }),
  resultPosition: integer("result_position").notNull()
}, (table) => ({
  primary: primaryKey({ columns: [table.queryKey, table.tjNumber] })
}));

export const schema = { songs, performances, auditEvents, idempotencyKeys, tjMirrorSongs, tjMirrorQueries, tjMirrorQueryResults };

export type SongRow = typeof songs.$inferSelect;
export type NewSongRow = typeof songs.$inferInsert;
export type PerformanceRow = typeof performances.$inferSelect;
export type NewPerformanceRow = typeof performances.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type TjMirrorSongRow = typeof tjMirrorSongs.$inferSelect;
export type TjMirrorQueryRow = typeof tjMirrorQueries.$inferSelect;
export type TjMirrorQueryResultRow = typeof tjMirrorQueryResults.$inferSelect;
