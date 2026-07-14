# Stage 10 Mobile Companion

HahaTalk 0.17.0 adds an Expo SDK 57 Android/iOS companion. It intentionally keeps the PC work desk as the primary surface while providing secure sign-in, Smart Room projections, short replies, media viewing and sharing, calendar/RSVP, personal broadcast viewing, and LiveKit call participation.

## Security boundary

- Mobile uses short-lived bearer access tokens and single-use rotating refresh tokens.
- Session material and the local AES key use SecureStore. Offline mutation bodies are AES-256-GCM ciphertext in SQLite and are capped at 50 items.
- Push tokens are AES-256-GCM encrypted on the server. Push jobs contain generic text and an allowlisted route, never message content or hidden-hub membership.
- Native requests require `X-HahaTalk-Client: mobile-v1`; browser origins cannot impersonate the native client.
- Remote control and mobile screen publishing remain unavailable. They require separate signed-native work and physical-device privacy validation.

## Build and verification

```powershell
npm run mobile:check
npm run mobile:integration
npm run mobile:export
npm run mobile:bundle-check
```

`EXPO_PUBLIC_API_URL` must be HTTPS outside local development. Push registration remains disabled until `EXPO_PUBLIC_EAS_PROJECT_ID`, APNs/FCM credentials, and a physical development build are configured.
