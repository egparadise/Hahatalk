"use client";

import {
  Camera,
  CameraOff,
  Image as ImageIcon,
  Mic,
  MicOff,
  MonitorUp,
  RefreshCw,
  Settings2,
  Sparkles,
  Square
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CallView, MeetingView, ScreenShareStatus, ScreenShareStopReason } from "@hahatalk/contracts";
import type { LocalVideoTrack, RemoteTrack, Room } from "livekit-client";
import { postJson } from "../lib/api-client";

type SessionView = CallView | MeetingView;
type CameraEffect = "none" | "blur" | "image";
type DeviceKind = "audioinput" | "audiooutput" | "videoinput";

export type LiveMediaControlsHandle = {
  prepareDisconnect: () => Promise<void>;
  stopScreenShare: (reason?: ScreenShareStopReason) => Promise<void>;
};

type LiveMediaControlsProps = {
  active: boolean;
  busy: boolean;
  cameraEnabled: boolean;
  cameraTrack: LocalVideoTrack | undefined;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  canShareScreen: boolean;
  room: Room | null;
  screenShareBlocked: boolean;
  screenShareStatus: ScreenShareStatus;
  sessionPath: string;
  microphoneEnabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onCameraEnabledChange: (enabled: boolean) => void;
  onCameraTrackChange: (track?: LocalVideoTrack) => void;
  onCameraWarning: (message: string) => void;
  onError: (message: string) => void;
  onLocalScreenTrackChange: (track?: LocalVideoTrack) => void;
  onMicrophoneEnabledChange: (enabled: boolean) => void;
  onUpdated: (view: SessionView) => void;
};

