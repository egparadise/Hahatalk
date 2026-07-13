# Stage 6D Screen Share, Devices, And Camera Backgrounds

## Scope

Stage 6D adds explicit desktop screen sharing, in-call device switching, and local camera background processing to ad-hoc calls and scheduled meetings. Recording, egress, system-audio capture, and persisted background images remain outside this stage.

## Durable Screen-Share Lifecycle

`009_screen_share_device_background.sql` extends each `call_participants` row with:

- `screen_share_status`: `off`, `starting`, or `active`.
- request, start, and end timestamps.
- a partial unique index that permits only one `starting` or `active` participant per session.

The API flow is deliberately separate from the initial join token:

1. A connected participant requests `/screen-share/start`.
2. The API records `starting`, emits viewer-specific realtime projections, and grants only `SCREEN_SHARE` in addition to the participant's current microphone/camera sources.
3. The renderer invokes `setScreenShareEnabled(true, { audio: false })` from a user gesture.
4. A published track is confirmed through `/screen-share/active`.
5. User stop, picker cancellation, track end, publish failure, role change, leave, or session termination returns the durable state to `off`.

Ad-hoc connected participants may request sharing. Scheduled meetings restrict it to a joined `host`, `cohost`, or `speaker`; an `attendee`, guest attendee, or subscriber attendee cannot request it. A demotion to attendee removes the screen-share state and provider permission in the same role-change workflow.

Provider grant failure rolls `starting` back to `off`. Provider revoke uncertainty attempts to remove the participant from LiveKit, increments the token version, marks the participant removed, and records an audit event. Initial call/meeting tokens never contain screen-share permission.

## Desktop Capture Boundary

Electron accepts display-capture requests only when all conditions hold:

- the renderer origin is the current packaged runtime origin;
- the request has a transient user gesture;
- the user chooses one enumerated local screen/window in the native selector.

The automated renderer harness uses `HAHATALK_TEST_FAKE_MEDIA=1` to select the first screen without a native dialog. This branch is unavailable in ordinary launches. Screen audio is disabled for Stage 6D.

## Device And Background Privacy

- Device enumeration starts only inside an active media desk.
- Camera, microphone, and available audio-output choices use LiveKit `Room.getLocalDevices` and `switchActiveDevice`.
- Device IDs remain renderer memory only; they are not sent to the API, audit log, local storage, or Obsidian report.
- User-selected background images use temporary object URLs and are revoked when replaced, disabled, or disconnected.
- `@livekit/track-processors` is dynamically loaded only when needed.
- MediaPipe WASM and the selfie-segmentation model are packaged under `public/media-segmentation`; camera frames and selected images remain on device.
- The CSP permits same-origin WebAssembly execution but does not add a remote model or script origin.

## UI Contract

- A shared screen appears in a dedicated, contain-fit stage above participant tiles.
- The active sharer is always named, and the local sharer has an immediate stop button in both the stage and toolbar.
- Camera tracks and screen tracks are keyed by LiveKit source, so one participant can publish both without one replacing the other.
- The settings tool uses device menus and a segmented `original / blur / image` camera-background control.
- Unsupported background processors remain visibly unavailable instead of simulating success.

## Verification

Fresh-DB integration checks prove migration checksum evidence, least-privilege initial tokens, provider-grant rollback, API and database singleton enforcement, meeting role boundaries, audit events, restart behavior, and terminal cleanup.

Installed Windows renderer checks prove real LiveKit participation, microphone/camera device enumeration, locally packaged MediaPipe blur with nonblank camera frames, explicit screen capture, provider screen permission/track publication, concurrent-share denial, immediate stop, role-demotion revocation, layout separation, and clean provider/database shutdown.
