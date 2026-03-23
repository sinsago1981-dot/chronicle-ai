# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── ai-trpg/            # AI TRPG game frontend (React + Vite, at /)
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.

## Windows / Cross-Platform Notes

- **Native binaries** (lightningcss, @tailwindcss/oxide, esbuild, rollup) — pnpm installs only the binary matching the current OS/arch automatically. No manual overrides needed.
- **Replit-specific Vite plugins** (`@replit/vite-plugin-*`) removed from all artifacts.
- **`export` → `cross-env`** — `cross-env` is used in api-server dev script for Windows CMD/PowerShell compatibility.
- **`--env-file-if-exists` → `load-env.mjs`** — `artifacts/api-server/load-env.mjs` is a thin wrapper that loads `.env` via `dotenv` before starting the server. Works with any Node 16+.
- **preinstall** uses `node -e "..."` instead of `sh -c` for cross-platform compatibility.

## Local Development (VS Code / Windows)

### 가장 쉬운 방법 (Windows)

**방법 A**: `start.bat` 파일을 더블클릭
- node_modules가 없으면 자동 설치
- .env가 없으면 자동 복사 후 메모장으로 오픈
- 첫 실행 시 DB 마이그레이션 자동 실행
- 완료 후 자동으로 두 서버 시작

**방법 B**: PowerShell 스크립트
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned  # 최초 1회
.\setup.ps1
```

### 수동 설정

**1. 필수 조건**
- Node.js 20+ (https://nodejs.org → LTS 버전)
- pnpm (`npm install -g pnpm`)
- PostgreSQL DB — **로컬 설치 불필요**: [Neon.tech](https://neon.tech) 무료 클라우드 DB 사용 가능

**2. 환경변수 설정**
```bash
cp .env.example .env
# .env 파일에서 DATABASE_URL, OPENAI_API_KEY 입력
```

**3. 패키지 설치**
```bash
pnpm install
```

**4. DB 테이블 생성 (첫 실행 시 한 번만)**
```bash
pnpm --filter @workspace/db run push
```

**5. 개발 서버 실행**
```bash
pnpm dev          # API(10000포트) + 웹(3000포트) 동시 실행
pnpm dev:api      # API 서버만 (터미널 1)
pnpm dev:web      # 웹 서버만 (터미널 2)
```
브라우저에서 http://localhost:3000 접속

### 환경변수 로딩 방식
- **API 서버** — `artifacts/api-server/load-env.mjs`가 `dotenv`로 루트 `.env`를 읽음 (Node 16+ 호환)
- **drizzle 마이그레이션** — `lib/db/drizzle.config.ts`에서 `dotenv`로 루트 `.env`를 읽음
- **프론트엔드 (Vite)** — 시크릿 불필요; `/api` 요청은 Vite 프록시로 API 서버에 전달
- **Replit** — 환경변수가 전역으로 설정됨; `.env` 파일 없어도 동작
