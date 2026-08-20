import {
  buildTjSearchUrl,
  parseTjHasMore,
  parseTjSearchHtml,
  type TjLookupRequest,
  type TjLookupResult,
  type TjSearchRequest,
  type TjSearchResult
} from "@songbook/shared";
import { createInMemoryTjSearchMirror, type TjMirrorSnapshot, type TjSearchMirror } from "../db/tjMirror.js";
import { DomainError, type DomainErrorCode } from "./errors.js";

export interface TjResponse {
  status: number;
  text(): Promise<string>;
}

export type TjFetcher = (url: string, init: { signal: globalThis.AbortSignal }) => Promise<TjResponse>;

export interface TjAdapterWarning {
  code: "refresh_failed" | "refresh_recovered" | "mirror_read_failed" | "mirror_write_failed" | "mirror_failure_record_failed" | "circuit_opened" | "circuit_recovered";
  queryKey?: string;
  errorCode?: string;
  consecutiveFailures?: number;
  message: string;
}

export interface TjAdapterOptions {
  fetcher?: TjFetcher;
  mirror?: TjSearchMirror;
  now?: () => number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  freshnessMs?: number;
  throttleWindowMs?: number;
  throttleLimit?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
  onWarn?: (warning: TjAdapterWarning) => void;
}

export interface TjManualFallback {
  manualFallback: true;
  code: DomainErrorCode;
  message: string;
}

export class TjAdapterError extends DomainError {
  readonly manualFallback = true as const;
  readonly retryable: boolean;

  constructor(code: Extract<DomainErrorCode, `TJ_${string}`>, message: string, retryable: boolean, details: unknown = null) {
    super(code, message, details);
    this.name = "TjAdapterError";
    this.retryable = retryable;
  }

  toManualFallback(): TjManualFallback {
    return { manualFallback: true, code: this.code, message: this.message };
  }
}

export interface TjAdapter {
  search(input: TjSearchRequest): Promise<TjSearchResult>;
  lookup(input: TjLookupRequest): Promise<TjLookupResult>;
}

const defaultFetcher: TjFetcher = async (url, init) => globalThis.fetch(url, init);
const DAY_MS = 24 * 60 * 60 * 1_000;

function errorCode(error: unknown): string {
  return error instanceof TjAdapterError ? error.code : "TJ_UPSTREAM_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFresh(snapshot: TjMirrorSnapshot, current: number, freshnessMs: number): boolean {
  if (!snapshot.checkedAt) return false;
  const checkedAt = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  const age = current - checkedAt;
  return age >= 0 && age < freshnessMs;
}

