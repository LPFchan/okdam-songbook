<script lang="ts">
  import { snackbar } from "../snackbar.svelte";

  // Drag horizontally to fling the toast away.
  let startX = 0;
  let deltaX = $state(0);
  let dragging = $state(false);

  function onPointerDown(event: PointerEvent) {
    dragging = true;
    startX = event.clientX;
    deltaX = 0;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    deltaX = event.clientX - startX;
  }

  function onPointerUp() {
    if (!dragging) return;
    if (Math.abs(deltaX) > 64) {
      snackbar.dismiss();
    }
    dragging = false;
    deltaX = 0;
  }
</script>

{#if snackbar.current}
  <div
    class="snackbar"
    class:snackbar-dragging={dragging}
    role="status"
    style:transform={dragging ? `translateX(calc(-50% + ${deltaX}px))` : undefined}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  >
    <span>{snackbar.current.message}</span>
    {#if snackbar.current.action}
      <button
        type="button"
        class="snackbar-action"
        onclick={() => {
          const action = snackbar.current?.action;
          snackbar.dismiss();
          if (action) void action.run();
        }}
      >
        {snackbar.current.action.label}
      </button>
    {/if}
  </div>
{/if}
