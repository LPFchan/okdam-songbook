import { useEffect, useMemo, useRef, useState } from "react";
import type { Song, TjSongCandidate } from "@songbook/shared";
import { addTjSong, searchTjSongs } from "../lib/api";

interface TjOmnibarResultsProps {
  query: string;
  enabled: boolean;
  songs: Song[];
  requireCredential(): Promise<string>;
  onManualAdd(): void;
  onOpenExisting(song: Song): void;
  onSongSaved(song: Song): void;
  onMessage(message: string): void;
}

const DEBOUNCE_MS = 450;

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function candidateKey(candidate: TjSongCandidate): string {
  return `${candidate.tjNumber}:${candidate.title}:${candidate.artist}`;
}

export function TjOmnibarResults({
  query,
  enabled,
  songs,
  requireCredential,
  onManualAdd,
  onOpenExisting,
  onSongSaved,
  onMessage
}: TjOmnibarResultsProps) {
  const trimmedQuery = query.trim();
  const searchable = trimmedQuery.length >= 2 || /^\d+$/u.test(trimmedQuery);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<TjSongCandidate[]>([]);
  const [error, setError] = useState("");
  const [completedQuery, setCompletedQuery] = useState("");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<Record<string, Song>>({});
  const requestIds = useRef(new Map<string, string>());

  useEffect(() => {
    if (!enabled || !searchable) {
      setLoading(false);
      setResults([]);
      setError("");
      setCompletedQuery("");
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void requireCredential()
        .then((credential) => searchTjSongs({ query: trimmedQuery, searchType: /^\d+$/u.test(trimmedQuery) ? "number" : "all", nation: "", page: 1, pageSize: 15 }, credential))
        .then((response) => {
          if (cancelled) return;
          setResults(response.candidates);
          setCompletedQuery(trimmedQuery);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setResults([]);
          setCompletedQuery(trimmedQuery);
          setError(reason instanceof Error ? reason.message : "TJ 검색을 불러오지 못했어.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, requireCredential, searchable, trimmedQuery]);

  const existingByCandidate = useMemo(() => {
    const matches = new Map<string, Song>();
    for (const candidate of results) {
      const existing = songs.find((song) => song.tjNumber === candidate.tjNumber || (
        normalized(song.title) === normalized(candidate.title) && normalized(song.artist) === normalized(candidate.artist)
      ));
      if (existing) matches.set(candidateKey(candidate), existing);
    }
    return matches;
  }, [results, songs]);

  async function addCandidate(candidate: TjSongCandidate) {
    const key = candidateKey(candidate);
    if (pending[key]) return;
    const existing = existingByCandidate.get(key) ?? added[key];
    if (existing) {
      onOpenExisting(existing);
      return;
    }

    let requestId = requestIds.current.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      requestIds.current.set(key, requestId);
    }
    setPending((current) => ({ ...current, [key]: true }));
    try {
      const credential = await requireCredential();
      const response = await addTjSong(candidate, credential, requestId);
      const song = response.song ?? response.existing;
      if (song) {
        setAdded((current) => ({ ...current, [key]: song }));
        onSongSaved(song);
        if (response.outcome === "created") onMessage(`${song.title}을(를) 추가했어.`);
        else onMessage("이미 Songbook에 있는 곡을 열었어.");
        onOpenExisting(song);
      }
    } catch (reason) {
      onMessage(reason instanceof Error ? reason.message : "곡을 추가하지 못했어.");
    } finally {
      setPending((current) => ({ ...current, [key]: false }));
    }
  }

  if (!searchable) return null;

  if (!enabled) {
    return (
      <section className="omnibar-tj" aria-label="TJ 검색">
        <p className="omnibar-tj-status">TJ에서도 찾으려면 로그인해줘.</p>
      </section>
    );
  }

  return (
    <section className="omnibar-tj" aria-label="TJ 검색 결과" aria-live="polite">
      <header className="omnibar-tj-heading">
        <div>
          <h2>TJ에서 더 찾기</h2>
          <p>Songbook 결과 다음에 TJ 반주곡 결과를 보여줘.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onManualAdd}>직접 입력</button>
      </header>
      {loading ? <p className="omnibar-tj-status">TJ 검색 중…</p> : null}
      {error ? <p className="omnibar-tj-status error">{error} 직접 입력은 계속 사용할 수 있어.</p> : null}
      {!loading && !error && completedQuery === trimmedQuery && results.length === 0 ? (
        <p className="omnibar-tj-status">TJ에도 검색 결과가 없어.</p>
      ) : null}
      {results.length ? (
        <div className="omnibar-tj-results">
          {results.map((candidate) => {
            const key = candidateKey(candidate);
            const existing = existingByCandidate.get(key) ?? added[key];
            return (
              <article className="omnibar-tj-row" key={key}>
                <span className="omnibar-tj-number">{candidate.tjNumber}</span>
                <div className="omnibar-tj-copy">
                  <strong>{candidate.title}</strong>
                  <small>{candidate.artist}</small>
                </div>
                <button type="button" className={existing ? "secondary-button" : "primary-button"} disabled={Boolean(pending[key])} onClick={() => void addCandidate(candidate)}>
                  {pending[key] ? "추가 중…" : existing ? "Songbook에서 열기" : "바로 추가"}
                </button>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
