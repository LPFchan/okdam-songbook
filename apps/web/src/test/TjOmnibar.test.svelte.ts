import { act, cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TjSongCandidate } from "@songbook/shared";
import TjOmnibar from "../lib/components/TjOmnibar.svelte";
import { addTjSong, searchTjSongs } from "../lib/api";

vi.mock("../lib/api", () => ({
  addTjSong: vi.fn(),
  searchTjSongs: vi.fn()
}));

const candidate: TjSongCandidate = {
  tjNumber: "68058",
  title: "Pretender",
  artist: "Official髭男dism",
  lyricist: "",
  composer: "",
  sourceUrl: "https://www.tjmedia.com/song/accompaniment_search?searchTxt=68058"
};

function renderOmnibar(props: Partial<Parameters<typeof render>[1]> = {}) {
  return render(TjOmnibar, {
    props: {
      query: "Pretender",
      enabled: true,
      songs: [],
      requireCredential: vi.fn().mockResolvedValue(undefined),
      onManualAdd: vi.fn(),
      onOpenExisting: vi.fn(),
      onSongSaved: vi.fn(),
      ...((props as { props?: object })?.props ?? {})
    }
  });
}

describe("TjOmnibar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchTjSongs).mockResolvedValue({
      query: "Pretender",
      searchType: "all",
      nation: "",
      page: 1,
      pageSize: 15,
      hasMore: false,
      candidates: [candidate],
      sourceUrl: candidate.sourceUrl
    });
  });

  afterEach(() => cleanup());

  it("waits for the debounce before searching TJ", async () => {
    renderOmnibar();
    expect(searchTjSongs).not.toHaveBeenCalled();
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    await waitFor(() => expect(searchTjSongs).toHaveBeenCalledTimes(1));
    await screen.findByText("Pretender");
  });

  it("renders TJ candidates with an add action", async () => {
    renderOmnibar();
    await screen.findByText("Pretender");
    expect(screen.getByText("68058")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "바로 추가" })).toBeInTheDocument();
  });

  it("hides the TJ section when TJ search is disabled", async () => {
    render(TjOmnibar, {
      props: {
        query: "Pretender",
        enabled: false,
        songs: [],
        requireCredential: vi.fn(),
        onManualAdd: vi.fn(),
        onOpenExisting: vi.fn(),
        onSongSaved: vi.fn()
      }
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(screen.queryByText(/TJ/)).not.toBeInTheDocument();
    expect(searchTjSongs).not.toHaveBeenCalled();
  });

  it("adds a candidate once and reports the saved song", async () => {
    const onSongSaved = vi.fn();
    vi.mocked(addTjSong).mockResolvedValue({
      outcome: "created",
      song: { id: "song-1", title: "Pretender" },
      existing: null,
      duplicateKind: null,
      canRestore: false,
      canOpen: true
    } as never);
    render(TjOmnibar, {
      props: {
        query: "Pretender",
        enabled: true,
        songs: [],
        requireCredential: vi.fn().mockResolvedValue(undefined),
        onManualAdd: vi.fn(),
        onOpenExisting: vi.fn(),
        onSongSaved
      }
    });
    const button = await screen.findByRole("button", { name: "바로 추가" });
    await button.click();
    await waitFor(() => expect(addTjSong).toHaveBeenCalledTimes(1));
    expect(onSongSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "song-1" }));
  });
});
