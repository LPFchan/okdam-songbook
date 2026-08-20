import type { Song, TjSearchType, TjSongCandidate } from "@songbook/shared";
import { isSearchableQuery, searchTypeForQuery } from "@songbook/shared";
import { TjAdapterError, type TjAdapter } from "./tj.js";
import type { SongbookService } from "./services.js";

export const tjSearchStates = [
  "searched",
  "skipped_anonymous",
  "disabled_by_input",
  "skipped_short_query",
  "unavailable",
  "throttled",
  "circuit_open",
  "failed"
] as const;

export type TjSearchState = typeof tjSearchStates[number];

export interface CombinedTjCandidate extends TjSongCandidate {
  alreadySaved: boolean;
  savedSongId: string | null;
  exactNumberMatch: boolean;
}

export interface CombinedSongSearch {
  query: string;
  saved: Song[];
  tj: {
    state: TjSearchState;
    searchType: TjSearchType | null;
    candidates: CombinedTjCandidate[];
    hasMore: boolean;
    sourceUrl: string;
    error: { code: string; retryable: boolean } | null;
  };
}

function errorCode(error: unknown): string {
  const code = error instanceof TjAdapterError
    ? error.code
    : error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "TJ_UPSTREAM_ERROR";
  return ["TJ_TIMEOUT", "TJ_BODY_TOO_LARGE", "TJ_RATE_LIMITED", "TJ_CIRCUIT_OPEN", "TJ_UPSTREAM_ERROR", "TJ_PARSER_ERROR"].includes(code)
    ? code
    : "TJ_UPSTREAM_ERROR";
}

function retryable(error: unknown): boolean {
  return error instanceof TjAdapterError ? error.retryable : errorCode(error) !== "TJ_PARSER_ERROR" && errorCode(error) !== "TJ_BODY_TOO_LARGE";
}

function baseTj(state: TjSearchState, searchType: TjSearchType | null): CombinedSongSearch["tj"] {
  return { state, searchType, candidates: [], hasMore: false, sourceUrl: "", error: null };
}

export async function combinedSongSearch(options: {
  service: SongbookService;
  tj?: TjAdapter;
  query: string;
  limit: number;
  includeTj: boolean;
  authenticated: boolean;
}): Promise<CombinedSongSearch> {
  const query = options.query.trim();
  const saved = options.service.search(query).slice(0, options.limit);
  const searchType = searchTypeForQuery(query);
  let tj: CombinedSongSearch["tj"];

  if (!options.includeTj) {
    tj = baseTj("disabled_by_input", null);
  } else if (!options.authenticated) {
    tj = baseTj("skipped_anonymous", null);
  } else if (!isSearchableQuery(query)) {
    tj = baseTj("skipped_short_query", null);
  } else if (!options.tj) {
    tj = baseTj("unavailable", searchType);
  } else {
    try {
      const result = await options.tj.search({ query, searchType, nation: "", page: 1, pageSize: Math.min(30, Math.max(1, options.limit)) });
      tj = {
        state: "searched",
        searchType,
        candidates: result.candidates.map((candidate) => {
          const existing = options.service.checkDuplicate({ tjNumber: candidate.tjNumber, title: candidate.title, artist: candidate.artist });
          return {
            ...candidate,
            alreadySaved: Boolean(existing),
            savedSongId: existing?.id ?? null,
            exactNumberMatch: searchType === "number" && candidate.tjNumber === query
          };
        }),
        hasMore: result.hasMore,
        sourceUrl: result.sourceUrl,
        error: null
      };
    } catch (error) {
      const code = errorCode(error);
      tj = {
        ...baseTj(code === "TJ_RATE_LIMITED" ? "throttled" : code === "TJ_CIRCUIT_OPEN" ? "circuit_open" : "failed", searchType),
        error: { code, retryable: retryable(error) }
      };
    }
  }

  return { query, saved, tj };
}
