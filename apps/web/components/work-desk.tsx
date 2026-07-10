"use client";

import {
  Bell,
  CalendarDays,
  Camera,
  CheckCircle2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Inbox,
  LockKeyhole,
  LogOut,
  MessageCircle,
  Mic2,
  MonitorUp,
  MoreHorizontal,
  PanelRightOpen,
  Paperclip,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Users,
  Video,
  Volume2
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  buildReadReport,
  characterPresets,
  createMessageAudience,
  createMessageDeliveryPlan,
  demoAiJobs,
  demoMessages,
  demoRoom,
  demoRoomMembers,
  demoUsers,
  getAudienceLabel,
  getRoomPresentationForViewer,
  isMessageVisibleTo,
  projectMessageForViewer,
  type AuthSession,
  type AiJob,
  type Attachment,
  type AudienceType,
  type Invite,
  type Message,
  type MvpSnapshot,
  type RoomMember,
  type RoomPresentation,
  type User
} from "@hahatalk/contracts";

type PanelKey = "files" | "pdf" | "reads" | "members" | "ai";
type AuthMode = "signup" | "login";

const reactions = ["확인", "완료", "질문", "긴급", "감사"];
type HahaTalkDesktopBridge = {
  apiBaseUrl?: string;
  isDesktop: boolean;
  platform: string;
  version?: string;
};

const desktopBridge = typeof window === "undefined"
  ? undefined
  : (window as Window & { hahaTalkDesktop?: HahaTalkDesktopBridge }).hahaTalkDesktop;
const apiBaseUrl = desktopBridge?.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4000";
const authSessionStorageKey = "hahatalk.authSession.v1";

export function WorkDesk() {
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState("");
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);
  const [displayName, setDisplayName] = useState("이과장");
  const [email, setEmail] = useState("you@inviz.co.kr");
  const [selectedCharacterId, setSelectedCharacterId] = useState(characterPresets[0]?.id ?? "");
  const selectedCharacter = characterPresets.find((character) => character.id === selectedCharacterId) ?? characterPresets[0]!;

  useEffect(() => {
    const storedSession = readStoredSession();

    if (!storedSession) {
      return;
    }

    setAuthSession(storedSession);
    setDisplayName(storedSession.user.displayName);
    setEmail(storedSession.user.email);
    setSelectedCharacterId(storedSession.user.character.id);
  }, []);

  const draftUser: User = {
    ...demoUsers[0]!,
    displayName: displayName.trim() || "나",
    email: email.trim() || demoUsers[0]!.email,
    character: selectedCharacter
  };
  const currentUser = authSession?.user ?? draftUser;
  const users = mergeCurrentUser(demoUsers, currentUser);

  async function submitAuth() {
    setAuthError("");
    setIsSubmittingAuth(true);

    try {
      const session = await postJson<AuthSession>(
        authMode === "signup" ? "/auth/signup" : "/auth/login",
        authMode === "signup"
          ? { displayName, email, characterId: selectedCharacterId }
          : { email }
      );

      setAuthSession(session);
      setDisplayName(session.user.displayName);
      setEmail(session.user.email);
      setSelectedCharacterId(session.user.character.id);
      window.localStorage.setItem(authSessionStorageKey, JSON.stringify(session));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "가입/로그인 처리 중 오류가 발생했습니다.");
    } finally {
      setIsSubmittingAuth(false);
    }
  }

  function logout() {
    window.localStorage.removeItem(authSessionStorageKey);
    setAuthSession(null);
    setAuthMode("login");
  }

  if (!authSession) {
    return (
      <SignupFlow
        authMode={authMode}
        displayName={displayName}
        email={email}
        error={authError}
        isSubmitting={isSubmittingAuth}
        selectedCharacterId={selectedCharacterId}
        onAuthModeChange={setAuthMode}
        onDisplayNameChange={setDisplayName}
        onEmailChange={setEmail}
        onCharacterChange={setSelectedCharacterId}
        onSubmit={submitAuth}
      />
    );
  }

  return <ChatDesk authSession={authSession} currentUser={currentUser} onLogout={logout} users={users} />;
}

