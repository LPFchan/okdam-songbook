import {
  buildTjSearchUrl,
  parseTjHasMore,
  parseTjSearchHtml,
  type TjLookupRequest,
  type TjLookupResult,
  type TjSearchRequest,
  type TjSearchResult
} from "@songbook/shared";
import { DomainError, type DomainErrorCode } from "./errors.js";

export interface TjResponse {
  status: number;
  text(): Promise<string>;
}

export type TjFetcher = (url: string, init: { signal: globalThis.AbortSignal }) => Promise<TjResponse>;

export interface TjAdapterOptions {
  fetcher?: TjFetcher;
  now?: () => number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  cacheTtlMs?: number;
  throttleWindowMs?: number;
  throttleLimit?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
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

interface CachedResult {
  expiresAt: number;
  result: TjSearchResult;
}

export interface TjAdapter {
  search(input: TjSearchRequest): Promise<TjSearchResult>;
  lookup(input: TjLookupRequest): Promise<TjLookupResult>;
}

const defaultFetcher: TjFetcher = async (url, init) => globalThis.fetch(url, init);

export function createTjAdapter(options: TjAdapterOptions = {}): TjAdapter {
  const fetcher = options.fetcher ?? defaultFetcher;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const throttleWindowMs = options.throttleWindowMs ?? 10_000;
  const throttleLimit = options.throttleLimit ?? 4;
  const failureThreshold = options.circuitFailureThreshold ?? 3;
  const circuitOpenMs = options.circuitOpenMs ?? 30_000;
  const cache = new Map<string, CachedResult>();
  const requestTimes: number[] = [];
  let failures = 0;
  let circuitOpenedAt = 0;

  const ensureAllowed = () => {
    const current = now();
    while (requestTimes[0] !== undefined && requestTimes[0] <= current - throttleWindowMs) requestTimes.shift();
    if (requestTimes.length >= throttleLimit) throw new TjAdapterError("TJ_RATE_LIMITED", "TJ 요청이 잠시 제한되었어.", true);
    if (circuitOpenedAt && current - circuitOpenedAt < circuitOpenMs) throw new TjAdapterError("TJ_CIRCUIT_OPEN", "TJ 연결이 잠시 중단되어 수동 입력을 사용할 수 있어.", true);
    if (circuitOpenedAt) { circuitOpenedAt = 0; failures = 0; }
    requestTimes.push(current);
  };

  const markFailure = () => {
    failures += 1;
    if (failures >= failureThreshold) circuitOpenedAt = now();
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
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
        markFailure();
        throw new TjAdapterError("TJ_BODY_TOO_LARGE", "TJ 응답이 너무 커서 읽지 않았어. 수동 입력을 사용할 수 있어.", false);
      }
      failures = 0;
      circuitOpenedAt = 0;
      return body;
    } finally {
      clearTimeout(timer);
    }
  };

  const search = async (input: TjSearchRequest): Promise<TjSearchResult> => {
    const url = buildTjSearchUrl(input);
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now()) return cached.result;
    const body = await fetchHtml(url);
    try {
      const candidates = parseTjSearchHtml(body, url);
      const result: TjSearchResult = { query: input.query, searchType: input.searchType ?? "all", nation: input.nation ?? "", page: input.page ?? 1, pageSize: input.pageSize ?? 15, hasMore: parseTjHasMore(body), candidates, sourceUrl: url };
      cache.set(url, { expiresAt: now() + cacheTtlMs, result });
      return result;
    } catch (error) {
      markFailure();
      throw new TjAdapterError("TJ_PARSER_ERROR", "TJ 검색 결과 형식을 읽지 못했어. 수동 입력을 사용할 수 있어.", false, error);
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
