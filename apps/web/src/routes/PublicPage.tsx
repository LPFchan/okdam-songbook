import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Filter, LogIn, Moon, Monitor, RefreshCw, RotateCcw, Search, SlidersHorizontal, Sun } from "lucide-react";
import type { PerformerId, Song, SongFilters, SortKey } from "@songbook/shared";
import { filterSongs, performerOrder, performers, searchSongs, sortSongs } from "@songbook/shared";
import { BottomSheet } from "../components/BottomSheet";
import { SongCard } from "../components/SongCard";
import { SongDetail } from "../components/SongDetail";
import { TjOmnibarResults } from "../components/TjOmnibarResults";
import { cancelPerformance, createPerformance, fetchPublicData } from "../lib/api";
import { readCachedPublicData, saveCachedPublicData } from "../lib/db";
import {
  drainOfflineQueue,
  enqueuePerformanceCancel,
  enqueuePerformanceCreate,
  classifyQueueError,
  queueCounts,
  queueItems,
  markQueueItemFailed,
  discardQueueItem,
  retryQueueItem,
  subscribeQueue,
  type QueueCounts
} from "../lib/offlineQueue";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { usePhysicsMode } from "../hooks/usePhysicsMode";
import { useTheme } from "../hooks/useTheme";
import { AuthRequiredError, useAuth } from "../lib/auth/AuthContext";
import { AdminPage, type AdminTab } from "./AdminPage";