export const LiveMediaControls = forwardRef<LiveMediaControlsHandle, LiveMediaControlsProps>(function LiveMediaControls({
  active,
  busy,
  cameraEnabled,
  cameraTrack,
  canPublishAudio,
  canPublishVideo,
  canShareScreen,
  microphoneEnabled,
  onBusyChange,
  onCameraEnabledChange,
  onCameraTrackChange,
  onCameraWarning,
  onError,
  onLocalScreenTrackChange,
  onMicrophoneEnabledChange,
  onUpdated,
  room,
  screenShareBlocked,
  screenShareStatus,
  sessionPath
}, ref) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devices, setDevices] = useState<Record<DeviceKind, MediaDeviceInfo[]>>({
    audioinput: [],
    audiooutput: [],
    videoinput: []
  });
  const [selectedDevices, setSelectedDevices] = useState<Partial<Record<DeviceKind, string>>>({});
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [effect, setEffect] = useState<CameraEffect>("none");
  const [effectBusy, setEffectBusy] = useState(false);
  const [effectSupported, setEffectSupported] = useState<boolean | null>(null);
  const [localScreenTrack, setLocalScreenTrack] = useState<LocalVideoTrack | undefined>();
  const backgroundUrlRef = useRef<string | undefined>(undefined);
  const backgroundTrackRef = useRef<LocalVideoTrack | undefined>(undefined);
  const disposingRef = useRef(false);
  const pendingScreenStopRef = useRef<ScreenShareStopReason | null>(null);
  const screenActionRef = useRef(false);
  const suppressScreenEndedRef = useRef(false);

  async function refreshDevices() {
    if (!room || !navigator.mediaDevices) return;
    setDeviceBusy(true);
    try {
      const { Room: LiveKitRoom } = await import("livekit-client");
      const kinds: DeviceKind[] = ["audioinput", "videoinput", "audiooutput"];
      const entries = await Promise.all(kinds.map(async (kind) => [
        kind,
        await LiveKitRoom.getLocalDevices(kind, false)
      ] as const));
      setDevices(Object.fromEntries(entries) as Record<DeviceKind, MediaDeviceInfo[]>);
      const selected = Object.fromEntries(
        kinds.map((kind) => [kind, room.getActiveDevice(kind) ?? ""])
      ) as Partial<Record<DeviceKind, string>>;
      setSelectedDevices(selected);
    } catch (nextError) {
      onError(errorMessage(nextError, "장치 목록을 불러오지 못했습니다."));
    } finally {
      setDeviceBusy(false);
    }
  }

  useEffect(() => {
    if (!settingsOpen) return;
    void refreshDevices();
    const handleChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handleChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handleChange);
  }, [settingsOpen, room]);

  useEffect(() => {
    if (!settingsOpen || effectSupported !== null) return;
    void import("@livekit/track-processors")
      .then((processors) => setEffectSupported(processors.supportsBackgroundProcessors()))
      .catch(() => setEffectSupported(false));
  }, [effectSupported, settingsOpen]);

  useEffect(() => {
    const previous = backgroundTrackRef.current;
    if (previous && previous !== cameraTrack) void previous.stopProcessor().catch(() => undefined);
    if (previous !== cameraTrack) {
      backgroundTrackRef.current = cameraTrack;
      setEffect("none");
      revokeBackgroundUrl();
    }
  }, [cameraTrack]);

  useEffect(() => {
    if (screenShareStatus !== "off" || !localScreenTrack || screenActionRef.current) return;
    suppressScreenEndedRef.current = true;
    void room?.localParticipant.setScreenShareEnabled(false)
      .catch(() => undefined)
      .finally(() => { suppressScreenEndedRef.current = false; });
    setLocalScreenTrack(undefined);
    onLocalScreenTrackChange(undefined);
  }, [localScreenTrack, onLocalScreenTrackChange, room, screenShareStatus]);

  useEffect(() => {
    if (active) disposingRef.current = false;
  }, [active, room]);

  useEffect(() => () => {
    disposingRef.current = true;
    void backgroundTrackRef.current?.stopProcessor().catch(() => undefined);
    revokeBackgroundUrl();
  }, []);

  async function switchDevice(kind: DeviceKind, deviceId: string) {
    if (!room || !deviceId) return;
    setDeviceBusy(true);
    try {
      await room.switchActiveDevice(kind, deviceId);
      setSelectedDevices((current) => ({ ...current, [kind]: deviceId }));
    } catch (nextError) {
      onError(errorMessage(nextError, "선택한 장치로 전환하지 못했습니다."));
    } finally {
      setDeviceBusy(false);
    }
  }

  async function toggleMicrophone() {
    if (!room || !canPublishAudio) return;
    onBusyChange(true);
    try {
      const enabled = !microphoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(enabled);
      onMicrophoneEnabledChange(enabled);
      onError("");
    } catch (nextError) {
      onError(errorMessage(nextError, "마이크를 전환하지 못했습니다."));
    } finally {
      onBusyChange(false);
    }
  }

  async function clearBackgroundEffect() {
    const track = backgroundTrackRef.current;
    if (track) await track.stopProcessor().catch(() => undefined);
    setEffect("none");
    revokeBackgroundUrl();
  }

  async function toggleCamera() {
    if (!room || !canPublishVideo) return;
    onBusyChange(true);
    try {
      const enabled = !cameraEnabled;
      if (!enabled) await clearBackgroundEffect();
      const publication = await room.localParticipant.setCameraEnabled(enabled);
      const track = enabled ? publication?.videoTrack : undefined;
      onCameraTrackChange(track);
      onCameraEnabledChange(enabled && Boolean(track));
      onCameraWarning("");
    } catch (nextError) {
      onCameraWarning(errorMessage(nextError, "카메라를 전환하지 못했습니다."));
    } finally {
      onBusyChange(false);
    }
  }

  async function applyBackground(nextEffect: Exclude<CameraEffect, "image">, imageUrl?: string) {
    if (!cameraTrack || !cameraEnabled) {
      onCameraWarning("카메라를 켠 뒤 배경 효과를 선택해 주세요.");
      return;
    }
    if (effectSupported === false) {
      onCameraWarning("이 장치에서는 실시간 배경 효과를 지원하지 않습니다.");
      return;
    }
    setEffectBusy(true);
    try {
      await cameraTrack.stopProcessor();
      if (nextEffect === "none") {
        setEffect("none");
        revokeBackgroundUrl();
      } else {
        const processors = await import("@livekit/track-processors");
        if (!processors.supportsBackgroundProcessors()) throw new Error("배경 처리 기능을 사용할 수 없습니다.");
        const processor = processors.BackgroundProcessor({
          ...(imageUrl ? { imagePath: imageUrl } : { blurRadius: 12 }),
          assetPaths: {
            modelAssetPath: "/media-segmentation/selfie_segmenter.tflite",
            tasksVisionFileSet: "/media-segmentation"
          }
        });
        await cameraTrack.setProcessor(processor);
        setEffect(imageUrl ? "image" : "blur");
        if (!imageUrl) revokeBackgroundUrl();
      }
      backgroundTrackRef.current = cameraTrack;
      onCameraWarning("");
    } catch (nextError) {
      setEffect("none");
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      onCameraWarning(errorMessage(nextError, "배경 효과를 적용하지 못했습니다."));
    } finally {
      setEffectBusy(false);
    }
  }

  async function selectBackgroundImage(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
      onCameraWarning("10MB 이하의 이미지 파일을 선택해 주세요.");
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    const previousUrl = backgroundUrlRef.current;
    backgroundUrlRef.current = nextUrl;
    await applyBackground("blur", nextUrl);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }

  async function startScreenShare() {
    if (!room || !canShareScreen || screenShareBlocked || screenActionRef.current) return;
    screenActionRef.current = true;
    onBusyChange(true);
    let permissionGranted = false;
    try {
      onUpdated(await postJson<SessionView>(`${sessionPath}/screen-share/start`, {}));
      permissionGranted = true;
      const publication = await room.localParticipant.setScreenShareEnabled(true, { audio: false });
      const track = publication?.videoTrack;
      if (!track) throw new Error("공유할 화면 트랙을 만들지 못했습니다.");
      setLocalScreenTrack(track);
      onLocalScreenTrackChange(track);
      track.mediaStreamTrack.addEventListener("ended", () => {
        if (disposingRef.current || suppressScreenEndedRef.current) return;
        if (screenActionRef.current) pendingScreenStopRef.current = "track_ended";
        else void stopScreenShare("track_ended");
      }, { once: true });
      onUpdated(await postJson<SessionView>(`${sessionPath}/screen-share/active`, {}));
      onError("");
    } catch (nextError) {
      suppressScreenEndedRef.current = true;
      await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
      suppressScreenEndedRef.current = false;
      setLocalScreenTrack(undefined);
      onLocalScreenTrackChange(undefined);
      if (permissionGranted) {
        const reason: ScreenShareStopReason = isCaptureCancellation(nextError) ? "capture_cancelled" : "publish_failed";
        await postJson<SessionView>(`${sessionPath}/screen-share/stop`, { reason })
          .then(onUpdated)
          .catch(() => undefined);
      }
      if (!isCaptureCancellation(nextError)) onError(errorMessage(nextError, "화면 공유를 시작하지 못했습니다."));
    } finally {
      screenActionRef.current = false;
      onBusyChange(false);
      const pendingReason = pendingScreenStopRef.current;
      pendingScreenStopRef.current = null;
      if (pendingReason && !disposingRef.current) void stopScreenShare(pendingReason);
    }
  }

  async function stopScreenShare(reason: ScreenShareStopReason = "user_stopped") {
    if (!room || screenActionRef.current) return;
    screenActionRef.current = true;
    onBusyChange(true);
    try {
      suppressScreenEndedRef.current = true;
      await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
      suppressScreenEndedRef.current = false;
      setLocalScreenTrack(undefined);
      onLocalScreenTrackChange(undefined);
      onUpdated(await postJson<SessionView>(`${sessionPath}/screen-share/stop`, { reason }));
      onError("");
    } catch (nextError) {
      onError(errorMessage(nextError, "화면 공유 상태를 종료하지 못했습니다."));
    } finally {
      screenActionRef.current = false;
      onBusyChange(false);
    }
  }

  async function prepareDisconnect() {
    disposingRef.current = true;
    await clearBackgroundEffect();
    suppressScreenEndedRef.current = true;
    await room?.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
    suppressScreenEndedRef.current = false;
    setLocalScreenTrack(undefined);
    onLocalScreenTrackChange(undefined);
  }

  useImperativeHandle(ref, () => ({ prepareDisconnect, stopScreenShare }));

  const sharing = screenShareStatus !== "off" || Boolean(localScreenTrack);
  return (
    <div className="live-media-controls">
      {canPublishAudio ? (
        <button className="call-control" data-enabled={microphoneEnabled} disabled={busy} onClick={() => void toggleMicrophone()} title={microphoneEnabled ? "마이크 끄기" : "마이크 켜기"} type="button">
          {microphoneEnabled ? <Mic size={21} /> : <MicOff size={21} />}
        </button>
      ) : null}
      {canPublishVideo ? (
        <button className="call-control" data-enabled={cameraEnabled} disabled={busy} onClick={() => void toggleCamera()} title={cameraEnabled ? "카메라 끄기" : "카메라 켜기"} type="button">
          {cameraEnabled ? <Camera size={21} /> : <CameraOff size={21} />}
        </button>
      ) : null}
      {canShareScreen || sharing ? (
        <button
          className="call-control screen-share-control"
          data-enabled={sharing}
          disabled={busy || (!sharing && (screenShareBlocked || !active))}
          onClick={() => void (sharing ? stopScreenShare() : startScreenShare())}
          title={sharing ? "화면 공유 중지" : screenShareBlocked ? "다른 참가자가 화면을 공유 중입니다" : "화면 공유"}
          type="button"
        >
          {sharing ? <Square size={18} /> : <MonitorUp size={21} />}
        </button>
      ) : null}
      <button className="call-control" data-open={settingsOpen} disabled={busy} onClick={() => setSettingsOpen((open) => !open)} title="미디어 장치 및 배경" type="button">
        <Settings2 size={21} />
      </button>

      {settingsOpen ? (
        <div className="live-media-settings" role="dialog" aria-label="미디어 장치 및 배경 설정">
          <div className="live-media-settings-heading">
            <strong>미디어 설정</strong>
            <button className="icon-button" disabled={deviceBusy} onClick={() => void refreshDevices()} title="장치 목록 새로 고침" type="button"><RefreshCw size={15} /></button>
          </div>
          <DeviceSelect disabled={deviceBusy} devices={devices.audioinput} kind="audioinput" label="마이크" selected={selectedDevices.audioinput} onChange={switchDevice} />
          {canPublishVideo ? <DeviceSelect disabled={deviceBusy} devices={devices.videoinput} kind="videoinput" label="카메라" selected={selectedDevices.videoinput} onChange={switchDevice} /> : null}
          {devices.audiooutput.length ? <DeviceSelect disabled={deviceBusy} devices={devices.audiooutput} kind="audiooutput" label="스피커" selected={selectedDevices.audiooutput} onChange={switchDevice} /> : null}
          {canPublishVideo ? (
            <div className="camera-effect-control">
              <span>카메라 배경</span>
              <div className="segmented-control" aria-label="카메라 배경 효과">
                <button data-active={effect === "none"} disabled={effectBusy} onClick={() => void applyBackground("none")} type="button">원본</button>
                <button data-active={effect === "blur"} disabled={effectBusy || effectSupported === false} onClick={() => void applyBackground("blur")} type="button"><Sparkles size={14} /> 흐림</button>
                <label className="background-image-button" data-active={effect === "image"}>
                  <ImageIcon size={14} /> 이미지
                  <input accept="image/*" disabled={effectBusy || effectSupported === false} onChange={(event) => void selectBackgroundImage(event.target.files?.[0])} type="file" />
                </label>
              </div>
              {effectSupported === false ? <small>이 장치는 실시간 배경 처리를 지원하지 않습니다.</small> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  function revokeBackgroundUrl() {
    if (!backgroundUrlRef.current) return;
    URL.revokeObjectURL(backgroundUrlRef.current);
    backgroundUrlRef.current = undefined;
  }
});

function DeviceSelect({
  devices,
  disabled,
  kind,
  label,
  onChange,
  selected
}: {
  devices: MediaDeviceInfo[];
  disabled: boolean;
  kind: DeviceKind;
  label: string;
  onChange: (kind: DeviceKind, deviceId: string) => Promise<void>;
  selected: string | undefined;
}) {
  return (
    <label className="live-device-select">
      <span>{label}</span>
      <select disabled={disabled || !devices.length} onChange={(event) => void onChange(kind, event.target.value)} value={selected ?? ""}>
        {!devices.length ? <option value="">사용 가능한 장치 없음</option> : null}
        {devices.map((device, index) => (
          <option key={device.deviceId || `${kind}-${index}`} value={device.deviceId}>
            {device.label || `${label} ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ScreenShareStage({
  busy,
  isSelf,
  onStop,
  sharerName,
  track
}: {
  busy: boolean;
  isSelf: boolean;
  onStop: () => void;
  sharerName: string;
  track: LocalVideoTrack | RemoteTrack | undefined;
}) {
  return (
    <section className="screen-share-stage" aria-label={`${sharerName} 화면 공유`}>
      <div className="screen-share-banner">
        <span><MonitorUp size={16} /><strong>{sharerName}</strong> 화면 공유</span>
        {isSelf ? <button disabled={busy} onClick={onStop} type="button"><Square size={13} /> 공유 중지</button> : null}
      </div>
      {track ? <AttachedMediaVideo track={track} /> : <div className="screen-share-waiting">공유 화면 연결 중</div>}
    </section>
  );
}

export function AttachedMediaVideo({ mirrored = false, track }: { mirrored?: boolean; track: LocalVideoTrack | RemoteTrack }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <video autoPlay className="call-video" data-mirrored={mirrored} muted={mirrored} playsInline ref={ref} />;
}

function isCaptureCancellation(error: unknown) {
  return error instanceof DOMException && ["AbortError", "NotAllowedError"].includes(error.name);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
