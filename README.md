# Songbook

개인용 노래방 애창곡 관리 PWA입니다. Cloudflare Workers 위의 Hono 앱과 D1을 중심으로 동작하며, `okdam.lost.plus`에서 서비스합니다.

## 현재 상태

`okdam-songbook` Worker가 PWA(Workers Assets), 공개 카탈로그 API, 보호된 브라우저 API, `/healthz`, stateless MCP를 한 origin에서 제공합니다. 상태는 D1 `okdam-songbook`에 있습니다.

Worker 자체에는 공개 route가 없습니다. `okdam.lost.plus/*` route는 Common Auth의 `auth-gateway` Worker가 갖고 있고, gateway가 credential을 검증한 뒤 service binding(`SONGBOOK_BACKEND`)으로 확인된 identity 헤더만 전달합니다. 앱은 credential을 직접 검증하지 않습니다.

MCP 전체는 `auth.lost.plus` OAuth 또는 `okdam-mcp` 용도의 machine token이 필요합니다. gateway identity가 없는 MCP 요청은 앱에서도 거부합니다.

## 주요 기능

- TJ 번호, 곡명, 아티스트, 일본어 원문, 한글 독음, 로마자, 메모 검색
- 카탈로그 중심 목록과 곡 상세 화면, 문맥형 추가·관리·공연 기록
- TJ 번호 정확 조회, 제한된 제목·아티스트 검색, 후보 수정 후 즉시 추가
- 다크 모드, 접근성 포커스, 검색엔진 noindex, PWA 설치와 IndexedDB 캐시
- 오프라인 공연 기록 큐와 `clientRequestId` 중복 방지
- `auth.lost.plus`의 `okdam` 서비스 허용 목록과 단일 사용자 권한 모델
- Workers AI 기반 한글 독음 후보 생성 (서버 전용 credential, 수동 폴백)

## 구조

```text
apps/worker/            Cloudflare Worker 진입점, wrangler.toml, D1 migrations
apps/server/            Worker가 mount하는 Hono 앱 (API, /healthz, /mcp, identity 헤더 파서)
apps/web/               Svelte + TypeScript + Vite PWA → apps/web/dist (Workers Assets)
packages/server-core/   도메인 서비스, 저장소, SQL executor(D1/Node), TJ 어댑터·미러
packages/songbook-mcp/  MCP 도구 (@modelcontextprotocol/server v2)
packages/shared/        공용 schema, search, permissions, TJ contracts
packages/songbook-admin/  Node 전용 SQLite 데이터 도구 (D1 대상 아님)
apps-script/, integrations/chatgpt-proxy/  retired legacy source
docs/                   architecture, deployment(runbook), security, API
records/                repo-template truth, decisions, research
```

## 로컬 실행과 검증

```bash
npm install
npm run dev            # 웹 앱 (mock 모드)
npm run verify         # typecheck + test + lint + build
cd apps/worker && npx wrangler dev   # Worker + 로컬 D1
```

mock 모드는 기본값입니다. `apps/web/.env.example`을 참고해 `.env`를 만들 수 있습니다.

## 배포

`npm run build` 후 `cd apps/worker && npx wrangler deploy`. 검증 명령, rollback, D1 backup 절차는 [docs/deployment.md](docs/deployment.md)에 있습니다.

## 운영 문서

- [Architecture](docs/architecture.md)
- [Deployment runbook](docs/deployment.md)
- [Security](docs/security.md)
- [API](docs/api.md)
- [Status](records/STATUS.md)

실제 이메일, 공통 인증 cookie·bearer token, Worker secret과 내부 공유 비밀은 저장소에 커밋하지 않습니다.
