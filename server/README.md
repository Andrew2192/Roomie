# Roomie Cortex API

Person 3's backend for analyzing uploaded room photos with Snowflake Cortex.

## Run locally

Requires Node.js 20 or newer and a Snowflake account with a programmatic access token and access to a vision-capable Cortex model.

```powershell
cd server
npm install
Copy-Item .env.example .env
```

Set `SNOWFLAKE_ACCOUNT_URL` to your account's HTTPS URL and `SNOWFLAKE_PAT` to your programmatic access token in `.env`. `CORTEX_MODEL` defaults to `openai-gpt-5`; set it to another vision-capable model enabled for your account if needed.

```powershell
npm run dev
```

The API listens on port `3001` by default. `CORS_ORIGINS` is a comma-separated allowlist and defaults to `http://localhost:5173`.

## API

`GET /api/health` returns `{ "status": "ok" }`.

`POST /api/analyze` accepts `multipart/form-data` with one image in the `image` field. JPEG, PNG, and WebP images up to 10 MB are accepted. A successful response has this shape:

```json
{
  "summary": "A compact room with a desk and bed.",
  "observations": ["The desk has limited clear surface space."],
  "suggestions": [
    {
      "title": "Use under-bed storage",
      "reason": "It can free up visible floor space.",
      "priority": "high"
    },
    {
      "title": "Clear the desk",
      "reason": "Move small items into nearby storage.",
      "priority": "medium"
    },
    {
      "title": "Use vertical shelving",
      "reason": "It can keep frequently used items accessible.",
      "priority": "low"
    }
  ]
}
```

The API returns an error status and an `{ "error": "..." }` message for invalid uploads, missing Cortex configuration, and upstream failures. Snowflake credentials stay on the server and must not be committed.

Run the API tests with `npm test`.
