import { describe, expect, it } from "vitest";

// Mirror of apps-script/src/chatgpt.gs. Kept in lock-step manually; if
// either changes, update both. Tested here so we can assert the contract
// without pulling in the Apps Script runtime.

type SongStatus = "active" | "hold" | "deletion_candidate" | "deleted";

interface SongRow {
  id: string;
  tjNumber: string;
  title: string;
  titleReadingKo?: string;
  titleRomanized?: string;
  titleAliases?: string[];
  artist: string;
  artistReadingKo?: string;
  artistAliases?: string[];
  country?: string;
  originalWork?: string;
  keyCandidates?: Array<Record<string, unknown>>;
  performerIds?: string[];
  updatedByName?: string;
  deletedByEmail?: string;
  memo?: string;
  status: SongStatus;
  youtubeUrl?: string;
  youtubeVideoId?: string;
  isOfficialTjVideo?: boolean | null;
  sourceType?: string;
  sourceReference?: string;
  createdByEmail?: string;
  createdByName?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
  version?: number;
}

interface ChangeLogRow {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  beforeJson: string;
  afterJson: string;
  actorEmail: string;
  actorName: string;
  actorRole: string;
  createdAt: string;
  clientRequestId: string;
  entityVersionBefore: number;
  entityVersionAfter: number;
}

interface AppendRowsCall {
  table: string;
  rows: Record<string, unknown>[];
}

interface ChatGptContext {
  scriptProps: Record<string, string>;
  songs: SongRow[];
  changeLog: ChangeLogRow[];
  appendRowsCalls: AppendRowsCall[];
  publicStatuses: SongStatus[];
  performerIds: string[];
  performerAliases: Record<string, string[]>;
  performerAliasKeys: string[];
  performerSources: string[];
  performanceStats: Record<string, { count: number; last: string }>;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function publicError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; publicMessage: string };
  err.code = code;
  err.publicMessage = message;
  return err;
}

function appendRows(ctx: ChatGptContext, name: "Songs" | "ChangeLog", rows: Record<string, unknown>[]): void {
  ctx.appendRowsCalls.push({ table: name, rows });
  if (name === "Songs") {
    for (const row of rows) {
      ctx.songs.push(row as unknown as SongRow);
    }
  } else {
    for (const row of rows) {
      ctx.changeLog.push(row as unknown as ChangeLogRow);
    }
  }
}

function findChangeByClientRequestId(ctx: ChatGptContext, clientRequestId: string): ChangeLogRow | null {
  if (!clientRequestId) return null;
  const hit = ctx.changeLog.find((row) => row.clientRequestId === clientRequestId);
  return hit ?? null;
}

function serializeSong(ctx: ChatGptContext, row: SongRow): Record<string, unknown> {
  return {
    id: row.id,
    tjNumber: row.tjNumber,
    title: row.title,
    titleReadingKo: row.titleReadingKo ?? "",
    titleRomanized: row.titleRomanized ?? "",
    titleAliases: row.titleAliases ?? [],
    artist: row.artist,
    artistReadingKo: row.artistReadingKo ?? "",
    artistAliases: row.artistAliases ?? [],
    country: row.country ?? "",
    originalWork: row.originalWork ?? "",
    keyCandidates: row.keyCandidates ?? [],
    performerIds: row.performerIds ?? [],
    memo: row.memo ?? "",
    status: row.status,
    youtubeUrl: row.youtubeUrl ?? "",
    youtubeVideoId: row.youtubeVideoId ?? "",
    isOfficialTjVideo: row.isOfficialTjVideo === undefined ? null : row.isOfficialTjVideo,
    sourceType: row.sourceType ?? "",
    sourceReference: row.sourceReference ?? "",
    createdByName: row.createdByName ?? "",
    createdAt: row.createdAt ?? "",
    updatedByName: "",
    updatedAt: row.updatedAt ?? "",
    deletedAt: row.deletedAt ?? "",
    version: row.version ?? 1,
    lastPerformedAt: "",
    performanceCount: 0
  };
}

function normalizeTjNumber(value: unknown): string {
  if (value === null || value === undefined) return "";
  const digits = String(value).normalize("NFKC").replace(/[^\d]/g, "");
  return digits;
}

function addPerformerIds(target: string[], ids: string[], performerIds: string[]): void {
  ids.forEach((id) => {
    if (performerIds.indexOf(id) === -1) throw publicError("VALIDATION_ERROR", "unknown performer id: " + id);
    if (target.indexOf(id) === -1) target.push(id);
  });
}

