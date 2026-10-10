import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { songSchema, type PerformerId, type RecommendationGroup, type TjSongCandidate } from "@songbook/shared";
import Recommendations from "../lib/components/Recommendations.svelte";
import { fetchRecommendations } from "../lib/api";
import { db } from "../lib/db";
import { clearRecommendationFeeds } from "../lib/recommendationFeed.svelte";

vi.mock("../lib/api", () => ({
  fetchRecommendations: vi.fn(),
  addTjSong: vi.fn(),
  searchTjSongs: vi.fn(),
  addDamSong: vi.fn(),
  searchDamSongs: vi.fn()
}));

function candidate(tjNumber: string, title: string, artist: string): TjSongCandidate {
  return { tjNumber, title, artist, lyricist: "", composer: "", sourceUrl: "https://www.tjmedia.com/song/accompaniment_search" };
}

function group(name: string, songs: TjSongCandidate[], error: string | null = null): RecommendationGroup {
  return { name, songCount: 1, candidates: songs, error };
}

function stubBottomInView() {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
}

function props(performerIds: PerformerId[], overrides: Record<string, unknown> = {}) {
  return {
    system: "tj" as const,
    performerIds,
    visible: true,
    enabled: true,
    songs: [],
    requireCredential: vi.fn().mockResolvedValue("auth.lost.plus:42"),
    onOpenExisting: vi.fn(),
    onSongSaved: vi.fn(),
    ...overrides
  };
}