export function createTjAdapter(options: TjAdapterOptions = {}): TjAdapter {
  const fetcher = options.fetcher ?? defaultFetcher;
  const mirror = options.mirror ?? createInMemoryTjSearchMirror();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const freshnessMs = options.freshnessMs ?? DAY_MS;
  const throttleWindowMs = options.throttleWindowMs ?? 10_000;
  const throttleLimit = options.throttleLimit ?? 4;
  const failureThreshold = options.circuitFailureThreshold ?? 3;
  const circuitOpenMs = options.circuitOpenMs ?? 30_000;
  const requestTimes: number[] = [];
  const inFlight = new Map<string, Promise<TjSearchResult>>();
  const warnedFailureKeys = new Set<string>();
  let warnedMirrorRead = false;
  let warnedMirrorWrite = false;
  let warnedMirrorFailureRecord = false;
  let failures = 0;
  let circuitOpenedAt = 0;

  const warn = (warning: TjAdapterWarning): void => {
    try { options.onWarn?.(warning); } catch { /* warnings must never affect the request */ }
  };

  const ensureAllowed = () => {
    const current = now();
    while (requestTimes[0] !== undefined && requestTimes[0] <= current - throttleWindowMs) requestTimes.shift();
    if (requestTimes.length >= throttleLimit) throw new TjAdapterError("TJ_RATE_LIMITED", "TJ 요청이 잠시 제한되었어.", true);
    if (circuitOpenedAt && current - circuitOpenedAt < circuitOpenMs) throw new TjAdapterError("TJ_CIRCUIT_OPEN", "TJ 연결이 잠시 중단되어 수동 입력을 사용할 수 있어.", true);
    if (circuitOpenedAt) {
      circuitOpenedAt = 0;
      failures = 0;
      warn({ code: "circuit_recovered", errorCode: "TJ_CIRCUIT_OPEN", message: "TJ circuit recovered; upstream requests are allowed again." });
    }
    requestTimes.push(current);
  };

  const markFailure = () => {
    failures += 1;
    if (failures >= failureThreshold && !circuitOpenedAt) {
      circuitOpenedAt = now();
      warn({ code: "circuit_opened", errorCode: "TJ_CIRCUIT_OPEN", message: "TJ circuit opened after repeated upstream failures." });
    }
  };

  const fetchHtml = async (url: string): Promise<string> => {
    ensureAllowed();
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: TjResponse;
      try {
        response = await fetcher(url, { signal: controller.signal });
      } catch (error) {
        markFailure();
        if (controller.signal.aborted) throw new TjAdapterError("TJ_TIMEOUT", "TJ 요청 시간이 초과되었어. 수동 입력을 사용할 수 있어.", true);
        throw new TjAdapterError("TJ_UPSTREAM_ERROR", "TJ에 연결하지 못했어. 수동 입력을 사용할 수 있어.", true, error);
      }
      if (response.status < 200 || response.status >= 300) {
        markFailure();
        throw new TjAdapterError("TJ_UPSTREAM_ERROR", `TJ가 HTTP ${response.status}로 응답했어.`, true, { status: response.status });
      }
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        markFailure();
        throw new TjAdapterError("TJ_UPSTREAM_ERROR", "TJ 응답을 읽지 못했어. 수동 입력을 사용할 수 있어.", true, error);
      }
      if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
        markFailure();
        throw new TjAdapterError("TJ_BODY_TOO_LARGE", "TJ 응답이 너무 커서 읽지 않았어. 수동 입력을 사용할 수 있어.", false);
      }
      failures = 0;
      return body;
    } finally {
      clearTimeout(timer);
    }
  };

  const readMirror = (queryKey: string): TjMirrorSnapshot | null => {
    try {
      return mirror.get(queryKey);
    } catch (error) {
      if (!warnedMirrorRead) {
        warnedMirrorRead = true;
        warn({ code: "mirror_read_failed", queryKey, message: `TJ mirror read failed: ${errorMessage(error)}` });
      }
      return null;
    }
  };

  const recordFailure = (queryKey: string, attemptedAt: string, error: unknown): number | null => {
    try {
      return mirror.recordFailure(queryKey, attemptedAt, errorCode(error));
    } catch (recordError) {
      if (!warnedMirrorFailureRecord) {
        warnedMirrorFailureRecord = true;
        warn({ code: "mirror_failure_record_failed", queryKey, errorCode: errorCode(error), message: `TJ mirror failure bookkeeping failed: ${errorMessage(recordError)}` });
      }
      return null;
    }
  };

  const refresh = async (request: TjSearchRequest, queryKey: string, stale: TjMirrorSnapshot | null): Promise<TjSearchResult> => {
    const attemptedAt = new Date(now()).toISOString();
    try {
      const body = await fetchHtml(queryKey);
      let candidates;
      try {
        candidates = parseTjSearchHtml(body, queryKey);
      } catch (error) {
        markFailure();
        throw new TjAdapterError("TJ_PARSER_ERROR", "TJ 검색 결과 형식을 읽지 못했어. 수동 입력을 사용할 수 있어.", false, error);
      }
      const result: TjSearchResult = {
        query: request.query.replace(/\s/gu, ""),
        searchType: request.searchType ?? "all",
        nation: request.nation ?? "",
        page: request.page ?? 1,
        pageSize: request.pageSize ?? 15,
        hasMore: parseTjHasMore(body),
        candidates,
        sourceUrl: queryKey
      };
      try {
        mirror.replace(result, new Date(now()).toISOString(), attemptedAt);
      } catch (error) {
        if (!warnedMirrorWrite) {
          warnedMirrorWrite = true;
          warn({ code: "mirror_write_failed", queryKey, message: `TJ mirror write failed: ${errorMessage(error)}` });
        }
      }
      if (stale?.consecutiveFailures) {
        warn({ code: "refresh_recovered", queryKey, errorCode: stale.lastErrorCode ?? undefined, consecutiveFailures: stale.consecutiveFailures, message: "TJ mirror refresh recovered after a previous failure." });
      }
      warnedFailureKeys.delete(queryKey);
      return result;
    } catch (error) {
      const code = errorCode(error);
      if (stale) {
        const count = recordFailure(queryKey, attemptedAt, error);
        if (!warnedFailureKeys.has(queryKey)) {
          warnedFailureKeys.add(queryKey);
          warn({ code: "refresh_failed", queryKey, errorCode: code, consecutiveFailures: count ?? undefined, message: `TJ refresh failed; serving the previous snapshot: ${errorMessage(error)}` });
        }
        return stale.result;
      }
      if (!warnedFailureKeys.has(queryKey)) {
        warnedFailureKeys.add(queryKey);
        warn({ code: "refresh_failed", queryKey, errorCode: code, message: `TJ refresh failed with no snapshot: ${errorMessage(error)}` });
      }
      throw error;
    }
  };

  const search = async (input: TjSearchRequest): Promise<TjSearchResult> => {
    const request: TjSearchRequest = {
      query: input.query,
      searchType: input.searchType ?? "all",
      nation: input.nation ?? "",
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 15
    };
    const queryKey = buildTjSearchUrl(request);
    const snapshot = readMirror(queryKey);
    if (snapshot && isFresh(snapshot, now(), freshnessMs)) return { ...snapshot.result, query: request.query };
    const existing = inFlight.get(queryKey);
    if (existing) return { ...(await existing), query: request.query };
    const promise = refresh(request, queryKey, snapshot);
    inFlight.set(queryKey, promise);
    try {
      return { ...(await promise), query: request.query };
    } finally {
      if (inFlight.get(queryKey) === promise) inFlight.delete(queryKey);
    }
  };

  return {
    search,
    lookup: async (input) => {
      const result = await search({ query: input.tjNumber, searchType: "number", nation: input.nation ?? "", page: 1, pageSize: input.pageSize ?? 15 });
      const candidate = result.candidates.find((entry) => entry.tjNumber === input.tjNumber) ?? null;
      return { query: input.tjNumber, candidate, candidates: result.candidates, sourceUrl: result.sourceUrl };
    }
  };
}
