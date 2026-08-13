import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { Image, ListMusic, LogIn, Search, Wand2, Youtube } from "lucide-react";
import type { PerformerId, Song, TjSearchType, TjSongCandidate } from "@songbook/shared";
import { can, performerOrder, performers, sampleSongs } from "@songbook/shared";
import { addTjSong, analyzeYouTube, fetchPublicData, generateReading, isApiAuthError, lookupTjSong, mockMode, restoreSong, searchTjSongs, upsertSong } from "../lib/api";
import { useAuth, AuthRequiredError } from "../lib/auth/AuthContext";

const googleScriptSrc = "https://accounts.google.com/gsi/client";

export type AdminTab = "add" | "songs" | "history";

function tjCandidateKey(candidate: TjSongCandidate): string {
  return `${candidate.tjNumber}:${candidate.title}:${candidate.artist}`;
}

const tabs: Array<{ id: AdminTab; label: string }> = [
  { id: "add", label: "곡 추가" },
  { id: "songs", label: "곡 관리" },
  { id: "history", label: "변경 이력" }
];

interface AdminPageProps {
  embedded?: boolean;
  surfaceTab?: AdminTab;
  onSongSaved?: (song: Song) => void;
}

function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts.id) return Promise.resolve();
  const existingScript = Array.from(document.scripts).find((script) => script.src === googleScriptSrc);
  if (existingScript) {
    return new Promise((resolve, reject) => {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Google 로그인 스크립트를 불러오지 못했어.")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = googleScriptSrc;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Google 로그인 스크립트를 불러오지 못했어.")), { once: true });
    document.head.append(script);
  });
}

