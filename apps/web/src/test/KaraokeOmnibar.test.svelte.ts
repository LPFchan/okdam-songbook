import { act, cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DamSongCandidate, TjSongCandidate } from "@songbook/shared";
import KaraokeOmnibar from "../lib/components/KaraokeOmnibar.svelte";
import { addDamSong, addTjSong, searchDamSongs, searchTjSongs } from "../lib/api";

vi.mock("../lib/api", () => ({
  addTjSong: vi.fn(),
  searchTjSongs: vi.fn(),
  addDamSong: vi.fn(),
  searchDamSongs: vi.fn()
}));

const candidate: TjSongCandidate = {
  tjNumber: "68058",
  title: "Pretender",
  artist: "Official髭男dism",
  lyricist: "",
  composer: "",
  sourceUrl: "https://www.tjmedia.com/song/accompaniment_search?searchTxt=68058"
};

const damCandidate: DamSongCandidate = {
  damNumber: "4415-89",
  title: "Pretender",
  artist: "Official髭男dism",
  titleYomi: "",
  artistYomi: "",
  sourceUrl: "https://www.clubdam.com/karaokesearch/songleaf.html?requestNo=4415-89"
};

function renderOmnibar(props: Partial<Parameters<typeof render>[1]> = {}) {
  return render(KaraokeOmnibar, {
    props: {
      query: "Pretender",
      enabled: true,
      songs: [],
      requireCredential: vi.fn().mockResolvedValue("auth.lost.plus:42"),
      onManualAdd: vi.fn(),
      onOpenExisting: vi.fn(),
      onSongSaved: vi.fn(),
      ...((props as { props?: object })?.props ?? {})
    }
  });
}

describe("KaraokeOmnibar", () => {
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
    render(KaraokeOmnibar, {
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
    const onOpenExisting = vi.fn();
    vi.mocked(addTjSong).mockResolvedValue({
      outcome: "created",
      song: { id: "song-1", title: "Pretender" },
      existing: null,
      duplicateKind: null,
      canRestore: false,
      canOpen: true
    } as never);
    render(KaraokeOmnibar, {
      props: {
        query: "Pretender",
        enabled: true,
        songs: [],
        requireCredential: vi.fn().mockResolvedValue("auth.lost.plus:42"),
        onManualAdd: vi.fn(),
        onOpenExisting,
        onSongSaved
      }
    });
    const button = await screen.findByRole("button", { name: "바로 추가" });
    await button.click();
    await waitFor(() => expect(addTjSong).toHaveBeenCalledTimes(1));
    expect(addTjSong).toHaveBeenCalledWith(candidate, expect.any(String), "auth.lost.plus:42");
    expect(onSongSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "song-1" }));
    // Adding is quiet: the song's sheet does not open.
    expect(onOpenExisting).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a sheet with the artist for a song not yet saved, and adds from it", async () => {
    const onOpenExisting = vi.fn();
    vi.mocked(addTjSong).mockResolvedValue({
      outcome: "created",
      song: { id: "song-1", title: "Pretender" },
      existing: null,
      duplicateKind: null,
      canRestore: false,
      canOpen: true
    } as never);
    renderOmnibar({ props: { onOpenExisting } } as never);
    (await screen.findByText("Pretender")).click();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Official髭男dism");
    expect(addTjSong).not.toHaveBeenCalled();
    (await screen.findByRole("button", { name: "Songbook에 추가" })).click();
    await waitFor(() => expect(addTjSong).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenExisting).not.toHaveBeenCalled();
  });

  it("searches DAM and links a DAM number to a saved song with the same name", async () => {
    vi.mocked(searchDamSongs).mockResolvedValue({
      query: "Pretender",
      searchType: "all",
      page: 1,
      pageSize: 15,
      hasMore: false,
      candidates: [damCandidate]
    });
    vi.mocked(addDamSong).mockResolvedValue({
      outcome: "linked",
      song: { id: "song-1", title: "Pretender", damNumber: "4415-89" },
      existing: null,
      duplicateKind: null,
      canRestore: false,
      canOpen: true
    } as never);
    const onSongSaved = vi.fn();
    const saved = { id: "song-1", title: "Pretender", artist: "Official髭男dism", tjNumber: "68058", damNumber: "", deletedAt: null };
    render(KaraokeOmnibar, {
      props: {
        system: "dam",
        query: "Pretender",
        enabled: true,
        songs: [saved as never],
        requireCredential: vi.fn().mockResolvedValue("auth.lost.plus:42"),
        onManualAdd: vi.fn(),
        onOpenExisting: vi.fn(),
        onSongSaved
      }
    });
    expect(await screen.findByText("DAM에서 더 찾기")).toBeInTheDocument();
    expect(await screen.findByText("4415-89")).toBeInTheDocument();
    expect(searchTjSongs).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "바로 추가" });
    await button.click();
    await waitFor(() => expect(addDamSong).toHaveBeenCalledWith(damCandidate, expect.any(String), "auth.lost.plus:42"));
    expect(onSongSaved).toHaveBeenCalledWith(expect.objectContaining({ damNumber: "4415-89" }));
  });
});
