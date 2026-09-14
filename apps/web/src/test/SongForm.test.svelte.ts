import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SongForm from "../lib/components/SongForm.svelte";
import { auth } from "../lib/auth.svelte";
import * as api from "../lib/api";

describe("SongForm", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ENABLE_MOCK_API", "true");
    auth.user = null;
    auth.status = "anonymous";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
    auth.user = { subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "여울", role: "allowed", expiresAt: null };
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

  it("writes the primary key candidate from the key control", async () => {
    render(SongForm, {
      props: { tab: "add", songs: [], onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });

    const stepper = screen.getByRole("group", { name: "키 조절" });
    const offset = () => stepper.querySelector(".key-offset-display"); 

    // 원키: offset without a 남/여 mode
    await screen.getByRole("button", { name: "반음 내리기" }).click();
    expect(offset()?.textContent).toBe("-1");

    await screen.getByRole("button", { name: "반음 올리기" }).click();
    expect(offset()?.textContent).toBe("0");

    await screen.getByRole("button", { name: "여" }).click();
    await screen.getByRole("button", { name: "반음 올리기" }).click();
    await screen.getByRole("button", { name: "반음 올리기" }).click();
    expect(offset()?.textContent).toBe("+2");
    expect(screen.getByRole("button", { name: "여" })).toHaveAttribute("aria-pressed", "true");

    await screen.getByRole("button", { name: "여" }).click();
    expect(screen.getByRole("button", { name: "여" })).toHaveAttribute("aria-pressed", "false");
    // offset is kept, so the song stores 원키 +2
    expect(offset()?.textContent).toBe("+2");
  });

  it("binds a save to the subject that opened the draft", async () => {
    auth.user = { subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "여울", role: "allowed", expiresAt: null };
    auth.status = "authenticated";
    vi.spyOn(auth, "requireValidCredential").mockResolvedValue(auth.user);
    const saved = { id: "song-1", title: "노래", artist: "가수", version: 1 };
    const upsert = vi.spyOn(api, "upsertSong").mockResolvedValue(saved as never);

    render(SongForm, {
      props: { tab: "add", songs: [], onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });
    await fireEvent.input(screen.getByPlaceholderText("곡명"), { target: { value: "노래" } });
    await fireEvent.input(screen.getByPlaceholderText("아티스트"), { target: { value: "가수" } });
    await screen.getByRole("button", { name: "저장" }).click();

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(auth.requireValidCredential).toHaveBeenCalledWith("auth.lost.plus:42");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ title: "노래" }), expect.any(String), "auth.lost.plus:42");
  });

  it("clears a draft when the active subject changes", async () => {
    auth.user = { subject: "auth.lost.plus:42", email: "a@example.com", displayName: "여울", role: "allowed", expiresAt: null };
    auth.status = "authenticated";
    render(SongForm, {
      props: { tab: "add", songs: [], onSongSaved: () => {}, onSongDeleted: () => {}, onRequestTab: () => {}, onClose: () => {} }
    });
    const title = screen.getByPlaceholderText("곡명");
    await fireEvent.input(title, { target: { value: "A의 초안" } });
    expect(title).toHaveValue("A의 초안");

    await act(() => {
      auth.user = { subject: "auth.lost.plus:99", email: "b@example.com", displayName: "마리", role: "allowed", expiresAt: null };
    });

    await waitFor(() => expect(title).toHaveValue(""));
  });
});