function OfflineQueueSurface({ online, auth, onMessage }: { online: boolean; auth: ReturnType<typeof useAuth>; onMessage: (message: string) => void }) {
  const [offlineQueue, setOfflineQueue] = useState<Awaited<ReturnType<typeof queueItems>>>([]);
  const [offlineQueueCounts, setOfflineQueueCounts] = useState<QueueCounts>({ pending: 0, inFlight: 0, failed: 0, deadLetter: 0, authPaused: false });

  const refreshOfflineQueue = useCallback(async () => {
    const [items, counts] = await Promise.all([queueItems(), queueCounts()]);
    setOfflineQueue(items);
    setOfflineQueueCounts(counts);
  }, []);

  const drainQueue = useCallback(async () => {
    await drainOfflineQueue(auth.user ? { auth, onChange: () => void refreshOfflineQueue() } : { onChange: () => void refreshOfflineQueue() });
    await refreshOfflineQueue();
  }, [auth, refreshOfflineQueue]);

  useEffect(() => {
    const unsubscribe = subscribeQueue(() => void refreshOfflineQueue());
    const onOnline = () => void drainQueue();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void drainQueue();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    void refreshOfflineQueue();
    if (online) void drainQueue();
    return () => {
      unsubscribe();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [drainQueue, online, refreshOfflineQueue]);

  useEffect(() => {
    if (auth.status === "authenticated" || auth.forceUpdateToken > 0) void drainQueue();
  }, [auth.forceUpdateToken, auth.status, drainQueue]);

  async function retryQueuedItem(id: string) {
    await retryQueueItem(id);
    await drainQueue();
    onMessage("동기화를 다시 시도할게.");
  }

  async function discardQueuedItem(id: string) {
    await discardQueueItem(id);
    await refreshOfflineQueue();
    onMessage("실패한 기록을 버렸어.");
  }

  const queueTotal = offlineQueueCounts.pending + offlineQueueCounts.inFlight + offlineQueueCounts.failed + offlineQueueCounts.deadLetter;
  if (!queueTotal) return null;
  return (
    <section className="offline-queue-panel" aria-label="오프라인 동기화">
      <div className="offline-queue-heading">
        <strong>오프라인 동기화</strong>
        <span>
          {offlineQueueCounts.pending + offlineQueueCounts.inFlight > 0 ? `대기 ${offlineQueueCounts.pending + offlineQueueCounts.inFlight}개` : ""}
          {offlineQueueCounts.failed + offlineQueueCounts.deadLetter > 0 ? ` · 확인 필요 ${offlineQueueCounts.failed + offlineQueueCounts.deadLetter}개` : ""}
        </span>
      </div>
      {offlineQueueCounts.authPaused ? <p className="hint">로그인하면 대기 중인 기록을 다시 동기화할 수 있어.</p> : null}
      <ul className="offline-queue-list">
        {offlineQueue.map((item) => (
          <li key={item.id}>
            <span>
              {item.action === "performance:create" ? "부른 기록" : "취소 기록"} · {item.status === "dead-letter" ? "동기화 실패" : item.status === "failed" ? "재시도 대기" : item.status === "in_flight" ? "동기화 중" : "대기 중"}
              {item.errorMessage ? <small>{item.errorMessage}</small> : null}
            </span>
            {item.status === "failed" || item.status === "dead-letter" ? (
              <span className="offline-queue-actions">
                <button type="button" aria-label="동기화 다시 시도" onClick={() => void retryQueuedItem(item.id)}>다시 시도</button>
                <button type="button" aria-label="실패한 기록 버리기" onClick={() => void discardQueuedItem(item.id)}>버리기</button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PublicPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [songs, setSongs] = useState<Song[]>([]);
  const [query, setQuery] = useState(() => window.localStorage.getItem("songbook:query") ?? "");
  const [sortKey, setSortKey] = useState<SortKey>(() => (window.localStorage.getItem("songbook:sort") as SortKey | null) ?? "title");
  const [filters, setFilters] = useState<SongFilters>({});
  const [selected, setSelected] = useState<Song | null>(null);
  const [lastSync, setLastSync] = useState("");
  const [message, setMessage] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [physicsMode, setPhysicsMode] = useState(false);
  const [physicsResetId, setPhysicsResetId] = useState(0);
  const [theme, setTheme] = useTheme();
  const titleTapRef = useRef(0);
  const titleKeyRef = useRef(0);
  const titleToggleRef = useRef(0);
  const online = useOnlineStatus();
  const requestedTab = searchParams.get("tab");
  const managementTab: AdminTab | null = requestedTab === "add" || requestedTab === "songs" || requestedTab === "history" ? requestedTab : null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const cached = await readCachedPublicData();
      if (cached && !cancelled) {
        setSongs(cached.songs);
        setLastSync(cached.updatedAt);
      }
      try {
        const data = await fetchPublicData();
        if (!cancelled) {
          setSongs(data.songs);
          setLastSync(data.updatedAt);
          await saveCachedPublicData(data);
        }
      } catch (error) {
        if (!cached) setMessage(error instanceof Error ? error.message : "데이터를 불러오지 못했어.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("songbook:query", query);
    window.localStorage.setItem("songbook:sort", sortKey);
  }, [query, sortKey]);

  const visibleSongs = useMemo(() => {
    return sortSongs(searchSongs(filterSongs(songs, filters), query), sortKey);
  }, [filters, query, songs, sortKey]);

  const showMessage = useCallback((nextMessage: string) => {
    setMessage(nextMessage);
  }, []);

  const exitPhysics = useCallback(() => {
    setPhysicsMode(false);
    setPhysicsResetId((version) => version + 1);
  }, []);

  usePhysicsMode({
    active: physicsMode,
    cardSelector: "[data-physics-card]",
    onExit: exitPhysics,
    onMessage: showMessage
  });

  const [lastPerformed, setLastPerformed] = useState<{ performanceId: string; clientRequestId: string; songId: string } | null>(null);

  const loginHint = useCallback(() => {
    setMessage("기록하려면 Google 로그인이 필요해. 관리 화면으로 이동할게.");
    window.setTimeout(() => navigate("/admin"), 800);
  }, [navigate]);

  async function performSong(song: Song, clientRequestId: string, performedAt: string) {
    const result = await createPerformance(song.id, clientRequestId, performedAt);
    const performanceId = result && typeof result === "object" && "id" in result ? String((result as { id: string }).id) : "";
    setLastPerformed(performanceId ? { performanceId, clientRequestId, songId: song.id } : null);
    setMessage(performanceId ? "오늘 부른 곡으로 기록했어. 8초 안에 취소할 수 있어." : "오늘 부른 곡으로 기록했어.");
  }

  async function markPerformed(song: Song) {
    const clientRequestId = crypto.randomUUID();
    const performedAt = new Date().toISOString();
    const optimistic = songs.map((item) =>
      item.id === song.id ? { ...item, performanceCount: item.performanceCount + 1, lastPerformedAt: new Date().toISOString() } : item
    );
    setSongs(optimistic);

    if (!online) {
      await enqueuePerformanceCreate(song.id, clientRequestId, performedAt);
      setMessage("오프라인이라 큐에 저장했어. 온라인 복귀 후 자동 동기화돼.");
      return;
    }

    try {
      await auth.requireValidCredential();
      await performSong(song, clientRequestId, performedAt);
    } catch (error) {
      // Roll back the optimistic count if the write was never sent (auth fail).
      if (error instanceof AuthRequiredError) {
        setSongs((prev) => prev.map((item) =>
          item.id === song.id
            ? { ...item, performanceCount: Math.max(0, (item.performanceCount ?? 0) - 1), lastPerformedAt: item.lastPerformedAt }
            : item
        ));
        await enqueuePerformanceCreate(song.id, clientRequestId, performedAt);
        loginHint();
        return;
      }
      // Network/server error: queue offline so the user does not lose the record.
      await enqueuePerformanceCreate(song.id, clientRequestId, performedAt);
      await markQueueItemFailed(clientRequestId, error, classifyQueueError(error));
      setMessage("기록에 실패해서 큐에 저장했어.");
    }
  }

  async function refreshCatalog() {
    try {
      const data = await fetchPublicData();
      setSongs(data.songs);
      setLastSync(data.updatedAt);
      await saveCachedPublicData(data);
      setMessage("목록을 새로고침했어.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "새로고침하지 못했어.");
    }
  }

  async function undoLastPerformance() {
    const target = lastPerformed;
    if (!target) {
      setMessage("취소할 기록이 없어.");
      return;
    }
    setLastPerformed(null);
    setSongs((prev) => prev.map((item) =>
      item.id === target.songId
        ? { ...item, performanceCount: Math.max(0, (item.performanceCount ?? 0) - 1), lastPerformedAt: "" }
      : item
    ));
    const cancellationRequestId = crypto.randomUUID();
    if (!online) {
      await enqueuePerformanceCancel(target.songId, target.performanceId, cancellationRequestId);
      setMessage("오프라인이라 취소는 큐에 저장했어.");
      return;
    }
    try {
      await auth.requireValidCredential();
      await cancelPerformance(target.performanceId, cancellationRequestId);
      setMessage("방금 기록한 곡을 취소했어.");
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        const queued = await enqueuePerformanceCancel(target.songId, target.performanceId, cancellationRequestId);
        await markQueueItemFailed(queued.id, new Error("로그인 후 다시 시도할 수 있어."), "auth");
        setMessage("취소하려면 Google 로그인이 필요해.");
        return;
      }
      const queued = await enqueuePerformanceCancel(target.songId, target.performanceId);
      await markQueueItemFailed(queued.id, error, classifyQueueError(error));
      setMessage("취소에 실패해서 큐에 저장했어.");
    }
  }

  const countries = [...new Set(songs.map((song) => song.country).filter(Boolean))];
  const genres = [...new Set(songs.flatMap((song) => song.genres))];
  const activeFilters = [
    filters.country ? { key: "country" as const, label: filters.country } : null,
    filters.genre ? { key: "genre" as const, label: filters.genre } : null,
    ...(filters.performerIds ?? []).map((id) => ({ key: `performer:${id}` as const, label: `부를 사람: ${performers[id].displayName}` })),
    filters.hasKey ? { key: "hasKey" as const, label: "추천 키 있음" } : null,
    filters.favorite ? { key: "favorite" as const, label: "즐겨찾기" } : null,
    filters.practicing ? { key: "practicing" as const, label: "연습 중" } : null
  ].filter(Boolean) as Array<{ key: keyof SongFilters | `performer:${PerformerId}`; label: string }>;

  function togglePhysics() {
    titleToggleRef.current = window.performance.now();
    setSelected(null);
    setFilterOpen(false);
    if (physicsMode) setPhysicsResetId((version) => version + 1);
    setPhysicsMode(!physicsMode);
  }

  function onTitleTap() {
    const now = window.performance.now();
    if (now - titleTapRef.current < 560) {
      titleTapRef.current = 0;
      togglePhysics();
      return;
    }
    titleTapRef.current = now;
  }

  function onTitleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter") return;
    const now = window.performance.now();
    if (now - titleKeyRef.current < 700) {
      titleKeyRef.current = 0;
      togglePhysics();
      return;
    }
    titleKeyRef.current = now;
  }

  function onTitleDoubleClick() {
    if (window.performance.now() - titleToggleRef.current > 220) togglePhysics();
  }

  function togglePerformerFilter(id: PerformerId) {
    setFilters((previous) => {
      const current = previous.performerIds ?? [];
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      return { ...previous, performerIds: next.length ? next : undefined };
    });
  }

  function toggleBooleanFilter(key: "hasKey" | "favorite" | "practicing") {
    setFilters((previous) => ({ ...previous, [key]: previous[key] ? undefined : true }));
  }

  function selectSingleFilter(key: "country" | "genre", value: string) {
    setFilters((previous) => ({ ...previous, [key]: value || undefined }));
  }

  function removeFilter(key: keyof SongFilters | `performer:${PerformerId}`) {
    if (key.startsWith("performer:")) {
      const id = key.replace("performer:", "") as PerformerId;
      setFilters((previous) => {
        const next = (previous.performerIds ?? []).filter((value) => value !== id);
        return { ...previous, performerIds: next.length ? next : undefined };
      });
      return;
    }
    setFilters((previous) => ({ ...previous, [key]: undefined }));
  }

  function handleFavorite(song: Song) {
    if (physicsMode) return;
    setMessage(song.status === "favorite" ? "즐겨찾기는 관리 화면에서 해제할 수 있어." : "즐겨찾기는 관리 화면에서 추가할 수 있어.");
  }

  const authLabel = auth.user
    ? `${auth.user.displayName} · ${auth.user.role}`
    : auth.displayInfo
      ? `${auth.displayInfo.displayName} · 다시 로그인 필요`
      : "비로그인";

  async function loginWithGoogle() {
    try {
      await auth.loginWithGoogleButton();
      setMessage("로그인됐어.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "로그인하지 못했어.");
    }
  }

  function chooseTheme(next: "system" | "light" | "dark") {
    setTheme(next);
  }

  useEffect(() => {
    if (requestedTab !== "settings") return;
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    setSearchParams(next, { replace: true });
  }, [requestedTab, searchParams, setSearchParams]);

  function closeManagement() {
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    setSearchParams(next, { replace: true });
  }

  function openManagement(tab: AdminTab) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setAccountOpen(false);
    setSearchParams(next);
  }

  const quickFilters: Array<{ key: "marie" | "seongwook" | "yeowool" | "favorite" | "practicing"; label: string }> = [
    { key: "marie", label: "마리" },
    { key: "seongwook", label: "성욱" },
    { key: "yeowool", label: "여울" },
    { key: "favorite", label: "즐겨찾기" },
    { key: "practicing", label: "연습 중" }
  ];

  return (
    <main className="app-frame" data-physics-active={physicsMode ? "true" : undefined}>
      <header className="topbar">
        <div className="topline">
          <div>
            <h1
              className="brand-title"
              role="button"
              tabIndex={0}
              onClick={onTitleTap}
              onDoubleClick={onTitleDoubleClick}
              onKeyDown={onTitleKey}
            >
              Songbook
            </h1>
            <p>
              {online ? "온라인" : "오프라인"} · 마지막 동기화 {lastSync ? new Date(lastSync).toLocaleString() : "없음"}
              {" · "}
              <span data-testid="public-auth-state" className="auth-pill">{authLabel}</span>
            </p>
          </div>
          <div className="top-actions">
            <button type="button" className="account-button" onClick={() => setAccountOpen(true)}>
              {auth.user ? auth.user.displayName : <LogIn size={17} />}
              <span className="account-button-label">계정</span>
            </button>
            <button
              type="button"
              className="icon-button theme-button"
              aria-label="테마 변경"
              onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}
            >
              {theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
          </div>
        </div>
        <label className="search-box">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Songbook과 TJ에서 곡명, 가수, 번호 검색" />
        </label>
        <div className="toolbar">
          <button type="button" onClick={() => setFilterOpen(true)}>
            <Filter size={17} />
            필터
          </button>
          <label>
            <SlidersHorizontal size={17} />
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
              <option value="title">가나다순</option>
              <option value="tjNumber">TJ 번호순</option>
              <option value="recentAdded">최근 추가순</option>
              <option value="recentUpdated">최근 수정순</option>
              <option value="recentPerformed">최근 부른 순</option>
              <option value="performanceCount">많이 부른 순</option>
            </select>
          </label>
          {auth.user ? <>
            <button type="button" onClick={() => openManagement("songs")}>곡 관리</button>
            <button type="button" onClick={() => openManagement("history")}>이력</button>
          </> : null}
        </div>
        {!filterOpen ? <div className="quick-chip-row" role="group" aria-label="빠른 필터">
          {quickFilters.map((filter) => {
            const pressed = filter.key === "favorite" || filter.key === "practicing"
              ? Boolean(filters[filter.key])
              : Boolean(filters.performerIds?.includes(filter.key));
            return (
              <button
                key={filter.key}
                type="button"
                className="chip-toggle quick-chip"
                aria-pressed={pressed}
                data-selected={pressed ? "true" : undefined}
                onClick={() => filter.key === "favorite" || filter.key === "practicing"
                  ? toggleBooleanFilter(filter.key)
                  : togglePerformerFilter(filter.key)}
              >
                {filter.label}
              </button>
            );
          })}
        </div> : null}
        {activeFilters.length ? (
          <div className="active-filters" aria-label="활성 필터">
            {activeFilters.map((filter) => (
              <button key={filter.key} type="button" onClick={() => removeFilter(filter.key)}>
                {filter.label} ×
              </button>
            ))}
            <button type="button" className="clear-filters" onClick={() => setFilters({})}>
              모두 초기화
            </button>
          </div>
        ) : null}
        <p className="result-count">{visibleSongs.length}곡</p>
      </header>

      {message ? (
        <div className="snackbar">
          <span>{message}</span>
          {lastPerformed ? (
            <button type="button" className="snackbar-action" onClick={() => void undoLastPerformance()}>
              취소
            </button>
          ) : null}
        </div>
      ) : null}
      <OfflineQueueSurface online={online} auth={auth} onMessage={setMessage} />
      <section className="song-list" aria-label="곡 목록">
        {visibleSongs.length > 0 ? (
          visibleSongs.map((song) => (
            <SongCard
              key={`${song.id}-${physicsResetId}`}
              disabled={physicsMode}
              song={song}
              query={query}
              onFavoriteClick={handleFavorite}
              onOpen={(nextSong) => {
                if (!physicsMode) setSelected(nextSong);
              }}
            />
          ))
        ) : (
          <div className="empty-state">{songs.length ? "검색 결과가 없어." : "아직 캐시된 곡이 없어. 한 번 온라인으로 동기화해줘."}</div>
        )}
      </section>

      <TjOmnibarResults
        query={query}
        enabled={Boolean(auth.user && online)}
        songs={songs}
        requireCredential={auth.requireValidCredential}
        onManualAdd={() => openManagement("add")}
        onOpenExisting={setSelected}
        onSongSaved={(saved) => setSongs((previous) => {
          const existing = previous.some((song) => song.id === saved.id);
          return existing ? previous.map((song) => song.id === saved.id ? saved : song) : [saved, ...previous];
        })}
        onMessage={setMessage}
      />

      {physicsMode ? (
        <button type="button" className="physics-restore" onClick={exitPhysics}>
          <RotateCcw size={16} />
          원상복구
        </button>
      ) : null}

      <BottomSheet open={Boolean(selected)} title={selected?.title ?? ""} onClose={() => setSelected(null)}>
        {selected ? <SongDetail song={selected} user={auth.user} onPerformed={markPerformed} /> : null}
      </BottomSheet>

      <BottomSheet open={filterOpen} title="필터" onClose={() => setFilterOpen(false)}>
        <div className="filter-form">
          <fieldset className="filter-fieldset">
            <legend>국가</legend>
            <div className="chip-toggle-group" role="group" aria-label="국가 필터">
              <button type="button" className="chip-toggle" aria-pressed={!filters.country} data-selected={!filters.country ? "true" : undefined} onClick={() => selectSingleFilter("country", "")}>전체</button>
              {countries.map((country) => (
                <button key={country} type="button" className="chip-toggle" aria-pressed={filters.country === country} data-selected={filters.country === country ? "true" : undefined} onClick={() => selectSingleFilter("country", country)}>{country}</button>
              ))}
            </div>
          </fieldset>
          <fieldset className="filter-fieldset">
            <legend>장르</legend>
            <div className="chip-toggle-group" role="group" aria-label="장르 필터">
              <button type="button" className="chip-toggle" aria-pressed={!filters.genre} data-selected={!filters.genre ? "true" : undefined} onClick={() => selectSingleFilter("genre", "")}>전체</button>
              {genres.map((genre) => (
                <button key={genre} type="button" className="chip-toggle" aria-pressed={filters.genre === genre} data-selected={filters.genre === genre ? "true" : undefined} onClick={() => selectSingleFilter("genre", genre)}>{genre}</button>
              ))}
            </div>
          </fieldset>
          <fieldset className="filter-fieldset">
            <legend>부를 사람</legend>
            <div className="chip-toggle-group" role="group" aria-label="부를 사람 필터">
              {performerOrder.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="chip-toggle"
                  aria-pressed={Boolean(filters.performerIds?.includes(id))}
                  data-selected={filters.performerIds?.includes(id) ? "true" : undefined}
                  onClick={() => togglePerformerFilter(id)}
                >
                  {performers[id].displayName}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="filter-fieldset">
            <legend>상태</legend>
            <div className="chip-toggle-group" role="group" aria-label="상태 필터">
              {([
                ["hasKey", "추천 키 있음"],
                ["favorite", "즐겨찾기"],
                ["practicing", "연습 중"]
              ] as const).map(([key, label]) => (
                <button key={key} type="button" className="chip-toggle" aria-pressed={Boolean(filters[key])} data-selected={filters[key] ? "true" : undefined} onClick={() => toggleBooleanFilter(key)}>{label}</button>
              ))}
            </div>
            <label className="sr-only" htmlFor="has-key-filter">추천 키 있음</label>
            <input id="has-key-filter" className="sr-only" type="checkbox" checked={Boolean(filters.hasKey)} onChange={() => toggleBooleanFilter("hasKey")} />
          </fieldset>
          <div className="filter-actions">
            <button type="button" className="secondary-button" onClick={() => setFilters({})}>
              초기화
            </button>
            <button type="button" className="primary-button" onClick={() => setFilterOpen(false)}>
              {visibleSongs.length}곡 보기
            </button>
          </div>
        </div>
      </BottomSheet>

      <BottomSheet open={accountOpen} title="계정 및 환경설정" onClose={() => setAccountOpen(false)}>
        <div className="account-surface">
          <section className="account-section" aria-labelledby="account-status-heading">
            <h3 id="account-status-heading">로그인</h3>
            <p className="hint">{auth.user ? `${auth.user.displayName} · ${auth.user.role}` : auth.status === "reauthRequired" ? "다시 로그인이 필요해." : "카탈로그는 로그인 없이 사용할 수 있어."}</p>
            {!auth.user ? (
              <button type="button" className="primary-button" onClick={() => void loginWithGoogle()}><LogIn size={17} /> Google로 로그인</button>
            ) : (
              <button type="button" className="secondary-button" onClick={() => { auth.signOut(); setMessage("로그아웃했어."); }}>로그아웃</button>
            )}
          </section>
          <section className="account-section" aria-labelledby="theme-heading">
            <h3 id="theme-heading">테마</h3>
            <div className="theme-options" role="group" aria-label="테마 선택">
              <button type="button" className="chip-toggle" aria-pressed={theme === "system"} data-selected={theme === "system" ? "true" : undefined} onClick={() => chooseTheme("system")}><Monitor size={16} /> 시스템</button>
              <button type="button" className="chip-toggle" aria-pressed={theme === "light"} data-selected={theme === "light" ? "true" : undefined} onClick={() => chooseTheme("light")}><Sun size={16} /> 밝게</button>
              <button type="button" className="chip-toggle" aria-pressed={theme === "dark"} data-selected={theme === "dark" ? "true" : undefined} onClick={() => chooseTheme("dark")}><Moon size={16} /> 어둡게</button>
            </div>
          </section>
          <section className="account-section" aria-labelledby="sync-heading">
            <h3 id="sync-heading">동기화</h3>
            <p className="hint">{online ? "온라인" : "오프라인"} · 마지막 동기화 {lastSync ? new Date(lastSync).toLocaleString() : "없음"}</p>
            <button type="button" className="secondary-button" onClick={() => void refreshCatalog()}><RefreshCw size={17} /> 목록 새로고침</button>
          </section>
        </div>
      </BottomSheet>

      <BottomSheet open={Boolean(managementTab)} title={managementTab === "songs" ? "곡 관리" : managementTab === "history" ? "변경 이력" : "곡 추가"} onClose={closeManagement}>
        {managementTab ? (
          <AdminPage
            embedded
            surfaceTab={managementTab}
            onSongSaved={(saved) => setSongs((previous) => {
              const existing = previous.some((song) => song.id === saved.id);
              return existing ? previous.map((song) => song.id === saved.id ? saved : song) : [saved, ...previous];
            })}
          />
        ) : null}
      </BottomSheet>
    </main>
  );
}
