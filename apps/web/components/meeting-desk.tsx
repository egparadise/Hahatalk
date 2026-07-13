"use client";

import {
  Check,
  Crown,
  DoorOpen,
  LoaderCircle,
  PhoneOff,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
  UserRoundX,
  Users,
  Video,
  Volume2,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalVideoTrack, RemoteTrack, Room } from "livekit-client";
import type {
  CallCapabilities,
  CallType,
  CalendarOccurrenceView,
  MeetingRole,
  MeetingView
} from "@hahatalk/contracts";
import { getJson, postJson } from "../lib/api-client";
import {
  AttachedMediaVideo,
  LiveMediaControls,
  type LiveMediaControlsHandle,
  ScreenShareStage
} from "./live-media-controls";

type MediaTrack = { identity: string; sid: string; track: RemoteTrack };
type MeetingPhase = "connecting" | "active" | "reconnecting" | "ended" | "error";

const roleLabels: Record<MeetingRole, string> = {
  attendee: "참석자",
  cohost: "공동 진행",
  host: "진행자",
  speaker: "발표자"
};

export function MeetingLobbyPanel({
  busy,
  callType,
  capabilities,
  error,
  event,
  loading,
  meeting,
  roleDrafts,
  onAdmit,
  onCallTypeChange,
  onChangeRole,
  onDeny,
  onEnd,
  onEnter,
  onJoin,
  onLeave,
  onOpen,
  onRefresh,
  onRoleDraftChange,
  onSchedule
}: {
  busy: boolean;
  callType: CallType;
  capabilities: CallCapabilities | null;
  error: string;
  event: CalendarOccurrenceView;
  loading: boolean;
  meeting: MeetingView | null;
  roleDrafts: Record<string, Exclude<MeetingRole, "host">>;
  onAdmit: (userId: string) => void;
  onCallTypeChange: (callType: CallType) => void;
  onChangeRole: (userId: string, role: Exclude<MeetingRole, "host">) => void;
  onDeny: (userId: string) => void;
  onEnd: () => void;
  onEnter: () => void;
  onJoin: () => void;
  onLeave: () => void;
  onOpen: () => void;
  onRefresh: () => void;
  onRoleDraftChange: (userId: string, role: Exclude<MeetingRole, "host">) => void;
  onSchedule: () => void;
}) {
  const eligible = event.status === "scheduled" && !event.allDay && Boolean(event.space) && Boolean(event.attendees?.length);
  return (
    <section className="meeting-lobby" data-status={meeting?.status ?? "none"}>
      <div className="meeting-lobby-heading">
        <span><Video size={15} /> 예약 회의</span>
        {meeting ? <strong>{meetingStatusLabel(meeting.status)}</strong> : null}
      </div>
      {loading ? <div className="meeting-lobby-state"><LoaderCircle className="spin" size={18} /> 회의 확인 중</div> : null}
      {error ? (
        <div className="meeting-lobby-error" role="alert">
          <span>{error}</span>
          <button className="icon-button" onClick={onRefresh} title="회의 상태 다시 확인" type="button"><RefreshCw size={15} /></button>
        </div>
      ) : null}
      {!loading && !meeting && !error ? (
        event.isCreator && eligible ? (
          <>
            <div className="segmented-control meeting-type-control" aria-label="회의 종류">
              <button data-active={callType === "voice"} onClick={() => onCallTypeChange("voice")} type="button"><Volume2 size={14} /> 음성</button>
              <button data-active={callType === "video"} onClick={() => onCallTypeChange("video")} type="button"><Video size={14} /> 영상</button>
            </div>
            <div className="meeting-role-editor">
              {event.attendees?.map((attendee) => (
                <label key={attendee.person.id}>
                  <span><img alt="" className="avatar" src={attendee.person.character.thumbnailUrl} />{attendee.person.displayName}</span>
                  <select
                    className="text-input"
                    disabled={attendee.person.role === "guest" || attendee.person.role === "subscriber" || attendee.response === "declined"}
                    onChange={(changeEvent) => onRoleDraftChange(attendee.person.id, changeEvent.target.value as Exclude<MeetingRole, "host">)}
                    value={roleDrafts[attendee.person.id] ?? "attendee"}
                  >
                    <option value="attendee">참석자</option>
                    <option value="speaker">발표자</option>
                    <option value="cohost">공동 진행</option>
                  </select>
                </label>
              ))}
            </div>
          <button className="primary-button meeting-primary" disabled={busy || capabilities?.available === false} onClick={onSchedule} type="button">
              <Video size={16} /> 회의 예약
            </button>
          </>
        ) : <div className="meeting-lobby-state">예약된 회의가 없습니다.</div>
      ) : null}
      {meeting ? (
        <>
          <div className="meeting-window-row">
            <span>{meeting.callType === "video" ? <Video size={14} /> : <Volume2 size={14} />}{meeting.callType === "video" ? "영상 회의" : "음성 회의"}</span>
            <small>{meeting.myRole === "host" ? <Crown size={13} /> : meeting.myRole === "cohost" ? <ShieldCheck size={13} /> : null}{roleLabels[meeting.myRole]}</small>
          </div>
          {meeting.status === "scheduled" && !meeting.canOpen ? (
            <div className="meeting-lobby-state">로비 오픈 · {formatDateTime(meeting.lobbyOpensAt)}</div>
          ) : null}
          <div className="meeting-actions">
            {meeting.canOpen ? <button className="primary-button" disabled={busy} onClick={onOpen} type="button"><DoorOpen size={16} /> 로비 열기</button> : null}
            {meeting.canEnter ? <button className="primary-button" disabled={busy} onClick={onEnter} type="button"><DoorOpen size={16} /> 대기실 입장</button> : null}
            {meeting.myStatus === "waiting" ? <span className="meeting-waiting"><LoaderCircle className="spin" size={15} /> 승인 대기</span> : null}
            {meeting.canJoin ? <button className="primary-button" disabled={busy} onClick={onJoin} type="button"><Video size={16} /> 회의 참가</button> : null}
            {meeting.canLeave && meeting.myStatus !== "joined" ? <button className="secondary-button" disabled={busy} onClick={onLeave} type="button"><X size={15} /> 나가기</button> : null}
            {meeting.canEnd ? <button className="secondary-button danger-button" disabled={busy} onClick={onEnd} type="button"><PhoneOff size={16} /> 회의 종료</button> : null}
          </div>
          <div className="meeting-participant-list">
            {meeting.participants.map((participant) => (
              <div data-status={participant.status} key={participant.person.id}>
                <img alt="" className="avatar" src={participant.person.character.thumbnailUrl} />
                <span><strong>{participant.person.displayName}{participant.isSelf ? " (나)" : ""}</strong><small>{roleLabels[participant.role]} · {meetingParticipantStatusLabel(participant.status)}</small></span>
                {meeting.canManageRoles && participant.role !== "host" ? (
                  <select
                    className="text-input"
                    disabled={busy || participant.status === "connecting" || participant.status === "declined"}
                    onChange={(changeEvent) => onChangeRole(participant.person.id, changeEvent.target.value as Exclude<MeetingRole, "host">)}
                    value={participant.role}
                  >
                    <option value="attendee">참석자</option>
                    <option value="speaker">발표자</option>
                    <option value="cohost">공동 진행</option>
                  </select>
                ) : <span className="meeting-role-chip">{roleLabels[participant.role]}</span>}
                {meeting.canAdmit && participant.status === "waiting" ? (
                  <span className="meeting-moderation-actions">
                    <button className="icon-button" disabled={busy} onClick={() => onAdmit(participant.person.id)} title="입장 승인" type="button"><UserRoundCheck size={16} /></button>
                    <button className="icon-button danger-button" disabled={busy} onClick={() => onDeny(participant.person.id)} title="입장 거절" type="button"><UserRoundX size={16} /></button>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function MeetingRoom({ meeting, onClose, onUpdated }: {
  meeting: MeetingView;
  onClose: () => void;
  onUpdated: (meeting: MeetingView) => void;
}) {
  const [phase, setPhase] = useState<MeetingPhase>("connecting");
  const [error, setError] = useState("");
  const [cameraWarning, setCameraWarning] = useState("");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [remoteTracks, setRemoteTracks] = useState<MediaTrack[]>([]);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | undefined>();
  const [localScreenTrack, setLocalScreenTrack] = useState<LocalVideoTrack | undefined>();
  const [busy, setBusy] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const mediaControlsRef = useRef<LiveMediaControlsHandle>(null);
  const intentionalDisconnectRef = useRef(false);
  const connectStartedRef = useRef(false);
  const self = meeting.participants.find((participant) => participant.isSelf);

  const connect = useCallback(async () => {
    if (roomRef.current || busy) return;
    setBusy(true);
    setError("");
    setPhase("connecting");
    intentionalDisconnectRef.current = false;
    try {
      const credential = await postJson<{
        meeting: MeetingView;
        serverUrl: string;
        token: string;
        tokenExpiresAt: string;
      }>(`/meetings/${meeting.id}/join`, {});
      const livekit = await import("livekit-client");
      const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(livekit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        const sid = track.sid ?? publication.trackSid;
        setRemoteTracks((current) => [...current.filter((item) => item.sid !== sid), { identity: participant.identity, sid, track }]);
      });
      room.on(livekit.RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
        setRemoteTracks((current) => current.filter((item) => item.sid !== track.sid));
      });
      room.on(livekit.RoomEvent.Reconnecting, () => setPhase("reconnecting"));
      room.on(livekit.RoomEvent.Reconnected, () => setPhase("active"));
      room.on(livekit.RoomEvent.ParticipantPermissionsChanged, (permissions, participant) => {
        if (participant.isLocal && !permissions?.canPublish) {
          setMicrophoneEnabled(false);
          setCameraEnabled(false);
          setLocalVideoTrack(undefined);
        }
      });
      room.on(livekit.RoomEvent.Disconnected, () => {
        setRemoteTracks([]);
        setLocalVideoTrack(undefined);
        setLocalScreenTrack(undefined);
        if (!intentionalDisconnectRef.current) {
          setError("미디어 연결이 종료되었습니다. 회의 상태를 다시 확인해 주세요.");
          setPhase("error");
        }
      });
      await room.connect(credential.serverUrl, credential.token, { autoSubscribe: true });
      if (self?.canPublishAudio) {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicrophoneEnabled(true);
      }
      if (self?.canPublishVideo && meeting.callType === "video") {
        try {
          const publication = await room.localParticipant.setCameraEnabled(true);
          setLocalVideoTrack(publication?.videoTrack);
          setCameraEnabled(Boolean(publication?.videoTrack));
        } catch {
          setCameraWarning("카메라 권한을 사용할 수 없어 음성으로 연결했습니다.");
        }
      }
      const connected = await postJson<MeetingView>(`/meetings/${meeting.id}/connected`, {});
      onUpdated(connected);
      setPhase("active");
    } catch (nextError) {
      intentionalDisconnectRef.current = true;
      roomRef.current?.disconnect();
      roomRef.current = null;
      setError(nextError instanceof Error ? nextError.message : "회의에 연결하지 못했습니다.");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, [busy, meeting.callType, meeting.id, onUpdated, self?.canPublishAudio, self?.canPublishVideo]);

  useEffect(() => {
    if (meeting.canJoin && !connectStartedRef.current) {
      connectStartedRef.current = true;
      void connect();
    }
  }, [connect, meeting.canJoin]);

  useEffect(() => {
    if (["ended", "cancelled", "failed", "expired"].includes(meeting.status)) {
      intentionalDisconnectRef.current = true;
      roomRef.current?.disconnect();
      roomRef.current = null;
      setPhase("ended");
    }
  }, [meeting.status]);

  useEffect(() => {
    if (!self?.canPublishAudio) setMicrophoneEnabled(false);
    if (!self?.canPublishVideo) {
      setCameraEnabled(false);
      setLocalVideoTrack(undefined);
    }
  }, [self?.canPublishAudio, self?.canPublishVideo]);

  useEffect(() => () => {
    intentionalDisconnectRef.current = true;
    roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  async function leave() {
    setBusy(true);
    intentionalDisconnectRef.current = true;
    const room = roomRef.current;
    roomRef.current = null;
    try {
      await mediaControlsRef.current?.prepareDisconnect();
      await room?.localParticipant.setCameraEnabled(false).catch(() => undefined);
      await room?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      room?.disconnect();
      onUpdated(await postJson<MeetingView>(`/meetings/${meeting.id}/leave`, {}));
      setPhase("ended");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "회의에서 나가지 못했습니다.");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      onUpdated(await getJson<MeetingView>(`/meetings/${meeting.id}`));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "회의 상태를 확인하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const videos = new Map(remoteTracks.filter((item) => item.track.kind === "video" && item.track.source === "camera").map((item) => [item.identity, item.track]));
  const audioTracks = remoteTracks.filter((item) => item.track.kind === "audio" && item.track.source === "microphone");
  const remoteScreen = remoteTracks.find((item) => item.track.kind === "video" && item.track.source === "screen_share");
  const screenSharer = meeting.participants.find((participant) => participant.screenShareStatus !== "off")
    ?? meeting.participants.find((participant) => participant.mediaIdentity === remoteScreen?.identity);
  const screenTrack = screenSharer?.isSelf ? localScreenTrack : remoteScreen?.track;
  const visibleParticipants = meeting.participants.filter((participant) => ["admitted", "connecting", "joined"].includes(participant.status));
  const phaseLabel = phase === "connecting" ? "연결 중"
    : phase === "reconnecting" ? "네트워크 재연결 중"
    : phase === "active" ? "회의 중"
    : phase === "ended" ? "회의 종료"
    : "연결 오류";

  return (
    <section className="call-desk meeting-room" data-phase={phase} aria-label={`${meeting.title} 회의`}>
      <header className="call-desk-header">
        <div><span className="call-kicker">{meeting.callType === "video" ? "예약 영상 회의" : "예약 음성 회의"}</span><h2>{meeting.title}</h2><span className="call-phase">{phaseLabel} · {roleLabels[meeting.myRole]}</span></div>
        {phase === "ended" ? <button className="icon-button call-close" onClick={onClose} title="회의 화면 닫기" type="button"><X size={20} /></button> : null}
      </header>
      {screenSharer ? (
        <ScreenShareStage
          busy={busy}
          isSelf={screenSharer.isSelf}
          onStop={() => void mediaControlsRef.current?.stopScreenShare()}
          sharerName={screenSharer.isSelf ? "내" : `${screenSharer.person.displayName}님의`}
          track={screenTrack}
        />
      ) : null}
      <div className="call-media-grid" data-count={Math.max(1, visibleParticipants.length)}>
        {visibleParticipants.map((participant) => {
          const videoTrack = participant.isSelf ? localVideoTrack : videos.get(participant.mediaIdentity);
          return (
            <div className="call-media-tile" data-self={participant.isSelf} key={participant.person.id}>
              {videoTrack ? <AttachedMediaVideo mirrored={participant.isSelf} track={videoTrack} /> : <div className="call-avatar-stage"><img alt="" src={participant.person.character.thumbnailUrl} /></div>}
              <div className="call-participant-label"><strong>{participant.person.displayName}{participant.isSelf ? " (나)" : ""}</strong><span>{roleLabels[participant.role]} · {meetingParticipantStatusLabel(participant.status)}</span></div>
            </div>
          );
        })}
        {!visibleParticipants.length ? <div className="meeting-empty-stage"><Users size={30} /><span>참가자 연결 대기</span></div> : null}
      </div>
      {audioTracks.map((item) => <AttachedAudio key={item.sid} track={item.track} />)}
      {cameraWarning ? <div className="call-warning" role="status">{cameraWarning}</div> : null}
      {error ? <div className="call-error" role="alert">{error}</div> : null}
      <footer className="call-controls">
        {["active", "reconnecting"].includes(phase) ? (
          <>
            <LiveMediaControls
              active={phase === "active"}
              busy={busy}
              cameraEnabled={cameraEnabled}
              cameraTrack={localVideoTrack}
              canPublishAudio={Boolean(self?.canPublishAudio)}
              canPublishVideo={Boolean(self?.canPublishVideo && meeting.callType === "video")}
              canShareScreen={meeting.canShareScreen}
              microphoneEnabled={microphoneEnabled}
              onBusyChange={setBusy}
              onCameraEnabledChange={setCameraEnabled}
              onCameraTrackChange={setLocalVideoTrack}
              onCameraWarning={setCameraWarning}
              onError={setError}
              onLocalScreenTrackChange={setLocalScreenTrack}
              onMicrophoneEnabledChange={setMicrophoneEnabled}
              onUpdated={(updated) => onUpdated(updated as MeetingView)}
              ref={mediaControlsRef}
              room={roomRef.current}
              screenShareBlocked={Boolean(screenSharer && !screenSharer.isSelf)}
              screenShareStatus={self?.screenShareStatus ?? "off"}
              sessionPath={`/meetings/${meeting.id}`}
            />
            <button className="call-control hangup" disabled={busy} onClick={() => void leave()} title="회의 나가기" type="button"><PhoneOff size={22} /></button>
          </>
        ) : null}
        {phase === "error" ? <><button className="call-command" disabled={busy} onClick={() => void connect()} type="button"><RefreshCw size={18} /> 다시 연결</button><button className="call-command" disabled={busy} onClick={() => void refresh()} type="button"><RefreshCw size={18} /> 상태 확인</button><button className="call-command hangup" disabled={busy} onClick={() => void leave()} type="button"><PhoneOff size={18} /> 나가기</button></> : null}
        {phase === "ended" ? <button className="call-command" onClick={onClose} type="button"><Check size={17} /> 일정으로 돌아가기</button> : null}
      </footer>
    </section>
  );
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

function meetingStatusLabel(status: MeetingView["status"]) {
  return {
    active: "진행 중",
    cancelled: "취소",
    ended: "종료",
    expired: "만료",
    failed: "열기 실패",
    lobby_open: "로비 열림",
    scheduled: "예약됨",
    starting: "로비 여는 중"
  }[status];
}

function meetingParticipantStatusLabel(status: MeetingView["participants"][number]["status"]) {
  return {
    admitted: "입장 승인",
    connecting: "연결 중",
    declined: "불참",
    invited: "초대됨",
    joined: "참여 중",
    left: "나감",
    missed: "미참석",
    removed: "입장 종료",
    waiting: "승인 대기"
  }[status];
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  }).format(new Date(value));
}