export function AdminPage({ embedded = false, surfaceTab, onSongSaved }: AdminPageProps) {
  const auth = useAuth();
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as AdminTab | null;
  const activeTab: AdminTab = surfaceTab ?? (requestedTab && tabs.some((tab) => tab.id === requestedTab) ? requestedTab : "add");
  const [tokenInput, setTokenInput] = useState("");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<Partial<Song>>({ title: "", artist: "", tjNumber: "", status: "active", country: "일본", performerIds: [] });
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [songs, setSongs] = useState<Song[]>(() => (mockMode() ? sampleSongs : []));
  const [songsError, setSongsError] = useState("");
  const [tjLookupLoading, setTjLookupLoading] = useState(false);
  const [tjLookupMessage, setTjLookupMessage] = useState("");
  const [tjSearchQuery, setTjSearchQuery] = useState("");
  const [tjSearchType, setTjSearchType] = useState<TjSearchType>("all");
  const [tjSearchLoading, setTjSearchLoading] = useState(false);
  const [tjSearchMessage, setTjSearchMessage] = useState("");
  const [tjCandidates, setTjCandidates] = useState<TjSongCandidate[]>([]);
  const [tjAddPending, setTjAddPending] = useState<Record<string, boolean>>({});
  const [tjAddRequestIds, setTjAddRequestIds] = useState<Record<string, string>>({});
  const [tjRestoreCandidate, setTjRestoreCandidate] = useState<Song | null>(null);
  const [tjRestorePending, setTjRestorePending] = useState(false);

  useEffect(() => {
    if (mockMode()) return;
    let cancelled = false;
    fetchPublicData()
      .then((data) => {
        if (cancelled) return;
        setSongs(data.songs);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSongsError(error instanceof Error ? error.message : "곡 목록을 불러오지 못했어.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One Google Identity Services init. The AuthProvider owns the actual
  // credential state; this block only renders the visible button so the user
  // can grant a fresh credential on demand.
  useEffect(() => {
    if (mockMode()) return;
    const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? undefined;
    if (!clientId || !googleButtonRef.current) return;
    let cancelled = false;
    loadGoogleIdentityScript()
      .then(() => {
        if (cancelled || !window.google?.accounts.id || !googleButtonRef.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response.credential) {
              auth.loginWithCredential(response.credential).catch((error) => {
                setMessage(error instanceof Error ? error.message : "로그인 실패");
              });
            } else {
              setMessage("Google 로그인 토큰을 받지 못했어.");
            }
          }
        });
        googleButtonRef.current.replaceChildren();
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: "outline",
          size: "large",
          type: "standard",
          shape: "rectangular",
          text: "signin_with",
          width: 280
        });
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Google 로그인 초기화 실패");
      });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  const handleAuthError = useCallback(
    (error: unknown): boolean => {
      if (error instanceof AuthRequiredError) {
        setMessage(error.message);
        return true;
      }
      if (isApiAuthError(error)) {
        setMessage("로그인이 만료됐어. 다시 로그인해줘.");
        return true;
      }
      return false;
    },
    []
  );

  async function loginWithToken() {
    const token = tokenInput.trim();
    if (!token) {
      try {
        await auth.loginWithGoogleButton();
        setMessage(`${auth.user?.displayName ?? "로그인"} 확인됐어.`);
      } catch (error) {
        handleAuthError(error);
      }
      return;
    }
    try {
      const user = await auth.loginWithCredential(token);
      setMessage(`${user.displayName} (${user.role})로 확인됐어.`);
    } catch (error) {
      handleAuthError(error);
    }
  }

  async function requireWriteCredential() {
    try {
      return await auth.requireValidCredential();
    } catch (error) {
      handleAuthError(error);
      throw error;
    }
  }

  async function lookupTjNumber() {
    const tjNumber = String(draft.tjNumber || "").replace(/\D/g, "");
    if (!tjNumber) {
      setTjLookupMessage("TJ 번호를 입력해줘.");
      return;
    }
    let idToken: string;
    try { idToken = await requireWriteCredential(); } catch { return; }
    setTjLookupLoading(true);
    setTjLookupMessage("");
    try {
      const result = await lookupTjSong({ tjNumber, nation: "", pageSize: 15 }, idToken);
      if (!result.candidate) {
        setTjLookupMessage(result.candidates.length > 1 ? "같은 번호의 결과가 여러 개라 직접 골라줘." : "TJ에서 해당 번호를 찾지 못했어. 아래 수동 입력을 계속 사용할 수 있어.");
        return;
      }
      const candidate = result.candidate;
      setDraft((previous) => ({
        ...previous,
        tjNumber: candidate.tjNumber,
        title: previous.title?.trim() ? previous.title : candidate.title,
        artist: previous.artist?.trim() ? previous.artist : candidate.artist,
        sourceType: "tjmedia",
        sourceReference: candidate.sourceUrl
      }));
      setTjLookupMessage("TJ 후보를 채웠어. 저장 전에 자유롭게 고쳐도 돼.");
    } catch (error) {
      if (!handleAuthError(error)) setTjLookupMessage(error instanceof Error ? error.message : "TJ 조회에 실패했어. 수동 입력을 사용해줘.");
    } finally {
      setTjLookupLoading(false);
    }
  }

  async function runTjSearch() {
    if (!tjSearchQuery.trim()) {
      setTjSearchMessage("검색어를 입력해줘.");
      return;
    }
    let idToken: string;
    try { idToken = await requireWriteCredential(); } catch { return; }
    setTjSearchLoading(true);
    setTjSearchMessage("");
    try {
      const result = await searchTjSongs({ query: tjSearchQuery, searchType: tjSearchType, nation: "", page: 1, pageSize: 15 }, idToken);
      setTjCandidates(result.candidates);
      setTjSearchMessage(result.candidates.length ? `${result.candidates.length}개 결과를 찾았어.` : "검색 결과가 없어. 수동 입력을 계속 사용할 수 있어.");
    } catch (error) {
      if (!handleAuthError(error)) setTjSearchMessage(error instanceof Error ? error.message : "TJ 검색에 실패했어. 수동 입력을 사용해줘.");
      setTjCandidates([]);
    } finally {
      setTjSearchLoading(false);
    }
  }

  async function addTjCandidate(candidate: TjSongCandidate) {
    const key = tjCandidateKey(candidate);
    if (tjAddPending[key]) return;
    let idToken: string;
    try { idToken = await requireWriteCredential(); } catch { return; }
    const requestId = tjAddRequestIds[key] || crypto.randomUUID();
    if (!tjAddRequestIds[key]) setTjAddRequestIds((previous) => ({ ...previous, [key]: requestId }));
    setTjAddPending((previous) => ({ ...previous, [key]: true }));
    try {
      const result = await addTjSong(candidate, idToken, requestId);
      if (result.outcome === "created" && result.song) {
        const saved = result.song as Song;
        setSongs((previous) => [...previous.filter((song) => song.id !== saved.id), saved]);
        onSongSaved?.(saved);
        setDraft(saved);
        setMessage("곡을 바로 추가했어. 필요하면 아래 폼에서 이어서 편집해줘.");
      } else if (result.existing) {
        const existing = result.existing as Song;
        setDraft(existing);
        setTjRestoreCandidate(result.outcome === "deleted" ? existing : null);
        setMessage(result.outcome === "deleted" ? "삭제된 같은 곡이 있어. 기존 곡을 열어 복구 여부를 확인해줘." : "같은 TJ 번호 또는 제목·아티스트의 곡이 이미 있어. 덮어쓰지 않았어.");
      }
    } catch (error) {
      if (!handleAuthError(error)) setMessage(error instanceof Error ? error.message : "곡 추가에 실패했어. 다시 눌러도 안전해.");
    } finally {
      setTjAddPending((previous) => ({ ...previous, [key]: false }));
    }
  }

  async function restoreTjCandidate() {
    if (!tjRestoreCandidate || tjRestorePending) return;
    let idToken: string;
    try { idToken = await requireWriteCredential(); } catch { return; }
    setTjRestorePending(true);
    try {
      const restored = await restoreSong(tjRestoreCandidate.id, idToken, crypto.randomUUID());
      setSongs((previous) => [...previous.filter((song) => song.id !== restored.id), restored]);
      onSongSaved?.(restored);
      setDraft(restored);
      setTjRestoreCandidate(null);
      setMessage("기존 곡을 복구했어.");
    } catch (error) {
      if (!handleAuthError(error)) setMessage(error instanceof Error ? error.message : "곡 복구에 실패했어.");
    } finally {
      setTjRestorePending(false);
    }
  }

  async function saveSong() {
    if (!auth.user || !can(auth.user.role, "song:create")) return;
    let idToken: string;
    try {
      idToken = await requireWriteCredential();
    } catch {
      return;
    }
    try {
      const saved = await upsertSong(draft, idToken, crypto.randomUUID());
      setDraft(saved);
      onSongSaved?.(saved);
      setMessage("저장했어. editor 곡도 즉시 공개 목록에 반영돼.");
    } catch (error) {
      if (!handleAuthError(error)) setMessage(error instanceof Error ? error.message : "저장 실패");
    }
  }

  async function fillReading() {
    if (!auth.user) return;
    let idToken: string;
    try {
      idToken = await requireWriteCredential();
    } catch {
      return;
    }
    try {
      const reading = await generateReading({ title: draft.title ?? "", artist: draft.artist ?? "" }, idToken);
      setDraft((prev) => ({ ...prev, ...reading }));
      setMessage("독음 후보를 채웠어. 저장 전에 수정할 수 있어.");
    } catch (error) {
      if (!handleAuthError(error)) setMessage(error instanceof Error ? error.message : "독음 생성 실패");
    }
  }

  async function analyzeVideo() {
    if (!auth.user) return;
    let idToken: string;
    try {
      idToken = await requireWriteCredential();
    } catch {
      return;
    }
    try {
      const result = await analyzeYouTube(youtubeUrl, idToken);
      setDraft((prev) => ({ ...prev, ...result }));
      setMessage("YouTube 분석 후보를 불러왔어. 자동 저장은 하지 않았어.");
    } catch (error) {
      if (!handleAuthError(error)) setMessage(error instanceof Error ? error.message : "YouTube 분석 실패");
    }
  }

  function toggleDraftPerformer(id: PerformerId) {
    setDraft((previous) => {
      const current = previous.performerIds ?? [];
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      return { ...previous, performerIds: next };
    });
  }

  const credentialStatus = auth.user
    ? `${auth.user.displayName} · ${auth.user.role}${auth.credentialExpiresAt ? ` · 만료 ${new Date(auth.credentialExpiresAt).toLocaleTimeString()}` : ""}`
    : auth.status === "reauthRequired"
      ? "다시 로그인 필요"
      : "미인증";

  return (
    <div className={embedded ? "admin-surface" : "admin-frame"}>
      {!embedded ? <header className="admin-header">
        <div>
          <h1>Songbook 관리</h1>
          <p>Google 로그인 토큰은 서버에서 다시 검증돼. mock 모드는 로컬 확인용이야.</p>
        </div>
        <Link className="admin-link" to="/">
          공개 화면
        </Link>
      </header> : null}

      {!embedded ? <section className="admin-panel">
        <h2>로그인</h2>
        {mockMode() ? (
          <p className="hint">mock 모드 — 아무 토큰이나 사용 가능해.</p>
        ) : null}
        <div className="google-login-row" ref={googleButtonRef} />
        <div className="inline-form">
          <input
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="Google ID token을 붙여넣거나 비워두고 버튼을 눌러"
          />
          <button type="button" className="primary-button" onClick={() => void loginWithToken()}>
            <LogIn size={18} />
            확인
          </button>
        </div>
        <p data-testid="admin-auth-state">{credentialStatus}</p>
        {auth.user ? (
          <button type="button" className="secondary-button" onClick={() => auth.signOut()}>
            로그아웃
          </button>
        ) : null}
      </section> : null}

      {!embedded ? <nav className="admin-tabs" aria-label="관리 탭">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={activeTab === tab.id ? "page" : undefined}
            onClick={() => setSearchParams(tab.id === "add" ? {} : { tab: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </nav> : null}

      {activeTab === "add" ? (
        <section className="admin-panel admin-form-panel">
          <header className="panel-heading">
            <h2>곡 추가</h2>
            <div className="panel-tools">
              <button type="button" className="secondary-button" disabled={!auth.user} onClick={() => void analyzeVideo()}>
                <Youtube size={17} />
                YouTube
              </button>
              <button type="button" className="secondary-button" disabled>
                <Image size={17} />
                이미지
              </button>
            </div>
          </header>
          <div className="inline-form import-row">
            <input value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="https://youtu.be/... 후보 가져오기" />
          </div>
          <section className="tj-tools" aria-label="TJ 검색">
            <div className="inline-form">
              <label className="tj-number-field">
                TJ 번호 자동 조회
                <input value={draft.tjNumber ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, tjNumber: event.target.value }))} inputMode="numeric" />
              </label>
              <button type="button" className="secondary-button" disabled={!auth.user || tjLookupLoading} onClick={() => void lookupTjNumber()}>{tjLookupLoading ? "조회 중…" : "번호 조회"}</button>
            </div>
            {tjLookupMessage ? <p className="hint">{tjLookupMessage}</p> : null}
            <div className="inline-form">
              <input value={tjSearchQuery} onChange={(event) => setTjSearchQuery(event.target.value)} placeholder="TJ 곡명·가수 검색 (Unicode 가능)" />
              <select aria-label="TJ 검색 방식" value={tjSearchType} onChange={(event) => setTjSearchType(event.target.value as TjSearchType)}>
                <option value="all">통합</option><option value="title">곡명</option><option value="artist">가수</option><option value="number">번호</option>
              </select>
              <button type="button" className="secondary-button" disabled={!auth.user || tjSearchLoading} onClick={() => void runTjSearch()}><Search size={17} />{tjSearchLoading ? "검색 중…" : "TJ 검색"}</button>
            </div>
            {tjSearchMessage ? <p className="hint">{tjSearchMessage}</p> : null}
            {tjRestoreCandidate ? <div className="tj-restore-action"><span>삭제된 곡: {tjRestoreCandidate.title}</span>{auth.user?.role === "owner" ? <button type="button" className="secondary-button" disabled={tjRestorePending} onClick={() => void restoreTjCandidate()}>{tjRestorePending ? "복구 중…" : "기존 곡 복구"}</button> : <span className="hint">기존 곡을 열었어. 복구는 소유자만 할 수 있어.</span>}</div> : null}
            {tjCandidates.length ? <div className="tj-results" aria-label="TJ 검색 결과">{tjCandidates.map((candidate) => {
              const duplicate = songs.find((song) => song.tjNumber === candidate.tjNumber || (song.title.trim().toLocaleLowerCase() === candidate.title.trim().toLocaleLowerCase() && song.artist.trim().toLocaleLowerCase() === candidate.artist.trim().toLocaleLowerCase()));
              return <div className="tj-result-row" key={candidate.tjNumber}>
                <span>{candidate.tjNumber}</span><strong>{candidate.title}</strong><small>{candidate.artist}</small>
                {duplicate ? <em>{duplicate.status === "deleted" ? "삭제됨" : "이미 있음"}</em> : null}
                <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">TJ 원본</a>
                <button type="button" className="secondary-button" disabled={Boolean(tjAddPending[tjCandidateKey(candidate)])} onClick={() => void addTjCandidate(candidate)}>{tjAddPending[tjCandidateKey(candidate)] ? "추가 중…" : duplicate ? "기존 곡 열기" : "바로 추가"}</button>
              </div>;
            })}</div> : null}
          </section>
          <div className="form-grid">
            <label>
              TJ 번호
              <input value={draft.tjNumber ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, tjNumber: event.target.value }))} />
            </label>
            <label>
              곡명
              <input required value={draft.title ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))} />
            </label>
            <label>
              곡명 독음
              <input value={draft.titleReadingKo ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, titleReadingKo: event.target.value }))} />
            </label>
            <label>
              아티스트
              <input required value={draft.artist ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, artist: event.target.value }))} />
            </label>
            <label>
              아티스트 독음
              <input value={draft.artistReadingKo ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, artistReadingKo: event.target.value }))} />
            </label>
            <label>
              국가
              <input value={draft.country ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, country: event.target.value }))} />
            </label>
            <fieldset className="form-wide performer-fieldset">
              <legend>부를 사람</legend>
              <div className="chip-toggle-group">
                {performerOrder.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="chip-toggle"
                    aria-pressed={Boolean(draft.performerIds?.includes(id))}
                    data-selected={draft.performerIds?.includes(id) ? "true" : undefined}
                    onClick={() => toggleDraftPerformer(id)}
                  >
                    {performers[id].displayName}
                  </button>
                ))}
              </div>
              <p className="hint">기존 '뽀냐' 데이터는 마리 + 여울로 변환됨</p>
            </fieldset>
            <label className="form-wide">
              메모
              <textarea value={draft.memo ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, memo: event.target.value }))} />
            </label>
          </div>
          <div className="admin-action-bar">
            <button type="button" className="secondary-button" onClick={() => setDraft({ title: "", artist: "", tjNumber: "", status: "active", country: "일본", performerIds: [] })}>
              취소
            </button>
            <span />
            <button type="button" className="secondary-button" disabled={!auth.user} onClick={() => void fillReading()}>
              <Wand2 size={18} />
              독음 생성
            </button>
            <button type="button" className="primary-button" disabled={!auth.user || !can(auth.user.role, "song:create")} onClick={() => void saveSong()}>
              저장
            </button>
          </div>
        </section>
      ) : null}

      {activeTab === "songs" ? (
        <section className="admin-panel">
          <h2>곡 관리</h2>
          {songsError ? <p className="hint error">{songsError}</p> : null}
          <div className="admin-song-list">
            {songs.map((song) => (
              <div key={song.id} className="admin-song-row">
                <ListMusic size={18} />
                <span>{song.tjNumber || "번호 없음"}</span>
                <strong>{song.title}</strong>
                <small>{song.artist}</small>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === "history" ? (
        <section className="admin-panel">
          <h2>변경 이력</h2>
          <pre>{JSON.stringify(songs.slice(0, 1), null, 2)}</pre>
        </section>
      ) : null}

      {message ? <div className="snackbar">{message}</div> : null}
    </div>
  );
}
