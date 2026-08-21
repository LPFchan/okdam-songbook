import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleSongs } from "@songbook/shared";
import SongForm from "../lib/components/SongForm.svelte";
import { auth } from "../lib/auth.svelte";

describe("SongForm", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ENABLE_MOCK_API", "true");
    auth.user = null;
    auth.status = "anonymous";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("offers performer toggles without a ponya option", async () => {
    render(SongForm, {
      props: { tab: "add", songs: [], onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });

    const marie = screen.getByRole("button", { name: "마리" });
    const yeowool = screen.getByRole("button", { name: "여울" });
    const seongwook = screen.getByRole("button", { name: "성욱" });
    expect(marie).toHaveAttribute("aria-pressed", "false");
    expect(yeowool).toHaveAttribute("aria-pressed", "false");
    expect(seongwook).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "뽀냐" })).not.toBeInTheDocument();

    await marie.click();
    await yeowool.click();
    expect(screen.getByRole("button", { name: "마리" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "여울" })).toHaveAttribute("aria-pressed", "true");
  });

  it("preselects the signed-in person for a new song", () => {
    auth.user = { email: "allowed@example.com", displayName: "여울", role: "allowed", expiresAt: null };
    auth.status = "authenticated";

    render(SongForm, {
      props: { tab: "add", songs: [], onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });

    expect(screen.getByRole("button", { name: "마리" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "여울" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "성욱" })).toHaveAttribute("aria-pressed", "false");
  });

  it("offers a single country choice as chips", async () => {
    render(SongForm, {
      props: { tab: "add", songs: [], onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });

    expect(screen.getByRole("button", { name: "일본" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "미국" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "한국" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "그 외" })).toHaveAttribute("aria-pressed", "false");

    await screen.getByRole("button", { name: "한국" }).click();
    expect(screen.getByRole("button", { name: "일본" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "한국" })).toHaveAttribute("aria-pressed", "true");
  });

  it("edits all catalog metadata fields", () => {
    const song = {
      ...sampleSongs[0]!,
      originalWork: "원작 이름",
      titleRomanized: "Romanized title",
      titleAliases: ["첫 별칭", "둘째 별칭"],
      artistAliases: ["가수 별칭"],
      youtubeUrl: "https://www.youtube.com/watch?v=abc123",
      status: "hold" as const
    };

    render(SongForm, {
      props: { tab: "add", songs: [song], editSong: song, onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });

    expect(screen.getByLabelText("원작")).toHaveValue("원작 이름");
    expect(screen.getByLabelText("로마자 곡명")).toHaveValue("Romanized title");
    expect(screen.getByLabelText("곡명 별칭")).toHaveValue("첫 별칭\n둘째 별칭");
    expect(screen.getByLabelText("아티스트 별칭")).toHaveValue("가수 별칭");
    expect(screen.getByLabelText("YouTube URL")).toHaveValue("https://www.youtube.com/watch?v=abc123");
    expect(screen.getByRole("button", { name: "보류" })).toHaveAttribute("aria-pressed", "true");
  });

  it("manages multiple detailed key candidates", async () => {
    render(SongForm, {
      props: { tab: "add", songs: [], onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });

    expect(screen.getByText("추천 키가 없어요.")).toBeInTheDocument();
    await screen.getByRole("button", { name: "키 추가" }).click();

    const stepper = screen.getByRole("group", { name: "키 1 조절" });
    const offset = () => stepper.querySelector(".key-offset-display"); 

    await screen.getByRole("button", { name: "키 1 반음 내리기" }).click();
    expect(offset()?.textContent).toBe("-1");

    await screen.getByRole("button", { name: "키 1 반음 올리기" }).click();
    expect(offset()?.textContent).toBe("0");

    await screen.getByRole("button", { name: "여" }).click();
    await screen.getByRole("button", { name: "키 1 반음 올리기" }).click();
    await screen.getByRole("button", { name: "키 1 반음 올리기" }).click();
    expect(offset()?.textContent).toBe("+2");
    expect(screen.getByRole("button", { name: "여" })).toHaveAttribute("aria-pressed", "true");

    await screen.getByRole("button", { name: "키 추가" }).click();
    expect(screen.getByRole("group", { name: "키 2 조절" })).toBeInTheDocument();
    await screen.getByRole("button", { name: "대표로 지정" }).click();
    expect(screen.getAllByRole("button", { name: "대표 키" })).toHaveLength(1);
  });
});
