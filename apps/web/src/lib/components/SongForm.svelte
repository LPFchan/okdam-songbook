<script lang="ts">
  import type { PerformerId, Song } from "@songbook/shared";
  import { can, performerOrder, performers } from "@songbook/shared";
  import { Pencil, Trash2, Wand2 } from "@lucide/svelte";
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
    return { title: "", artist: "", tjNumber: "", status: "active", country: "일본", performerIds: [] };
  }

  type KeyMode = "none" | "female" | "male";

  let draft = $state<Partial<Song>>(emptyDraft());
  let editingId = $state<string | null>(null);
  let deleteConfirm = $state(false);
  let deletePending = $state(false);
  let readingPending = $state(false);
  let keyMode = $state<KeyMode>("none");
  let keyOffset = $state(0);

  function loadKeyFromSong(song: Song | null) {
    const candidate = song?.keyCandidates.find((key) => key.isPrimary) ?? song?.keyCandidates[0];
    if (candidate) {
      keyMode = candidate.baseMode === "female" || candidate.baseMode === "male" ? candidate.baseMode : "none";
      keyOffset = candidate.offset;
    } else {
      keyMode = "none";
      keyOffset = 0;
    }
  }

  function clampOffset(value: number): number {
    return Math.min(12, Math.max(-12, Math.trunc(value)));
  }

  function syncKeyCandidate(mode: KeyMode) {
    const current = (draft.keyCandidates ?? []).filter((_, index) => index > 0);
    if (mode === "none" && keyOffset === 0) {
      draft = { ...draft, keyCandidates: [] };
      return;
    }
    const primary = {
      id: draft.keyCandidates?.[0]?.id ?? crypto.randomUUID(),
      baseMode: (mode === "none" ? "original" : mode) as "original" | "male" | "female",
      offset: keyOffset,
      label: "추천",
      memo: "",
      isPrimary: true
    };
    draft = { ...draft, keyCandidates: [primary, ...current] };
  }

  function setKeyMode(mode: KeyMode) {
    keyMode = mode;
    syncKeyCandidate(mode);
  }

  function adjustOffset(delta: number) {
    keyOffset = clampOffset(keyOffset + delta);
    syncKeyCandidate(keyMode);
  }

  function onOffsetInput(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    keyOffset = clampOffset(value);
    syncKeyCandidate(keyMode);
  }

  // Load an externally requested song into the form (detail-sheet edit, list edit).
  $effect(() => {
    if (editSong) {
      draft = { ...editSong };
      editingId = editSong.id;
      loadKeyFromSong(editSong);
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

  function resetDraft() {
    draft = emptyDraft();
    editingId = null;
    deleteConfirm = false;
    keyMode = "none";
    keyOffset = 0;
  }

  function startEdit(song: Song) {
    draft = { ...song };
    editingId = song.id;
    loadKeyFromSong(song);
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
          <input bind:value={draft.tjNumber} inputmode="numeric" placeholder="없으면 비워둬도 돼요" />
        </label>
        <label>
          국가
          <input bind:value={draft.country} />
        </label>
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
      <h3 class="form-section-title">키</h3>
      <div class="key-control">
        <div class="key-stepper" role="group" aria-label="키 조절">
          <button type="button" class="key-step-button" aria-label="반음 내리기" onclick={() => adjustOffset(-1)}>
            −
          </button>
          <input
            class="key-offset-input"
            type="number"
            inputmode="numeric"
            min="-12"
            max="12"
            aria-label="키 오프셋"
            value={keyOffset}
            oninput={onOffsetInput}
          />
          <button type="button" class="key-step-button" aria-label="반음 올리기" onclick={() => adjustOffset(1)}>
            +
          </button>
        </div>
        <div class="chip-toggle-group" role="group" aria-label="키 기준">
          <button type="button" class="chip-toggle" aria-pressed={keyMode === "male"} data-selected={keyMode === "male" ? "true" : undefined} onclick={() => setKeyMode(keyMode === "male" ? "none" : "male")}>
            남
          </button>
          <button type="button" class="chip-toggle" aria-pressed={keyMode === "female"} data-selected={keyMode === "female" ? "true" : undefined} onclick={() => setKeyMode(keyMode === "female" ? "none" : "female")}>
            여
          </button>
        </div>
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
    {#if !songs.length}<p class="hint">곡이 없어요.</p>{/if}
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
