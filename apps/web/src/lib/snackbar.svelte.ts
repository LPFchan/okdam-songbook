export interface SnackbarAction {
  label: string;
  run(): void | Promise<void>;
}

export interface SnackbarState {
  message: string;
  action: SnackbarAction | null;
}

const DEFAULT_TIMEOUT_MS = 4000;

class SnackbarStore {
  current = $state<SnackbarState | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Show a transient message. Auto-dismisses; never blocks interaction. */
  show(message: string, options: { action?: SnackbarAction | null } = {}) {
    this.clearTimer();
    this.current = { message, action: options.action ?? null };
    this.timer = setTimeout(() => this.dismiss(), DEFAULT_TIMEOUT_MS);
  }

  dismiss() {
    this.clearTimer();
    this.current = null;
  }

  private clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

export const snackbar = new SnackbarStore();