function normalizePerformerToken(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^추천인\s*/u, "")
    .replace(/^[()[\]{}"'`]+|[()[\]{}"'`]+$/gu, "")
    .replace(/[。．.!！?？:：;；]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function splitPerformerText(value: string): string[] {
  return normalizePerformerToken(value)
    .replace(/[,，、/／·・\n\r\t]+/gu, " ")
    .split(/\s+/u)
    .map(normalizePerformerToken)
    .filter(Boolean);
}

function normalizePerformerIds(ctx: ChatGptContext, value: unknown): { ids: string[]; unknownNames: string[] } {
  const ids: string[] = [];
  const unknownNames: string[] = [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? splitPerformerText(value) : [];
  values.forEach((entry) => {
    const token = normalizePerformerToken(String(entry));
    if (!token) return;
    const mapped = ctx.performerAliases[token];
    if (mapped) {
      addPerformerIds(ids, mapped, ctx.performerIds);
      return;
    }
    if (unknownNames.indexOf(token) === -1) unknownNames.push(token);
  });
  return { ids, unknownNames };
}

function strictPerformerIds(ctx: ChatGptContext, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : splitPerformerText(String(value));
  if (!values.length) return [];
  const ids: string[] = [];
  values.forEach((token) => {
    const normalized = normalizePerformerToken(token);
    if (!normalized) return;
    const mapped = ctx.performerAliases[normalized];
    if (mapped) {
      addPerformerIds(ids, mapped, ctx.performerIds);
      return;
    }
    if (ctx.performerIds.indexOf(normalized) === -1) {
      throw publicError("VALIDATION_ERROR", "unknown performer id: " + normalized);
    }
    if (ids.indexOf(normalized) === -1) ids.push(normalized);
  });
  return ids;
}

function normalizeSongInput(ctx: ChatGptContext, song: Record<string, unknown>): SongRow {
  if (!song.title || !song.artist) throw publicError("VALIDATION_ERROR", "title/artist required");
  const performerIds = normalizePerformerIds(ctx, song.performerIds).ids;
  return {
    id: typeof song.id === "string" ? song.id : "",
    tjNumber: normalizeTjNumber(song.tjNumber),
    title: String(song.title).trim(),
    titleReadingKo: String(song.titleReadingKo ?? "").trim(),
    titleRomanized: String(song.titleRomanized ?? "").trim(),
    titleAliases: (song.titleAliases as string[] | undefined) ?? [],
    artist: String(song.artist).trim(),
    artistReadingKo: String(song.artistReadingKo ?? "").trim(),
    artistAliases: (song.artistAliases as string[] | undefined) ?? [],
    country: String(song.country ?? "").trim(),
    originalWork: String(song.originalWork ?? "").trim(),
    keyCandidates: (song.keyCandidates as Array<Record<string, unknown>> | undefined) ?? [],
    performerIds,
    memo: String(song.memo ?? "").trim(),
    status: "active",
    youtubeUrl: String(song.youtubeUrl ?? "").trim(),
    youtubeVideoId: "",
    isOfficialTjVideo: null,
    sourceType: String(song.sourceType ?? "").trim(),
    sourceReference: String(song.sourceReference ?? "").trim(),
    version: 1
  };
}

function gptAuthenticate(ctx: ChatGptContext, body: Record<string, unknown>): { actor: { email: string; displayName: string; role: string } } {
  const provided = String((body && body.apiKey) || "").trim();
  if (!provided) throw publicError("FORBIDDEN", "apiKey required");
  const expected = ctx.scriptProps.CHATGPT_ACTION_SECRET || "";
  if (!expected) throw publicError("FORBIDDEN", "server secret missing");
  if (!constantTimeEquals(provided, expected)) throw publicError("FORBIDDEN", "apiKey mismatch");
  return { actor: { email: "", displayName: "ChatGPT", role: "integration" } };
}

function gptSearchSongs(ctx: ChatGptContext, body: Record<string, unknown>): { query: string; total: number; songs: Record<string, unknown>[] } {
  const query = String((body && body.query) || "").trim().toLowerCase();
  if (!query) return { query: "", total: 0, songs: [] };
  const matches = ctx.songs
    .filter((row) => ctx.publicStatuses.indexOf(row.status) !== -1)
    .map((row) => serializeSong(ctx, row))
    .filter((song) => {
      const haystack = [
        song.title,
        song.titleReadingKo,
        song.titleRomanized,
        (song.titleAliases as string[]).join(" "),
        song.artist,
        song.artistReadingKo,
        (song.artistAliases as string[]).join(" "),
        song.tjNumber,
        (song.performerIds as string[]).join(" ")
      ].join(" ").toLowerCase();
      return haystack.indexOf(query) !== -1;
    });
  return { query, total: matches.length, songs: matches.slice(0, 25) };
}

function gptCheckDuplicate(ctx: ChatGptContext, body: Record<string, unknown>): { duplicate: boolean; matchedBy: string | null; song: Record<string, unknown> | null } {
  const tjNumber = normalizeTjNumber(body && body.tjNumber);
  const title = String((body && body.title) || "").trim();
  const artist = String((body && body.artist) || "").trim();
  if (!tjNumber && (!title || !artist)) throw publicError("BAD_REQUEST", "tjNumber or title+artist required");
  if (tjNumber) {
    const hit = ctx.songs.find((row) => row.tjNumber === tjNumber && row.status !== "deleted");
    if (hit) return { duplicate: true, matchedBy: "tjNumber", song: serializeSong(ctx, hit) };
  }
  if (title && artist) {
    const key = title.toLowerCase() + "|" + artist.toLowerCase();
    const hit = ctx.songs.find((row) => (row.title.toLowerCase() + "|" + row.artist.toLowerCase()) === key && row.status !== "deleted");
    if (hit) return { duplicate: true, matchedBy: "titleArtist", song: serializeSong(ctx, hit) };
  }
  return { duplicate: false, matchedBy: null, song: null };
}

function gptAddSong(ctx: ChatGptContext, body: Record<string, unknown>): { duplicate: boolean; matchedBy: string | null; song: Record<string, unknown> | null } {
  const auth = gptAuthenticate(ctx, body);
  if (body.confirmed !== true) throw publicError("CONFIRMATION_REQUIRED", "confirmed: true required");
  const clientRequestId = String((body && body.clientRequestId) || "").trim();
  if (!clientRequestId) throw publicError("BAD_REQUEST", "clientRequestId required");
  if (!body.title || !body.artist) throw publicError("VALIDATION_ERROR", "title/artist required");
  const prior = findChangeByClientRequestId(ctx, clientRequestId);
  if (prior) {
    const hit = ctx.songs.find((row) => row.id === prior.entityId);
    if (hit) return { duplicate: true, matchedBy: "clientRequestId", song: serializeSong(ctx, hit) };
    return { duplicate: true, matchedBy: "clientRequestId", song: null };
  }
  const incoming = normalizeSongInput(ctx, {
    title: body.title,
    artist: body.artist,
    tjNumber: body.tjNumber,
    titleReadingKo: body.titleReadingKo,
    titleRomanized: body.titleRomanized,
    titleAliases: body.titleAliases,
    artistReadingKo: body.artistReadingKo,
    artistAliases: body.artistAliases,
    country: body.country,
    originalWork: body.originalWork,
    performerIds: strictPerformerIds(ctx, body.performerIds),
    keyCandidates: body.keyCandidates,
    memo: body.memo,
    youtubeUrl: body.youtubeUrl,
    sourceType: "chatgpt",
    sourceReference: "chatgpt-action"
  });
  if (incoming.tjNumber) {
    const hit = ctx.songs.find((row) => row.tjNumber === incoming.tjNumber && row.status !== "deleted");
    if (hit) return { duplicate: true, matchedBy: "tjNumber", song: serializeSong(ctx, hit) };
  }
  const targetKey = incoming.title.toLowerCase() + "|" + incoming.artist.toLowerCase();
  const titleHit = ctx.songs.find((row) => (row.title.toLowerCase() + "|" + row.artist.toLowerCase()) === targetKey && row.status !== "deleted");
  if (titleHit) return { duplicate: true, matchedBy: "titleArtist", song: serializeSong(ctx, titleHit) };
  const now = new Date().toISOString();
  const row: SongRow = {
    ...incoming,
    id: "row-" + Math.random().toString(36).slice(2),
    createdByEmail: "",
    createdByName: auth.actor.displayName,
    createdAt: now,
    updatedByName: auth.actor.displayName,
    updatedAt: now,
    deletedAt: "",
    deletedByEmail: "",
    version: 1
  };
  appendRows(ctx, "Songs", [row as unknown as Record<string, unknown>]);
  appendRows(ctx, "ChangeLog", [
    {
      id: "log-" + Math.random().toString(36).slice(2),
      entityType: "Song",
      entityId: row.id,
      action: "create",
      beforeJson: "",
      afterJson: JSON.stringify(row),
      actorEmail: auth.actor.email,
      actorName: auth.actor.displayName,
      actorRole: auth.actor.role,
      createdAt: now,
      clientRequestId,
      entityVersionBefore: 0,
      entityVersionAfter: 1
    }
  ]);
  return { duplicate: false, matchedBy: null, song: serializeSong(ctx, row) };
}

function makeContext(): ChatGptContext {
  return {
    scriptProps: { CHATGPT_ACTION_SECRET: "s3cret" },
    songs: [
      {
        id: "existing-1",
        tjNumber: "12345",
        title: "Lemon",
        artist: "YUI",
        status: "active",
        performerIds: ["marie"]
      }
    ],
    changeLog: [],
    appendRowsCalls: [],
    publicStatuses: ["active", "hold"],
    performerIds: ["marie", "yeowool", "seongwook"],
    performerAliases: {
      "마리": ["marie"],
      "성욱": ["seongwook"],
      "여울": ["yeowool"],
      "뽀냐": ["marie", "yeowool"],
      marie: ["marie"],
      seongwook: ["seongwook"],
      seonguk: ["seongwook"],
      yeowool: ["yeowool"],
      yeoul: ["yeowool"],
      ponya: ["marie", "yeowool"]
    },
    performerAliasKeys: ["뽀냐", "성욱", "여울", "마리"],
    performerSources: [],
    performanceStats: {}
  };
}

describe("gptAuthenticate", () => {
  it("rejects when the secret is missing from Script Properties", () => {
    const ctx = makeContext();
    delete ctx.scriptProps.CHATGPT_ACTION_SECRET;
    expect(() => gptAuthenticate(ctx, { apiKey: "s3cret" })).toThrow(/server secret missing/);
  });

  it("rejects when the apiKey is missing", () => {
    const ctx = makeContext();
    expect(() => gptAuthenticate(ctx, {})).toThrow(/apiKey required/);
  });

  it("rejects mismatched apiKey", () => {
    const ctx = makeContext();
    expect(() => gptAuthenticate(ctx, { apiKey: "wrong" })).toThrow(/apiKey mismatch/);
  });

  it("accepts a matching apiKey and exposes the ChatGPT actor", () => {
    const ctx = makeContext();
    const auth = gptAuthenticate(ctx, { apiKey: "s3cret" });
    expect(auth.actor).toEqual({ email: "", displayName: "ChatGPT", role: "integration" });
  });
});

describe("gptSearchSongs", () => {
  it("returns empty when query is blank", () => {
    const ctx = makeContext();
    expect(gptSearchSongs(ctx, {})).toEqual({ query: "", total: 0, songs: [] });
  });

  it("matches across title, artist, tjNumber, and performerIds", () => {
    const ctx = makeContext();
    ctx.songs.push({
      id: "tsuki",
      tjNumber: "99999",
      title: "月光花",
      artist: "Janne Da Arc",
      status: "active",
      performerIds: ["yeowool"]
    });
    expect(gptSearchSongs(ctx, { query: "tsuki" }).total).toBe(0);
    expect(gptSearchSongs(ctx, { query: "月光" }).total).toBe(1);
    expect(gptSearchSongs(ctx, { query: "janne" }).total).toBe(1);
    expect(gptSearchSongs(ctx, { query: "99999" }).total).toBe(1);
    expect(gptSearchSongs(ctx, { query: "yeowool" }).total).toBe(1);
  });

  it("hides deleted or hidden songs", () => {
    const ctx = makeContext();
    ctx.songs.push({ id: "hidden", tjNumber: "00001", title: "x", artist: "y", status: "deleted", performerIds: [] });
    ctx.songs.push({ id: "candidate", tjNumber: "00002", title: "x", artist: "y", status: "deletion_candidate", performerIds: [] });
    const result = gptSearchSongs(ctx, { query: "x" });
    expect(result.total).toBe(0);
  });

  it("caps results at 25", () => {
    const ctx = makeContext();
    for (let i = 0; i < 30; i += 1) {
      ctx.songs.push({ id: `bulk-${i}`, tjNumber: `${40000 + i}`, title: "Bulk", artist: "A", status: "active", performerIds: [] });
    }
    expect(gptSearchSongs(ctx, { query: "bulk" }).total).toBe(30);
    expect(gptSearchSongs(ctx, { query: "bulk" }).songs.length).toBe(25);
  });
});

describe("gptCheckDuplicate", () => {
  it("requires tjNumber or title+artist", () => {
    const ctx = makeContext();
    expect(() => gptCheckDuplicate(ctx, {})).toThrow(/BAD_REQUEST|tjNumber/);
  });

  it("returns the existing song when tjNumber matches", () => {
    const ctx = makeContext();
    const result = gptCheckDuplicate(ctx, { tjNumber: "12345" });
    expect(result.duplicate).toBe(true);
    expect(result.matchedBy).toBe("tjNumber");
    expect(result.song && (result.song as { id: string }).id).toBe("existing-1");
  });

  it("returns the existing song when title+artist match", () => {
    const ctx = makeContext();
    const result = gptCheckDuplicate(ctx, { title: "Lemon", artist: "YUI" });
    expect(result.duplicate).toBe(true);
    expect(result.matchedBy).toBe("titleArtist");
  });

  it("returns duplicate=false when no match", () => {
    const ctx = makeContext();
    expect(gptCheckDuplicate(ctx, { title: "Other", artist: "YUI" })).toEqual({ duplicate: false, matchedBy: null, song: null });
  });
});

describe("gptAddSong", () => {
  function baseBody() {
    return {
      apiKey: "s3cret",
      confirmed: true,
      clientRequestId: "req-1",
      title: "Pretender",
      artist: "Official髭男dism",
      performerIds: ["marie", "yeowool"]
    };
  }

  it("rejects when confirmed !== true", () => {
    const ctx = makeContext();
    expect(() => gptAddSong(ctx, { ...baseBody(), confirmed: false })).toThrowError(expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }));
  });

  it("rejects when clientRequestId is missing", () => {
    const ctx = makeContext();
    expect(() => gptAddSong(ctx, { ...baseBody(), clientRequestId: "" })).toThrow(/clientRequestId required/);
  });

  it("inserts a new song and writes a ChangeLog row with ChatGPT actor", () => {
    const ctx = makeContext();
    const result = gptAddSong(ctx, baseBody());
    expect(result.duplicate).toBe(false);
    expect(result.song).toBeTruthy();
    expect(ctx.songs.length).toBe(2);
    expect(ctx.changeLog.length).toBe(1);
    const log = ctx.changeLog[0]!;
    expect(log.actorName).toBe("ChatGPT");
    expect(log.actorRole).toBe("integration");
    expect(log.actorEmail).toBe("");
    expect(log.entityType).toBe("Song");
    expect(log.action).toBe("create");
    expect(log.clientRequestId).toBe("req-1");
    expect(log.entityVersionBefore).toBe(0);
    expect(log.entityVersionAfter).toBe(1);
  });

  it("reuses the previous result when clientRequestId repeats", () => {
    const ctx = makeContext();
    const first = gptAddSong(ctx, baseBody());
    expect(first.duplicate).toBe(false);
    const second = gptAddSong(ctx, baseBody());
    expect(second.duplicate).toBe(true);
    expect(second.matchedBy).toBe("clientRequestId");
    expect(ctx.songs.length).toBe(2);
  });

  it("returns the existing song when the TJ number is already registered", () => {
    const ctx = makeContext();
    const result = gptAddSong(ctx, { ...baseBody(), tjNumber: "12345" });
    expect(result.duplicate).toBe(true);
    expect(result.matchedBy).toBe("tjNumber");
    expect(ctx.songs.length).toBe(1);
  });

  it("returns the existing song when title+artist already match", () => {
    const ctx = makeContext();
    const result = gptAddSong(ctx, { ...baseBody(), title: "Lemon", artist: "YUI" });
    expect(result.duplicate).toBe(true);
    expect(result.matchedBy).toBe("titleArtist");
    expect(ctx.songs.length).toBe(1);
  });

  it("expands 뽀냐 to marie + yeowool without storing the alias", () => {
    const ctx = makeContext();
    const result = gptAddSong(ctx, { ...baseBody(), performerIds: ["뽀냐"] });
    expect(result.duplicate).toBe(false);
    const stored = ctx.songs[ctx.songs.length - 1]!;
    expect(stored.performerIds).toEqual(["marie", "yeowool"]);
    expect(stored.performerIds).not.toContain("뽀냐");
  });

  it("rejects unknown performer ids", () => {
    const ctx = makeContext();
    expect(() => gptAddSong(ctx, { ...baseBody(), performerIds: ["ghost"] })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("rejects bad apiKey without writing anything", () => {
    const ctx = makeContext();
    expect(() => gptAddSong(ctx, { ...baseBody(), apiKey: "wrong" })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(ctx.songs.length).toBe(1);
    expect(ctx.changeLog.length).toBe(0);
  });
});
