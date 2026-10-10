import { z } from "zod";
import { songSchema } from "./schemas.js";

export const damNumberSchema = z.string().trim().regex(/^\d{4}-\d{2}$/u);

export const damSongCandidateSchema = z.object({
  damNumber: damNumberSchema,
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().min(1).max(300),
  titleYomi: z.string().trim().max(300).default(""),
  artistYomi: z.string().trim().max(300).default(""),
  sourceUrl: z.string().url()
});

/** clubdam.com returns up to 100 songs per keyword search request. */
export const DAM_MAX_PAGE_SIZE = 100;

export const damSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(120),
  page: z.number().int().min(1).max(10).optional().default(1),
  pageSize: z.number().int().min(1).max(DAM_MAX_PAGE_SIZE).optional().default(15)
});

export const damSearchResultSchema = z.object({
  query: z.string(),
  searchType: z.enum(["all", "number"]),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
  candidates: z.array(damSongCandidateSchema)
});

export const damAddResultSchema = z.object({
  /** "linked" means the DAM number was attached to a saved song with the same name. */
  outcome: z.enum(["created", "linked", "duplicate", "deleted"]),
  song: songSchema.nullable(),
  existing: songSchema.nullable().default(null),
  duplicateKind: z.enum(["damNumber", "titleArtist"]).nullable().default(null),
  canRestore: z.boolean().default(false),
  canOpen: z.boolean().default(false)
});

export type DamSongCandidate = z.infer<typeof damSongCandidateSchema>;
export type DamSearchRequest = z.infer<typeof damSearchRequestSchema>;
export type DamSearchResult = z.infer<typeof damSearchResultSchema>;
export type DamAddResult = z.infer<typeof damAddResultSchema>;

/** The karaoke system whose numbers the catalog shows. Chosen per device. */
export type KaraokeSystem = "tj" | "dam";

export const DAM_API_BASE = "https://www.clubdam.com/dkwebsys/search-api";

/**
 * Fixed request fields DAM's own search page sends. The auth key is a public
 * constant in clubdam.com's page script, not a credential.
 */
const DAM_CLIENT_FIELDS = {
  modelTypeCode: "1",
  serialNo: "AT00001",
  compId: "1",
  authKey: "2/Qb9R@8s*",
  contentsCode: null,
  serviceCode: null
};

/** "1472-59", "147259" and "1472 59" all name the same DAM song. */
export function normalizeDamNumber(value: string): string | null {
  const digits = value.normalize("NFKC").trim().match(/^(\d{4})[-\s]?(\d{2})$/u);
  return digits ? `${digits[1]}-${digits[2]}` : null;
}

/** DAM numbers are always four digits, a hyphen, and two digits. */
export function isDamNumberQuery(query: string): boolean {
  return /^\d{4}[-\s]?\d{2}$/u.test(query.normalize("NFKC").trim());
}

export function damSongUrl(damNumber: string): string {
  return `https://www.clubdam.com/karaokesearch/songleaf.html?requestNo=${encodeURIComponent(damNumber)}`;
}

export function buildDamKeywordRequest(input: DamSearchRequest): { url: string; body: string } {
  return {
    url: `${DAM_API_BASE}/SearchVariousByKeywordApi`,
    body: JSON.stringify({
      ...DAM_CLIENT_FIELDS,
      keyword: input.query.trim(),
      // Popularity, as DAM's own search page does. "1" is kana order.
      sort: "2",
      dispCount: String(input.pageSize ?? 15),
      pageNo: String(input.page ?? 1)
    })
  };
}

export function buildDamNumberRequest(damNumber: string): { url: string; body: string } {
  return {
    url: `${DAM_API_BASE}/GetMusicDetailInfoApi`,
    body: JSON.stringify({ ...DAM_CLIENT_FIELDS, requestNo: damNumber })
  };
}

const damEnvelopeSchema = z.object({
  result: z.object({ statusCode: z.string() })
});

const damKeywordResponseSchema = z.object({
  data: z.object({ hasNext: z.string().optional() }).passthrough(),
  list: z.array(z.object({
    requestNo: z.string(),
    title: z.string(),
    artist: z.string(),
    titleYomi: z.string().optional(),
    artistYomi: z.string().optional()
  }).passthrough())
});

const damDetailResponseSchema = z.object({
  data: z.object({
    requestNo: z.string(),
    title: z.string().optional(),
    artist: z.string().optional(),
    titleYomi_Kana: z.string().optional()
  }).passthrough()
});

function assertOk(json: unknown): void {
  const envelope = damEnvelopeSchema.safeParse(json);
  if (!envelope.success || envelope.data.result.statusCode !== "0000") throw new Error("DAM_PARSER_DRIFT");
}

function toCandidate(entry: { requestNo: string; title?: string; artist?: string; titleYomi?: string; artistYomi?: string }): DamSongCandidate | null {
  const damNumber = normalizeDamNumber(entry.requestNo);
  const parsed = damSongCandidateSchema.safeParse({
    damNumber,
    title: entry.title ?? "",
    artist: entry.artist ?? "",
    titleYomi: entry.titleYomi ?? "",
    artistYomi: entry.artistYomi ?? "",
    sourceUrl: damNumber ? damSongUrl(damNumber) : ""
  });
  return parsed.success ? parsed.data : null;
}

/** Parse a keyword search response. Raw DAM payloads never leave this boundary. */
export function parseDamKeywordResponse(json: unknown): { candidates: DamSongCandidate[]; hasMore: boolean } {
  assertOk(json);
  const parsed = damKeywordResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error("DAM_PARSER_DRIFT");
  const seen = new Set<string>();
  const candidates = parsed.data.list.flatMap((entry) => {
    const candidate = toCandidate(entry);
    if (!candidate || seen.has(candidate.damNumber)) return [];
    seen.add(candidate.damNumber);
    return [candidate];
  });
  return { candidates, hasMore: parsed.data.data.hasNext === "1" };
}

function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * DAM's keyword search also matches lyrics, lyricists and composers. Songs
 * whose title or artist contains the query come first; DAM's order is kept
 * within each group.
 */
export function rankDamCandidates(query: string, candidates: DamSongCandidate[]): DamSongCandidate[] {
  const needle = folded(query);
  if (!needle) return candidates;
  const named = (candidate: DamSongCandidate) =>
    [candidate.title, candidate.artist, candidate.titleYomi, candidate.artistYomi].some((field) => folded(field).includes(needle));
  return [...candidates.filter(named), ...candidates.filter((candidate) => !named(candidate))];
}

/** Parse a number lookup. DAM answers an unknown number with a bare requestNo. */
export function parseDamDetailResponse(json: unknown): DamSongCandidate | null {
  assertOk(json);
  const parsed = damDetailResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error("DAM_PARSER_DRIFT");
  const { requestNo, title, artist, titleYomi_Kana } = parsed.data.data;
  if (!title || !artist) return null;
  return toCandidate({ requestNo, title, artist, titleYomi: titleYomi_Kana });
}
