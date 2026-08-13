import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
