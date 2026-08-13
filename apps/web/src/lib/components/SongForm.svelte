<script lang="ts">
  import type { PerformerId, Song, TjSearchType, TjSongCandidate } from "@songbook/shared";
  import { can, performerOrder, performers } from "@songbook/shared";
  import { Search, SquarePlay, Wand2 } from "@lucide/svelte";
  import {
    addTjSong,
    analyzeYouTube,
    generateReading,
    lookupTjSong,
    restoreSong,
    searchTjSongs,
    upsertSong
  } from "../api";
  import { auth, handleAuthErrorMessage } from "../auth.svelte";
  import { snackbar } from "../snackbar.svelte";

  export type AdminTab = "add" | "songs" | "history";

  interface Props {
    tab: AdminTab;
    songs: Song[];
    editSong?: Song | null;
    onSongSaved(song: Song): void;
    onRequestTab(tab: AdminTab): void;
  }

  const { tab, songs, editSong = null, onSongSaved, onRequestTab }: Props = $props();

  function emptyDraft(): Partial<Song> {
    return { title: "", artist: "", tjNumber: "", status: "active", country: "일본", performerIds: [] };
  }

  let draft = $state<Partial<Song>>(emptyDraft());
  let editingId = $state<string | null>(null);
  let youtubeUrl = $state("");
  let tjLookupLoading = $state(false);
  let tjLookupMessage = $state("");
  let tjSearchQuery = $state("");
  let tjSearchType = $state<TjSearchType>("all");
  let tjSearchLoading = $state(false);
  let tjSearchMessage = $state("");
  let tjCandidates = $state<TjSongCandidate[]>([]);
  let tjAddPending = $state<Record<string, boolean>>({});
  const tjAddRequestIds = new Map<string, string>();
  let tjRestoreCandidate = $state<Song | null>(null);
  let tjRestorePending = $state(false);

  function tjCandidateKey(candidate: TjSongCandidate): string {
    return `${candidate.tjNumber}:${candidate.title}:${candidate.artist}`;
  }

  // Load an externally requested song into the form (detail-sheet edit, list edit).
  $effect(() => {
    if (editSong) {
      draft = { ...editSong };
      editingId = editSong.id;
    }
  });

  function messageOrAuth(error: unknown, fallback: string): string {
    return handleAuthErrorMessage(error) ?? (error instanceof Error ? error.message : fallback);
  }

  async function requireWriteCredential(): Promise<boolean> {
    try {
      await auth.requireValidCredential();
      return true;
    } catch (error) {
      snackbar.show(handleAuthErrorMessage(error) ?? "로그인이 필요해.");
      return false;
    }
  }

  async function lookupTjNumber() {
    const tjNumber = String(draft.tjNumber || "").replace(/\D/g, "");
    if (!tjNumber) {
      tjLookupMessage = "TJ 번호를 입력해줘.";
      return;
    }
    if (!(await requireWriteCredential())) return;
    tjLookupLoading = true;
    tjLookupMessage = "";
    try {
      const result = await lookupTjSong({ tjNumber, nation: "", pageSize: 15 });
      if (!result.candidate) {
        tjLookupMessage =
          result.candidates.length > 1
            ? "같은 번호의 결과가 여러 개라 직접 골라줘."
            : "TJ에서 해당 번호를 찾지 못했어. 아래 수동 입력을 계속 사용할 수 있어.";
        return;
      }
      const candidate = result.candidate;
      draft = {
        ...draft,
        tjNumber: candidate.tjNumber,
        title: draft.title?.trim() ? draft.title : candidate.title,
        artist: draft.artist?.trim() ? draft.artist : candidate.artist,
        sourceType: "tjmedia",
        sourceReference: candidate.sourceUrl
      };
      tjLookupMessage = "TJ 후보를 채웠어. 저장 전에 자유롭게 고쳐도 돼.";
    } catch (error) {
      tjLookupMessage = messageOrAuth(error, "TJ 조회에 실패했어. 수동 입력을 사용해줘.");
    } finally {
      tjLookupLoading = false;
    }
  }

  async function runTjSearch() {
    if (!tjSearchQuery.trim()) {
      tjSearchMessage = "검색어를 입력해줘.";
      return;
    }
    if (!(await requireWriteCredential())) return;
    tjSearchLoading = true;
    tjSearchMessage = "";
    try {
      const result = await searchTjSongs({ query: tjSearchQuery, searchType: tjSearchType, nation: "", page: 1, pageSize: 15 });
      tjCandidates = result.candidates;
      tjSearchMessage = result.candidates.length
        ? `${result.candidates.length}개 결과를 찾았어.`
        : "검색 결과가 없어. 수동 입력을 계속 사용할 수 있어.";
    } catch (error) {
      tjSearchMessage = messageOrAuth(error, "TJ 검색에 실패했어. 수동 입력을 사용해줘.");
      tjCandidates = [];
    } finally {
      tjSearchLoading = false;
    }
  }

  async function addTjCandidate(candidate: TjSongCandidate) {
    const key = tjCandidateKey(candidate);
    if (tjAddPending[key]) return;
    if (!(await requireWriteCredential())) return;
    let requestId = tjAddRequestIds.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      tjAddRequestIds.set(key, requestId);
    }
    tjAddPending = { ...tjAddPending, [key]: true };
    try {
      const result = await addTjSong(candidate, requestId);
      if (result.outcome === "created" && result.song) {
        const saved = result.song as Song;
        onSongSaved(saved);
        draft = saved;
        editingId = saved.id;
        snackbar.show("곡을 바로 추가했어. 필요하면 아래 폼에서 이어서 편집해줘.");
      } else if (result.existing) {
        const existing = result.existing as Song;
        draft = existing;
        editingId = existing.id;
        tjRestoreCandidate = result.outcome === "deleted" ? existing : null;
        snackbar.show(
          result.outcome === "deleted"
            ? "삭제된 같은 곡이 있어. 기존 곡을 열어 복구 여부를 확인해줘."
            : "같은 TJ 번호 또는 제목·아티스트의 곡이 이미 있어. 덮어쓰지 않았어."
        );
      }
    } catch (error) {
      snackbar.show(messageOrAuth(error, "곡 추가에 실패했어. 다시 눌러도 안전해."));
    } finally {
      tjAddPending = { ...tjAddPending, [key]: false };
    }
  }

  async function restoreTjCandidate() {
    if (!tjRestoreCandidate || tjRestorePending) return;
    if (!(await requireWriteCredential())) return;
    tjRestorePending = true;
    try {
      const restored = await restoreSong(tjRestoreCandidate.id, crypto.randomUUID());
      onSongSaved(restored);
      draft = restored;
      editingId = restored.id;
      tjRestoreCandidate = null;
      snackbar.show("기존 곡을 복구했어.");
    } catch (error) {
      snackbar.show(messageOrAuth(error, "곡 복구에 실패했어."));
    } finally {
      tjRestorePending = false;
    }
  }

  async function saveSong() {
    if (!auth.user || !can(auth.user.role, editingId ? "song:update" : "song:create")) return;
    if (!(await requireWriteCredential())) return;
    try {
      const saved = await upsertSong(draft, crypto.randomUUID());
      draft = saved;
      editingId = saved.id;
      onSongSaved(saved);
      snackbar.show("저장했어. 공개 목록에 바로 반영돼.");
    } catch (error) {
      snackbar.show(messageOrAuth(error, "저장에 실패했어."));
    }
  }

  async function fillReading() {
    if (!auth.user) return;
    if (!(await requireWriteCredential())) return;
    try {
      const reading = await generateReading({ title: draft.title ?? "", artist: draft.artist ?? "" });
      draft = { ...draft, ...reading };
      snackbar.show("독음 후보를 채웠어. 저장 전에 수정할 수 있어.");
    } catch (error) {
      snackbar.show(messageOrAuth(error, "독음 생성에 실패했어."));
    }
  }

  async function analyzeVideo() {
    if (!auth.user) return;
    if (!(await requireWriteCredential())) return;
    try {
      const result = await analyzeYouTube(youtubeUrl);
      draft = { ...draft, ...result };
      snackbar.show("YouTube 분석 후보를 불러왔어. 자동 저장은 하지 않았어.");
    } catch (error) {
      snackbar.show(messageOrAuth(error, "YouTube 분석에 실패했어."));
    }
  }

  function toggleDraftPerformer(id: PerformerId) {
    const current = draft.performerIds ?? [];
    draft = {
      ...draft,
      performerIds: current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    };
  }

  function resetDraft() {
    draft = emptyDraft();
    editingId = null;
  }

  function startEdit(song: Song) {
    draft = { ...song };
    editingId = song.id;
    onRequestTab("add");
  }

  function findDuplicate(candidate: TjSongCandidate): Song | undefined {
    return songs.find(
      (song) =>
        song.tjNumber === candidate.tjNumber ||
        (song.title.trim().toLocaleLowerCase() === candidate.title.trim().toLocaleLowerCase() &&
          song.artist.trim().toLocaleLowerCase() === candidate.artist.trim().toLocaleLowerCase())
    );
  }

  const canSave = $derived(Boolean(auth.user && can(auth.user.role, editingId ? "song:update" : "song:create")));
