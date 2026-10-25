# Roomie — AI-Powered Room Analysis

Roomie turns a single room photo into (1) an interactive 3D point-cloud reconstruction and (2) AI organization recommendations.

- **Depth + 3D:** REAL in-browser monocular depth estimation (Depth Anything V2, Transformers.js/ONNX) rendered as a colored, orbitable Three.js point cloud. No API keys.
- **AI insights:** Snowflake Cortex (vision-capable model) via a small Node/Express backend. Snowflake credentials stay server-side only.
- **Web:** React + Vite app at the repo root.
- **Mobile:** Expo (React Native) app in `mobile/`, testable in Expo Go.

## Repo layout

```
server/          Express API wrapping Snowflake Cortex (Person 3)
src/             React web app
  components/    Room3D.jsx (3D viewer), RoomAnalysis.jsx (AI panel)
  lib/           depth.js (in-browser depth pipeline), api.js (backend client), analysis.js
mobile/          Expo Go mobile app (camera/library scan → backend + embedded web viewer)
scripts/         Browser smoke tests + dev-only mock backend
```

## Quick start (web + AI)

```sh
# 1. Backend
cd server
npm install
cp .env.example .env        # then fill in the Snowflake values
npm run dev                 # http://localhost:3001

# 2. Web frontend (repo root)
npm install
npm run dev                 # http://localhost:5173 (proxies /api → :3001)
```

Upload a room photo: the 3D scan builds on the left, Cortex recommendations load on the right, independently.

### Required environment variables (`server/.env`)

| Variable | Meaning |
| --- | --- |
| `SNOWFLAKE_ACCOUNT_URL` | `https://<account-identifier>.snowflakecomputing.com` (bare identifier without the scheme also works) |
| `SNOWFLAKE_PAT` | Programmatic Access Token (Bearer). Never exposed to any frontend. |
| `CORTEX_MODEL` | Vision-capable model, default `openai-gpt-5` |
| `PORT` | Default `3001` |
| `CORS_ORIGINS` | Comma-separated allowlist, default `http://localhost:5173` |

The API is `POST /api/analyze` (multipart field `image`, JPEG/PNG/WebP ≤ 10 MB) → `{ summary, observations[], suggestions[{title, reason, priority}] }`, and `GET /api/health`. Failures return `{ error }` with a real, honest message — results are never fabricated client-side.

## Expo Go (mobile)

```sh
cd mobile
npm install
npx expo start              # scan the QR with Expo Go (same Wi-Fi as your machine)
```

In `mobile/.env.local` set `EXPO_PUBLIC_API_URL=http://<YOUR-LAN-IP>:3001` and optionally `EXPO_PUBLIC_3D_VIEWER_URL=http://<YOUR-LAN-IP>:5173` (run `npm run dev:host`). The phone can scan with the camera; the 3D tab embeds the web viewer and injects the photo via the `ROOMIE_IMAGE` window-message bridge. Details: [`mobile/ROOMIE-MOBILE-SETUP.md`](mobile/ROOMIE-MOBILE-SETUP.md).

## Tests & verification

```sh
# Backend + depth/UI lib units (includes Cortex request-shape tests)
node scripts/api-and-unit-tests.mjs

# Full browser workflow (needs Chrome on macOS, dev server on :5173, backend on :3001)
node scripts/smoke-integration.mjs

# While Snowflake access is blocked by account network policy, obtain a real-shape
# success path locally with the stub (clearly NOT a live result):
node scripts/mock-cortex-server.mjs &
API_PROXY_TARGET=http://localhost:3011 npm run dev -- --port 5173 &
node scripts/smoke-integration.mjs
```

`npm run build` must pass. Known status: a live Cortex request reaches Snowflake's auth layer and is currently rejected by the account's **network policy** (HTTP 401, code `390432`); an account admin must allowlist the client IP before the live pass can succeed.

## Notes

- The 3D reconstruction is an approximate 2.5D relief, not a true scan.
- First 3D scan downloads the model (~26 MB) once per browser, then it's cached.
- Do not commit secrets: `server/.env` and `mobile/.env.local` are gitignored; `EXPO_PUBLIC_*` values are public by design.
