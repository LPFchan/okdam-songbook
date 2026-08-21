# Songbook

개인용 노래방 애창곡 관리 PWA입니다. GitHub Pages의 정적 웹 앱, 비공개 Google Sheets/Apps Script 데이터 경계, 별도 Cloudflare Worker ChatGPT OAuth 경계를 함께 사용합니다.

## 현재 상태

통합 소스에는 카탈로그 중심의 통합 화면, 문맥형 곡 추가·관리·공연 기록, TJ 반주번호 보조 입력, OCI Node/Hono 서버, Better Auth 브라우저 세션이 반영되어 있습니다. 서버는 PWA, SQLite, TJ 미러, API, Better Auth, stateless MCP를 한 origin에서 제공합니다.

MCP는 공개 카탈로그·통합 검색·곡 조회를 로그아웃 상태에서 제공하고, 공연 기록과 곡 변경은 Better Auth OAuth bearer 및 현재 이메일→공개 이름 allowlist로 보호합니다. MCP 쿠키는 identity가 아니며, 이 MCP/OAuth 경계는 현재 운영 중입니다.

## 주요 기능

- TJ 번호, 곡명, 아티스트, 일본어 원문, 한글 독음, 로마자, 메모 검색
- 카탈로그 중심 목록과 곡 상세 화면, 문맥형 추가·관리·공연 기록
- TJ 번호 정확 조회, 제한된 제목·아티스트 검색, 후보 수정 후 즉시 추가
- 다크 모드, 접근성 포커스, 검색엔진 noindex, PWA 설치와 IndexedDB 캐시
- 오프라인 공연 기록 큐와 `clientRequestId` 중복 방지
- 단일 allowlist 사용자 권한 모델과 OCI 서버의 정확한 이메일→공개 이름 판정
- CSV/JSON/AI/YouTube/Image 분석을 위한 안전한 API 경계와 수동 폴백

## 구조

```text
apps/web/        React + TypeScript + Vite PWA
apps-script/     Google Apps Script Web App source
integrations/    legacy Cloudflare Worker and ChatGPT OAuth source
packages/shared/ shared schemas, search, permissions, TJ contracts
docs/            architecture, deployment, security, API, operations
records/         repo-template truth, decisions, research
```

## 로컬 실행과 검증

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm run test
npm run build
```

mock 모드는 기본값입니다. `apps/web/.env.example`을 참고해 `.env`를 만들 수 있습니다. 운영 인증을 켜려면 [현재 운영 체크리스트](docs/ops-checklist-2026-08-13.md)를 먼저 완료해야 합니다.

## 운영 문서

- [Architecture](docs/architecture.md)
- [API](docs/api.md)
- [Security](docs/security.md)
- [Deployment](docs/deployment.md)
- [Production rollout checklist](docs/ops-checklist-2026-08-13.md)
- [Apps Script README](apps-script/README.md)

실제 이메일, OAuth client secret, Better Auth secret, D1 ID와 내부 공유 비밀은 저장소에 커밋하지 않습니다.
