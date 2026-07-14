"use client";

import {
  Bell,
  BellOff,
  CalendarDays,
  Check,
  Clock3,
  ExternalLink,
  FolderOpen,
  LogOut,
  MessageCircle,
  Mic,
  MicOff,
  PanelRightOpen,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  UserRoundCog,
  UserX,
  Users,
  Video,
  VideoOff,
  X
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalVideoTrack, RemoteTrack, Room } from "livekit-client";
import { io } from "socket.io-client";
import {
  type AuthSession,
  type BroadcastChannelSummary,
  type BroadcastChannelVisibility,
  type BroadcastChatMode,
  type BroadcastDashboard,
  type BroadcastJoinView,
  type BroadcastMessageKind,
  type BroadcastMessageView,
  type BroadcastNotificationLevel,
  type BroadcastParticipantView,
  type BroadcastReaction,
  type BroadcastReactionCount,
  type BroadcastRole,
  type BroadcastSessionView,
  type CallType,
  type User
} from "@hahatalk/contracts";
import { apiBaseUrl, getJson, postJson, requestJson } from "../lib/api-client";
import { AttachedMediaVideo } from "./live-media-controls";

type BroadcastDeskProps = {
  authSession: AuthSession;
  currentUser: User;
  onLogout: () => void;
  onOpenCalendar: () => void;
  onOpenChat: () => void;
  onOpenChatSpace: (spaceId: string) => void;
  onOpenContacts: () => void;
};

type MediaPhase = "idle" | "connecting" | "active" | "reconnecting" | "error";
type RemoteMedia = { identity: string; name: string; sid: string; track: RemoteTrack };
type PanelMode = "conversation" | "moderation";

const roleLabels: Record<BroadcastRole, string> = {
  cohost: "공동 진행",
  host: "진행자",
  speaker: "발언자",
  viewer: "시청자"
};

const statusLabels: Record<BroadcastSessionView["status"], string> = {
  cancelled: "취소",
  ended: "종료",
  failed: "실패",
  live: "방송 중",
  scheduled: "예약",
  starting: "시작 중"
};

const reactionOptions: Array<{ label: string; reaction: BroadcastReaction }> = [
  { label: "좋아요", reaction: "like" },
  { label: "박수", reaction: "applause" },
  { label: "감사", reaction: "thanks" },
  { label: "질문", reaction: "question" },
  { label: "축하", reaction: "celebrate" }
];

