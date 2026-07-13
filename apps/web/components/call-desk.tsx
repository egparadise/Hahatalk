"use client";

import { Camera, CameraOff, Mic, MicOff, PhoneCall, PhoneOff, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalVideoTrack, RemoteTrack, Room } from "livekit-client";
import type { CallView } from "@hahatalk/contracts";
import { getJson, postJson } from "../lib/api-client";

type CallPhase = "waiting" | "connecting" | "active" | "reconnecting" | "ended" | "error";
type MediaTrack = { identity: string; sid: string; track: RemoteTrack };

export function CallDesk({
  call,
  onDismiss,
  onUpdated
}: {
  call: CallView;
  onDismiss: () => void;
  onUpdated: (call: CallView) => void;
}) {
  const [phase, setPhase] = useState<CallPhase>(call.isCreator ? "connecting" : "waiting");
  const [error, setError] = useState("");
  const [cameraWarning, setCameraWarning] = useState("");
  const [microphoneEnabled, setMicrophoneEnabledState] = useState(false);
  const [cameraEnabled, setCameraEnabledState] = useState(false);
  const [remoteTracks, setRemoteTracks] = useState<MediaTrack[]>([]);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | undefined>();
  const [isActionBusy, setIsActionBusy] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const autoJoinStartedRef = useRef(false);

  const connect = useCallback(async () => {
    if (roomRef.current || isActionBusy) return;
    setIsActionBusy(true);
    setError("");
    setCameraWarning("");
    setPhase("connecting");
    intentionalDisconnectRef.current = false;
    try {
      const credential = await postJson<{
        call: CallView;
        serverUrl: string;
        token: string;
        tokenExpiresAt: string;
      }>(`/calls/${call.id}/join`, {});
      const livekit = await import("livekit-client");
      const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(livekit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        const sid = track.sid ?? publication.trackSid;
        setRemoteTracks((current) => [
          ...current.filter((item) => item.sid !== sid),
          { identity: participant.identity, sid, track }
        ]);
      });
      room.on(livekit.RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
        setRemoteTracks((current) => current.filter((item) => item.sid !== track.sid));
      });
      room.on(livekit.RoomEvent.Reconnecting, () => setPhase("reconnecting"));
      room.on(livekit.RoomEvent.Reconnected, () => setPhase("active"));
      room.on(livekit.RoomEvent.Disconnected, () => {
        setRemoteTracks([]);
        setLocalVideoTrack(undefined);
        if (!intentionalDisconnectRef.current) {
          setError("미디어 연결이 종료되었습니다. 통화 상태를 다시 확인해 주세요.");
          setPhase("error");
        }
      });

      await room.connect(credential.serverUrl, credential.token, { autoSubscribe: true });
      await room.localParticipant.setMicrophoneEnabled(true);
      setMicrophoneEnabledState(true);
      if (call.callType === "video") {
        try {
          const publication = await room.localParticipant.setCameraEnabled(true);
          setLocalVideoTrack(publication?.videoTrack);
          setCameraEnabledState(Boolean(publication?.videoTrack));
        } catch {
          setCameraWarning("카메라 권한을 사용할 수 없어 음성으로 연결했습니다.");
        }
      }
      const connected = await postJson<CallView>(`/calls/${call.id}/connected`, {});
      onUpdated(connected);
      setPhase("active");
    } catch (nextError) {
      intentionalDisconnectRef.current = true;
      roomRef.current?.disconnect();
      roomRef.current = null;
      setError(nextError instanceof Error ? nextError.message : "통화에 연결하지 못했습니다.");
      setPhase("error");
    } finally {
      setIsActionBusy(false);
    }
  }, [call.callType, call.id, isActionBusy, onUpdated]);

  useEffect(() => {
    if (call.isCreator && call.canJoin && !autoJoinStartedRef.current) {
      autoJoinStartedRef.current = true;
      void connect();
    }
  }, [call.canJoin, call.isCreator, connect]);

  useEffect(() => {
    if (["ended", "cancelled", "failed", "expired"].includes(call.status)) {
      intentionalDisconnectRef.current = true;
      roomRef.current?.disconnect();
      roomRef.current = null;
      setPhase("ended");
    }
  }, [call.status]);

  useEffect(() => () => {
    intentionalDisconnectRef.current = true;
    roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  async function decline() {
    setIsActionBusy(true);
    setError("");
    try {
      const updated = await postJson<CallView>(`/calls/${call.id}/decline`, {});
      onUpdated(updated);
      setPhase("ended");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "통화를 거절하지 못했습니다.");
    } finally {
      setIsActionBusy(false);
    }
  }

  async function leaveOrEnd() {
    setIsActionBusy(true);
    setError("");
    intentionalDisconnectRef.current = true;
    const room = roomRef.current;
    roomRef.current = null;
    try {
      await room?.localParticipant.setCameraEnabled(false).catch(() => undefined);
      await room?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      room?.disconnect();
      const updated = await postJson<CallView>(`/calls/${call.id}/${call.canEnd ? "end" : "leave"}`, {});
      onUpdated(updated);
      setPhase("ended");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "통화를 종료하지 못했습니다.");
      setPhase("error");
    } finally {
      setIsActionBusy(false);
    }
  }

  async function toggleMicrophone() {
    const room = roomRef.current;
    if (!room) return;
    setIsActionBusy(true);
    try {
      const enabled = !microphoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(enabled);
      setMicrophoneEnabledState(enabled);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "마이크를 전환하지 못했습니다.");
    } finally {
      setIsActionBusy(false);
    }
  }

  async function toggleCamera() {
    const room = roomRef.current;
    if (!room || call.callType !== "video") return;
    setIsActionBusy(true);
    try {
      const enabled = !cameraEnabled;
      const publication = await room.localParticipant.setCameraEnabled(enabled);
      setLocalVideoTrack(enabled ? publication?.videoTrack : undefined);
      setCameraEnabledState(enabled && Boolean(publication?.videoTrack));
      setCameraWarning("");
    } catch (nextError) {
      setCameraWarning(nextError instanceof Error ? nextError.message : "카메라를 전환하지 못했습니다.");
    } finally {
      setIsActionBusy(false);
    }
  }

  async function refreshCall() {
    setIsActionBusy(true);
    try {
      onUpdated(await getJson<CallView>(`/calls/${call.id}`));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "통화 상태를 확인하지 못했습니다.");
    } finally {
      setIsActionBusy(false);
    }
  }

  const videos = new Map(
    remoteTracks.filter((item) => item.track.kind === "video").map((item) => [item.identity, item.track])
  );
  const audioTracks = remoteTracks.filter((item) => item.track.kind === "audio");
  const phaseLabel = phase === "waiting" ? "수신 통화"
    : phase === "connecting" ? "연결 중"
    : phase === "reconnecting" ? "네트워크 재연결 중"
    : phase === "active" ? "통화 중"
    : phase === "ended" ? "통화 종료"
    : "연결 오류";

  return (
    <section className="call-desk" data-phase={phase} aria-label={`${call.title} 통화`}>
      <header className="call-desk-header">
        <div>
          <span className="call-kicker">{call.callType === "video" ? "영상 통화" : "음성 통화"}</span>
          <h2>{call.title}</h2>
          <span className="call-phase">{phaseLabel}</span>
        </div>
        {phase === "ended" ? (
          <button className="icon-button call-close" onClick={onDismiss} title="통화 화면 닫기" type="button">
            <X size={20} />
          </button>
        ) : null}
      </header>

      <div className="call-media-grid" data-count={call.participants.length}>
        {call.participants.map((participant) => {
          const videoTrack = participant.isSelf ? localVideoTrack : videos.get(participant.mediaIdentity);
          return (
            <div className="call-media-tile" data-self={participant.isSelf} key={participant.person.id}>
              {videoTrack ? <AttachedVideo mirrored={participant.isSelf} track={videoTrack} /> : (
                <div className="call-avatar-stage">
                  <img alt="" src={participant.person.character.thumbnailUrl} />
                </div>
              )}
              <div className="call-participant-label">
                <strong>{participant.person.displayName}{participant.isSelf ? " (나)" : ""}</strong>
                <span>{participantStatusLabel(participant.status)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {audioTracks.map((item) => <AttachedAudio key={item.sid} track={item.track} />)}
      {cameraWarning ? <div className="call-warning" role="status">{cameraWarning}</div> : null}
      {error ? <div className="call-error" role="alert">{error}</div> : null}

      <footer className="call-controls">
        {phase === "waiting" ? (
          <>
            <button className="call-command accept" disabled={isActionBusy} onClick={() => void connect()} type="button">
              <PhoneCall size={20} /> 받기
            </button>
            <button className="call-command hangup" disabled={isActionBusy} onClick={() => void decline()} type="button">
              <PhoneOff size={20} /> 거절
            </button>
          </>
        ) : null}
        {["active", "reconnecting"].includes(phase) ? (
          <>
            <button className="call-control" data-enabled={microphoneEnabled} disabled={isActionBusy} onClick={() => void toggleMicrophone()} title={microphoneEnabled ? "마이크 끄기" : "마이크 켜기"} type="button">
              {microphoneEnabled ? <Mic size={21} /> : <MicOff size={21} />}
            </button>
            {call.callType === "video" ? (
              <button className="call-control" data-enabled={cameraEnabled} disabled={isActionBusy} onClick={() => void toggleCamera()} title={cameraEnabled ? "카메라 끄기" : "카메라 켜기"} type="button">
                {cameraEnabled ? <Camera size={21} /> : <CameraOff size={21} />}
              </button>
            ) : null}
            <button className="call-control hangup" disabled={isActionBusy} onClick={() => void leaveOrEnd()} title={call.canEnd ? "모두의 통화 종료" : "통화 나가기"} type="button">
              <PhoneOff size={22} />
            </button>
          </>
        ) : null}
        {phase === "error" ? (
          <>
            {call.canJoin ? (
              <button className="call-command" disabled={isActionBusy} onClick={() => void connect()} type="button">
                <RefreshCw size={18} /> 다시 연결
              </button>
            ) : (
              <button className="call-command" disabled={isActionBusy} onClick={() => void refreshCall()} type="button">
                <RefreshCw size={18} /> 상태 확인
              </button>
            )}
            {!call.canJoin ? <button className="call-command" onClick={onDismiss} type="button">닫기</button> : null}
            {call.canEnd || call.canLeave ? (
              <button className="call-command hangup" disabled={isActionBusy} onClick={() => void leaveOrEnd()} type="button">
                <PhoneOff size={18} /> 종료
              </button>
            ) : null}
          </>
        ) : null}
        {phase === "ended" ? (
          <button className="call-command" onClick={onDismiss} type="button">채팅으로 돌아가기</button>
        ) : null}
      </footer>
    </section>
  );
}

function AttachedVideo({ mirrored = false, track }: { mirrored?: boolean; track: LocalVideoTrack | RemoteTrack }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <video autoPlay className="call-video" data-mirrored={mirrored} muted={mirrored} playsInline ref={ref} />;
}

function AttachedAudio({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <audio autoPlay ref={ref} />;
}

function participantStatusLabel(status: CallView["participants"][number]["status"]) {
  return {
    connecting: "연결 중",
    declined: "거절",
    invited: "응답 대기",
    joined: "참여 중",
    left: "나감",
    missed: "부재중",
    removed: "종료됨"
  }[status];
}
