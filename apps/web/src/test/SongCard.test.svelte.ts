import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleSongs } from "@songbook/shared";
import SongCard from "../lib/components/SongCard.svelte";

const song = sampleSongs[0]!;

describe("SongCard", () => {
  afterEach(() => cleanup());

  it("renders the TJ number, title, and artist", () => {
    render(SongCard, {
      props: { song, query: "", favorite: false, onOpen: vi.fn(), onFavoriteClick: vi.fn() }
    });
    expect(screen.getByText(song.title)).toBeInTheDocument();
    expect(screen.getByText(song.artist)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(song.tjNumber || "----"))).toBeInTheDocument();
  });

  it("opens the detail view when activated", async () => {
    const onOpen = vi.fn();
    render(SongCard, {
      props: { song, query: "", favorite: false, onOpen, onFavoriteClick: vi.fn() }
    });
    await screen.getByRole("button", { name: new RegExp(song.title) }).click();
    expect(onOpen).toHaveBeenCalledWith(song);
  });

  it("marks search matches", () => {
    render(SongCard, {
      props: { song, query: song.title.slice(0, 2), favorite: false, onOpen: vi.fn(), onFavoriteClick: vi.fn() }
    });
    const marks = document.querySelectorAll("mark.hit");
    expect(marks.length).toBeGreaterThan(0);
  });

  it("renders personal favorite state and toggles it directly", async () => {
    const onFavoriteClick = vi.fn();
    render(SongCard, {
      props: { song, query: "", favorite: true, onOpen: vi.fn(), onFavoriteClick }
    });
    const heart = screen.getByRole("button", { name: "즐겨찾기에서 제거" });
    expect(heart).toHaveAttribute("aria-pressed", "true");
    await heart.click();
    expect(onFavoriteClick).toHaveBeenCalledWith(song);
  });
});
