import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleSongs } from "@songbook/shared";
import { PublicPage } from "../routes/PublicPage";

const runnerStop = vi.fn();
const engineClear = vi.fn();

vi.mock("matter-js", () => ({
  Bodies: {
    rectangle: (x: number, y: number, width: number, height: number, options?: object) => ({
      angle: 0,
      angularVelocity: 0,
      position: { x, y },
      velocity: { x: 0, y: 0 },
      width,
      height,
      options
    })
  },
  Body: {
    setAngularVelocity: vi.fn(),
    setPosition: vi.fn((body, position) => {
      body.position = position;
    }),
    setVelocity: vi.fn((body, velocity) => {
      body.velocity = velocity;
    })
  },
  Composite: {
    add: vi.fn(),
    clear: vi.fn(),
    remove: vi.fn()
  },
  Engine: {
    clear: engineClear,
    create: () => ({ gravity: { y: 0 }, world: {} })
  },
  Events: {
    off: vi.fn(),
    on: vi.fn()
  },
  Mouse: {
    create: vi.fn(() => ({}))
  },
  MouseConstraint: {
    create: vi.fn(() => ({}))
  },
  Runner: {
    create: () => ({}),
    run: vi.fn(),
    stop: runnerStop
  }
}));

function renderPublic(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<PublicPage />} />
        <Route path="/admin" element={<PublicPage />} />
        <Route path="/other" element={<div>다른 화면</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("PublicPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // PublicPage unit tests run against the local mock data so we don't have
    // to mock the Apps Script fetch surface here.
    vi.stubEnv("VITE_ENABLE_MOCK_API", "true");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 844);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: HTMLElement) {
      if (this.matches("[data-physics-card]")) {
        const index = Array.from(document.querySelectorAll("[data-physics-card]")).indexOf(this);
        return { bottom: 210 + index * 92, height: 82, left: 16, right: 374, top: 128 + index * 92, width: 358, x: 16, y: 128 + index * 92, toJSON: () => ({}) };
      }
      return { bottom: 40, height: 40, left: 0, right: 100, top: 0, width: 100, x: 0, y: 0, toJSON: () => ({}) };
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    runnerStop.mockClear();
    engineClear.mockClear();
  });

  it("renders the search interface", async () => {
    renderPublic();
    expect(screen.getByPlaceholderText("Songbook과 TJ에서 곡명, 가수, 번호 검색")).toBeInTheDocument();
    expect(await screen.findByText("レーゾンデートル")).toBeInTheDocument();
  });

  it("enters physics mode by title double click and restores card styles", async () => {
    const user = userEvent.setup();
    renderPublic();
    await screen.findByText("レーゾンデートル");

    await user.click(screen.getByRole("button", { name: "Songbook" }));
    await user.click(screen.getByRole("button", { name: "Songbook" }));

    expect(await screen.findByRole("button", { name: "원상복구" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-physics-card]")).toHaveClass("song-card--physics"));

    await user.click(screen.getByRole("button", { name: "원상복구" }));
    await waitFor(() => expect(document.querySelector("[data-physics-card]")).not.toHaveAttribute("style"));
    expect(runnerStop).toHaveBeenCalled();
    expect(engineClear).toHaveBeenCalled();
  });

  it("does not open song detail while physics mode is active", async () => {
    const user = userEvent.setup();
    renderPublic();
    await screen.findByText("レーゾンデートル");

    await user.click(screen.getByRole("button", { name: "Songbook" }));
    await user.click(screen.getByRole("button", { name: "Songbook" }));
    await screen.findByRole("button", { name: "원상복구" });

    await user.click(screen.getByRole("button", { name: /28805/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a toast instead of physics mode for reduced motion users", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const user = userEvent.setup();
    renderPublic();
    await screen.findByText("レーゾンデートル");

    await user.click(screen.getByRole("button", { name: "Songbook" }));
    await user.click(screen.getByRole("button", { name: "Songbook" }));

    expect(await screen.findByText("움직임 줄이기 설정 때문에 physics mode는 실행하지 않았어.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "원상복구" })).not.toBeInTheDocument();
  });

  it("keeps checkbox labels aligned in the filter sheet", async () => {
    const user = userEvent.setup();
    renderPublic();
    await screen.findByText("レーゾンデートル");

    await user.click(screen.getByRole("button", { name: "필터" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("추천 키 있음")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\d+곡 보기/ })).toBeInTheDocument();
  });

  it("shows migrated ponya performers in detail without recommender memo", async () => {
    const user = userEvent.setup();
    const migrated = sampleSongs.find((song) => song.performerIds.includes("marie") && song.performerIds.includes("yeowool"));
    expect(migrated).toBeTruthy();
    renderPublic();
    await screen.findByText(migrated!.title);

    await user.click(screen.getByRole("button", { name: new RegExp(migrated!.title) }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("부를 사람")).toBeInTheDocument();
    expect(within(dialog).getByText("마리")).toBeInTheDocument();
    expect(within(dialog).getByText("여울")).toBeInTheDocument();
    expect(screen.queryByText(/추천인 뽀냐/)).not.toBeInTheDocument();
  });

  it("filters migrated ponya songs by Marie and Yeowool only", async () => {
    const user = userEvent.setup();
    const migrated = sampleSongs.find((song) => song.performerIds.includes("marie") && song.performerIds.includes("yeowool") && !song.performerIds.includes("seongwook"));
    expect(migrated).toBeTruthy();
    renderPublic();
    await screen.findByText(migrated!.title);

    await user.click(screen.getByRole("button", { name: "필터" }));
    await user.click(screen.getByRole("button", { name: "마리" }));
    expect(await screen.findByText(migrated!.title)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "마리" }));
    await user.click(screen.getByRole("button", { name: "여울" }));
    expect(await screen.findByText(migrated!.title)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "여울" }));
    await user.click(screen.getByRole("button", { name: "성욱" }));
    await waitFor(() => expect(screen.queryByText(migrated!.title)).not.toBeInTheDocument());
  });

  it("exposes quick filters as pressed chips", async () => {
    const user = userEvent.setup();
    renderPublic();
    await screen.findByText("レーゾンデートル");

    const quickFilters = screen.getByRole("group", { name: "빠른 필터" });
    const marie = within(quickFilters).getByRole("button", { name: "마리" });
    expect(marie).toHaveAttribute("aria-pressed", "false");
    await user.click(marie);
    expect(marie).toHaveAttribute("aria-pressed", "true");
  });

  it("opens legacy admin tab links in the unified page and drops settings", async () => {
    renderPublic("/admin?tab=songs");
    expect(await screen.findByRole("dialog", { name: "곡 관리" })).toBeInTheDocument();

    cleanup();
    renderPublic("/admin?tab=settings");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("contains focus and restores it when a sheet closes", async () => {
    const user = userEvent.setup();
    renderPublic();
    await screen.findByText("レーゾンデートル");
    const filterButton = screen.getByRole("button", { name: "필터" });
    await user.click(filterButton);
    expect(screen.getByRole("button", { name: "닫기" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(filterButton).toHaveFocus();
  });
});
