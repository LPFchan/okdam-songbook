<script lang="ts">
  import { snackbar } from "../snackbar.svelte";
</script>

{#if snackbar.current}
  <div class="snackbar" role="status">
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
