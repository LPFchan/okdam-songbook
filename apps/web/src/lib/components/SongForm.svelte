<script lang="ts">
  import type { KeyCandidate, PerformerId, Song } from "@songbook/shared";
  import { can, normalizePerformerIds, performerOrder, performers } from "@songbook/shared";
  import { Pencil, Plus, Trash2, Wand2, X } from "@lucide/svelte";
  import {
    deleteSong,
    generateReading,
    upsertSong
  } from "../api";
  import { auth, handleAuthErrorMessage } from "../auth.svelte";
  import { snackbar } from "../snackbar.svelte";

  export type AdminTab = "add" | "songs";

  interface Props {
    tab: AdminTab;
    songs: Song[];
    editSong?: Song | null;
    onSongSaved(song: Song): void;
    onSongDeleted(songId: string): void;
    onRequestTab(tab: AdminTab): void;
    onClose(): void;
    // When set (sheet usage), the form hands its action-row snippet to the
    // sheet's fixed footer so it stays clear of the scroll area's fade mask.
    // When unset, the action bar renders inline at the end of the form.
    registerActions?: (content: import("svelte").Snippet) => void;
  }

  const { tab, songs, editSong = null, onSongSaved, onSongDeleted, onRequestTab, onClose, registerActions }: Props = $props();

  function emptyDraft(): Partial<Song> {
    const performerIds = auth.user ? normalizePerformerIds([auth.user.displayName]).ids : [];
    return { title: "", artist: "", tjNumber: "", status: "active", country: "일본", performerIds };
  }

  const countryOptions = ["일본", "미국", "한국", "그 외"] as const;
  const primaryCountries: readonly string[] = countryOptions.slice(0, 3);

  let draft = $state<Partial<Song>>(emptyDraft());
  let editingId = $state<string | null>(null);
  let deleteConfirm = $state(false);
  let deletePending = $state(false);
  let readingPending = $state(false);

  function clampOffset(value: number): number {
    return Math.min(12, Math.max(-12, Math.trunc(value)));
  }

  function addKeyCandidate() {
    const current = draft.keyCandidates ?? [];
    const candidate: KeyCandidate = {
      id: crypto.randomUUID(),
      baseMode: "original",
      offset: 0,
      label: current.length ? "" : "추천",
      memo: "",
      isPrimary: current.length === 0
    };
    draft = { ...draft, keyCandidates: [...current, candidate] };
  }

  function updateKeyCandidate(id: string, patch: Partial<KeyCandidate>) {
    draft = {
      ...draft,
      keyCandidates: (draft.keyCandidates ?? []).map((candidate) => candidate.id === id ? { ...candidate, ...patch } : candidate)
    };
  }

  function adjustKeyOffset(candidate: KeyCandidate, delta: number) {
    updateKeyCandidate(candidate.id, { offset: clampOffset(candidate.offset + delta) });
  }

  function makePrimaryKey(id: string) {
    draft = {
      ...draft,
      keyCandidates: (draft.keyCandidates ?? []).map((candidate) => ({ ...candidate, isPrimary: candidate.id === id }))
    };
  }

  function removeKeyCandidate(id: string) {
    const current = draft.keyCandidates ?? [];
    const removed = current.find((candidate) => candidate.id === id);
    const remaining = current.filter((candidate) => candidate.id !== id);
    if (removed?.isPrimary && remaining.length) remaining[0] = { ...remaining[0]!, isPrimary: true };
    draft = { ...draft, keyCandidates: remaining };
  }

  function parseAliases(value: string): string[] {
    return Array.from(new Set(value.split(/\r?\n/).map((alias) => alias.trim()).filter(Boolean)));
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
      snackbar.show(handleAuthErrorMessage(error) ?? "로그인이 필요해요.");
      return false;
    }
  }

  async function saveSong() {
    if (!auth.user || !can(auth.user.role, editingId ? "song:update" : "song:create")) return;
    if (!(await requireWriteCredential())) return;
    try {
      const saved = await upsertSong(draft, crypto.randomUUID());
      onSongSaved(saved);
      resetDraft();
      onClose();
      snackbar.show("저장했어요.");
    } catch (error) {
      snackbar.show(messageOrAuth(error, "저장에 실패했어요."));
    }
  }

  async function deleteDraft() {
    if (!editingId || !auth.user || !can(auth.user.role, "song:delete")) return;
    if (!deleteConfirm) {
      deleteConfirm = true;
      setTimeout(() => {
        deleteConfirm = false;
      }, 4000);
      return;
    }
    if (deletePending) return;
    deleteConfirm = false;
    if (!(await requireWriteCredential())) return;
    deletePending = true;
    try {
      await deleteSong({ id: editingId, version: draft.version ?? 0 }, crypto.randomUUID());
      const title = draft.title || "곡";
      onSongDeleted(editingId);
      resetDraft();
      onClose();
      snackbar.show(`${title}을(를) 삭제했어요.`);
    } catch (error) {
      snackbar.show(messageOrAuth(error, "삭제에 실패했어요."));
    } finally {
      deletePending = false;
    }
  }

  async function fillReading() {
    if (!auth.user || readingPending) return;
    if (!(await requireWriteCredential())) return;
    readingPending = true;
    try {
      const reading = await generateReading({ title: draft.title ?? "", artist: draft.artist ?? "" });
      draft = { ...draft, ...reading };
      snackbar.show("독음 후보를 채웠어요. 저장 전에 수정할 수 있어요.");
    } catch (error) {
      snackbar.show(messageOrAuth(error, "독음 생성에 실패했어요."));
    } finally {
      readingPending = false;
    }
  }

  function toggleDraftPerformer(id: PerformerId) {
    const current = draft.performerIds ?? [];
    draft = {
      ...draft,
      performerIds: current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    };
  }

  function isDraftCountrySelected(country: (typeof countryOptions)[number]): boolean {
    if (country === "그 외") return Boolean(draft.country && !primaryCountries.includes(draft.country));
    return draft.country === country;
  }

  function resetDraft() {
    draft = emptyDraft();
    editingId = null;
    deleteConfirm = false;
  }

  function startEdit(song: Song) {
    draft = { ...song };
    editingId = song.id;
    onRequestTab("add");
  }

  const canSave = $derived(Boolean(auth.user && can(auth.user.role, editingId ? "song:update" : "song:create")));

  // Hoist the action row into the sheet's fixed footer. Runs from an effect
  // because calling it from a template expression mutates the sheet's state
  // during template evaluation, which Svelte forbids (state_unsafe_mutation).
  $effect(() => {
    if (tab === "add") registerActions?.(formActions);
  });
