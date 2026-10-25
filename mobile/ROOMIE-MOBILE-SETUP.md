# Roomie — Expo Go mobile build

The Roomie native mobile app lives at `Roomie/mobile/` alongside the existing `Roomie/frontend/` Vite web app. It does **not** delete or replace the existing web work.

## First-time setup (from the existing Roomie repo root)

```sh
npx create-expo-app@latest mobile --template blank@sdk-57
cd mobile
npx expo install expo-image-picker expo-image-manipulator react-native-webview
```

Extract `roomie-expo-patch.zip` at the **repo root**, so it overwrites only `mobile/App.js` and adds `mobile/.env.example` and this setup document.

```sh
cd mobile
npx expo login
npx expo start
```

Open Expo Go on your iPhone and sign in with the same Expo account. Scan the QR code with the iPhone Camera app. Use the same Wi-Fi as your Mac. On restrictive campus Wi-Fi, `npx expo start --tunnel` may help with **the Expo bundle only**. It does *not* tunnel Andrew's API or Person 2's viewer.

## Built now

- Native app: scan with phone camera or select a photo
- Image normalization to a 960 px-wide JPEG for reliable uploads
- Responsive dark-mode app UI; Scan / 3D View / Insights tabs
- Clearly labeled sample recommendations if no backend URL is set
- POST image via `multipart/form-data` to `/api/analyze`
- Embedded Three.js website via WebView, when viewer URL is configured

## Andrew: API handoff

Copy `mobile/.env.example` to `mobile/.env.local`, then set `EXPO_PUBLIC_API_URL` to an address your iPhone can access, e.g. `http://YOUR-MAC-LAN-IP:3001` on the same Wi-Fi, or a deployed HTTPS URL. Do NOT include `/api/analyze` in the variable. `.env.local` is ignored by Git so machine-specific URLs are not committed.

Endpoint: `POST /api/analyze`; field `image` (JPEG file); JSON:

```json
{
  "summary": "Compact room with a desk and bed",
  "observations": ["Desk has little free space"],
  "suggestions": [
    {"title":"Move accessories","reason":"Free up desk space","priority":"high"}
  ]
}
```

**Snowflake secrets stay on Andrew's Node/Express backend only.** `EXPO_PUBLIC_*` variables are public in the client app.

## Person 2: 3D handoff

Their existing browser Depth Anything V2 + Three.js app **cannot be imported directly into React Native**. Keep it as a separate web viewer hosted on an iPhone-accessible URL, embedded in the Expo WebView. Set `EXPO_PUBLIC_3D_VIEWER_URL` in `mobile/.env` accordingly, e.g. `http://YOUR-MAC-LAN-IP:5173` (run Vite with `npm run dev -- --host 0.0.0.0`) or a deployed HTTPS URL.

Their web viewer must listen for this event:

```js
window.addEventListener('message', (event) => {
  if (event.data?.type === 'ROOMIE_IMAGE') {
    const imageDataUrl = event.data.imageDataUrl; // data:image/jpeg;base64,...
    // Pass imageDataUrl to the viewer's depth estimation pipeline.
  }
});
```

In this native app the WebView receives that event after loading. Ensure the viewer accepts an image supplied by this event, rather than requiring a browser file picker. The source is a downscaled image, so processing is lighter on mobile. Person 2 must test depth-model inference inside iOS WebView; if unsupported or too slow, deploy a precomputed depth demo with an explicit label or move inference to a service.

## Important networking caveats

- `localhost` on the iPhone means the iPhone, **not your computer**.
- `npx expo start --tunnel` tunnels only the Expo development server.
- Both separate URLs must be accessible from the phone for real 3D/AI to work.
- If HTTP is blocked on iOS, use an HTTPS deployment/tunnel for the web viewer/backend.
- Do not commit `.env` with credentials or sensitive addresses. Public Expo URLs aren't secrets, but tokens always are.

## Optional Expo Go support check

If Expo Go complains about a mismatched SDK, verify `package.json` Expo version and choose a matching version of Expo Go or scaffold using the version recommended by Expo docs for your physical iOS device. Run `npx expo-doctor@latest` to diagnose.
