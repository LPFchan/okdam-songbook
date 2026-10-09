import {
  buildDamKeywordRequest,
  buildDamNumberRequest,
  isDamNumberQuery,
  normalizeDamNumber,
  parseDamDetailResponse,
  parseDamKeywordResponse,
  type DamSearchRequest,
  type DamSearchResult
} from "@songbook/shared";
import { DomainError } from "./errors.js";

export interface DamResponse {
  status: number;
  json(): Promise<unknown>;
}

export type DamFetcher = (url: string, init: { method: "POST"; body: string; signal: globalThis.AbortSignal; headers: Record<string, string> }) => Promise<DamResponse>;

export interface DamAdapterOptions {
  fetcher?: DamFetcher;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  throttleWindowMs?: number;
  throttleLimit?: number;
}

export interface DamAdapter {
  search(input: DamSearchRequest): Promise<DamSearchResult>;
}

const defaultFetcher: DamFetcher = async (url, init) => globalThis.fetch(url, init);
const DAM_REQUEST_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
};
const CACHE_LIMIT = 200;

/**
 * clubdam.com search. Unlike TJ there is no D1 mirror: answers are cached in
 * memory for the life of the isolate, which is enough to absorb repeated
 * keystrokes and paging without storing DAM's catalog.
 */
export function createDamAdapter(options: DamAdapterOptions = {}): DamAdapter {
  const fetcher = options.fetcher ?? defaultFetcher;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const cacheMs = options.cacheMs ?? 24 * 60 * 60 * 1_000;
  const throttleWindowMs = options.throttleWindowMs ?? 10_000;
  const throttleLimit = options.throttleLimit ?? 4;
  const requestTimes: number[] = [];
  const cache = new Map<string, { at: number; result: Promise<DamSearchResult> }>();

  const post = async (request: { url: string; body: string }): Promise<unknown> => {
    const current = now();
    while (requestTimes[0] !== undefined && requestTimes[0] <= current - throttleWindowMs) requestTimes.shift();
    if (requestTimes.length >= throttleLimit) throw new DomainError("DAM_RATE_LIMITED", "DAM 요청이 잠시 제한되었어.");
    requestTimes.push(current);
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(request.url, { method: "POST", body: request.body, signal: controller.signal, headers: DAM_REQUEST_HEADERS });
      if (response.status < 200 || response.status >= 300) throw new DomainError("DAM_UPSTREAM_ERROR", `DAM이 HTTP ${response.status}로 응답했어.`, { status: response.status });
      return await response.json();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("DAM_UPSTREAM_ERROR", controller.signal.aborted ? "DAM 요청 시간이 초과되었어." : "DAM에 연결하지 못했어.");
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchResult = async (request: DamSearchRequest): Promise<DamSearchResult> => {
    const base = { query: request.query, page: request.page, pageSize: request.pageSize };
    try {
      // DAM's keyword search never matches request numbers, so numbers go to the detail lookup.
      const damNumber = isDamNumberQuery(request.query) ? normalizeDamNumber(request.query) : null;
      if (damNumber) {
        const candidate = parseDamDetailResponse(await post(buildDamNumberRequest(damNumber)));
        return { ...base, searchType: "number", hasMore: false, candidates: candidate ? [candidate] : [] };
      }
      const { candidates, hasMore } = parseDamKeywordResponse(await post(buildDamKeywordRequest(request)));
      return { ...base, searchType: "all", hasMore, candidates };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("DAM_UPSTREAM_ERROR", "DAM 검색 결과 형식을 읽지 못했어.");
    }
  };

  return {
    search: async (input) => {
      const request = { query: input.query.trim(), page: input.page ?? 1, pageSize: input.pageSize ?? 15 };
      const key = JSON.stringify(request);
      const cached = cache.get(key);
      if (cached && now() - cached.at < cacheMs) return cached.result;
      const result = fetchResult(request);
      cache.delete(key);
      cache.set(key, { at: now(), result });
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      result.catch(() => { if (cache.get(key)?.result === result) cache.delete(key); });
      return result;
    }
  };
}