</script>

{#if tab === "add"}
  <section class="admin-panel admin-form-panel">
    <section class="form-section" aria-label="기본 정보">
      <h3 class="form-section-title">기본 정보</h3>
      <div class="form-grid">
        <label class="form-wide">
          곡명
          <input required bind:value={draft.title} placeholder="곡명" />
        </label>
        <label class="form-wide">
          아티스트
          <input required bind:value={draft.artist} placeholder="아티스트" />
        </label>
        <label>
          TJ 번호
          <input bind:value={draft.tjNumber} inputmode="numeric" placeholder="TJ 번호" />
        </label>
        <label>
          원작
          <input bind:value={draft.originalWork} placeholder="애니, 게임, 영화 등" />
        </label>
      </div>
    </section>
    <section class="form-section" aria-label="국가">
      <h3 class="form-section-title">국가</h3>
      <div class="chip-toggle-group">
        {#each countryOptions as country (country)}
          <button
            type="button"
            class="chip-toggle"
            aria-pressed={isDraftCountrySelected(country)}
            data-selected={isDraftCountrySelected(country) ? "true" : undefined}
            onclick={() => (draft = { ...draft, country })}
          >
            {country}
          </button>
        {/each}
      </div>
    </section>
    <section class="form-section" aria-label="독음">
      <div class="form-section-heading">
        <h3 class="form-section-title">독음</h3>
        <button type="button" class="ghost-button" disabled={!auth.user || readingPending || !(draft.title || draft.artist)} onclick={() => void fillReading()}>
          <Wand2 size={15} />
          {readingPending ? "생성 중…" : "자동 생성"}
        </button>
      </div>
      <div class="form-grid">
        <label>
          곡명 독음
          <input bind:value={draft.titleReadingKo} />
        </label>
        <label>
          아티스트 독음
          <input bind:value={draft.artistReadingKo} />
        </label>
        <label class="form-wide">
          로마자 곡명
          <input bind:value={draft.titleRomanized} placeholder="Kirari" />
        </label>
        <label>
          곡명 별칭
          <textarea
            value={(draft.titleAliases ?? []).join("\n")}
            oninput={(event) => (draft = { ...draft, titleAliases: parseAliases(event.currentTarget.value) })}
            placeholder="한 줄에 하나씩"
          ></textarea>
        </label>
        <label>
          아티스트 별칭
          <textarea
            value={(draft.artistAliases ?? []).join("\n")}
            oninput={(event) => (draft = { ...draft, artistAliases: parseAliases(event.currentTarget.value) })}
            placeholder="한 줄에 하나씩"
          ></textarea>
        </label>
      </div>
    </section>
    <section class="form-section" aria-label="부를 사람">
      <h3 class="form-section-title">부를 사람</h3>
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
    </section>

    <section class="form-section" aria-label="키">
      <div class="form-section-heading">
        <h3 class="form-section-title">추천 키</h3>
        <button type="button" class="ghost-button" onclick={addKeyCandidate}>
          <Plus size={15} /> 키 추가
        </button>
      </div>
      {#if draft.keyCandidates?.length}
        <div class="key-candidate-list">
          {#each draft.keyCandidates as candidate, index (candidate.id)}
            <fieldset class="key-candidate">
              <legend>키 {index + 1}</legend>
              <div class="key-candidate-heading">
                <button
                  type="button"
                  class="chip-toggle"
                  aria-pressed={candidate.isPrimary}
                  data-selected={candidate.isPrimary ? "true" : undefined}
                  onclick={() => makePrimaryKey(candidate.id)}
                >
                  {candidate.isPrimary ? "대표 키" : "대표로 지정"}
                </button>
                <button type="button" class="icon-button compact-icon-button" aria-label={`키 ${index + 1} 삭제`} onclick={() => removeKeyCandidate(candidate.id)}>
                  <X size={16} />
                </button>
              </div>
              <div class="chip-toggle-group" role="group" aria-label={`키 ${index + 1} 기준`}>
                {#each [["original", "원곡"], ["male", "남"], ["female", "여"], ["custom", "직접"]] as [mode, label]}
                  <button
                    type="button"
                    class="chip-toggle"
                    aria-pressed={candidate.baseMode === mode}
                    data-selected={candidate.baseMode === mode ? "true" : undefined}
                    onclick={() => updateKeyCandidate(candidate.id, { baseMode: mode as KeyCandidate["baseMode"] })}
                  >{label}</button>
                {/each}
              </div>
              <div class="key-control">
                <div class="key-stepper" role="group" aria-label={`키 ${index + 1} 조절`}>
                  <button type="button" class="key-step-button" aria-label={`키 ${index + 1} 반음 내리기`} onclick={() => adjustKeyOffset(candidate, -1)}>−</button>
                  <span class="key-offset-display" aria-live="polite">{candidate.offset > 0 ? "+" + candidate.offset : candidate.offset}</span>
                  <button type="button" class="key-step-button" aria-label={`키 ${index + 1} 반음 올리기`} onclick={() => adjustKeyOffset(candidate, 1)}>+</button>
                </div>
              </div>
              <div class="form-grid">
                <label>
                  이름
                  <input value={candidate.label} maxlength="40" placeholder="추천, 마리용 등" oninput={(event) => updateKeyCandidate(candidate.id, { label: event.currentTarget.value })} />
                </label>
                <label>
                  키 메모
                  <input value={candidate.memo} maxlength="500" placeholder="후렴만 +1 등" oninput={(event) => updateKeyCandidate(candidate.id, { memo: event.currentTarget.value })} />
                </label>
              </div>
            </fieldset>
          {/each}
        </div>
      {:else}
        <p class="form-empty-note">추천 키가 없어요.</p>
      {/if}
    </section>
    <section class="form-section" aria-label="영상">
      <h3 class="form-section-title">영상</h3>
      <div class="form-grid">
        <label class="form-wide">
          YouTube URL
          <input type="url" bind:value={draft.youtubeUrl} placeholder="https://www.youtube.com/watch?v=…" />
        </label>
      </div>
    </section>
    <section class="form-section" aria-label="상태">
      <h3 class="form-section-title">상태</h3>
      <div class="chip-toggle-group">
        <button type="button" class="chip-toggle" aria-pressed={draft.status === "active"} data-selected={draft.status === "active" ? "true" : undefined} onclick={() => (draft = { ...draft, status: "active" })}>활성</button>
        <button type="button" class="chip-toggle" aria-pressed={draft.status === "hold"} data-selected={draft.status === "hold" ? "true" : undefined} onclick={() => (draft = { ...draft, status: "hold" })}>보류</button>
      </div>
    </section>
    <section class="form-section" aria-label="메모">
      <h3 class="form-section-title">메모</h3>
      <textarea bind:value={draft.memo} placeholder="주의할 점 등"></textarea>
    </section>
    {#if !registerActions}
      <div class="admin-action-bar">
        {@render formActions()}
      </div>
    {/if}
  </section>
{:else if tab === "songs"}
  <section class="admin-panel">
    <h2>곡 관리</h2>
    <div class="admin-song-list">
      {#each songs as song (song.id)}
        <button type="button" class="admin-song-row" onclick={() => startEdit(song)}>
          <span>{song.tjNumber || "번호 없음"}</span>
          <strong>{song.title}</strong>
          <small>{song.artist}</small>
          <Pencil size={15} class="admin-song-edit" aria-hidden="true" />
        </button>
      {/each}
    </div>
  </section>
{/if}

{#snippet formActions()}
  <button type="button" class="primary-button" disabled={!canSave} onclick={() => void saveSong()}>
    {editingId ? "수정 저장" : "저장"}
  </button>
  {#if editingId && can(auth.user?.role, "song:delete")}
    <button
      type="button"
      class="danger-button"
      data-confirm={deleteConfirm ? "true" : undefined}
      disabled={deletePending}
      onclick={() => void deleteDraft()}
    >
      <Trash2 size={17} />
      {deletePending ? "삭제 중…" : deleteConfirm ? "한 번 더 누르면 삭제" : "삭제"}
    </button>
  {/if}
{/snippet}