</script>

{#if tab === "add"}
  <section class="admin-panel admin-form-panel">
    <header class="panel-heading">
      <h2>{editingId ? "곡 수정" : "곡 추가"}</h2>
      <div class="panel-tools">
        <button type="button" class="secondary-button" disabled={!auth.user} onclick={() => void analyzeVideo()}>
          <SquarePlay size={17} />
          YouTube
        </button>
      </div>
    </header>
    <div class="inline-form">
      <input bind:value={youtubeUrl} placeholder="https://youtu.be/... 후보 가져오기" />
    </div>
    <section class="tj-tools" aria-label="TJ 검색">
      <div class="inline-form">
        <label class="tj-number-field">
          TJ 번호 자동 조회
          <input bind:value={draft.tjNumber} inputmode="numeric" />
        </label>
        <button type="button" class="secondary-button" disabled={!auth.user || tjLookupLoading} onclick={() => void lookupTjNumber()}>
          {tjLookupLoading ? "조회 중…" : "번호 조회"}
        </button>
      </div>
      {#if tjLookupMessage}<p class="hint">{tjLookupMessage}</p>{/if}
      <div class="inline-form">
        <input bind:value={tjSearchQuery} placeholder="TJ 곡명·가수 검색 (Unicode 가능)" />
        <select aria-label="TJ 검색 방식" bind:value={tjSearchType}>
          <option value="all">통합</option>
          <option value="title">곡명</option>
          <option value="artist">가수</option>
          <option value="number">번호</option>
        </select>
        <button type="button" class="secondary-button" disabled={!auth.user || tjSearchLoading} onclick={() => void runTjSearch()}>
          <Search size={17} />{tjSearchLoading ? "검색 중…" : "TJ 검색"}
        </button>
      </div>
      {#if tjSearchMessage}<p class="hint">{tjSearchMessage}</p>{/if}
      {#if tjRestoreCandidate}
        <div class="tj-restore-action">
          <span>삭제된 곡: {tjRestoreCandidate.title}</span>
          {#if auth.user?.role === "owner"}
            <button type="button" class="secondary-button" disabled={tjRestorePending} onclick={() => void restoreTjCandidate()}>
              {tjRestorePending ? "복구 중…" : "기존 곡 복구"}
            </button>
          {:else}
            <span class="hint">기존 곡을 열었어. 복구는 소유자만 할 수 있어.</span>
          {/if}
        </div>
      {/if}
      {#if tjCandidates.length}
        <div class="tj-results" aria-label="TJ 검색 결과">
          {#each tjCandidates as candidate (candidate.tjNumber)}
            {@const duplicate = findDuplicate(candidate)}
            <div class="tj-result-row">
              <span>{candidate.tjNumber}</span>
              <strong>{candidate.title}</strong>
              <small>{candidate.artist}</small>
              {#if duplicate}<em>{duplicate.status === "deleted" ? "삭제됨" : "이미 있음"}</em>{/if}
              <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">TJ 원본</a>
              <button
                type="button"
                class="secondary-button"
                disabled={Boolean(tjAddPending[tjCandidateKey(candidate)])}
                onclick={() => void addTjCandidate(candidate)}
              >
                {tjAddPending[tjCandidateKey(candidate)] ? "추가 중…" : duplicate ? "기존 곡 열기" : "바로 추가"}
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>
    <div class="form-grid">
      <label>
        TJ 번호
        <input bind:value={draft.tjNumber} />
      </label>
      <label>
        곡명
        <input required bind:value={draft.title} />
      </label>
      <label>
        곡명 독음
        <input bind:value={draft.titleReadingKo} />
      </label>
      <label>
        아티스트
        <input required bind:value={draft.artist} />
      </label>
      <label>
        아티스트 독음
        <input bind:value={draft.artistReadingKo} />
      </label>
      <label>
        국가
        <input bind:value={draft.country} />
      </label>
      <fieldset class="form-wide performer-fieldset">
        <legend>부를 사람</legend>
        <div class="chip-toggle-group">
          {#each performerOrder as id (id)}
            <button
              type="button"
              class="chip-toggle"
              aria-pressed={Boolean(draft.performerIds?.includes(id))}
              data-selected={draft.performerIds?.includes(id) ? "true" : undefined}
              onclick={() => toggleDraftPerformer(id)}
            >
              {performers[id].displayName}
            </button>
          {/each}
        </div>
        <p class="hint">기존 '뽀냐' 데이터는 마리 + 여울로 변환됨</p>
      </fieldset>
      <label class="form-wide">
        메모
        <textarea bind:value={draft.memo}></textarea>
      </label>
    </div>
    <div class="admin-action-bar">
      <button type="button" class="secondary-button" onclick={resetDraft}>취소</button>
      <span></span>
      <button type="button" class="secondary-button" disabled={!auth.user} onclick={() => void fillReading()}>
        <Wand2 size={18} />
        독음 생성
      </button>
      <button type="button" class="primary-button" disabled={!canSave} onclick={() => void saveSong()}>
        {editingId ? "수정 저장" : "저장"}
      </button>
    </div>
  </section>
{:else if tab === "songs"}
  <section class="admin-panel">
    <h2>곡 관리</h2>
    {#if !songs.length}<p class="hint">곡이 없어.</p>{/if}
    <div class="admin-song-list">
      {#each songs as song (song.id)}
        <button type="button" class="admin-song-row" onclick={() => startEdit(song)}>
          <span>{song.tjNumber || "번호 없음"}</span>
          <strong>{song.title}</strong>
          <small>{song.artist}</small>
        </button>
      {/each}
    </div>
  </section>
{:else}
  <section class="admin-panel">
    <h2>변경 이력</h2>
    <p class="hint">서버 측 변경 이력 뷰는 아직 준비 중이야. 지금은 최신 곡 스냅샷만 보여줘.</p>
    <pre class="history-pre">{JSON.stringify(songs.slice(0, 1), null, 2)}</pre>
  </section>
{/if}