describe("Recommendations", () => {
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(fetchRecommendations).mockReset();
    await clearRecommendationFeeds();
  });

  it("lists each person's songs, hiding saved ones and songs another person already showed", async () => {
    vi.mocked(fetchRecommendations).mockResolvedValue({
      groups: [
        { name: "페퍼톤스", songCount: 6, candidates: [candidate("1", "Saved", "페퍼톤스"), candidate("2", "New Hit", "페퍼톤스")], error: null },
        { name: "Other Artist", songCount: 3, candidates: [candidate("2", "New Hit", "페퍼톤스")], error: null }
      ],
      hasMore: false
    });
    render(Recommendations, {
      props: props(["marie"], { songs: [songSchema.parse({ id: "s1", tjNumber: "1", title: "Saved", artist: "페퍼톤스" })] })
    });
    await waitFor(() => expect(screen.getByText("New Hit")).toBeTruthy());
    expect(fetchRecommendations).toHaveBeenCalledWith({ performerIds: ["marie"], system: "tj", exclude: [] });
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getAllByText("New Hit")).toHaveLength(1);
    expect(screen.queryByText("Other Artist")).toBeNull();
    expect(screen.getByText(/저장된 곡 6곡/u)).toBeTruthy();
  });

  it("hides an artist whose search failed and asks for it again", async () => {
    stubBottomInView();
    vi.mocked(fetchRecommendations)
      .mockResolvedValueOnce({ groups: [group("Flaky", [], "검색하지 못했어."), group("Steady", [candidate("1", "Steady Song", "Steady")])], hasMore: false })
      .mockResolvedValueOnce({ groups: [group("Flaky", [candidate("2", "Flaky Song", "Flaky")])], hasMore: false });
    render(Recommendations, { props: props(["eunhu"]) });
    await waitFor(() => expect(screen.getByText("Steady Song")).toBeTruthy());
    expect(screen.queryByText("검색하지 못했어.")).toBeNull();
    expect(screen.queryByText("Flaky")).toBeNull();
    await waitFor(() => expect(screen.getByText("Flaky Song")).toBeTruthy(), { timeout: 5_000 });
    expect(fetchRecommendations).toHaveBeenLastCalledWith({ performerIds: ["eunhu"], system: "tj", exclude: ["Steady"] });
  }, 10_000);

  it("retries a request that failed outright", async () => {
    vi.mocked(fetchRecommendations)
      .mockRejectedValueOnce(new Error("요청에 실패했어요."))
      .mockResolvedValueOnce({ groups: [group("Late", [candidate("3", "Late Song", "Late")])], hasMore: false });
    render(Recommendations, { props: props(["seongwook"]) });
    await waitFor(() => expect(screen.getByText("Late Song")).toBeTruthy(), { timeout: 5_000 });
    expect(screen.queryByText("다시 시도")).toBeNull();
  }, 10_000);

  it("asks again at once when 다시 시도 is pressed after retries run out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(fetchRecommendations)
      .mockRejectedValueOnce(new Error("1")).mockRejectedValueOnce(new Error("2")).mockRejectedValueOnce(new Error("3"))
      .mockRejectedValueOnce(new Error("4")).mockRejectedValueOnce(new Error("5"))
      .mockResolvedValueOnce({ groups: [group("Back", [candidate("6", "Back Song", "Back")])], hasMore: false });
    render(Recommendations, { props: props(["marie"]) });
    for (let i = 0; i < 6 && !screen.queryByText("다시 시도"); i += 1) await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchRecommendations).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
    screen.getByText("다시 시도").click();
    await waitFor(() => expect(screen.getByText("Back Song")).toBeTruthy());
  });

  it("stops loading a performer's pages once the filter moves on", async () => {
    stubBottomInView();
    vi.mocked(fetchRecommendations).mockImplementation(async ({ performerIds, exclude }) => ({
      groups: [group(`${performerIds[0]}-${exclude?.length ?? 0}`, [candidate(`${performerIds[0]}${exclude?.length ?? 0}`, "Song", "A")])],
      hasMore: true
    }));
    const view = render(Recommendations, { props: props(["marie"]) });
    await waitFor(() => expect(fetchRecommendations).toHaveBeenCalledTimes(1));
    await view.rerender(props(["eunhu"]));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const marieCalls = vi.mocked(fetchRecommendations).mock.calls.filter(([input]) => input.performerIds[0] === "marie");
    expect(marieCalls).toHaveLength(1);
  }, 10_000);

  it("keeps what it loaded while the session is re-checked", async () => {
    vi.mocked(fetchRecommendations).mockResolvedValue({ groups: [group("Kept", [candidate("4", "Kept Song", "Kept")])], hasMore: false });
    const view = render(Recommendations, { props: props(["yeowool"]) });
    await waitFor(() => expect(screen.getByText("Kept Song")).toBeTruthy());
    await view.rerender(props(["yeowool"], { enabled: false }));
    expect(screen.getByText("Kept Song")).toBeTruthy();
    await view.rerender(props(["yeowool"]));
    expect(screen.getByText("Kept Song")).toBeTruthy();
    expect(fetchRecommendations).toHaveBeenCalledTimes(1);
  });

  it("shows a day-old-or-newer saved feed without asking again", async () => {
    await db.recommendations.put({ key: "tj:marie", startedAt: Date.now() - 60_000, groups: [group("Stored", [candidate("5", "Stored Song", "Stored")])], hasMore: false });
    render(Recommendations, { props: props(["marie"]) });
    await waitFor(() => expect(screen.getByText("Stored Song")).toBeTruthy());
    expect(fetchRecommendations).not.toHaveBeenCalled();
  });

  it("shows the empty state when nobody has new songs", async () => {
    vi.mocked(fetchRecommendations).mockResolvedValue({ groups: [group("A", [])], hasMore: false });
    render(Recommendations, { props: props(["eunhu"]) });
    await waitFor(() => expect(screen.getByText("새로 찾은 곡이 없어요.")).toBeTruthy());
  });

  it("loads the next artists once the bottom of the section is near", async () => {
    stubBottomInView();
    vi.mocked(fetchRecommendations).mockImplementation(async ({ exclude }) => exclude?.length
      ? { groups: [group("Second", [candidate("20", "Later Song", "Second")])], hasMore: false }
      : { groups: [group("First", [candidate("10", "Early Song", "First")])], hasMore: true });
    render(Recommendations, { props: props(["seongwook"]) });
    await waitFor(() => expect(screen.getByText("Later Song")).toBeTruthy(), { timeout: 3_000 });
    expect(screen.getByText("Early Song")).toBeTruthy();
    expect(fetchRecommendations).toHaveBeenCalledWith({ performerIds: ["seongwook"], system: "tj", exclude: ["First"] });
  });
});
