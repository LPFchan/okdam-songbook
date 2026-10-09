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
      { name: "페퍼톤스", role: "artist", songCount: 6, candidates: [candidate("1", "Saved", "페퍼톤스"), candidate("2", "New Hit", "페퍼톤스")], error: null },
      { name: "신재평", role: "composer", songCount: 3, candidates: [candidate("2", "New Hit", "페퍼톤스")], error: null }
    ];
    vi.mocked(fetchRecommendations).mockResolvedValue(groups);
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
    expect(fetchRecommendations).toHaveBeenCalledWith({ performerIds: ["marie"], system: "tj" });
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getAllByText("New Hit")).toHaveLength(1);
    expect(screen.queryByText("신재평")).toBeNull();
    expect(screen.getByText(/가수 · 저장된 곡 6곡/u)).toBeTruthy();
  });
});
