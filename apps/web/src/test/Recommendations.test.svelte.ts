import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { songSchema, type RecommendationGroup, type TjSongCandidate } from "@songbook/shared";
import Recommendations from "../lib/components/Recommendations.svelte";
import { fetchRecommendations } from "../lib/api";

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

describe("Recommendations", () => {
  afterEach(() => cleanup());

  it("lists each person's songs, hiding saved ones and songs another person already showed", async () => {
    const groups: RecommendationGroup[] = [
      { name: "페퍼톤스", songCount: 6, candidates: [candidate("1", "Saved", "페퍼톤스"), candidate("2", "New Hit", "페퍼톤스")], error: null },
      { name: "Other Artist", songCount: 3, candidates: [candidate("2", "New Hit", "페퍼톤스")], error: null }
    ];
    vi.mocked(fetchRecommendations).mockResolvedValue({ groups, hasMore: false });
    render(Recommendations, {
      props: {
        system: "tj",
        performerIds: ["marie"],
        enabled: true,
        songs: [songSchema.parse({ id: "s1", tjNumber: "1", title: "Saved", artist: "페퍼톤스" })],
        requireCredential: vi.fn().mockResolvedValue("auth.lost.plus:42"),
        onOpenExisting: vi.fn(),
        onSongSaved: vi.fn()
      }
    });
    await waitFor(() => expect(screen.getByText("New Hit")).toBeTruthy());
    expect(fetchRecommendations).toHaveBeenCalledWith({ performerIds: ["marie"], system: "tj", exclude: [] });
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getAllByText("New Hit")).toHaveLength(1);
    expect(screen.queryByText("Other Artist")).toBeNull();
    expect(screen.getByText(/저장된 곡 6곡/u)).toBeTruthy();
  });

  it("shows the empty state for no people and refetches answers that held errors", async () => {
    const props = {
      system: "dam" as const,
      performerIds: ["eunhu" as const],
      enabled: true,
      songs: [],
      requireCredential: vi.fn().mockResolvedValue("auth.lost.plus:42"),
      onOpenExisting: vi.fn(),
      onSongSaved: vi.fn()
    };
    vi.mocked(fetchRecommendations).mockReset().mockResolvedValue({ groups: [{ name: "A", songCount: 1, candidates: [], error: "검색하지 못했어." }], hasMore: false });
    render(Recommendations, { props });
    await waitFor(() => expect(screen.getByText("검색하지 못했어.")).toBeTruthy());
    cleanup();
    vi.mocked(fetchRecommendations).mockResolvedValue({ groups: [], hasMore: false });
    render(Recommendations, { props });
    await waitFor(() => expect(screen.getByText("새로 찾은 곡이 없어요.")).toBeTruthy());
    expect(fetchRecommendations).toHaveBeenCalledTimes(2);
  });

  it("loads the next artists once the bottom of the section is in view", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.callback([{ isIntersecting: true }]); }
      disconnect() {}
    });
    vi.mocked(fetchRecommendations).mockReset().mockImplementation(async ({ exclude }) => exclude?.length
      ? { groups: [{ name: "Second", songCount: 1, candidates: [candidate("20", "Later Song", "Second")], error: null }], hasMore: false }
      : { groups: [{ name: "First", songCount: 2, candidates: [candidate("10", "Early Song", "First")], error: null }], hasMore: true });
    render(Recommendations, {
      props: {
        system: "tj",
        performerIds: ["seongwook"],
        enabled: true,
        songs: [],
        requireCredential: vi.fn().mockResolvedValue("auth.lost.plus:42"),
        onOpenExisting: vi.fn(),
        onSongSaved: vi.fn()
      }
    });
    await waitFor(() => expect(screen.getByText("Later Song")).toBeTruthy());
    expect(screen.getByText("Early Song")).toBeTruthy();
    expect(fetchRecommendations).toHaveBeenCalledWith({ performerIds: ["seongwook"], system: "tj", exclude: ["First"] });
    vi.unstubAllGlobals();
  });
});
