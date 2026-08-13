import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleSongs, type TjSongCandidate } from "@songbook/shared";
import { TjOmnibarResults } from "../components/TjOmnibarResults";
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

describe("TjOmnibarResults", () => {
  beforeEach(() => {
    window.localStorage.clear();
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
    render(
      <TjOmnibarResults
        query="Pretender"
        enabled
        songs={[]}
        requireCredential={vi.fn().mockResolvedValue("credential")}
        onManualAdd={vi.fn()}
        onOpenExisting={vi.fn()}
        onSongSaved={vi.fn()}
        onMessage={vi.fn()}
      />
    );
    expect(searchTjSongs).not.toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)); });
    expect(searchTjSongs).not.toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    await waitFor(() => expect(searchTjSongs).toHaveBeenCalledWith(expect.objectContaining({ query: "Pretender" }), "credential"));
    expect(await screen.findByText("Official髭男dism")).toBeInTheDocument();
  });

  it("opens a matching saved song instead of adding it again", async () => {
    const existing = { ...sampleSongs[0]!, tjNumber: candidate.tjNumber, title: candidate.title, artist: candidate.artist };
    const onOpenExisting = vi.fn();
    render(
      <TjOmnibarResults
        query="68058"
        enabled
        songs={[existing]}
        requireCredential={vi.fn().mockResolvedValue("credential")}
        onManualAdd={vi.fn()}
        onOpenExisting={onOpenExisting}
        onSongSaved={vi.fn()}
        onMessage={vi.fn()}
      />
    );
    const button = await screen.findByRole("button", { name: "Songbook에서 열기" }, { timeout: 1500 });
    await userEvent.click(button);
    expect(addTjSong).not.toHaveBeenCalled();
    expect(onOpenExisting).toHaveBeenCalledWith(existing);
  });

  it("adds a new TJ candidate inline", async () => {
    const saved = { ...sampleSongs[0]!, id: "tj-new", tjNumber: candidate.tjNumber, title: candidate.title, artist: candidate.artist };
    vi.mocked(addTjSong).mockResolvedValue({ outcome: "created", song: saved, existing: null, duplicateKind: null, canRestore: false, canOpen: true });
    const onSongSaved = vi.fn();
    render(
      <TjOmnibarResults
        query="Pretender"
        enabled
        songs={[]}
        requireCredential={vi.fn().mockResolvedValue("credential")}
        onManualAdd={vi.fn()}
        onOpenExisting={vi.fn()}
        onSongSaved={onSongSaved}
        onMessage={vi.fn()}
      />
    );
    const button = await screen.findByRole("button", { name: "바로 추가" }, { timeout: 1500 });
    await userEvent.click(button);
    await waitFor(() => expect(onSongSaved).toHaveBeenCalledWith(saved));
  });
});
