<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { registerSW } from "virtual:pwa-register";
  import "../app.css";

  let { children }: { children: Snippet } = $props();

  let updateReady = $state(false);
  let applyUpdate = $state<(() => void) | null>(null);

  onMount(() => {
    const sw = registerSW({
      onNeedRefresh() {
        updateReady = true;
      }
    });
    applyUpdate = () => {
      void sw(true);
    };
  });
</script>

{@render children()}

{#if updateReady}
  <div class="update-toast" role="status">
    <span>새 버전이 있어요.</span>
    <button type="button" onclick={() => (applyUpdate ? applyUpdate() : window.location.reload())}>업데이트</button>
  </div>
{/if}
