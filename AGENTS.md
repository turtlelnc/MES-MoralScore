# Repository Guidelines

## Project Structure & Module Organization

- `server/` — Express 5 + `node:sqlite` backend. `index.mjs` boots the process; `app.mjs` builds the app from a database/config; `schema.sql` + `migrations.mjs` own the schema; domain modules (`rules`, `scoring`, `submissions`, `appeals`, `roster`, `analytics`, `reports`, `share`, `admin`, `imports`, `evidence`) each export `register*Routes(app, ctx)`. Shared helpers live in `core.mjs` and deterministic aggregations in `ledger.mjs`.
- `src/` — React 19 + TypeScript SPA. `main.tsx` is the shell (routing, session, layout); pages live in `src/pages/`; shared primitives in `src/components/ui.tsx`; design tokens in `src/styles.css`.
- `server/*.test.ts` — Vitest unit/integration tests; `server/test-utils.mjs` provides isolated temp databases and seeded fixtures (`server/fixtures.mjs`).
- `tests/browser/` — Playwright real-browser flows against an isolated fixture server.
- `tools/` — operations CLI (`ops/backup.mjs`, `create-admin.mjs`). `docs/` — architecture contract, deployment and security notes.

## Build, Test, and Development Commands

- `npm install` — install dependencies (Node.js ≥ 24).
- `npm run seed:demo` — load fictional demo data (`--force` replays); `npm start` — serve `dist/` + API on port 8080.
- `npm run dev:server` + `npm run dev` — API + Vite dev server (proxy `/api` → 8080).
- `npm test` — run Vitest. `npm run build` — `tsc -b && vite build`.
- `npm run test:browser` — Playwright flows; `npm run admin:create -- --account=...` — bootstrap a production admin; `npm run backup:run` / `npm run backup:status` — real SQLite backups.

## Coding Style & Naming Conventions

ESM JavaScript on the server (`.mjs`), strict TypeScript/TSX on the frontend. Use 2-space indentation, double quotes, semicolons and trailing commas as in existing files. Server functions/variables are camelCase; database columns are snake_case; React components are PascalCase files (`QuickScorePage.tsx`). All user-facing strings are Simplified Chinese. Use `ctx.parseBody(zodSchema, body)`, `ctx.httpError`, `ctx.scope`, `ctx.audit` instead of ad-hoc implementations. Never edit generated `dist/`; never commit `data/`, `.env` or dependencies.

## Testing Guidelines

Add tests for every behavioural change: permission/data-scope isolation, ledger immutability and reversal, rule version lifecycle, submission verification, appeal decisions, report aggregation and import transaction rollback. Name files `<module>.test.ts` and describe blocks in Chinese. Prefer `createTestServer()` (fresh temp DB per test) over mocks. Run `npm test` and `npm run build` before finishing; browser changes also require `npm run test:browser`.

## Commit & Pull Request Guidelines

Use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), imperative subject, Chinese or English body. Each PR should describe user-visible behaviour, list verification commands and include screenshots for UI changes. Never commit secrets, student data, `data/`, `dist/` or `node_modules/`. Version bumps must update `package.json`, `server/version.mjs`, `src/version.ts`, `server/version.test.ts` and README badges together.

## Security & Configuration Tips

Server-side RBAC and data scopes are mandatory — hiding UI is not authorization. Evidence files stay in `DATA_DIR/evidence` with random names and authorized downloads. Parent-share and submission tokens are hashed at rest; never log raw tokens or passwords. Require `APP_SECRET` (≥32 random chars), HTTPS and `COOKIE_SECURE=1` in production. Audit logs, appeal decisions and score records are append-only; use reversal/correction flows instead of edits.
