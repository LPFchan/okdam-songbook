function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** The current local day, replaced when the date rolls over so day-relative labels re-render. */
class TodayStore {
  now = $state(new Date());

  start(): () => void {
    if (typeof window === "undefined") return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const current = new Date();
      if (dayKey(current) !== dayKey(this.now)) this.now = current;
    };
    const schedule = () => {
      const current = new Date();
      const midnight = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, midnight.getTime() - current.getTime() + 1000);
    };
    // Timers can stall while a phone is asleep; re-check when the app comes back.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }
}

export const today = new TodayStore();