function SignupFlow({
  authMode,
  displayName,
  email,
  error,
  isSubmitting,
  selectedCharacterId,
  onAuthModeChange,
  onDisplayNameChange,
  onEmailChange,
  onCharacterChange,
  onSubmit
}: {
  authMode: AuthMode;
  displayName: string;
  email: string;
  error: string;
  isSubmitting: boolean;
  selectedCharacterId: string;
  onAuthModeChange: (value: AuthMode) => void;
  onDisplayNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onCharacterChange: (value: string) => void;
  onSubmit: () => Promise<void>;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit();
  }

  return (
    <main className="auth-shell">
      <form className="auth-panel" aria-label="가입 및 로그인" onSubmit={handleSubmit}>
        <div className="brand-mark">인</div>
        <h1>{authMode === "signup" ? "HahaTalk 가입" : "HahaTalk 로그인"}</h1>
        <p className="auth-copy">
          {authMode === "signup" ? "업무 프로필과 캐릭터를 정하고 바로 허브 대화에 입장합니다." : "업무 이메일로 내 세션을 다시 엽니다."}
        </p>
        <div className="auth-mode-tabs" aria-label="인증 모드">
          <button className="chip-button" data-active={authMode === "signup"} onClick={() => onAuthModeChange("signup")} type="button">
            가입하기
          </button>
          <button className="chip-button" data-active={authMode === "login"} onClick={() => onAuthModeChange("login")} type="button">
            로그인
          </button>
        </div>
        <div className="field-stack">
          {authMode === "signup" ? (
            <label className="field">
              이름
              <input className="text-input" minLength={2} required value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} />
            </label>
          ) : null}
          <label className="field">
            업무 이메일
            <input className="text-input" required type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} />
          </label>
        </div>

        {authMode === "signup" ? (
          <>
            <h2 className="section-title" style={{ marginTop: 24, fontSize: 16 }}>
              캐릭터 선택
            </h2>
            <div className="character-grid">
              {characterPresets.map((character) => (
                <button
                  className="character-card"
                  data-selected={character.id === selectedCharacterId}
                  key={character.id}
                  onClick={() => onCharacterChange(character.id)}
                  type="button"
                >
                  <img alt="" src={character.thumbnailUrl} />
                  <strong>{character.name}</strong>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "처리 중" : authMode === "signup" ? "가입하고 업무방 입장" : "로그인하고 입장"}
        </button>
      </form>
      <section className="auth-preview" aria-label="업무 화면 미리보기">
        <div className="desktop-preview">
          <div className="preview-left">
            <div className="workspace-name">HAHATALK</div>
            <div className="preview-room" />
            <div className="preview-room" />
            <div className="preview-room" />
          </div>
          <div className="preview-center">
            <h2 className="room-title">프로젝트 A 허브방</h2>
            <div className="preview-message" />
            <div className="preview-message" />
            <div className="preview-message" />
          </div>
          <div className="preview-right">
            <div className="panel-title">
              <FileText size={17} /> PDF
            </div>
            <div className="preview-panel-line" />
            <div className="preview-panel-line" />
            <div className="preview-panel-line" />
          </div>
        </div>
      </section>
    </main>
  );
}

function ChatDesk({
  authSession,
  currentUser,
  onLogout,
  users
}: {
  authSession: AuthSession;
  currentUser: User;
  onLogout: () => void;
  users: User[];
}) {
  const initialRoomPresentation = getRoomPresentationForViewer(demoRoom, demoRoomMembers, users, currentUser.id);
  const initialVisibleMemberIds = new Set(initialRoomPresentation.visibleMemberIds);
  const [roomPresentation, setRoomPresentation] = useState<RoomPresentation>(initialRoomPresentation);
  const [roomUsers, setRoomUsers] = useState<User[]>(users.filter((user) => initialVisibleMemberIds.has(user.id)));
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>(
    demoRoomMembers.filter((member) => initialVisibleMemberIds.has(member.userId))
  );
  const [messages, setMessages] = useState<Message[]>(
    demoMessages
      .map((message) => projectMessageForViewer(message, demoRoom, demoRoomMembers, currentUser.id))
      .filter((message): message is Message => Boolean(message))
  );
  const [aiJobs, setAiJobs] = useState<AiJob[]>(demoAiJobs);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [activePanel, setActivePanel] = useState<PanelKey>("files");
  const [selectedMessageId, setSelectedMessageId] = useState(demoMessages[0]?.id ?? "");
  const [audienceType, setAudienceType] = useState<AudienceType>("all");
  const [targetUserIds, setTargetUserIds] = useState<string[]>(["user-mina"]);
  const [composer, setComposer] = useState("");
  const [requiresConfirmation, setRequiresConfirmation] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("customer@example.com");
  const [notice, setNotice] = useState("외부 게스트는 초대받은 방과 파일만 볼 수 있습니다.");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isInviting, setIsInviting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isConfirmingRead, setIsConfirmingRead] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshSnapshot();
  }, [authSession.token]);

  const visibleMessages = useMemo(
    () => messages.filter((message) => isMessageVisibleTo(message, currentUser.id, roomMembers)),
    [currentUser.id, messages, roomMembers]
  );
  const selectedMessage = messages.find((message) => message.id === selectedMessageId) ?? visibleMessages.at(-1) ?? messages[0]!;
  const attachments = messages.flatMap((message) => message.attachments.map((attachment) => ({ attachment, message })));
  const selectedPdf = attachments.find(({ attachment }) => attachment.mimeType === "application/pdf")?.attachment;

  const targetUsers = roomUsers.filter((user) => user.id !== currentUser.id && !user.id.startsWith("guest"));

  function getEffectiveAudience() {
    if (roomPresentation.canSelectAudience) {
      return {
        audienceType,
        targetUserIds: audienceType === "all" ? [] : targetUserIds
      };
    }

    if (roomPresentation.mode === "group" || roomPresentation.mode === "meeting" || roomPresentation.mode === "channel") {
      return { audienceType: "all" as const, targetUserIds: [] };
    }

    const counterpartId = roomPresentation.visibleMemberIds.find((userId) => userId !== currentUser.id);
    return { audienceType: "private" as const, targetUserIds: counterpartId ? [counterpartId] : [] };
  }

  async function refreshSnapshot() {
    setIsSyncing(true);
    setSyncError("");

    try {
      const snapshot = await getJson<MvpSnapshot>(`/mvp?viewerId=${encodeURIComponent(currentUser.id)}`);
      const nextUsers = mergeCurrentUser(snapshot.users, currentUser);

      setRoomPresentation(snapshot.room);
      setRoomUsers(nextUsers);
      setRoomMembers(snapshot.roomMembers);
      setMessages(snapshot.messages);
      setAiJobs(snapshot.aiJobs);
      setInvites(snapshot.invites);

      if (!snapshot.messages.some((message) => message.id === selectedMessageId)) {
        setSelectedMessageId(snapshot.messages[0]?.id ?? "");
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "업무방 동기화 실패");
    } finally {
      setIsSyncing(false);
    }
  }

  async function sendTextMessage(body = composer) {
    const trimmed = body.trim();

    if (!trimmed || isSending) {
      return;
    }

    const effectiveAudience = getEffectiveAudience();

    const message = createLocalMessage({
      body: trimmed,
      currentUser,
      audienceType: effectiveAudience.audienceType,
      targetUserIds: effectiveAudience.targetUserIds,
      roomMembers,
      requiresConfirmation
    });

    setMessages((current) => [...current, message]);
    setSelectedMessageId(message.id);
    setComposer("");
    setRequiresConfirmation(false);

    setIsSending(true);
    try {
      const savedMessage = await postJson<Message>("/messages", {
        senderId: currentUser.id,
        body: trimmed,
        audienceType: effectiveAudience.audienceType,
        targetUserIds: effectiveAudience.targetUserIds,
        requiresConfirmation
      });

      setMessages((current) => current.map((candidate) => candidate.id === message.id ? savedMessage : candidate));
      setSelectedMessageId(savedMessage.id);
      setNotice("메시지가 서버에 저장되었습니다.");
    } catch (error) {
      setMessages((current) => current.filter((candidate) => candidate.id !== message.id));
      setComposer(trimmed);
      setRequiresConfirmation(Boolean(message.metadata.requiresConfirmation));
      setNotice(`메시지 전송 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsSending(false);
    }
  }

  function toggleTarget(userId: string) {
    setTargetUserIds((current) => {
      if (audienceType === "private") {
        return [userId];
      }

      return current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId];
    });
  }

  function changeAudience(nextAudienceType: AudienceType) {
    setAudienceType(nextAudienceType);

    if (nextAudienceType === "private") {
      setTargetUserIds((current) => [current[0] ?? "user-mina"]);
    }
  }

  function addReaction(reaction: string) {
    setComposer((current) => (current ? `${current} ${reaction}` : reaction));
  }

  async function createInvite() {
    const email = inviteEmail.trim();

    if (!email) {
      return;
    }

    if (!authSession.permissions.canInviteGuests) {
      setNotice("현재 세션은 게스트 초대 권한이 없습니다.");
      return;
    }

    setIsInviting(true);
    try {
      const invite = await postJson<Invite>("/invites", {
        email,
        role: "guest",
        invitedBy: currentUser.id
      });

      setInvites((current) => [invite, ...current]);
      setNotice(`${invite.email} 게스트 초대장이 서버에 저장되었습니다. 다운로드와 전달 권한은 제한됩니다.`);
      setInviteEmail("");
    } catch (error) {
      setNotice(`게스트 초대 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsInviting(false);
    }
  }

  async function confirmSelectedRead() {
    if (!selectedMessage?.metadata.requiresConfirmation || isConfirmingRead) {
      return;
    }

    setIsConfirmingRead(true);
    try {
      const confirmedMessage = await postJson<Message>(`/messages/${selectedMessage.id}/confirm`, {
        userId: currentUser.id
      });

      setMessages((current) => current.map((message) => message.id === confirmedMessage.id ? confirmedMessage : message));
      setSelectedMessageId(confirmedMessage.id);
      setNotice("확인 상태가 읽음 리포트에 저장되었습니다.");
    } catch (error) {
      setNotice(`확인 처리 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsConfirmingRead(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const id = `msg-file-${Date.now()}`;
    const now = new Date().toISOString();
    const effectiveAudience = getEffectiveAudience();
    const deliveryPlan = createMessageDeliveryPlan(
      demoRoom,
      roomMembers,
      id,
      currentUser.id,
      effectiveAudience.audienceType,
      effectiveAudience.targetUserIds,
      now
    );
    const objectUrl = URL.createObjectURL(file);
    const attachment: Attachment = {
      id: `att-${Date.now()}`,
      messageId: id,
      uploaderId: currentUser.id,
      storageKey: `local-demo/${file.name}`,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      previewStatus: "ready",
      virusScanStatus: "clean",
      createdAt: now,
      objectUrl
    };
    const messageType = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : "file";
    const message: Message = {
      id,
      roomId: demoRoom.id,
      senderId: currentUser.id,
      messageType,
      deliveryMode: deliveryPlan.deliveryMode,
      body: `${file.name} 공유`,
      metadata: { source: "file_upload", mediaVisibility: "shared" },
      createdAt: now,
      audiences: createMessageAudience(
        id,
        deliveryPlan.normalizedAudienceType,
        currentUser.id,
        deliveryPlan.normalizedTargetUserIds
      ),
      deliveries: deliveryPlan.deliveries,
      attachments: [attachment]
    };

    setMessages((current) => [...current, message]);
    setSelectedMessageId(message.id);
    setActivePanel(file.type === "application/pdf" ? "pdf" : "files");
    event.target.value = "";

    setIsUploading(true);
    try {
      const savedMessage = await postJson<Message>("/attachments", {
        uploaderId: currentUser.id,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        audienceType: effectiveAudience.audienceType,
        targetUserIds: effectiveAudience.targetUserIds,
        source: "file_upload",
        mediaVisibility: "shared"
      });
      const messageWithPreview = attachPreviewUrl(savedMessage, objectUrl);

      setMessages((current) => current.map((candidate) => candidate.id === message.id ? messageWithPreview : candidate));
      setSelectedMessageId(savedMessage.id);
      setNotice(`${file.name} 메타데이터가 서버에 저장되었습니다.`);
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      setMessages((current) => current.filter((candidate) => candidate.id !== message.id));
      setNotice(`파일 메타데이터 저장 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsUploading(false);
    }
  }

  async function shareScreenCapture() {
    try {
      const mediaDevices = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
      };

      if (!mediaDevices.getDisplayMedia) {
        setNotice("현재 브라우저는 화면 캡처 공유를 지원하지 않습니다.");
        return;
      }

      const stream = await mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((resolve) => window.setTimeout(resolve, 250));

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      stream.getTracks().forEach((track) => track.stop());

      if (!blob) {
        setNotice("화면 캡처 이미지를 만들지 못했습니다.");
        return;
      }

      const id = `msg-capture-${Date.now()}`;
      const now = new Date().toISOString();
      const effectiveAudience = getEffectiveAudience();
      const deliveryPlan = createMessageDeliveryPlan(
        demoRoom,
        roomMembers,
        id,
        currentUser.id,
        effectiveAudience.audienceType,
        effectiveAudience.targetUserIds,
        now
      );
      const attachment: Attachment = {
        id: `att-capture-${Date.now()}`,
        messageId: id,
        uploaderId: currentUser.id,
        storageKey: `local-demo/screen-${Date.now()}.png`,
        fileName: "화면캡처.png",
        mimeType: "image/png",
        sizeBytes: blob.size,
        previewStatus: "ready",
        virusScanStatus: "clean",
        createdAt: now,
        objectUrl: URL.createObjectURL(blob)
      };
      const message: Message = {
        id,
        roomId: demoRoom.id,
        senderId: currentUser.id,
        messageType: "image",
        deliveryMode: deliveryPlan.deliveryMode,
        body: "현재 화면 캡처 공유",
        metadata: { source: "screen_capture", mediaVisibility: "shared" },
        createdAt: now,
        audiences: createMessageAudience(
          id,
          deliveryPlan.normalizedAudienceType,
          currentUser.id,
          deliveryPlan.normalizedTargetUserIds
        ),
        deliveries: deliveryPlan.deliveries,
        attachments: [attachment]
      };

      setMessages((current) => [...current, message]);
      setSelectedMessageId(message.id);
      setActivePanel("files");
      setIsUploading(true);
      try {
        const savedMessage = await postJson<Message>("/attachments", {
          uploaderId: currentUser.id,
          fileName: "화면캡처.png",
          mimeType: "image/png",
          sizeBytes: blob.size,
          audienceType: effectiveAudience.audienceType,
          targetUserIds: effectiveAudience.targetUserIds,
          source: "screen_capture",
          mediaVisibility: "shared"
        });
        const messageWithPreview = attachPreviewUrl(savedMessage, attachment.objectUrl!);

        setMessages((current) => current.map((candidate) => candidate.id === message.id ? messageWithPreview : candidate));
        setSelectedMessageId(savedMessage.id);
        setNotice("화면 캡처 메타데이터가 서버에 저장되었습니다.");
      } catch (error) {
        URL.revokeObjectURL(attachment.objectUrl!);
        setMessages((current) => current.filter((candidate) => candidate.id !== message.id));
        setNotice(`화면 캡처 메타데이터 저장 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
      } finally {
        setIsUploading(false);
      }
    } catch {
      setNotice("화면 캡처 공유가 취소되었습니다.");
    }
  }

  function popOut() {
    window.open(window.location.href, "hahatalk-popout", "width=980,height=760");
  }

  return (
    <main className="app-shell">
      <nav className="rail" aria-label="주요 이동">
        <div className="brand-mark">인</div>
        <div className="rail-actions">
          <button className="rail-button" data-active="true" title="채팅" type="button">
            <MessageCircle size={21} />
          </button>
          <button className="rail-button" title="사람" type="button">
            <Users size={21} />
          </button>
          <button className="rail-button" title="일정" type="button">
            <CalendarDays size={21} />
          </button>
          <button className="rail-button" title="파일" type="button">
            <FolderOpen size={21} />
          </button>
        </div>
        <img className="avatar" alt="" src={currentUser.character.thumbnailUrl} />
      </nav>

      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="workspace-name">INVIZ WORKSPACE</div>
          <h2 className="section-title" style={{ marginTop: 4, fontSize: 22 }}>
            HahaTalk
          </h2>
        </div>
        <div className="sidebar-header">
          <label className="search-box">
            <Search size={16} />
            <input className="text-input" placeholder="대화, 파일, 사람 검색" />
          </label>
        </div>
        <div className="room-list">
          <button className="room-item" data-active="true" type="button">
            <strong>{roomPresentation.title}</strong>
            <span className="room-meta">
              {roomPresentation.mode === "hub_owner" ? "전체 공지/선택 발송/개별 대화" : "개인 대화"}
            </span>
          </button>
          <button className="room-item" type="button">
            <strong>고객지원 대기실</strong>
            <span className="room-meta">게스트 안전 모드</span>
          </button>
          <button className="room-item" type="button">
            <strong>영업자료 검토</strong>
            <span className="room-meta">PDF와 읽음 확인</span>
          </button>
        </div>
      </aside>

      <section className="workspace" aria-label="채팅 업무 공간">
        <header className="workspace-header">
          <div>
            <h1 className="room-title">{roomPresentation.title}</h1>
            <div className="tiny">
              {roomPresentation.rosterVisible ? `허브 ${roomPresentation.memberCount ?? roomUsers.length}명` : "1:1 대화"}
              {` · ${authSession.role === "guest" ? "게스트 세션" : "내부 세션"}`}
              {authSession.permissions.canOpenReadReport ? " · 읽음 리포트 켜짐" : ""}
            </div>
          </div>
          <div className="header-actions">
            <span className="sync-chip" data-state={syncError ? "error" : isSyncing ? "loading" : "ready"}>
              {syncError ? "동기화 실패" : isSyncing ? "동기화 중" : "API 동기화"}
            </span>
            <span className="session-chip">{currentUser.displayName}</span>
            <button className="icon-button" onClick={() => void refreshSnapshot()} title="업무방 새로고침" type="button">
              <RefreshCw size={18} />
            </button>
            <button className="icon-button" onClick={() => setNotice("음성통화는 LiveKit 연결 단계에서 활성화됩니다.")} title="음성통화" type="button">
              <Phone size={18} />
            </button>
            <button className="icon-button" onClick={() => setNotice("화상통화는 LiveKit 방 생성 후 연결됩니다.")} title="화상통화" type="button">
              <Video size={18} />
            </button>
            <button className="icon-button" onClick={popOut} title="개별 창 열기" type="button">
              <PanelRightOpen size={18} />
            </button>
            <button className="icon-button" title="알림" type="button">
              <Bell size={18} />
            </button>
            <button className="icon-button" onClick={onLogout} title="로그아웃" type="button">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <div className="message-list" role="log">
          {visibleMessages.map((message) => {
            const sender = roomUsers.find((user) => user.id === message.senderId) ?? currentUser;
            const readCount = message.deliveries.filter((delivery) => delivery.readAt).length;

            return (
              <article
                className="message"
                data-own={message.senderId === currentUser.id}
                key={message.id}
                onClick={() => setSelectedMessageId(message.id)}
              >
                <img className="avatar" alt="" src={sender.character.thumbnailUrl} />
                <div className="message-bubble">
                  <div className="message-meta">
                    <strong>{message.senderId === currentUser.id ? "나" : sender.displayName}</strong>
                    <span>{formatTime(message.createdAt)}</span>
                    <span className="audience-chip">{getAudienceLabel(message, roomUsers)}</span>
                    {message.metadata.requiresConfirmation ? <span className="status-chip">확인 요청</span> : null}
                  </div>
                  <p className="message-body">{message.body}</p>
                  {message.attachments.length > 0 ? (
                    <div className="attachment-strip">
                      {message.attachments.map((attachment) => (
                        <button
                          className="attachment-tile"
                          key={attachment.id}
                          onClick={() => setActivePanel(attachment.mimeType === "application/pdf" ? "pdf" : "files")}
                          type="button"
                        >
                          {attachment.mimeType.startsWith("image/") ? <ImageIcon size={21} /> : <FileText size={21} />}
                          <span>
                            <strong>{attachment.fileName}</strong>
                            <span className="tiny">{formatBytes(attachment.sizeBytes)} · {attachment.previewStatus}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="message-actions" style={{ marginTop: 10 }}>
                    {authSession.permissions.canOpenReadReport ? <span className="tiny">읽음 {readCount}</span> : null}
                    {authSession.permissions.canOpenReadReport ? (
                      <button className="secondary-button" onClick={() => setActivePanel("reads")} type="button">
                        <CheckCircle2 size={16} /> 리포트
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <footer className="composer">
          <div className="audience-tabs" aria-label="메시지 대상">
            {roomPresentation.canSelectAudience ? (
              <>
                <button className="chip-button" data-active={audienceType === "all"} onClick={() => changeAudience("all")} type="button">
                  전체
                </button>
                <button className="chip-button" data-active={audienceType === "selected"} onClick={() => changeAudience("selected")} type="button">
                  선택
                </button>
                <button className="chip-button" data-active={audienceType === "private"} onClick={() => changeAudience("private")} type="button">
                  1:1
                </button>
                <span className="audience-chip">{audienceLabel(audienceType, targetUserIds, roomUsers)}</span>
              </>
            ) : (
              <span className="audience-chip">{roomPresentation.mode === "direct" ? "1:1" : "전체"}</span>
            )}
          </div>
          {roomPresentation.canSelectAudience && audienceType !== "all" ? (
            <div className="target-list">
              {targetUsers.map((user) => (
                <button className="target-toggle" data-active={targetUserIds.includes(user.id)} key={user.id} onClick={() => toggleTarget(user.id)} type="button">
                  <img className="avatar" alt="" src={user.character.thumbnailUrl} style={{ width: 22, height: 22 }} />
                  {user.displayName}
                </button>
              ))}
            </div>
          ) : null}
          <div className="composer-tools">
            <button className="icon-button" disabled={isUploading} onClick={() => fileInputRef.current?.click()} title="파일 첨부" type="button">
              <Paperclip size={18} />
            </button>
            <button className="icon-button" disabled={isUploading} onClick={shareScreenCapture} title="화면 캡처 공유" type="button">
              <Camera size={18} />
            </button>
            <button className="icon-button" onClick={() => setNotice("STT 음성메시지는 AI 작업 대기열로 들어갑니다.")} title="STT" type="button">
              <Mic2 size={18} />
            </button>
            <button className="icon-button" onClick={() => setNotice("TTS 읽어주기는 캐시된 음성 자산을 우선 사용합니다.")} title="TTS" type="button">
              <Volume2 size={18} />
            </button>
            <button className="chip-button" data-active={requiresConfirmation} onClick={() => setRequiresConfirmation((current) => !current)} type="button">
              확인 요청
            </button>
            {reactions.map((reaction) => (
              <button className="reaction-button" key={reaction} onClick={() => addReaction(reaction)} type="button">
                {reaction}
              </button>
            ))}
          </div>
          <div className="composer-row">
            <textarea
              className="composer-input"
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendTextMessage();
                }
              }}
              placeholder="메시지 입력"
              value={composer}
            />
            <button className="icon-button" disabled={isSending} onClick={() => void sendTextMessage()} title="보내기" type="button">
              <Send size={19} />
            </button>
          </div>
          <input
            hidden
            onChange={handleFileChange}
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
          />
        </footer>
      </section>

      <aside className="right-panel" aria-label="업무 패널">
        <div className="panel-tabs">
          <button className="panel-tab" data-active={activePanel === "files"} onClick={() => setActivePanel("files")} title="파일" type="button">
            <FolderOpen size={18} />
          </button>
          <button className="panel-tab" data-active={activePanel === "pdf"} onClick={() => setActivePanel("pdf")} title="PDF" type="button">
            <FileText size={18} />
          </button>
          {authSession.permissions.canOpenReadReport ? (
            <button className="panel-tab" data-active={activePanel === "reads"} onClick={() => setActivePanel("reads")} title="읽음" type="button">
              <CheckCircle2 size={18} />
            </button>
          ) : null}
          <button className="panel-tab" data-active={activePanel === "members"} onClick={() => setActivePanel("members")} title="참여자" type="button">
            <Users size={18} />
          </button>
          <button className="panel-tab" data-active={activePanel === "ai"} onClick={() => setActivePanel("ai")} title="AI" type="button">
            <Sparkles size={18} />
          </button>
          <button className="panel-tab" onClick={popOut} title="패널 팝업" type="button">
            <MonitorUp size={18} />
          </button>
        </div>
        <div className="panel-content">
          <PanelBody
            activePanel={activePanel}
            attachments={attachments.map((item) => item.attachment)}
            canInviteGuests={authSession.permissions.canInviteGuests}
            currentUser={currentUser}
            invites={invites}
            inviteEmail={inviteEmail}
            isConfirmingRead={isConfirmingRead}
            isInviting={isInviting}
            notice={notice}
            onConfirmRead={() => void confirmSelectedRead()}
            onCreateInvite={() => void createInvite()}
            onInviteEmailChange={setInviteEmail}
            selectedMessage={selectedMessage}
            selectedPdf={selectedPdf}
            users={roomUsers}
            aiJobs={aiJobs}
          />
        </div>
      </aside>
    </main>
  );
}

function PanelBody({
  activePanel,
  attachments,
  canInviteGuests,
  currentUser,
  invites,
  inviteEmail,
  isConfirmingRead,
  isInviting,
  notice,
  onConfirmRead,
  onCreateInvite,
  onInviteEmailChange,
  selectedMessage,
  selectedPdf,
  users,
  aiJobs
}: {
  activePanel: PanelKey;
  attachments: Attachment[];
  canInviteGuests: boolean;
  currentUser: User;
  invites: Invite[];
  inviteEmail: string;
  isConfirmingRead: boolean;
  isInviting: boolean;
  notice: string;
  onConfirmRead: () => void;
  onCreateInvite: () => void;
  onInviteEmailChange: (value: string) => void;
  selectedMessage: Message;
  selectedPdf: Attachment | undefined;
  users: User[];
  aiJobs: AiJob[];
}) {
  if (activePanel === "reads") {
    return <ReadPanel currentUser={currentUser} isConfirmingRead={isConfirmingRead} message={selectedMessage} onConfirmRead={onConfirmRead} users={users} />;
  }

  if (activePanel === "pdf") {
    return <PdfPanel pdf={selectedPdf} />;
  }

  if (activePanel === "members") {
    return (
      <>
        <div className="panel-section">
          <h2 className="panel-title">
            <Plus size={17} /> 대상 초대
          </h2>
          <label className="field">
            이메일
            <input className="text-input" disabled={!canInviteGuests || isInviting} value={inviteEmail} onChange={(event) => onInviteEmailChange(event.target.value)} />
          </label>
          <button className="primary-button" disabled={!canInviteGuests || isInviting} onClick={onCreateInvite} style={{ marginTop: 10 }} type="button">
            {isInviting ? "초대 저장 중" : "게스트 초대"}
          </button>
        </div>
        {invites.length > 0 ? (
          <div className="panel-section">
            <h2 className="panel-title">
              <Inbox size={17} /> 최근 초대
            </h2>
            {invites.map((invite) => (
              <div className="invite-row" key={invite.id}>
                <span>
                  <strong>{invite.email}</strong>
                  <span className="tiny" style={{ display: "block" }}>
                    {formatTime(invite.createdAt)} · {invite.role}
                  </span>
                </span>
                <span className="status-chip">{invite.status}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="panel-section">
          <h2 className="panel-title">
            <Users size={17} /> 참여자
          </h2>
          {users.map((user) => (
            <div className="member-row" key={user.id}>
              <img alt="" src={user.character.thumbnailUrl} />
              <span>
                <strong>{user.displayName}</strong>
                <span className="tiny" style={{ display: "block" }}>
                  {user.email}
                </span>
              </span>
              {user.id.startsWith("guest") ? <span className="guest-chip">게스트</span> : <span className="tiny">내부</span>}
            </div>
          ))}
        </div>
        <div className="notice">{notice}</div>
      </>
    );
  }

  if (activePanel === "ai") {
    return (
      <>
        <div className="panel-section">
          <h2 className="panel-title">
            <Sparkles size={17} /> AI 작업 대기열
          </h2>
          {aiJobs.map((job) => (
            <div className="ai-row" key={job.id}>
              {job.jobType === "tts" ? <Volume2 size={18} /> : job.jobType === "stt" ? <Mic2 size={18} /> : <Sparkles size={18} />}
              <span>
                <strong>{job.jobType.toUpperCase()}</strong>
                <span className="tiny" style={{ display: "block" }}>
                  {job.createdAt}
                </span>
              </span>
              <span className="status-chip">{job.status}</span>
            </div>
          ))}
        </div>
        <div className="panel-section">
          <h2 className="panel-title">
            <LockKeyhole size={17} /> 민감 기능
          </h2>
          <p className="panel-muted">녹화, 원격제어, AI transcript export는 동의와 감사 로그가 붙은 뒤 활성화됩니다.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="panel-section">
        <h2 className="panel-title">
          <FolderOpen size={17} /> 파일
        </h2>
        {attachments.length === 0 ? (
          <p className="panel-muted">공유된 파일이 없습니다.</p>
        ) : (
          attachments.map((attachment) => (
            <div className="attachment-tile" key={attachment.id}>
              {attachment.mimeType.startsWith("image/") ? <ImageIcon size={21} /> : <FileText size={21} />}
              <span>
                <strong>{attachment.fileName}</strong>
                <span className="tiny">
                  {formatBytes(attachment.sizeBytes)} · {attachment.virusScanStatus}
                </span>
              </span>
            </div>
          ))
        )}
      </div>
      <div className="panel-section">
        <h2 className="panel-title">
          <Inbox size={17} /> 미리보기
        </h2>
        <AttachmentPreview attachment={attachments.at(-1)} />
      </div>
      <div className="notice">{notice}</div>
    </>
  );
}

function AttachmentPreview({ attachment }: { attachment: Attachment | undefined }) {
  if (!attachment) {
    return <div className="file-preview panel-muted">파일 없음</div>;
  }

  if (attachment.mimeType.startsWith("image/") && attachment.objectUrl) {
    return (
      <div className="file-preview">
        <img alt={attachment.fileName} src={attachment.objectUrl} />
      </div>
    );
  }

  if (attachment.mimeType.startsWith("video/") && attachment.objectUrl) {
    return (
      <div className="file-preview">
        <video controls src={attachment.objectUrl} />
      </div>
    );
  }

  return (
    <div className="file-preview">
      <div style={{ textAlign: "center" }}>
        <FileText size={34} />
        <strong style={{ display: "block", marginTop: 8 }}>{attachment.fileName}</strong>
        <span className="tiny">{attachment.mimeType}</span>
      </div>
    </div>
  );
}

function PdfPanel({ pdf }: { pdf: Attachment | undefined }) {
  return (
    <>
      <div className="panel-section">
        <h2 className="panel-title">
          <FileText size={17} /> PDF 문서
        </h2>
        <strong>{pdf?.fileName ?? "프로젝트A_제안서_v1.pdf"}</strong>
        <p className="panel-muted">PDF.js 뷰어 연결 지점입니다. 업로드 PDF는 객체 URL로 표시하고, 서버 저장본은 서명 URL로 교체합니다.</p>
      </div>
      {pdf?.objectUrl ? (
        <iframe className="file-preview" src={pdf.objectUrl} title={pdf.fileName} />
      ) : (
        <div className="pdf-pages">
          <div className="pdf-page">
            <strong>프로젝트 A 제안서</strong>
            <div className="pdf-page-line" />
            <div className="pdf-page-line" />
            <div className="pdf-page-line" />
          </div>
          <div className="pdf-page">
            <strong>범위와 일정</strong>
            <div className="pdf-page-line" />
            <div className="pdf-page-line" />
            <div className="pdf-page-line" />
          </div>
        </div>
      )}
    </>
  );
}

function ReadPanel({
  currentUser,
  isConfirmingRead,
  message,
  onConfirmRead,
  users
}: {
  currentUser: User;
  isConfirmingRead: boolean;
  message: Message;
  onConfirmRead: () => void;
  users: User[];
}) {
  const report = buildReadReport(message, users);
  const currentRead = report.find((row) => row.user.id === currentUser.id);
  const canConfirm = Boolean(message.metadata.requiresConfirmation && !currentRead?.confirmedAt);

  return (
    <>
      <div className="panel-section">
        <h2 className="panel-title">
          <CheckCircle2 size={17} /> 읽음 리포트
        </h2>
        <p className="panel-muted">{message.body}</p>
        {canConfirm ? (
          <button className="primary-button" disabled={isConfirmingRead} onClick={onConfirmRead} style={{ marginTop: 10 }} type="button">
            {isConfirmingRead ? "확인 저장 중" : "확인했습니다"}
          </button>
        ) : null}
      </div>
      <div className="panel-section">
        {report.map((row) => (
          <div className="read-row" key={row.user.id}>
            <img alt="" src={row.user.character.thumbnailUrl} />
            <span>
              <strong>{row.user.displayName}</strong>
              <span className="tiny" style={{ display: "block" }}>
                {row.readAt ? formatTime(row.readAt) : "미읽음"}
              </span>
            </span>
            {row.confirmedAt ? <span className="status-chip">확인</span> : row.readAt ? <span className="audience-chip">읽음</span> : <span className="guest-chip">대기</span>}
          </div>
        ))}
      </div>
    </>
  );
}

function createLocalMessage({
  body,
  currentUser,
  audienceType,
  targetUserIds,
  roomMembers,
  requiresConfirmation
}: {
  body: string;
  currentUser: User;
  audienceType: AudienceType;
  targetUserIds: string[];
  roomMembers: RoomMember[];
  requiresConfirmation: boolean;
}): Message {
  const id = `msg-local-${Date.now()}`;
  const now = new Date().toISOString();
  const deliveryPlan = createMessageDeliveryPlan(
    demoRoom,
    roomMembers,
    id,
    currentUser.id,
    audienceType,
    targetUserIds,
    now
  );

  return {
    id,
    roomId: demoRoom.id,
    senderId: currentUser.id,
    messageType: "text",
    deliveryMode: deliveryPlan.deliveryMode,
    body,
    metadata: requiresConfirmation ? { requiresConfirmation: true } : {},
    createdAt: now,
    audiences: createMessageAudience(
      id,
      deliveryPlan.normalizedAudienceType,
      currentUser.id,
      deliveryPlan.normalizedTargetUserIds
    ),
    deliveries: deliveryPlan.deliveries,
    attachments: []
  };
}

function audienceLabel(audienceType: AudienceType, targetUserIds: string[], users: User[]) {
  if (audienceType === "all") {
    return "전체";
  }

  const names = targetUserIds
    .map((id) => users.find((user) => user.id === id)?.displayName)
    .filter((name): name is string => Boolean(name));

  if (audienceType === "private") {
    return `${names[0] ?? "대상"}와 비공개`;
  }

  return `${names.length}명 선택`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readStoredSession() {
  try {
    const rawSession = window.localStorage.getItem(authSessionStorageKey);

    if (!rawSession) {
      return null;
    }

    const session = JSON.parse(rawSession) as AuthSession;

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      window.localStorage.removeItem(authSessionStorageKey);
      return null;
    }

    return session;
  } catch {
    window.localStorage.removeItem(authSessionStorageKey);
    return null;
  }
}

async function postJson<TResponse>(path: string, payload: Record<string, unknown>): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return response.json() as Promise<TResponse>;
}

async function getJson<TResponse>(path: string): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`);

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return response.json() as Promise<TResponse>;
}

function mergeCurrentUser(users: User[], currentUser: User) {
  const mergedUsers = users.map((user) => user.id === currentUser.id ? currentUser : user);

  if (mergedUsers.some((user) => user.id === currentUser.id)) {
    return mergedUsers;
  }

  return [currentUser, ...mergedUsers];
}

function attachPreviewUrl(message: Message, objectUrl: string): Message {
  return {
    ...message,
    attachments: message.attachments.map((attachment, index) => index === 0 ? { ...attachment, objectUrl } : attachment)
  };
}

async function readApiError(response: Response) {
  try {
    const body = await response.json() as { message?: string | string[]; error?: string };
    const message = Array.isArray(body.message) ? body.message.join(" ") : body.message;

    return message ?? body.error ?? `요청 실패 (${response.status})`;
  } catch {
    return `요청 실패 (${response.status})`;
  }
}
