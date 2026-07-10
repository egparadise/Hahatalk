# Technology Decisions - 2026-07-10

This record uses current primary sources reviewed on 2026-07-10. Recheck versions and licenses at the start of each implementation stage.

## AI Assistant

Decision: use a provider interface whose minimum accepted family is Qwen 3.5. Start evaluation with `Qwen/Qwen3.5-9B`, then choose deployment size from measured Korean quality, latency, VRAM, and concurrency.

- The official model card lists Qwen3.5-9B as Apache-2.0, multimodal, tool-capable, and serveable through vLLM/SGLang/OpenAI-compatible APIs: [Qwen3.5-9B model card](https://huggingface.co/Qwen/Qwen3.5-9B).
- Do not run the full assistant model on mobile. Keep the model ID in `ai_model_configs` so Qwen 3.6+ can be evaluated without schema changes.

## STT

Decision: use OpenAI Whisper weights through `faster-whisper`, with Silero VAD, as an asynchronous worker. Keep original `openai/whisper` available as the reference implementation for evaluation.

- OpenAI's repository documents multilingual Whisper, the optimized `turbo` model, and MIT licensing: [openai/whisper](https://github.com/openai/whisper).
- `faster-whisper` is a CTranslate2 reimplementation with batched transcription and integrated Silero VAD support: [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper).
- Silero VAD is MIT licensed: [silero-vad license](https://github.com/snakers4/silero-vad/blob/master/LICENSE).

Start with `turbo` for low-latency message drafts and benchmark `large-v3` for Korean meeting accuracy. The sender reviews STT text before transmission.

## TTS Recommendation

Primary recommendation: Qwen3-TTS.

- Qwen3-TTS officially supports Korean, streaming generation, emotion/prosody control, a Korean `Sohee` voice, and 3-second rapid voice cloning in Base models: [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS).
- The repository is Apache-2.0: [Qwen3-TTS license](https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE).

Deployment tiers:

1. Standard Korean reading: `Qwen3-TTS-12Hz-0.6B-CustomVoice` for the first benchmark.
2. Higher-quality standard/expressive speech: `1.7B-CustomVoice` or `1.7B-VoiceDesign`.
3. Consented voice profile: `1.7B-Base`, isolated behind voice-profile consent, encryption, revocation, watermark, and audit controls.

MeloTTS can remain a lightweight fallback benchmark, but it is no longer the primary recommendation because Qwen3-TTS covers the requested streaming, Korean, expression, and cloning path in one maintained family. Never enroll a person from historical call recordings unless that person gives explicit, purpose-specific consent.

## Calls And Broadcasts

Decision: LiveKit for voice, video, screen share, scheduled meetings, and personal broadcasts.

- LiveKit models realtime communication as rooms, participants, and tracks across web/mobile/embedded platforms: [LiveKit basics](https://docs.livekit.io/intro/basics/).
- It supports screen sharing across platforms, with ReplayKit on iOS and MediaProjection on Android: [LiveKit screen sharing](https://docs.livekit.io/transport/media/screenshare/).
- It offers media/data E2EE, while key distribution remains the application's responsibility: [LiveKit encryption](https://docs.livekit.io/transport/encryption/).

Background blur and replacement are client video processors and must be capability-tested per device. Recording requires a consent snapshot before LiveKit egress starts.

## Cross-Platform Clients

Decision: keep Next.js web and Electron desktop; add Expo/React Native mobile in the same monorepo after the persisted conversation API stabilizes.

- Expo supports monorepo layouts for Android and iOS projects: [Expo monorepos](https://docs.expo.dev/guides/monorepos/).
- Electron provides desktop capture and isolated utility processes for native-adjacent work: [Electron docs](https://www.electronjs.org/docs/latest/README), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).

Remote-control code does not run in the renderer. It lives in a separate signed support agent with the smallest possible IPC surface.

## Remote Support

Prototype decision: evaluate MeshCentral behind HahaTalk's consent and audit control plane; keep a native-agent option for a later security-reviewed implementation.

- MeshCentral provides a web-based remote desktop server and agents across Windows, Linux, macOS, and other targets: [MeshCentral](https://github.com/Ylianst/MeshCentral), [MeshAgent](https://github.com/Ylianst/MeshAgent).
- MeshCentral is Apache-2.0. RustDesk is a capable alternative but its official repository is AGPL-3.0, which creates different distribution obligations for an embedded commercial product: [RustDesk](https://github.com/rustdesk/rustdesk).

Windows host/control is first. Apple documents screen capture and user-managed sharing APIs, but this should not be interpreted as unrestricted third-party iOS device control: [ReplayKit](https://developer.apple.com/documentation/ReplayKit), [ScreenCaptureKit](https://developer.apple.com/documentation/ScreenCaptureKit).

## Database Privacy

Decision: PostgreSQL with application authorization plus row-level-security tests as defense in depth.

- PostgreSQL RLS can default-deny rows without a matching policy, but owners and `BYPASSRLS` roles require careful handling: [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

The client never queries canonical hub rows directly. The API returns a viewer projection, and tests verify that member count, other deliveries, and target metadata are absent.

## Codex Development System

Decision: small repo `AGENTS.md` for persistent rules, `.agents/skills` for the reusable stage loop, `.codex/agents` for specialist roles, and `.codex/hooks.json` for lifecycle reminders.

- Codex recommends `AGENTS.md` for durable repo guidance and `.agents/skills` for repo-scoped workflows: [Codex customization](https://developers.openai.com/codex/concepts/customization).
- Project hooks can live in `.codex/hooks.json` and run at lifecycle events: [Codex hooks](https://developers.openai.com/codex/config-advanced#hooks).

## Windows Desktop Packaging

- Electron's official distribution guide recommends Electron Forge for packaging and distributables. HahaTalk uses Forge with Squirrel.Windows to produce a per-user installer: [Electron packaging](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging), [Squirrel.Windows maker](https://www.electronforge.io/config/makers/squirrel.windows).
- The packaged API runs in Electron `utilityProcess`, which provides a Node child process while preserving process isolation from the renderer: [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).
- Next.js `output: "export"` creates static assets that can be served by the local Electron runtime without a separate Next.js server: [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports).
- The renderer retains context isolation, sandboxing, disabled Node integration, parsed-origin navigation checks, and explicit display-media permission handling following Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security) and [session API](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).
- Rejected for this stage: packaging the full monorepo and `node_modules`, because it increases installer size and leaks build-only dependencies. The API is bundled and static assets are copied as explicit runtime resources instead.
