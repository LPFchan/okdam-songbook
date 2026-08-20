<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ChevronDown, LogIn, LogOut, Search, SlidersHorizontal, X } from "@lucide/svelte";
  import type { PerformerId, Song, SongFilters, SortKey } from "@songbook/shared";
  import { filterSongs, performers, searchSongs, sortSongs } from "@songbook/shared";
  import BottomSheet from "./BottomSheet.svelte";
  import SongCard from "./SongCard.svelte";
  import SongDetail from "./SongDetail.svelte";
  import SongForm, { type AdminTab } from "./SongForm.svelte";
  import TjOmnibar from "./TjOmnibar.svelte";
  import Snackbar from "./Snackbar.svelte";
  import { createPerformance, fetchPublicData } from "../api";
  import { readCachedPublicData, saveCachedPublicData } from "../db";
  import {
    drainOfflineQueue,
    cancelPerformanceOrQueue,
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
  } from "../offlineQueue";
  import type { OfflineQueueItem } from "../db";
  import { auth, AuthRequiredError } from "../auth.svelte";
  import { onlineStatus } from "../online.svelte";
  import { snackbar } from "../snackbar.svelte";
  import { createSpring, GENTLE } from "../spring";

  type QueueItem = Awaited<ReturnType<typeof queueItems>>[number];

  let songs = $state<Song[]>([]);
  let catalogVersion = $state(0);
  let query = $state("");
  let sortKey = $state<SortKey>("recentAdded");
  let filters = $state<SongFilters>({});
  let selected = $state<Song | null>(null);
  let chipsExpanded = $state(false);
  let editingSong = $state<Song | null>(null);
  let confirmSignOut = $state(false);
  // Pixels the topbar is currently pushed off-screen (0 = fully visible).
  let topbarShift = $state(0);
  let topbarEl = $state<HTMLElement | null>(null);
  let topbarHeight = $state(0);
  let lastPerformed = $state<{ performanceId: string; clientRequestId: string; songId: string } | null>(null);
  let undoTimer: ReturnType<typeof setTimeout> | undefined;

  let queueList = $state<QueueItem[]>([]);
  let queueCountsState = $state<QueueCounts>({ pending: 0, inFlight: 0, failed: 0, deadLetter: 0, authPaused: false });

  const requestedTab = $derived(page.url.searchParams.get("tab"));
  const managementTab = $derived<AdminTab | null>(
    requestedTab === "add" || requestedTab === "songs" ? requestedTab : null
  );

  onMount(() => {
    query = window.localStorage.getItem("songbook:query") ?? "";
    sortKey = (window.localStorage.getItem("songbook:sort") as SortKey | null) ?? "recentAdded";

    const stopOnline = onlineStatus.start();
    void auth.initialize();

    // Normalize ?tab=settings away (the old Settings tab no longer exists).
    if (page.url.searchParams.get("tab") === "settings") {
      const next = new URL(page.url);
      next.searchParams.delete("tab");
      void goto(next, { replaceState: true, noScroll: true, keepFocus: true });
    }

    let cancelled = false;
    async function load() {
      const cached = await readCachedPublicData();
      if (cached && !cancelled) {
        songs = cached.songs;
        catalogVersion += 1;
      }
      try {
        const data = await fetchPublicData();
        if (!cancelled) {
          songs = data.songs;
          catalogVersion += 1;
          await saveCachedPublicData(data);
        }
      } catch (error) {
        if (!cached) snackbar.show(error instanceof Error ? error.message : "데이터를 불러오지 못했어요.");
      }
    }
    void load();

    const unsubscribe = subscribeQueue(() => void refreshQueue());
    const onOnline = () => void drainQueue();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void drainQueue();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);

    // Slide the topbar with the scroll delta, pixel for pixel, and drive it
    // through a spring so motion stays smooth at 60/120fps. Like Safari's
    // bottom bar collapse: the bar follows the finger freely, and when the
    // scroll settles it commits to hidden or shown based on a threshold —
    // below the threshold it springs back to its previous state.
    let committedTarget: "shown" | "hidden" | null = null;
    const topbarSpring = createSpring(0, GENTLE, (value) => {
      // Ignore stale spring frames while the finger owns the bar.
      if (committedTarget) topbarShift = Math.round(value * 10) / 10;
    });
    let lastScrollY = window.scrollY;
    let pulled = 0;
    // Once the pull crosses the commit threshold the bar is handed to the
    // spring and finishes on its own. Remember which edge owns it so a scroll
    // in the opposite direction can re-attach even after the spring settles.
    const onScroll = () => {
      const current = window.scrollY;
      const height = topbarHeight || 150;
      const delta = current - lastScrollY;
      lastScrollY = current;

      if (current <= 4) {
        pulled = 0;
        committedTarget = "shown";
        topbarSpring.setTarget(0);
        return;
      }
      if (delta === 0) return;

      // Hysteresis biased toward commitment: snap shut once 15% is hidden,
      // snap open once 15% is revealed (i.e. less than 85% still hidden —
      // `pulled` counts hidden pixels). Between the two marks the bar just
      // follows the finger.
      const hideThreshold = height * 0.15;
      const showThreshold = height * 0.85;

      if (committedTarget) {
        const reversing =
          (committedTarget === "hidden" && delta < 0) || (committedTarget === "shown" && delta > 0);
        if (!reversing) return;

        topbarSpring.stop();
        pulled = Math.min(Math.max(topbarSpring.value, 0), height);
        committedTarget = null;
      }

      // Follow the finger exactly while between the two marks.
      pulled = Math.min(Math.max(pulled + delta, 0), height);
      topbarShift = pulled;

      // Hand off to the spring whenever the bar is past the mark in the
      // direction of travel. A level check, not an edge crossing, so a
      // re-attach that lands past the mark still commits instead of
      // stranding the bar on the finger. Note: settle() zeroes velocity,
      // so call it before setTarget().
      if (delta > 0 && pulled > hideThreshold) {
        committedTarget = "hidden";
        topbarSpring.settle(pulled);
        topbarSpring.setTarget(height);
      } else if (delta < 0 && pulled < showThreshold) {
        committedTarget = "shown";
        topbarSpring.settle(pulled);
        topbarSpring.setTarget(0);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    // Keep the page padding in sync with the real topbar height so the
    // first song is never hidden underneath it.
    const observer = new ResizeObserver(() => {
      topbarHeight = topbarEl?.offsetHeight ?? 0;
    });
    if (topbarEl) observer.observe(topbarEl);

    void refreshQueue();
    if (onlineStatus.online) void drainQueue();

    return () => {
      cancelled = true;
      stopOnline();
      unsubscribe();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("scroll", onScroll);
      topbarSpring.stop();
      observer.disconnect();
    };
  });

  $effect(() => {
    const stored = window.localStorage.getItem("songbook:query") ?? "";
    if (query !== stored) window.localStorage.setItem("songbook:query", query);
  });

  $effect(() => {
    const stored = (window.localStorage.getItem("songbook:sort") as SortKey | null) ?? "recentAdded";
    if (sortKey !== stored) window.localStorage.setItem("songbook:sort", sortKey);
  });

  // Drain the offline queue whenever authentication is (re)established.
  $effect(() => {
    if (auth.status === "authenticated" || auth.forceUpdateToken > 0) void drainQueue();
  });

  const visibleSongs = $derived(sortSongs(searchSongs(filterSongs(songs, filters), query), sortKey));

  // Briefly fade the list out and back in whenever the visible set changes
  // order or membership, instead of animating each card's position.
  const listSignature = $derived(visibleSongs.map((song) => song.id).join(","));
  let listFaded = $state(false);
  let lastSignature = "";
  $effect(() => {
    const signature = listSignature;
    if (!lastSignature) {
      lastSignature = signature;
      return;
    }
    if (signature === lastSignature) return;
    lastSignature = signature;
    listFaded = true;
    const settle = window.setTimeout(() => {
      listFaded = false;
    }, 90);
    return () => window.clearTimeout(settle);
  });
  const countries = $derived([...new Set(songs.map((song) => song.country).filter(Boolean))]);
  const genres = $derived([...new Set(songs.flatMap((song) => song.genres))]);

  interface ActiveFilter {
    key: keyof SongFilters | `performer:${PerformerId}`;
    label: string;
  }

  const activeFilters = $derived.by((): ActiveFilter[] => {
    const list: Array<ActiveFilter | null> = [
      filters.country ? { key: "country", label: filters.country } : null,
      filters.genre ? { key: "genre", label: filters.genre } : null,
      ...(filters.performerIds ?? []).map((id) => ({ key: `performer:${id}` as const, label: `부를 사람: ${performers[id].displayName}` })),
      filters.hasKey ? { key: "hasKey", label: "추천 키 있음" } : null,
      filters.favorite ? { key: "favorite", label: "즐겨찾기" } : null,
      filters.practicing ? { key: "practicing", label: "연습 중" } : null
    ];
    return list.filter(Boolean) as ActiveFilter[];
  });

  const quickFilters: Array<{ key: PerformerId | "favorite" | "practicing"; label: string }> = [
    { key: "marie", label: "마리" },
    { key: "seongwook", label: "성욱" },
    { key: "yeowool", label: "여울" },
    { key: "favorite", label: "즐겨찾기" },
    { key: "practicing", label: "연습 중" }
  ];

  async function refreshQueue() {
    const [items, counts] = await Promise.all([queueItems(), queueCounts()]);
    queueList = items;
    queueCountsState = counts;
  }

  async function drainQueue() {
    await drainOfflineQueue(auth.user ? { auth, onChange: () => void refreshQueue() } : { onChange: () => void refreshQueue() });
    await refreshQueue();
  }

  async function retryQueuedItem(id: string) {
    await retryQueueItem(id);
    await drainQueue();
    snackbar.show("동기화를 다시 시도할게요.");
  }

  async function discardQueuedItem(id: string) {
    await discardQueueItem(id);
    await refreshQueue();
    snackbar.show("실패한 기록을 버렸어요.");
  }

  const queueTotal = $derived(
    queueCountsState.pending + queueCountsState.inFlight + queueCountsState.failed + queueCountsState.deadLetter
  );

  function scheduleUndoExpiry() {
    if (undoTimer !== undefined) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      lastPerformed = null;
    }, 8000);
  }

  async function performSong(song: Song, clientRequestId: string, performedAt: string) {
    const result = await createPerformance(song.id, clientRequestId, performedAt);
    const performanceId = result && typeof result === "object" && "id" in result ? String(result.id) : "";
    lastPerformed = performanceId ? { performanceId, clientRequestId, songId: song.id } : null;
    if (performanceId) {
      scheduleUndoExpiry();
      snackbar.show("오늘 부른 곡으로 기록했어요.", {
        action: { label: "취소", run: () => undoLastPerformance() }
      });
    } else {
      snackbar.show("오늘 부른 곡으로 기록했어요.");
    }
  }

  async function markPerformed(song: Song) {
    selected = null;
    const clientRequestId = crypto.randomUUID();
    const performedAt = new Date().toISOString();
    songs = songs.map((item) =>
      item.id === song.id
        ? { ...item, performanceCount: item.performanceCount + 1, lastPerformedAt: new Date().toISOString() }
        : item
    );

    if (!onlineStatus.online) {
      await enqueuePerformanceCreate(song.id, clientRequestId, performedAt);
      snackbar.show("오프라인이라 큐에 저장했어요. 온라인 복귀 후 자동 동기화돼요.");
      return;
    }

    try {
      await auth.requireValidCredential();
      await performSong(song, clientRequestId, performedAt);
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        songs = songs.map((item) =>
          item.id === song.id
            ? { ...item, performanceCount: Math.max(0, (item.performanceCount ?? 0) - 1) }
            : item
        );
        await enqueuePerformanceCreate(song.id, clientRequestId, performedAt);
        snackbar.show("기록하려면 Google 로그인이 필요해요.");
        return;
      }
      await enqueuePerformanceCreate(song.id, clientRequestId, performedAt);
      await markQueueItemFailed(clientRequestId, error, classifyQueueError(error));
      snackbar.show("기록에 실패해서 큐에 저장했어요.");
    }
  }

  async function undoLastPerformance() {
    const target = lastPerformed;
    if (!target) {
      snackbar.show("취소할 기록이 없어요.");
      return;
    }
    lastPerformed = null;
    if (undoTimer !== undefined) clearTimeout(undoTimer);
    songs = songs.map((item) =>
      item.id === target.songId
        ? { ...item, performanceCount: Math.max(0, (item.performanceCount ?? 0) - 1), lastPerformedAt: "" }
        : item
    );
    const cancellationRequestId = crypto.randomUUID();
    if (!onlineStatus.online) {
      await enqueuePerformanceCancel(target.songId, target.performanceId, cancellationRequestId);
      snackbar.show("오프라인이라 취소는 큐에 저장했어요.");
      return;
    }
    try {
      await auth.requireValidCredential();
      const result = await cancelPerformanceOrQueue(target.songId, target.performanceId, cancellationRequestId);
      snackbar.show(result.queued ? "취소에 실패해서 큐에 저장했어요." : "방금 기록한 곡을 취소했어요.");
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        const queued = await enqueuePerformanceCancel(target.songId, target.performanceId, cancellationRequestId);
        await markQueueItemFailed(queued.id, new Error("로그인 후 다시 시도할 수 있어요."), "auth");
        snackbar.show("취소하려면 Google 로그인이 필요해요.");
        return;
      }
      snackbar.show(error instanceof Error ? error.message : "취소에 실패했어요.");
    }
  }

  async function loginWithGoogle() {
    try {
      await auth.loginWithGoogleButton();
      snackbar.show("로그인됐어요.");
    } catch (error) {
      snackbar.show(error instanceof Error ? error.message : "로그인하지 못했어요.");
    }
  }

  function onAccountClick() {
    if (!auth.user) {
      void loginWithGoogle();
      return;
    }
    if (!confirmSignOut) {
      confirmSignOut = true;
      setTimeout(() => {
        confirmSignOut = false;
      }, 3000);
      return;
    }
    confirmSignOut = false;
    auth.signOut();
    snackbar.show("로그아웃했어요.");
  }

  function openManagement(tab: AdminTab, song: Song | null = null) {
    editingSong = tab === "add" ? song : null;
    const next = new URL(page.url);
    next.searchParams.set("tab", tab);
    void goto(next, { noScroll: true, keepFocus: true });
  }

  function closeManagement() {
    editingSong = null;
    const next = new URL(page.url);
    next.searchParams.delete("tab");
    void goto(next, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function onSongSaved(saved: Song) {
    songs = songs.some((song) => song.id === saved.id)
      ? songs.map((song) => (song.id === saved.id ? saved : song))
      : [saved, ...songs];
    catalogVersion += 1;
  }

  function onSongDeleted(deletedId: string) {
    songs = songs.filter((song) => song.id !== deletedId);
    if (selected?.id === deletedId) selected = null;
    if (editingSong?.id === deletedId) closeManagement();
    catalogVersion += 1;
  }

  function togglePerformerFilter(id: PerformerId) {
    const current = filters.performerIds ?? [];
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    filters = { ...filters, performerIds: next.length ? next : undefined };
  }

  function toggleBooleanFilter(key: "hasKey" | "favorite" | "practicing") {
    filters = { ...filters, [key]: filters[key] ? undefined : true };
  }

  function selectSingleFilter(key: "country" | "genre", value: string) {
    filters = { ...filters, [key]: value || undefined };
  }

  function removeFilter(key: ActiveFilter["key"]) {
    if (key.startsWith("performer:")) {
      const id = key.replace("performer:", "") as PerformerId;
      togglePerformerFilter(id);
      return;
    }
    filters = { ...filters, [key]: undefined };
  }

  function handleFavorite(song: Song) {
    snackbar.show(
      song.status === "favorite" ? "즐겨찾기 해제는 곡 수정에서 할 수 있어요." : "즐겨찾기는 곡 수정에서 추가할 수 있어요."
    );
  }

  function managementTitle(tab: AdminTab): string {
    if (tab === "songs") return "곡 관리";
    return editingSong ? "곡 수정" : "곡 추가";
  }
</script>

<main class="app-frame" style:padding-top={topbarHeight ? `calc(${topbarHeight}px + env(safe-area-inset-top, 0px))` : undefined}>
  <header
    class="topbar"
    bind:this={topbarEl}
    style:transform={`translate(-50%, -${topbarShift}px)`}
  >
    <div class="topline">
      <h1 class="brand-title">Songbook</h1>
      <button
        type="button"
        class="account-button"
        data-authenticated={auth.user ? "true" : undefined}
        data-confirm={confirmSignOut ? "true" : undefined}
        onclick={onAccountClick}
      >
        {#if auth.user}
          <LogOut size={16} />
          {confirmSignOut ? "한 번 더 누르면 로그아웃" : auth.user.displayName}
        {:else}
          <LogIn size={16} />
          로그인
        {/if}
      </button>
    </div>
    <label class="search-box">
      <Search size={18} />
      <input bind:value={query} placeholder="곡명, 가수, TJ 번호 검색" />
      {#if query}
        <button type="button" class="search-clear" aria-label="검색어 지우기" onclick={() => (query = "")}>
          <X size={16} />
        </button>
      {/if}
    </label>
    <div class="controls-bar">
      <label class="sort-select">
        <SlidersHorizontal size={15} />
        <select bind:value={sortKey}>
          <option value="title">가나다순</option>
          <option value="tjNumber">TJ 번호순</option>
          <option value="recentAdded">최근 추가순</option>
          <option value="recentUpdated">최근 수정순</option>
          <option value="recentPerformed">최근 부른 순</option>
          <option value="performanceCount">많이 부른 순</option>
        </select>
      </label>
      <div class="controls-bar-scroll" class:chips-expanded={chipsExpanded} role="group" aria-label="필터">
        {#each quickFilters as filter (filter.key)}
          {@const pressed =
            filter.key === "favorite" || filter.key === "practicing"
              ? Boolean(filters[filter.key])
              : Boolean(filters.performerIds?.includes(filter.key))}
          <button
            type="button"
            class="chip-toggle quick-chip"
            aria-pressed={pressed}
            data-selected={pressed ? "true" : undefined}
            onclick={() =>
              filter.key === "favorite" || filter.key === "practicing"
                ? toggleBooleanFilter(filter.key)
                : togglePerformerFilter(filter.key)}
          >
            {filter.label}
          </button>
        {/each}
        <button
          type="button"
          class="chip-toggle"
          aria-pressed={Boolean(filters.hasKey)}
          data-selected={filters.hasKey ? "true" : undefined}
          onclick={() => toggleBooleanFilter("hasKey")}
        >
          추천 키
        </button>
        {#each countries as country (country)}
          <button
            type="button"
            class="chip-toggle"
            aria-pressed={filters.country === country}
            data-selected={filters.country === country ? "true" : undefined}
            onclick={() => selectSingleFilter("country", filters.country === country ? "" : country)}
          >
            {country}
          </button>
        {/each}
        {#each genres as genre (genre)}
          <button
            type="button"
            class="chip-toggle"
            aria-pressed={filters.genre === genre}
            data-selected={filters.genre === genre ? "true" : undefined}
            onclick={() => selectSingleFilter("genre", filters.genre === genre ? "" : genre)}
          >
            {genre}
          </button>
          {/each}
      </div>
      <button
        type="button"
        class="chips-expand-button"
        aria-expanded={chipsExpanded}
        aria-label={chipsExpanded ? "필터 접기" : "필터 펼치기"}
        onclick={() => (chipsExpanded = !chipsExpanded)}
      >
        <ChevronDown size={17} />
      </button>
    </div>
    {#if activeFilters.length}
      <div class="active-filters" aria-label="활성 필터">
        {#each activeFilters as filter (filter.key)}
          <button type="button" onclick={() => removeFilter(filter.key)}>{filter.label} ×</button>
        {/each}
        <button type="button" class="clear-filters" onclick={() => (filters = {})}>모두 초기화</button>
      </div>
    {/if}
    <p class="result-count">{visibleSongs.length}곡</p>
  </header>

  {#if queueTotal}
    <section class="offline-queue-panel" aria-label="오프라인 동기화">
      <div class="offline-queue-heading">
        <strong>오프라인 동기화</strong>
        <span>
          {#if queueCountsState.pending + queueCountsState.inFlight > 0}
            대기 {queueCountsState.pending + queueCountsState.inFlight}개
          {/if}
          {#if queueCountsState.failed + queueCountsState.deadLetter > 0}
            · 확인 필요 {queueCountsState.failed + queueCountsState.deadLetter}개
          {/if}
        </span>
      </div>
      {#if queueCountsState.authPaused}
        <p class="hint">로그인하면 대기 중인 기록을 다시 동기화할 수 있어.</p>
      {/if}
      <ul class="offline-queue-list">
        {#each queueList as item (item.id)}
          <li>
            <span>
              {item.action === "performance:create" ? "부른 기록" : "취소 기록"} ·
              {item.status === "dead-letter"
                ? "동기화 실패"
                : item.status === "failed"
                  ? "재시도 대기"
                  : item.status === "in_flight"
                    ? "동기화 중"
                    : "대기 중"}
              {#if item.errorMessage}<small>{item.errorMessage}</small>{/if}
            </span>
            {#if item.status === "failed" || item.status === "dead-letter"}
              <span class="offline-queue-actions">
                <button type="button" aria-label="동기화 다시 시도" onclick={() => void retryQueuedItem(item.id)}>다시 시도</button>
                <button type="button" aria-label="실패한 기록 버리기" onclick={() => void discardQueuedItem(item.id)}>버리기</button>
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="song-list" class:list-faded={listFaded} aria-label="곡 목록">
    {#if visibleSongs.length > 0}
      {#each visibleSongs as song (song.id)}
        <SongCard {song} {query} onOpen={(next) => (selected = next)} onFavoriteClick={handleFavorite} />
      {/each}
    {:else}
      <div class="empty-state">
        {songs.length ? "검색 결과가 없어요." : "아직 캐시된 곡이 없어요. 한 번 온라인으로 동기화해주세요."}
      </div>
    {/if}
  </section>

  {#key catalogVersion}
    <TjOmnibar
      {query}
      enabled={Boolean(auth.user && onlineStatus.online)}
      {songs}
      requireCredential={auth.requireValidCredential.bind(auth)}
      onManualAdd={() => openManagement("add")}
      onOpenExisting={(song) => (selected = song)}
      {onSongSaved}
    />
  {/key}

  {#if selected}
    <BottomSheet title={selected.title} onClose={() => (selected = null)}>
      <SongDetail
        song={selected}
        user={auth.user}
        onPerformed={(song) => void markPerformed(song)}
        onEdit={(song) => {
          selected = null;
          openManagement("add", song);
        }}
      />
    </BottomSheet>
  {/if}

  {#if managementTab}
    <BottomSheet title={managementTitle(managementTab)} onClose={closeManagement}>
      {#if auth.user}
        <div class="admin-surface">
          {#if managementTab !== "add"}
            <nav class="admin-tabs" aria-label="관리 탭">
              <button type="button" aria-current={managementTab === "songs" ? "page" : undefined} onclick={() => openManagement("songs")}>곡 관리</button>
            </nav>
          {/if}
          <SongForm tab={managementTab} {songs} editSong={editingSong} {onSongSaved} {onSongDeleted} onRequestTab={(tab) => openManagement(tab)} onClose={closeManagement} />
        </div>
      {:else}
        <p class="hint">곡 관리는 로그인한 편집자만 사용할 수 있어요.</p>
        <button type="button" class="primary-button" onclick={() => void loginWithGoogle()}>
          <LogIn size={17} />
          Google로 로그인
        </button>
      {/if}
    </BottomSheet>
  {/if}
</main>

<Snackbar />