export function BroadcastDesk({
  authSession,
  currentUser,
  onLogout,
  onOpenCalendar,
  onOpenChat,
  onOpenChatSpace,
  onOpenContacts
}: BroadcastDeskProps) {
  const requestedChannelId = typeof window === "undefined"
    ? ""
    : new URLSearchParams(window.location.search).get("channel") ?? "";
  const [dashboard, setDashboard] = useState<BroadcastDashboard | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState(requestedChannelId);
  const [broadcast, setBroadcast] = useState<BroadcastSessionView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("conversation");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [messageKind, setMessageKind] = useState<BroadcastMessageKind>("chat");
  const [messageBody, setMessageBody] = useState("");
  const [mediaPhase, setMediaPhase] = useState<MediaPhase>("idle");
  const [mediaWarning, setMediaWarning] = useState("");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack>();
  const [remoteMedia, setRemoteMedia] = useState<RemoteMedia[]>([]);
  const roomRef = useRef<Room | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const broadcastRef = useRef<BroadcastSessionView | null>(null);

  const selectedChannel = useMemo(
    () => dashboard?.channels.find((channel) => channel.id === selectedChannelId),
    [dashboard?.channels, selectedChannelId]
  );
  const pendingMessages = broadcast?.messages.filter((message) => message.status === "pending") ?? [];
  const stageTracks = remoteMedia.filter((item) => item.track.kind === "video" && item.track.source === "camera");
  const remoteAudio = remoteMedia.filter((item) => item.track.kind === "audio");

  useEffect(() => {
    broadcastRef.current = broadcast;
  }, [broadcast]);

  const refreshDashboard = useCallback(async (preferredChannelId?: string, quiet = false) => {
    if (quiet) setIsRefreshing(true);
    else setIsLoading(true);
    setError("");
    try {
      const next = await getJson<BroadcastDashboard>("/broadcasts");
      setDashboard(next);
      setSelectedChannelId((current) => {
        const preferred = preferredChannelId ?? current;
        if (preferred && next.channels.some((channel) => channel.id === preferred)) return preferred;
        return next.channels.find((channel) => channel.nextSession?.status === "live")?.id
          ?? next.channels[0]?.id
          ?? "";
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "방송 채널을 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  const refreshBroadcast = useCallback(async (sessionId?: string, quiet = false) => {
    const targetId = sessionId ?? broadcastRef.current?.id;
    if (!targetId) return;
    if (!quiet) setBusyAction("refresh-session");
    try {
      const next = await getJson<BroadcastSessionView>(`/broadcasts/sessions/${targetId}`);
      setBroadcast(next);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "방송 상태를 확인하지 못했습니다.");
    } finally {
      if (!quiet) setBusyAction("");
    }
  }, []);

  useEffect(() => {
    void refreshDashboard();
  }, [authSession.user.id, refreshDashboard]);

  useEffect(() => {
    const sessionId = selectedChannel?.nextSession?.id;
    setNotice("");
    setError("");
    if (!sessionId) {
      setBroadcast(null);
      return;
    }
    void refreshBroadcast(sessionId);
  }, [selectedChannel?.id, selectedChannel?.nextSession?.id, refreshBroadcast]);

  useEffect(() => {
    const socket = io(apiBaseUrl, { transports: ["websocket"], withCredentials: true });
    socket.on("broadcast:updated", (payload: { channelId?: string; sessionId?: string }) => {
      void refreshDashboard(selectedChannelId, true);
      if (payload.sessionId && payload.sessionId === broadcastRef.current?.id) {
        void refreshBroadcast(payload.sessionId, true);
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [refreshBroadcast, refreshDashboard, selectedChannelId]);

  useEffect(() => {
    if (broadcast?.status !== "live") return;
    const timer = window.setInterval(() => void refreshBroadcast(broadcast.id, true), 3_000);
    return () => window.clearInterval(timer);
  }, [broadcast?.id, broadcast?.status, refreshBroadcast]);

  useEffect(() => {
    if (broadcast && broadcast.status !== "live" && roomRef.current) disconnectMedia();
  }, [broadcast?.status]);

  useEffect(() => {
    if (broadcast?.myRole !== "viewer" || !roomRef.current) return;
    void roomRef.current.localParticipant.setCameraEnabled(false).catch(() => undefined);
    void roomRef.current.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    setLocalVideoTrack(undefined);
    setMicrophoneEnabled(false);
    setCameraEnabled(false);
  }, [broadcast?.myRole]);

  useEffect(() => () => disconnectMedia(), []);

  async function perform<T>(action: string, operation: () => Promise<T>, success?: string) {
    setBusyAction(action);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      if (success) setNotice(success);
      return result;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "요청을 처리하지 못했습니다.");
      return undefined;
    } finally {
      setBusyAction("");
    }
  }

  async function createChannel(input: {
    description: string;
    handle: string;
    name: string;
    visibility: BroadcastChannelVisibility;
  }) {
    const created = await perform(
      "create-channel",
      () => postJson<BroadcastChannelSummary>("/broadcasts/channels", input),
      "방송 채널을 만들었습니다."
    );
    if (!created) return;
    setShowCreateChannel(false);
    await refreshDashboard(created.id, true);
  }

  async function changeSubscription(level?: BroadcastNotificationLevel) {
    if (!selectedChannel) return;
    const updated = level
      ? await perform(
          "subscribe",
          () => postJson<BroadcastChannelSummary>(`/broadcasts/channels/${selectedChannel.id}/subscribe`, {
            notificationLevel: level
          }),
          selectedChannel.isSubscribed ? "알림 설정을 바꿨습니다." : "채널을 구독했습니다."
        )
      : await perform(
          "unsubscribe",
          () => requestJson<BroadcastChannelSummary>(`/broadcasts/channels/${selectedChannel.id}/subscription`, "DELETE"),
          "채널 구독을 해제했습니다."
        );
    if (updated) await refreshDashboard(updated.id, true);
  }

  async function scheduleBroadcast(input: {
    callType: CallType;
    chatMode: BroadcastChatMode;
    description: string;
    expectedEndAt: string;
    replayRequested: boolean;
    scheduledFor: string;
    title: string;
    viewerLimit: number;
  }) {
    if (!selectedChannel) return;
    const created = await perform(
      "schedule",
      () => postJson<BroadcastSessionView>(`/broadcasts/channels/${selectedChannel.id}/sessions`, {
        ...input,
        clientSessionId: crypto.randomUUID(),
        expectedEndAt: new Date(input.expectedEndAt).toISOString(),
        scheduledFor: new Date(input.scheduledFor).toISOString()
      }),
      "방송을 예약했습니다."
    );
    if (!created) return;
    setBroadcast(created);
    setShowSchedule(false);
    await refreshDashboard(selectedChannel.id, true);
  }

  async function startBroadcast() {
    if (!broadcast) return;
    const started = await perform(
      "start",
      () => postJson<BroadcastSessionView>(`/broadcasts/sessions/${broadcast.id}/start`, { version: broadcast.version }),
      "방송을 시작했습니다."
    );
    if (!started) return;
    setBroadcast(started);
    await connectMedia(started);
  }

  async function connectMedia(target = broadcastRef.current) {
    if (!target || roomRef.current) return;
    setBusyAction("join");
    setError("");
    setMediaWarning("");
    setMediaPhase("connecting");
    intentionalDisconnectRef.current = false;
    try {
      const credential = await postJson<BroadcastJoinView>(`/broadcasts/sessions/${target.id}/join`, {});
      setBroadcast(credential.broadcast);
      const livekit = await import("livekit-client");
      const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(livekit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        const sid = track.sid ?? publication.trackSid;
        setRemoteMedia((current) => [
          ...current.filter((item) => item.sid !== sid),
          { identity: participant.identity, name: participant.name || "발언자", sid, track }
        ]);
      });
      room.on(livekit.RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
        setRemoteMedia((current) => current.filter((item) => item.sid !== track.sid));
      });
      room.on(livekit.RoomEvent.Reconnecting, () => setMediaPhase("reconnecting"));
      room.on(livekit.RoomEvent.Reconnected, () => setMediaPhase("active"));
      room.on(livekit.RoomEvent.Disconnected, () => {
        setRemoteMedia([]);
        setLocalVideoTrack(undefined);
        setMicrophoneEnabled(false);
        setCameraEnabled(false);
        if (!intentionalDisconnectRef.current) {
          setMediaPhase("error");
          setError("방송 미디어 연결이 종료되었습니다. 다시 입장해 주세요.");
        }
      });
      await room.connect(credential.serverUrl, credential.token, { autoSubscribe: true });
      if (credential.broadcast.myRole !== "viewer") {
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          setMicrophoneEnabled(true);
        } catch {
          setMediaWarning("마이크 권한을 사용할 수 없습니다. 장치 설정을 확인해 주세요.");
        }
        if (credential.broadcast.callType === "video") {
          try {
            const publication = await room.localParticipant.setCameraEnabled(true);
            setLocalVideoTrack(publication?.videoTrack);
            setCameraEnabled(Boolean(publication?.videoTrack));
          } catch {
            setMediaWarning("카메라를 사용할 수 없어 음성으로 입장했습니다.");
          }
        }
      }
      const connected = await postJson<BroadcastSessionView>(`/broadcasts/sessions/${target.id}/connected`, {});
      setBroadcast(connected);
      setMediaPhase("active");
    } catch (nextError) {
      disconnectMedia();
      setMediaPhase("error");
      setError(nextError instanceof Error ? nextError.message : "방송에 입장하지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  function disconnectMedia() {
    intentionalDisconnectRef.current = true;
    const room = roomRef.current;
    roomRef.current = null;
    room?.localParticipant.setCameraEnabled(false).catch(() => undefined);
    room?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    room?.disconnect();
    setRemoteMedia([]);
    setLocalVideoTrack(undefined);
    setMicrophoneEnabled(false);
    setCameraEnabled(false);
    setMediaPhase("idle");
  }

  async function leaveBroadcast() {
    if (!broadcast) return;
    disconnectMedia();
    const updated = await perform(
      "leave",
      () => postJson<BroadcastSessionView>(`/broadcasts/sessions/${broadcast.id}/leave`, {}),
      "방송에서 나왔습니다."
    );
    if (updated) setBroadcast(updated);
  }

  async function endBroadcast() {
    if (!broadcast) return;
    disconnectMedia();
    const updated = await perform(
      "end",
      () => postJson<BroadcastSessionView>(`/broadcasts/sessions/${broadcast.id}/end`, { version: broadcast.version }),
      "방송을 종료했습니다."
    );
    if (updated) {
      setBroadcast(updated);
      await refreshDashboard(updated.channelId, true);
    }
  }

  async function toggleMicrophone() {
    const room = roomRef.current;
    if (!room) return;
    setBusyAction("microphone");
    try {
      await room.localParticipant.setMicrophoneEnabled(!microphoneEnabled);
      setMicrophoneEnabled((current) => !current);
      setMediaWarning("");
    } catch (nextError) {
      setMediaWarning(nextError instanceof Error ? nextError.message : "마이크 상태를 바꾸지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  async function toggleCamera() {
    const room = roomRef.current;
    if (!room) return;
    setBusyAction("camera");
    try {
      const publication = await room.localParticipant.setCameraEnabled(!cameraEnabled);
      setLocalVideoTrack(publication?.videoTrack);
      setCameraEnabled(Boolean(publication?.videoTrack));
      setMediaWarning("");
    } catch (nextError) {
      setMediaWarning(nextError instanceof Error ? nextError.message : "카메라 상태를 바꾸지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!broadcast || !messageBody.trim()) return;
    const updated = await perform(
      "message",
      () => postJson<BroadcastSessionView>(`/broadcasts/sessions/${broadcast.id}/messages`, {
        body: messageBody.trim(),
        clientMessageId: crypto.randomUUID(),
        kind: messageKind
      })
    );
    if (updated) {
      setBroadcast(updated);
      setMessageBody("");
    }
  }

  async function moderateMessage(message: BroadcastMessageView, action: "publish" | "hide" | "restore" | "dismiss") {
    if (!broadcast) return;
    const updated = await perform(
      `moderate-message:${message.id}`,
      () => requestJson<BroadcastSessionView>(
        `/broadcasts/sessions/${broadcast.id}/messages/${message.id}/moderate`,
        "PATCH",
        { action, version: message.version }
      )
    );
    if (updated) setBroadcast(updated);
  }

  async function sendReaction(reaction: BroadcastReaction) {
    if (!broadcast) return;
    const counts = await perform(
      `reaction:${reaction}`,
      () => postJson<BroadcastReactionCount[]>(`/broadcasts/sessions/${broadcast.id}/reactions`, {
        clientReactionId: crypto.randomUUID(),
        reaction
      })
    );
    if (counts) setBroadcast((current) => current ? { ...current, reactionCounts: counts } : current);
  }

  async function changeRole(participant: BroadcastParticipantView, role: Exclude<BroadcastRole, "host">) {
    if (!broadcast) return;
    const updated = await perform(
      `role:${participant.person.id}`,
      () => requestJson<BroadcastSessionView>(
        `/broadcasts/sessions/${broadcast.id}/participants/${participant.person.id}/role`,
        "PATCH",
        { role, version: broadcast.version }
      )
    );
    if (updated) setBroadcast(updated);
  }

  async function moderateParticipant(participant: BroadcastParticipantView, action: "remove" | "block" | "unblock") {
    if (!broadcast) return;
    const updated = await perform(
      `${action}:${participant.person.id}`,
      () => postJson<BroadcastSessionView>(
        `/broadcasts/sessions/${broadcast.id}/participants/${participant.person.id}/moderate`,
        { action }
      )
    );
    if (updated) setBroadcast(updated);
  }

  async function requestPrivateService() {
    if (!selectedChannel) return;
    const handoff = await perform(
      "handoff",
      () => postJson<{ spaceId: string }>(`/broadcasts/channels/${selectedChannel.id}/private-handoff`, {})
    );
    if (handoff) onOpenChatSpace(handoff.spaceId);
  }

  function selectChannel(channel: BroadcastChannelSummary) {
    setSelectedChannelId(channel.id);
    const url = new URL(window.location.href);
    url.searchParams.set("desk", "broadcast");
    url.searchParams.set("channel", channel.id);
    window.history.replaceState(null, "", url);
  }

  function popOut() {
    const url = new URL(window.location.href);
    url.searchParams.set("desk", "broadcast");
    if (selectedChannelId) url.searchParams.set("channel", selectedChannelId);
    window.open(url.toString(), `hahatalk-broadcast-${Date.now()}`, "width=1440,height=900");
  }

  return (
    <main className="app-shell broadcast-shell">
      <nav className="rail" aria-label="주요 이동">
        <div className="brand-mark">인</div>
        <div className="rail-actions">
          <button className="rail-button" onClick={onOpenChat} title="채팅" type="button"><MessageCircle size={21} /></button>
          <button className="rail-button" onClick={onOpenContacts} title="사람" type="button"><Users size={21} /></button>
          <button className="rail-button" onClick={onOpenCalendar} title="일정" type="button"><CalendarDays size={21} /></button>
          <button className="rail-button" data-active="true" title="방송" type="button"><Radio size={21} /></button>
          <button className="rail-button" title="파일" type="button"><FolderOpen size={21} /></button>
        </div>
        <img className="avatar" alt="" src={currentUser.character.thumbnailUrl} />
      </nav>

      <aside className="sidebar broadcast-sidebar">
        <div className="sidebar-header broadcast-sidebar-heading">
          <div>
            <div className="workspace-name">INVIZ BROADCAST</div>
            <h2 className="section-title">채널</h2>
          </div>
          <button className="icon-button" disabled={isRefreshing} onClick={() => void refreshDashboard(undefined, true)} title="채널 새로고침" type="button">
            <RefreshCw className={isRefreshing ? "spin" : ""} size={17} />
          </button>
        </div>
        <div className="broadcast-sidebar-command">
          <button className="primary-button" disabled={!dashboard?.canCreateChannel} onClick={() => setShowCreateChannel(true)} type="button">
            <Plus size={17} /> 새 채널
          </button>
        </div>
        <div className="broadcast-channel-list">
          {isLoading ? <div className="broadcast-empty">채널을 불러오는 중입니다.</div> : null}
          {!isLoading && !dashboard?.channels.length ? (
            <div className="broadcast-empty">아직 방송 채널이 없습니다.</div>
          ) : null}
          {dashboard?.channels.map((channel) => (
            <button
              className="broadcast-channel-row"
              data-active={channel.id === selectedChannelId}
              key={channel.id}
              onClick={() => selectChannel(channel)}
              type="button"
            >
              <img alt="" src={channel.owner.character.thumbnailUrl} />
              <span>
                <strong>{channel.name}</strong>
                <small>@{channel.handle} · 구독 {channel.subscriberCount}</small>
              </span>
              {channel.nextSession?.status === "live" ? <b className="live-badge">LIVE</b> : null}
            </button>
          ))}
        </div>
        <div className="broadcast-sidebar-footer">
          <button className="secondary-button" onClick={onLogout} type="button"><LogOut size={16} /> 로그아웃</button>
        </div>
      </aside>

      <section className="workspace broadcast-workspace" aria-label="개인 방송 작업 공간">
        <header className="workspace-header broadcast-workspace-header">
          <div>
            <div className="broadcast-heading-line">
              <h1 className="room-title">{broadcast?.title ?? selectedChannel?.name ?? "개인 방송"}</h1>
              {broadcast ? <span className="broadcast-status" data-status={broadcast.status}>{statusLabels[broadcast.status]}</span> : null}
            </div>
            <div className="room-meta">
              {broadcast
                ? `${formatDateTime(broadcast.scheduledFor)} · ${broadcast.callType === "video" ? "영상" : "음성"} · 시청 ${broadcast.viewerCount}`
                : selectedChannel?.description || "채널을 선택해 주세요."}
            </div>
          </div>
          <div className="header-actions">
            <button className="icon-button" onClick={popOut} title="방송을 새 창으로 열기" type="button"><ExternalLink size={17} /></button>
            <button className="icon-button" onClick={() => setToolsOpen((current) => !current)} title="대화 및 운영 패널" type="button"><PanelRightOpen size={17} /></button>
          </div>
        </header>

        <div className="broadcast-stage" data-phase={mediaPhase}>
          {!selectedChannel ? (
            <BroadcastWelcome onCreate={() => setShowCreateChannel(true)} />
          ) : !broadcast ? (
            <ChannelIdle
              channel={selectedChannel}
              onSchedule={() => setShowSchedule(true)}
              onSubscribe={() => void changeSubscription("live_only")}
            />
          ) : (
            <>
              <div className="broadcast-video-grid" data-count={Math.max(stageTracks.length + (localVideoTrack ? 1 : 0), 1)}>
                {localVideoTrack ? (
                  <div className="broadcast-video-tile" data-self="true">
                    <AttachedMediaVideo mirrored track={localVideoTrack} />
                    <span>{currentUser.displayName} · {roleLabels[broadcast.myRole]}</span>
                  </div>
                ) : null}
                {stageTracks.map((item) => (
                  <div className="broadcast-video-tile" key={item.sid}>
                    <AttachedMediaVideo track={item.track} />
                    <span>{item.name}</span>
                  </div>
                ))}
                {!localVideoTrack && !stageTracks.length ? (
                  <div className="broadcast-poster">
                    <img alt="" src={broadcast.channel.owner.character.thumbnailUrl} />
                    <strong>{broadcast.channel.owner.displayName}</strong>
                    <span>{broadcast.status === "live" ? mediaPhaseLabel(mediaPhase, broadcast.myStatus) : statusLabels[broadcast.status]}</span>
                  </div>
                ) : null}
              </div>

              <div className="broadcast-stage-overlay">
                <span><Radio size={14} /> {broadcast.status === "live" ? "LIVE" : statusLabels[broadcast.status]}</span>
                <span>{broadcast.viewerCount}명 시청</span>
              </div>

              {remoteAudio.map((item) => <AttachedBroadcastAudio key={item.sid} track={item.track} />)}
              {mediaWarning ? <div className="broadcast-media-warning" role="status">{mediaWarning}</div> : null}
            </>
          )}
        </div>

        <footer className="broadcast-control-bar">
          {broadcast?.status === "scheduled" && broadcast.canStart ? (
            <button className="broadcast-command live" disabled={Boolean(busyAction)} onClick={() => void startBroadcast()} type="button">
              <Play size={18} /> 방송 시작
            </button>
          ) : null}
          {broadcast?.status === "live" && broadcast.canJoin && mediaPhase !== "active" && mediaPhase !== "reconnecting" ? (
            <button className="broadcast-command live" disabled={busyAction === "join"} onClick={() => void connectMedia()} type="button">
              <Play size={18} /> {broadcast.myRole === "viewer" ? "시청하기" : "스튜디오 입장"}
            </button>
          ) : null}
          {broadcast && ["host", "cohost", "speaker"].includes(broadcast.myRole) && mediaPhase === "active" ? (
            <>
              <button className="broadcast-round-control" data-enabled={microphoneEnabled} disabled={Boolean(busyAction)} onClick={() => void toggleMicrophone()} title={microphoneEnabled ? "마이크 끄기" : "마이크 켜기"} type="button">
                {microphoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}
              </button>
              {broadcast.callType === "video" ? (
                <button className="broadcast-round-control" data-enabled={cameraEnabled} disabled={Boolean(busyAction)} onClick={() => void toggleCamera()} title={cameraEnabled ? "카메라 끄기" : "카메라 켜기"} type="button">
                  {cameraEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                </button>
              ) : null}
            </>
          ) : null}
          {broadcast?.status === "live" && broadcast.canLeave && mediaPhase !== "idle" ? (
            <button className="broadcast-command" disabled={Boolean(busyAction)} onClick={() => void leaveBroadcast()} type="button">나가기</button>
          ) : null}
          {broadcast?.status === "live" && broadcast.canEnd ? (
            <button className="broadcast-command end" disabled={Boolean(busyAction)} onClick={() => void endBroadcast()} type="button"><Square size={17} /> 종료</button>
          ) : null}
          {broadcast?.status === "ended" ? <ReplayBoundary broadcast={broadcast} /> : null}
        </footer>

        {error ? <div className="broadcast-toast error" role="alert"><X size={16} /> {error}</div> : null}
        {notice ? <div className="broadcast-toast" role="status"><Check size={16} /> {notice}</div> : null}
      </section>

      <aside className="broadcast-tools" data-open={toolsOpen}>
        <div className="panel-header broadcast-panel-header">
          <div>
            <div className="workspace-name">LIVE DESK</div>
            <h2 className="panel-title">대화와 운영</h2>
          </div>
          <button className="icon-button broadcast-tools-close" onClick={() => setToolsOpen(false)} title="패널 닫기" type="button"><X size={17} /></button>
        </div>
        <div className="broadcast-panel-tabs segmented-control">
          <button data-active={panelMode === "conversation"} onClick={() => setPanelMode("conversation")} type="button">대화</button>
          <button data-active={panelMode === "moderation"} onClick={() => setPanelMode("moderation")} type="button">
            운영{pendingMessages.length ? ` ${pendingMessages.length}` : ""}
          </button>
        </div>
        {panelMode === "conversation" ? (
          <BroadcastConversation
            broadcast={broadcast}
            busyAction={busyAction}
            messageBody={messageBody}
            messageKind={messageKind}
            onBodyChange={setMessageBody}
            onKindChange={setMessageKind}
            onPrivateService={() => void requestPrivateService()}
            onReact={(reaction) => void sendReaction(reaction)}
            onSend={sendMessage}
          />
        ) : (
          <BroadcastOperations
            broadcast={broadcast}
            busyAction={busyAction}
            channel={selectedChannel}
            onChangeRole={(participant, role) => void changeRole(participant, role)}
            onModerateMessage={(message, action) => void moderateMessage(message, action)}
            onModerateParticipant={(participant, action) => void moderateParticipant(participant, action)}
            onSchedule={() => setShowSchedule(true)}
            onSubscription={(level) => void changeSubscription(level)}
          />
        )}
      </aside>

      {showCreateChannel ? <CreateChannelDialog onClose={() => setShowCreateChannel(false)} onSubmit={createChannel} /> : null}
      {showSchedule && selectedChannel ? (
        <ScheduleBroadcastDialog channel={selectedChannel} onClose={() => setShowSchedule(false)} onSubmit={scheduleBroadcast} />
      ) : null}
    </main>
  );
}

function BroadcastWelcome({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="broadcast-welcome">
      <Radio size={36} />
      <h2>개인 방송 작업대</h2>
      <p>채널을 만들고 방송을 예약하면 구독자에게 라이브 화면과 검수형 질문 창이 열립니다.</p>
      <button className="broadcast-command live" onClick={onCreate} type="button"><Plus size={18} /> 채널 만들기</button>
    </div>
  );
}

function ChannelIdle({
  channel,
  onSchedule,
  onSubscribe
}: {
  channel: BroadcastChannelSummary;
  onSchedule: () => void;
  onSubscribe: () => void;
}) {
  return (
    <div className="broadcast-welcome">
      <img className="broadcast-owner-avatar" alt="" src={channel.owner.character.thumbnailUrl} />
      <h2>{channel.name}</h2>
      <p>{channel.description || `${channel.owner.displayName}님의 방송 채널입니다.`}</p>
      {channel.canManage ? (
        <button className="broadcast-command live" onClick={onSchedule} type="button"><Clock3 size={18} /> 방송 예약</button>
      ) : !channel.isSubscribed && channel.canSubscribe ? (
        <button className="broadcast-command live" onClick={onSubscribe} type="button"><Bell size={18} /> 구독하기</button>
      ) : <span className="broadcast-quiet-state">다음 방송을 기다리는 중입니다.</span>}
    </div>
  );
}

function BroadcastConversation({
  broadcast,
  busyAction,
  messageBody,
  messageKind,
  onBodyChange,
  onKindChange,
  onPrivateService,
  onReact,
  onSend
}: {
  broadcast: BroadcastSessionView | null;
  busyAction: string;
  messageBody: string;
  messageKind: BroadcastMessageKind;
  onBodyChange: (value: string) => void;
  onKindChange: (value: BroadcastMessageKind) => void;
  onPrivateService: () => void;
  onReact: (reaction: BroadcastReaction) => void;
  onSend: (event: FormEvent) => void;
}) {
  if (!broadcast) return <div className="broadcast-panel-empty">방송을 예약하면 대화 도구가 열립니다.</div>;
  const canAnnounce = broadcast.canModerate;
  return (
    <div className="broadcast-conversation">
      <div className="broadcast-message-list">
        {!broadcast.messages.length ? <div className="broadcast-panel-empty">아직 대화가 없습니다.</div> : null}
        {broadcast.messages.filter((message) => message.status !== "dismissed").map((message) => (
          <article className="broadcast-message-row" data-status={message.status} key={message.id}>
            <div>
              <strong>{message.senderLabel}</strong>
              <span>{message.kind === "question" ? "질문" : message.kind === "announcement" ? "공지" : roleLabels[message.senderRole]}</span>
              {message.status === "pending" ? <b>검수 대기</b> : null}
            </div>
            <p>{message.body}</p>
            <time>{formatTime(message.createdAt)}</time>
          </article>
        ))}
      </div>
      {broadcast.status === "live" ? (
        <>
          <div className="broadcast-reactions" aria-label="방송 반응">
            {reactionOptions.map((option) => {
              const count = broadcast.reactionCounts.find((item) => item.reaction === option.reaction)?.count ?? 0;
              return (
                <button disabled={busyAction.startsWith("reaction:")} key={option.reaction} onClick={() => onReact(option.reaction)} title={option.label} type="button">
                  <span>{reactionSymbol(option.reaction)}</span>{count ? <b>{count}</b> : null}
                </button>
              );
            })}
          </div>
          <form className="broadcast-composer" onSubmit={onSend}>
            <div className="segmented-control broadcast-kind-control">
              <button data-active={messageKind === "chat"} onClick={() => onKindChange("chat")} type="button">대화</button>
              <button data-active={messageKind === "question"} onClick={() => onKindChange("question")} type="button">질문</button>
              {canAnnounce ? <button data-active={messageKind === "announcement"} onClick={() => onKindChange("announcement")} type="button">공지</button> : null}
            </div>
            <div className="broadcast-composer-row">
              <textarea maxLength={2000} onChange={(event) => onBodyChange(event.target.value)} placeholder={messageKind === "question" ? "질문은 진행자 검수 후 공개됩니다." : "방송 대화를 입력하세요."} value={messageBody} />
              <button
                className="icon-button"
                disabled={!messageBody.trim() || busyAction === "message" || (messageKind === "question" ? !broadcast.canAskQuestion : !broadcast.canSendChat)}
                title="메시지 보내기"
                type="submit"
              ><Send size={18} /></button>
            </div>
          </form>
        </>
      ) : null}
      {broadcast.canRequestPrivateService ? (
        <button className="broadcast-private-handoff" disabled={busyAction === "handoff"} onClick={onPrivateService} type="button">
          <MessageCircle size={16} /> 진행자와 비공개 상담
        </button>
      ) : null}
    </div>
  );
}

function BroadcastOperations({
  broadcast,
  busyAction,
  channel,
  onChangeRole,
  onModerateMessage,
  onModerateParticipant,
  onSchedule,
  onSubscription
}: {
  broadcast: BroadcastSessionView | null;
  busyAction: string;
  channel: BroadcastChannelSummary | undefined;
  onChangeRole: (participant: BroadcastParticipantView, role: Exclude<BroadcastRole, "host">) => void;
  onModerateMessage: (message: BroadcastMessageView, action: "publish" | "hide" | "restore" | "dismiss") => void;
  onModerateParticipant: (participant: BroadcastParticipantView, action: "remove" | "block" | "unblock") => void;
  onSchedule: () => void;
  onSubscription: (level?: BroadcastNotificationLevel) => void;
}) {
  if (!channel) return <div className="broadcast-panel-empty">채널을 선택해 주세요.</div>;
  if (!channel.canManage) {
    return (
      <div className="broadcast-operations">
        <section>
          <div className="broadcast-section-title"><Bell size={15} /> 구독 설정</div>
          <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => onSubscription(channel.notificationLevel === "all" ? "live_only" : "all")} type="button">
            {channel.notificationLevel === "all" ? <BellOff size={16} /> : <Bell size={16} />}
            {channel.notificationLevel === "all" ? "라이브 알림만" : "모든 알림"}
          </button>
          {channel.isSubscribed ? <button className="secondary-button danger-button" disabled={Boolean(busyAction)} onClick={() => onSubscription(undefined)} type="button">구독 해제</button> : null}
        </section>
        <section>
          <div className="broadcast-section-title"><ShieldCheck size={15} /> 시청자 보호</div>
          <p>시청자 명단과 다른 시청자의 신원은 공개되지 않습니다. 질문은 검수형 방송에서 익명으로 전달됩니다.</p>
        </section>
      </div>
    );
  }

  const participants = broadcast?.moderationParticipants ?? [];
  const pending = broadcast?.messages.filter((message) => message.status === "pending") ?? [];
  return (
    <div className="broadcast-operations">
      <section>
        <div className="broadcast-section-title"><Clock3 size={15} /> 방송 일정</div>
        <button className="secondary-button" disabled={Boolean(busyAction) || Boolean(broadcast && !["ended", "cancelled", "failed"].includes(broadcast.status))} onClick={onSchedule} type="button"><Plus size={16} /> 새 방송 예약</button>
      </section>
      {broadcast?.canModerate ? (
        <section>
          <div className="broadcast-section-title"><ShieldCheck size={15} /> 질문 검수 <span>{pending.length}</span></div>
          {!pending.length ? <p>검수를 기다리는 질문이 없습니다.</p> : null}
          {pending.map((message) => (
            <div className="broadcast-moderation-row" key={message.id}>
              <strong>{message.senderLabel}</strong>
              <p>{message.body}</p>
              <div>
                <button disabled={Boolean(busyAction)} onClick={() => onModerateMessage(message, "publish")} type="button"><Check size={15} /> 공개</button>
                <button disabled={Boolean(busyAction)} onClick={() => onModerateMessage(message, "dismiss")} type="button"><X size={15} /> 닫기</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {broadcast?.canManageRoles ? (
        <section>
          <div className="broadcast-section-title"><UserRoundCog size={15} /> 참여자 운영 <span>{participants.length}</span></div>
          {participants.map((participant) => (
            <div className="broadcast-participant-row" key={participant.person.id}>
              <img alt="" src={participant.person.character.thumbnailUrl} />
              <span><strong>{participant.person.displayName}</strong><small>{roleLabels[participant.role]} · {participant.status}</small></span>
              {!participant.isSelf ? (
                <div>
                  <select disabled={Boolean(busyAction)} onChange={(event) => onChangeRole(participant, event.target.value as Exclude<BroadcastRole, "host">)} value={participant.role === "host" ? "cohost" : participant.role}>
                    <option value="viewer">시청자</option>
                    <option value="speaker">발언자</option>
                    <option value="cohost">공동 진행</option>
                  </select>
                  <button disabled={Boolean(busyAction)} onClick={() => onModerateParticipant(participant, "remove")} title="방송에서 내보내기" type="button"><UserX size={15} /></button>
                  <button disabled={Boolean(busyAction)} onClick={() => onModerateParticipant(participant, "block")} title="채널 차단" type="button"><ShieldCheck size={15} /></button>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function CreateChannelDialog({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (input: { description: string; handle: string; name: string; visibility: BroadcastChannelVisibility }) => void;
}) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<BroadcastChannelVisibility>("organization");
  return (
    <div className="broadcast-dialog-backdrop" role="presentation">
      <form className="broadcast-dialog" onSubmit={(event) => { event.preventDefault(); onSubmit({ description, handle, name, visibility }); }}>
        <header><div><span>CHANNEL</span><h2>새 방송 채널</h2></div><button className="icon-button" onClick={onClose} title="닫기" type="button"><X size={17} /></button></header>
        <label>채널 이름<input className="text-input" maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></label>
        <label>채널 주소<input className="text-input" maxLength={40} onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))} pattern="[a-z0-9][a-z0-9._-]{2,39}" placeholder="inviz-service" required value={handle} /></label>
        <label>소개<textarea className="text-input" maxLength={500} onChange={(event) => setDescription(event.target.value)} value={description} /></label>
        <div className="segmented-control">
          <button data-active={visibility === "organization"} onClick={() => setVisibility("organization")} type="button">조직 공개</button>
          <button data-active={visibility === "unlisted"} onClick={() => setVisibility("unlisted")} type="button">링크 공개</button>
        </div>
        <button className="primary-button" disabled={name.trim().length < 2 || handle.length < 3} type="submit">채널 만들기</button>
      </form>
    </div>
  );
}

function ScheduleBroadcastDialog({
  channel,
  onClose,
  onSubmit
}: {
  channel: BroadcastChannelSummary;
  onClose: () => void;
  onSubmit: (input: {
    callType: CallType;
    chatMode: BroadcastChatMode;
    description: string;
    expectedEndAt: string;
    replayRequested: boolean;
    scheduledFor: string;
    title: string;
    viewerLimit: number;
  }) => void;
}) {
  const start = new Date(Date.now() + 5 * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scheduledFor, setScheduledFor] = useState(toLocalInput(start));
  const [expectedEndAt, setExpectedEndAt] = useState(toLocalInput(end));
  const [callType, setCallType] = useState<CallType>("video");
  const [chatMode, setChatMode] = useState<BroadcastChatMode>("moderated");
  const [viewerLimit, setViewerLimit] = useState(500);
  const [replayRequested, setReplayRequested] = useState(true);
  return (
    <div className="broadcast-dialog-backdrop" role="presentation">
      <form className="broadcast-dialog schedule" onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ callType, chatMode, description, expectedEndAt, replayRequested, scheduledFor, title, viewerLimit });
      }}>
        <header><div><span>@{channel.handle}</span><h2>방송 예약</h2></div><button className="icon-button" onClick={onClose} title="닫기" type="button"><X size={17} /></button></header>
        <label>제목<input className="text-input" maxLength={120} onChange={(event) => setTitle(event.target.value)} required value={title} /></label>
        <label>설명<textarea className="text-input" maxLength={1000} onChange={(event) => setDescription(event.target.value)} value={description} /></label>
        <div className="broadcast-form-grid">
          <label>시작<input className="text-input" onChange={(event) => setScheduledFor(event.target.value)} required type="datetime-local" value={scheduledFor} /></label>
          <label>종료 예정<input className="text-input" min={scheduledFor} onChange={(event) => setExpectedEndAt(event.target.value)} required type="datetime-local" value={expectedEndAt} /></label>
        </div>
        <div className="broadcast-form-grid">
          <label>형식<select className="text-input" onChange={(event) => setCallType(event.target.value as CallType)} value={callType}><option value="video">영상 방송</option><option value="voice">음성 방송</option></select></label>
          <label>대화<select className="text-input" onChange={(event) => setChatMode(event.target.value as BroadcastChatMode)} value={chatMode}><option value="moderated">질문 검수</option><option value="subscribers">구독자 대화</option><option value="disabled">진행자만</option></select></label>
        </div>
        <label>최대 시청자<input className="text-input" max={3000} min={1} onChange={(event) => setViewerLimit(Number(event.target.value))} type="number" value={viewerLimit} /></label>
        <label className="broadcast-checkbox"><input checked={replayRequested} onChange={(event) => setReplayRequested(event.target.checked)} type="checkbox" /> 다시보기 생성 요청</label>
        <button className="primary-button" disabled={title.trim().length < 2 || new Date(expectedEndAt) <= new Date(scheduledFor)} type="submit">방송 예약</button>
      </form>
    </div>
  );
}

function ReplayBoundary({ broadcast }: { broadcast: BroadcastSessionView }) {
  const label = broadcast.replay.status === "processing"
    ? "다시보기 처리 중"
    : broadcast.replay.status === "ready"
      ? "다시보기 열기"
      : broadcast.replay.status === "unavailable"
        ? "다시보기 준비 안 됨"
        : "다시보기 없음";
  return <span className="broadcast-replay-state"><Play size={15} /> {label}</span>;
}

function AttachedBroadcastAudio({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <audio autoPlay ref={ref} />;
}

function mediaPhaseLabel(phase: MediaPhase, status: BroadcastSessionView["myStatus"]) {
  if (phase === "connecting") return "방송에 연결하는 중입니다.";
  if (phase === "reconnecting") return "네트워크를 다시 연결하는 중입니다.";
  if (phase === "error") return "미디어 연결을 확인해 주세요.";
  if (phase === "active" || status === "joined") return "라이브 방송 중입니다.";
  return "입장하면 라이브 화면이 재생됩니다.";
}

function reactionSymbol(reaction: BroadcastReaction) {
  return { applause: "👏", celebrate: "🎉", like: "♥", question: "?", thanks: "✓" }[reaction];
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function toLocalInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
