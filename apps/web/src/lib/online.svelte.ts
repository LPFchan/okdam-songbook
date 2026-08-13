class OnlineStore {
  online = $state(true);

  start(): () => void {
    if (typeof window === "undefined") return () => {};
    this.online = navigator.onLine;
    const onOnline = () => {
      this.online = true;
    };
    const onOffline = () => {
      this.online = false;
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }
}

export const onlineStatus = new OnlineStore();
