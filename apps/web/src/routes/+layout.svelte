<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { registerSW } from "virtual:pwa-register";
  import "../app.css";

  let { children }: { children: Snippet } = $props();

  let updateReady = $state(false);
  let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = $state(null);

  onMount(() => {
    const sw = registerSW({
      onNeedRefresh() {
        updateReady = true;
        updateServiceWorker = sw;
      }
    });
  });

  function applyUpdate() {
    if (updateServiceWorker) void updateServiceWorker(true);
    else window.location.reload();
  }
</script>

{@render children()}

{#if updateReady}
  <div class="update-toast" role="status">
    <span>새 버전이 있어.</span>
    <button type="button" onclick={applyUpdate}>업데이트</button>
  </div>
{/if}
