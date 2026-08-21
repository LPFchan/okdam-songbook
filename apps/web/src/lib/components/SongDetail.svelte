<script lang="ts">
  import type { Song } from "@songbook/shared";
  import { can, formatPerformerNames, primaryKey, sortPerformerIds, performers } from "@songbook/shared";
  import { CalendarCheck, Edit3 } from "@lucide/svelte";
  import type { AuthUser } from "../auth.svelte";

  interface Props {
    song: Song;
    user: AuthUser | null;
    onPerformed(song: Song): void;
    onEdit(song: Song): void;
    // When set (sheet usage), the detail hands its action-row snippet to the
    // sheet's fixed footer so it stays clear of the scroll area's fade mask.
    registerActions?: (content: import("svelte").Snippet) => void;
  }

  const { song, user, onPerformed, onEdit, registerActions }: Props = $props();

  const performerIds = $derived(sortPerformerIds(song.performerIds));
  const canEdit = $derived(can(user?.role, "song:update"));
  const canPerform = $derived(can(user?.role, "performance:create"));

  function subjectParticle(name: string): string {
    const last = name.codePointAt(name.length - 1);
    if (last === undefined || last < 0xac00 || last > 0xd7a3) return "가";
    return (last - 0xac00) % 28 === 0 ? "가" : "이가";
  }

  // Hoist the action row into the sheet's fixed footer. Runs from an effect
  // because calling it from a template expression mutates the sheet's state
  // during template evaluation, which Svelte forbids (state_unsafe_mutation).
  $effect(() => {
    registerActions?.(detailActions);
  });
</script>

<div class="detail-grid">
  <div>
    <span class="detail-label">TJ 번호</span>
    <strong>{song.tjNumber || "없음"}</strong>
  </div>
  <div>
    <span class="detail-label">추천 키</span>
    <strong>{primaryKey(song) || "미입력"}</strong>
  </div>
  <div>
    <span class="detail-label">부를 사람</span>
    {#if performerIds.length}
      <div class="performer-chip-row" aria-label={formatPerformerNames(performerIds)}>
        {#each performerIds as id (id)}
          <span class="performer-chip">{performers[id].displayName}</span>
        {/each}
      </div>
    {:else}
      <span>미지정</span>
    {/if}
  </div>
  <div>
    <span class="detail-label">곡명 독음</span>
    <span>{song.titleReadingKo || "미입력"}</span>
  </div>
  <div>
    <span class="detail-label">아티스트 독음</span>
    <span>{song.artistReadingKo || "미입력"}</span>
  </div>
  <div>
    <span class="detail-label">원작</span>
    <span>{song.originalWork || "미입력"}</span>
  </div>
  <div class="detail-wide">
    <span class="detail-label">메모</span>
    <p>{song.memo || "메모 없음"}</p>
  </div>
  <div class="detail-wide">
    <span class="detail-label">최근 기록</span>
    <p>
      {#if song.lastPerformedAt}
        {#if song.lastPerformedByName}{song.lastPerformedByName}{subjectParticle(song.lastPerformedByName)} 최근 부름 · {:else}마지막 {/if}{new Date(song.lastPerformedAt).toLocaleString()} · 총 {song.performanceCount}회
      {:else}
        마지막 없음 · 총 {song.performanceCount}회
      {/if}
    </p>
  </div>
</div>

{#snippet detailActions()}
  {#if canPerform}
    <button type="button" class="primary-button" onclick={() => onPerformed(song)}>
      <CalendarCheck size={18} />
      오늘 불렀어요!
    </button>
  {/if}
  {#if canEdit}
    <button type="button" class="secondary-button" onclick={() => onEdit(song)}>
      <Edit3 size={18} />
      수정
    </button>
  {/if}
{/snippet}
