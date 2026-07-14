"use client";

import {
  Bell,
  CalendarDays,
  Camera,
  CheckCircle2,
  ChevronUp,
  Copy,
  FileText,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Inbox,
  KeyRound,
  LogOut,
  MessageCircle,
  Mic2,
  MonitorUp,
  MoreHorizontal,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Radio,
  Reply,
  RefreshCw,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  Users,
  Video,
  Volume2,
  X,
  XCircle
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  buildReadReport,
  characterPresets,
  createMessageAudience,
  createMessageDeliveryPlan,
  demoMessages,
  demoRoom,
  demoRoomMembers,
  demoUsers,
  getAudienceLabel,
  getRoomPresentationForViewer,
  isMessageVisibleTo,
  projectMessageForViewer,
  type ApprovalPolicy,
  type AiCapabilityView,
  type AuthSession,
  type AiJob,
  type Attachment,
  type AudienceType,
  type CallCapabilities,
  type CallType,
  type CallView,
  type CreatedMembershipInvitation,
  type ConversationListItem,
  type ConversationView,
  type DeviceSessionView,
  type InvitationAcceptanceResult,
  type InvitationPreview,
  type Message,
  type MessageDeleteResult,
  type MembershipInvitationView,
  type MediaArchiveScope,
  type MediaAssetView,
  type MediaLibraryView,
  type MediaUploadSessionView,
  type MediaUploadSource,
  type MvpSnapshot,
  type RoomMember,
  type RoomPresentation,
  type TypingUpdate,
  type User,
  type VoiceProfileView
} from "@hahatalk/contracts";
import { apiBaseUrl, fetchBinary, getJson, postJson, putBinary, requestJson } from "../lib/api-client";
import { ContactsDesk } from "./contacts-desk";
import { CalendarDesk } from "./calendar-desk";
import { MediaPanel, type MediaUploadTaskView } from "./media-panel";
import { PdfViewer } from "./pdf-viewer";
import { CallDesk } from "./call-desk";
import { BroadcastDesk } from "./broadcast-desk";
import { AiPanel } from "./ai-panel";

type PanelKey = "files" | "pdf" | "reads" | "members" | "ai";
type ReadReportRow = ReturnType<typeof buildReadReport>[number];
type AuthMode = "activate" | "login" | "invitation";
type CredentialAuthMode = Exclude<AuthMode, "invitation">;
type MediaMode = "archive" | "share";

const reactions = ["확인", "완료", "질문", "긴급", "감사"];
export function WorkDesk() {
  const [authMode, setAuthMode] = useState<AuthMode>("activate");
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [isRestoringAuth, setIsRestoringAuth] = useState(true);
  const [authError, setAuthError] = useState("");
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);
  const [displayName, setDisplayName] = useState("이과장");
  const [email, setEmail] = useState("you@inviz.co.kr");
  const [password, setPassword] = useState("");
  const [selectedCharacterId, setSelectedCharacterId] = useState(characterPresets[0]?.id ?? "");
  const [initialInviteCode, setInitialInviteCode] = useState("");
  const [deskMode, setDeskMode] = useState<"chat" | "contacts" | "calendar" | "broadcast">(() => {
    if (typeof window === "undefined") return "chat";
    const requested = new URLSearchParams(window.location.search).get("desk");
    return requested === "contacts" || requested === "calendar" || requested === "broadcast" ? requested : "chat";
  });
  const selectedCharacter = characterPresets.find((character) => character.id === selectedCharacterId) ?? characterPresets[0]!;

  useEffect(() => {
    let active = true;
    const invitationHash = window.location.hash.match(/^#invite=(.+)$/);
    if (invitationHash?.[1]) {
      try {
        setInitialInviteCode(decodeURIComponent(invitationHash[1]));
        setAuthMode("invitation");
      } catch {
        setInitialInviteCode("");
      }
    }
    void getJson<AuthSession>("/auth/me")
      .then((session) => {
        if (!active) {
          return;
        }
        setAuthSession(session);
        setDisplayName(session.user.displayName);
        setEmail(session.user.email);
        setSelectedCharacterId(session.user.character.id);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setIsRestoringAuth(false);
        }
      });
    return () => {
      active = false;
    };
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
        authMode === "activate" ? "/auth/signup" : "/auth/login",
        authMode === "activate"
          ? { displayName, email, password, characterId: selectedCharacterId }
          : { email, password }
      );

      setAuthSession(session);
      setDisplayName(session.user.displayName);
      setEmail(session.user.email);
      setSelectedCharacterId(session.user.character.id);
      setPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "가입/로그인 처리 중 오류가 발생했습니다.");
    } finally {
      setIsSubmittingAuth(false);
    }
  }

  async function logout() {
    try {
      await postJson<{ ok: boolean }>("/auth/logout", {});
    } catch {
      // The local authenticated view still closes if the API is already unavailable.
    }
    setAuthSession(null);
    setAuthMode("login");
    setDeskMode("chat");
  }

  if (isRestoringAuth) {
    return <main className="auth-shell" aria-busy="true" />;
  }

  if (!authSession) {
    if (authMode === "invitation") {
      return (
        <InvitationAcceptanceFlow
          initialInviteCode={initialInviteCode}
          onBack={() => setAuthMode("login")}
          onComplete={(acceptedEmail) => {
            setEmail(acceptedEmail);
            setPassword("");
            setAuthMode("login");
          }}
        />
      );
    }
    return (
      <SignupFlow
        authMode={authMode}
        displayName={displayName}
        email={email}
        password={password}
        error={authError}
        isSubmitting={isSubmittingAuth}
        selectedCharacterId={selectedCharacterId}
        onAuthModeChange={(value) => setAuthMode(value)}
        onInvitationMode={() => setAuthMode("invitation")}
        onDisplayNameChange={setDisplayName}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        onCharacterChange={setSelectedCharacterId}
        onSubmit={submitAuth}
      />
    );
  }

  function openDesk(mode: "chat" | "contacts" | "calendar" | "broadcast", spaceId?: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("desk", mode);
    if (spaceId) url.searchParams.set("space", spaceId);
    else if (mode !== "chat") url.searchParams.delete("space");
    window.history.replaceState(null, "", url);
    setDeskMode(mode);
  }

  return deskMode === "contacts" ? (
    <ContactsDesk
      authSession={authSession}
      currentUser={currentUser}
      onLogout={logout}
      onOpenBroadcast={() => openDesk("broadcast")}
      onOpenCalendar={() => openDesk("calendar")}
      onOpenChat={() => openDesk("chat")}
    />
  ) : deskMode === "calendar" ? (
    <CalendarDesk
      authSession={authSession}
      currentUser={currentUser}
      onLogout={logout}
      onOpenBroadcast={() => openDesk("broadcast")}
      onOpenChat={() => openDesk("chat")}
      onOpenContacts={() => openDesk("contacts")}
    />
  ) : deskMode === "broadcast" ? (
    <BroadcastDesk
      authSession={authSession}
      currentUser={currentUser}
      onLogout={logout}
      onOpenCalendar={() => openDesk("calendar")}
      onOpenChat={() => openDesk("chat")}
      onOpenChatSpace={(spaceId) => openDesk("chat", spaceId)}
      onOpenContacts={() => openDesk("contacts")}
    />
  ) : (
    <ChatDesk
      authSession={authSession}
      currentUser={currentUser}
      initialInviteCode={initialInviteCode}
      onLogout={logout}
      onOpenBroadcast={() => openDesk("broadcast")}
      onOpenCalendar={() => openDesk("calendar")}
      onOpenContacts={() => openDesk("contacts")}
      users={users}
    />
  );
}

function SignupFlow({
  authMode,
  displayName,
  email,
  password,
  error,
  isSubmitting,
  selectedCharacterId,
  onAuthModeChange,
  onInvitationMode,
  onDisplayNameChange,
  onEmailChange,
  onPasswordChange,
  onCharacterChange,
  onSubmit
}: {
  authMode: CredentialAuthMode;
  displayName: string;
  email: string;
  password: string;
  error: string;
  isSubmitting: boolean;
  selectedCharacterId: string;
  onAuthModeChange: (value: CredentialAuthMode) => void;
  onInvitationMode: () => void;
  onDisplayNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
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
        <h1>{authMode === "activate" ? "HahaTalk 계정 활성화" : "HahaTalk 로그인"}</h1>
        <p className="auth-copy">
          {authMode === "activate" ? "등록된 초기 계정의 업무 프로필과 캐릭터를 설정합니다." : "업무 이메일과 비밀번호로 내 세션을 다시 엽니다."}
        </p>
        <div className="auth-mode-tabs" aria-label="인증 모드">
          <button className="chip-button" data-active={authMode === "activate"} onClick={() => onAuthModeChange("activate")} type="button">
            계정 활성화
          </button>
          <button className="chip-button" data-active={authMode === "login"} onClick={() => onAuthModeChange("login")} type="button">
            로그인
          </button>
          <button className="chip-button" onClick={onInvitationMode} type="button">
            초대 수락
          </button>
        </div>
        <div className="field-stack">
          {authMode === "activate" ? (
            <label className="field">
              이름
              <input className="text-input" minLength={2} required value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} />
            </label>
          ) : null}
          <label className="field">
            업무 이메일
            <input className="text-input" required type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} />
          </label>
          <label className="field">
            비밀번호
            <input
              autoComplete={authMode === "activate" ? "new-password" : "current-password"}
              className="text-input"
              maxLength={128}
              minLength={authMode === "activate" ? 12 : 1}
              required
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
          </label>
        </div>

        {authMode === "activate" ? (
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
          {isSubmitting ? "처리 중" : authMode === "activate" ? "계정 활성화" : "로그인하고 입장"}
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

function InvitationAcceptanceFlow({
  initialInviteCode,
  onBack,
  onComplete
}: {
  initialInviteCode: string;
  onBack: () => void;
  onComplete: (email: string) => void;
}) {
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [result, setResult] = useState<InvitationAcceptanceResult | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [characterId, setCharacterId] = useState(characterPresets[2]?.id ?? characterPresets[0]!.id);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptGroupJoin, setAcceptGroupJoin] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function inspectInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      const nextPreview = await postJson<InvitationPreview>("/invitations/preview", { inviteCode: inviteCode.trim() });
      setPreview(nextPreview);
      window.history.replaceState(null, "", window.location.pathname);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "초대 코드를 확인하지 못했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function acceptInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      const accepted = await postJson<InvitationAcceptanceResult>("/invitations/accept", {
        acceptGroupJoin,
        acceptPrivacy,
        acceptTerms,
        characterId,
        displayName,
        inviteCode,
        password
      });
      setResult(accepted);
      setInviteCode("");
      setPassword("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "초대 수락을 완료하지 못했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function declineInvitation() {
    setError("");
    setIsSubmitting(true);
    try {
      await postJson<{ ok: boolean }>("/invitations/decline", { inviteCode });
      setResult({ email: "", loginAllowed: false, role: preview?.role ?? "guest", status: "pending_approval" });
      setInviteCode("");
      setPreview(null);
      onBack();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "초대 거절을 저장하지 못했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (result) {
    return (
      <main className="auth-shell auth-shell-single">
        <section className="auth-panel" aria-live="polite">
          <div className="brand-mark">인</div>
          <ShieldCheck size={34} />
          <h1>{result.loginAllowed ? "가입 승인 완료" : "가입 승인 대기"}</h1>
          <div className="invite-summary">
            <strong>{result.role === "guest" ? "외부 게스트" : "내부 구성원"}</strong>
            <span className="tiny">{result.loginAllowed ? "로그인 가능" : "필요한 구성원 승인을 기다리는 중"}</span>
          </div>
          {result.loginAllowed ? (
            <button className="primary-button" onClick={() => onComplete(result.email)} type="button">
              로그인으로 이동
            </button>
          ) : (
            <button className="secondary-button" onClick={onBack} type="button">
              로그인 화면
            </button>
          )}
        </section>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="auth-shell auth-shell-single">
        <form className="auth-panel" onSubmit={inspectInvitation}>
          <div className="brand-mark">인</div>
          <h1>HahaTalk 초대 수락</h1>
          <label className="field">
            초대 코드
            <input
              autoComplete="off"
              className="text-input"
              minLength={40}
              required
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
            />
          </label>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "확인 중" : "초대 확인"}
          </button>
          <button className="secondary-button" onClick={onBack} type="button">
            로그인으로 돌아가기
          </button>
        </form>
      </main>
    );
  }

  if (preview.accountClaimed) {
    return (
      <main className="auth-shell auth-shell-single">
        <section className="auth-panel">
          <div className="brand-mark">인</div>
          <KeyRound size={34} />
          <h1>기존 계정 초대</h1>
          <div className="invite-summary">
            <strong>{preview.organizationName}</strong>
            <span>{preview.inviterDisplayName} · {preview.emailMasked}</span>
            <span className="tiny">{preview.role === "guest" ? "외부 게스트" : "내부 구성원"}</span>
          </div>
          <div className="notice">기존 계정으로 로그인한 뒤 참여자 패널에서 초대 코드를 수락합니다.</div>
          <button className="primary-button" onClick={onBack} type="button">로그인</button>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-shell auth-shell-single">
      <form className="auth-panel" onSubmit={acceptInvitation}>
        <div className="brand-mark">인</div>
        <h1>{preview.organizationName} 가입</h1>
        <div className="invite-summary">
          <strong>{preview.inviterDisplayName}</strong>
          <span>{preview.emailMasked} · {preview.role === "guest" ? "외부 게스트" : "내부 구성원"}</span>
          <span className="tiny">만료 {formatDateTime(preview.expiresAt)}</span>
        </div>
        <div className="field-stack">
          <label className="field">
            이름
            <input className="text-input" minLength={2} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label className="field">
            새 비밀번호
            <input
              autoComplete="new-password"
              className="text-input"
              minLength={12}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>
        <div className="character-grid compact-character-grid">
          {characterPresets.map((character) => (
            <button
              className="character-card"
              data-selected={character.id === characterId}
              key={character.id}
              onClick={() => setCharacterId(character.id)}
              type="button"
            >
              <img alt="" src={character.thumbnailUrl} />
              <strong>{character.name}</strong>
            </button>
          ))}
        </div>
        <div className="consent-list">
          <label><input checked={acceptTerms} onChange={(event) => setAcceptTerms(event.target.checked)} type="checkbox" /> 이용약관 동의</label>
          <label><input checked={acceptPrivacy} onChange={(event) => setAcceptPrivacy(event.target.checked)} type="checkbox" /> 개인정보 처리 동의</label>
          <label><input checked={acceptGroupJoin} onChange={(event) => setAcceptGroupJoin(event.target.checked)} type="checkbox" /> 그룹 가입 동의</label>
        </div>
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <button className="primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "가입 처리 중" : "동의하고 가입"}
        </button>
        <button className="secondary-button" disabled={isSubmitting} onClick={() => void declineInvitation()} type="button">
          초대 거절
        </button>
      </form>
    </main>
  );
}

function ChatDesk({
  authSession,
  currentUser,
  initialInviteCode,
  onLogout,
  onOpenBroadcast,
  onOpenCalendar,
  onOpenContacts,
  users
}: {
  authSession: AuthSession;
  currentUser: User;
  initialInviteCode: string;
  onLogout: () => void;
  onOpenBroadcast: () => void;
  onOpenCalendar: () => void;
  onOpenContacts: () => void;
  users: User[];
}) {
  const initialRoomMembers = mergeCurrentMembership(demoRoomMembers, currentUser, authSession.role, authSession.createdAt);
  const initialRoomPresentation = {
    ...getRoomPresentationForViewer(demoRoom, initialRoomMembers, users, currentUser.id),
    roomId: authSession.roomId
  };
  const initialVisibleMemberIds = new Set(initialRoomPresentation.visibleMemberIds);
  const [activeSpaceId, setActiveSpaceId] = useState(() => {
    if (typeof window === "undefined") return authSession.roomId;
    return new URLSearchParams(window.location.search).get("space") ?? authSession.roomId;
  });
  const [spaces, setSpaces] = useState<ConversationListItem[]>([]);
  const [roomPresentation, setRoomPresentation] = useState<RoomPresentation>(initialRoomPresentation);
  const [roomUsers, setRoomUsers] = useState<User[]>(users.filter((user) => initialVisibleMemberIds.has(user.id)));
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>(
    initialRoomMembers.filter((member) => initialVisibleMemberIds.has(member.userId))
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [nextMessageCursor, setNextMessageCursor] = useState<string | undefined>();
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [aiJobs, setAiJobs] = useState<AiJob[]>([]);
  const [aiCapabilities, setAiCapabilities] = useState<AiCapabilityView>();
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfileView[]>([]);
  const [isAiAction, setIsAiAction] = useState(false);
  const [invitations, setInvitations] = useState<MembershipInvitationView[]>([]);
  const [sessions, setSessions] = useState<DeviceSessionView[]>([]);
  const [activePanel, setActivePanel] = useState<PanelKey>(() => {
    if (typeof window === "undefined") return "files";
    const panel = new URLSearchParams(window.location.search).get("panel");
    return (["files", "pdf", "reads", "members", "ai"] as PanelKey[]).includes(panel as PanelKey)
      ? panel as PanelKey
      : "files";
  });
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [audienceType, setAudienceType] = useState<AudienceType>("all");
  const [targetUserIds, setTargetUserIds] = useState<string[]>(["user-mina"]);
  const [composer, setComposer] = useState("");
  const [replyToId, setReplyToId] = useState<string | undefined>();
  const [editingMessageId, setEditingMessageId] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [typingUsers, setTypingUsers] = useState<TypingUpdate[]>([]);
  const [realtimeState, setRealtimeState] = useState<"connecting" | "online" | "offline">("connecting");
  const [requiresConfirmation, setRequiresConfirmation] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("customer@example.com");
  const [inviteRole, setInviteRole] = useState<"member" | "guest">("guest");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("owner_and_invitee");
  const [requiredApprovalCount, setRequiredApprovalCount] = useState(2);
  const [latestInviteCode, setLatestInviteCode] = useState("");
  const [receivedInviteCode, setReceivedInviteCode] = useState(initialInviteCode);
  const [acceptExistingTerms, setAcceptExistingTerms] = useState(false);
  const [acceptExistingPrivacy, setAcceptExistingPrivacy] = useState(false);
  const [acceptExistingGroupJoin, setAcceptExistingGroupJoin] = useState(false);
  const [notice, setNotice] = useState("외부 게스트는 초대받은 방과 파일만 볼 수 있습니다.");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isInviting, setIsInviting] = useState(false);
  const [isInvitationAction, setIsInvitationAction] = useState(false);
  const [isSessionAction, setIsSessionAction] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [mediaMode, setMediaMode] = useState<MediaMode>("share");
  const [mediaLibrary, setMediaLibrary] = useState<MediaLibraryView>({ albums: [], assets: [], hasMore: false });
  const [selectedAssetId, setSelectedAssetId] = useState(() => (
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("asset") ?? ""
  ));
  const [mediaDateFilter, setMediaDateFilter] = useState("");
  const [mediaPlaceFilter, setMediaPlaceFilter] = useState("");
  const [mediaScopeFilter, setMediaScopeFilter] = useState<"" | MediaArchiveScope>("");
  const [mediaPlaceDraft, setMediaPlaceDraft] = useState("");
  const [mediaCapturedDraft, setMediaCapturedDraft] = useState("");
  const [albumName, setAlbumName] = useState("");
  const [selectedAlbumId, setSelectedAlbumId] = useState("");
  const [uploadTask, setUploadTask] = useState<MediaUploadTaskView>({ fileName: "", progress: 0, status: "idle" });
  const [retryUpload, setRetryUpload] = useState<{
    file: File;
    options?: { archiveOnly?: boolean; keepPanel?: PanelKey };
    source: MediaUploadSource;
  } | null>(null);
  const [isConfirmingRead, setIsConfirmingRead] = useState(false);
  const [readReportRows, setReadReportRows] = useState<ReadReportRow[] | undefined>();
  const [callCapabilities, setCallCapabilities] = useState<CallCapabilities>({
    available: false,
    deployment: "unconfigured",
    provider: "livekit",
    recording: {
      available: false,
      deployment: "unconfigured",
      mode: "room_composite",
      outputFormat: "mp4",
      policyVersion: "hahatalk-recording-v1",
      provider: "livekit-egress"
    },
    tokenTtlSeconds: 120
  });
  const [calls, setCalls] = useState<CallView[]>([]);
  const [selectedCallId, setSelectedCallId] = useState("");
  const [isCallAction, setIsCallAction] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadIdRef = useRef("");
  const activeSpaceIdRef = useRef(activeSpaceId);
  const readPendingIdsRef = useRef(new Set<string>());

  useEffect(() => {
    activeSpaceIdRef.current = activeSpaceId;
  }, [activeSpaceId]);

  useEffect(() => {
    const selected = mediaLibrary.assets.find((asset) => asset.id === selectedAssetId);
    setMediaPlaceDraft(selected?.placeName ?? "");
    setMediaCapturedDraft(selected?.capturedAt?.slice(0, 19) ?? "");
  }, [mediaLibrary.assets, selectedAssetId]);

  useEffect(() => {
    if (activePanel !== "ai") return;
    void refreshAiWorkbench(true);
    const timer = window.setInterval(() => void refreshAiWorkbench(true), 2_500);
    return () => window.clearInterval(timer);
  }, [activePanel, currentUser.id]);

  useEffect(() => {
    void refreshSnapshot();
  }, [authSession.user.id]);

  useEffect(() => {
    const socket = io(apiBaseUrl, {
      transports: ["websocket"],
      withCredentials: true
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      setRealtimeState("online");
      socket.emit("room:join", { spaceId: activeSpaceIdRef.current });
    });
    socket.on("disconnect", () => setRealtimeState("offline"));
    socket.on("connect_error", () => setRealtimeState("offline"));
    const applyMessage = (message: Message) => {
      if (message.roomId === activeSpaceIdRef.current) {
        setMessages((current) => upsertMessage(current, message));
      }
      void refreshSpaceList();
      void refreshMediaLibrary();
    };
    socket.on("message:created", applyMessage);
    socket.on("message:updated", applyMessage);
    socket.on("message:delivery-updated", applyMessage);
    socket.on("message:deleted", (deleted: MessageDeleteResult) => {
      setMessages((current) => current.filter((message) => message.id !== deleted.id));
      setSelectedMessageId((current) => current === deleted.id ? "" : current);
      void refreshSpaceList();
      void refreshMediaLibrary();
    });
    socket.on("typing:updated", (update: TypingUpdate) => {
      if (update.spaceId !== activeSpaceIdRef.current || update.userId === currentUser.id) {
        return;
      }
      setTypingUsers((current) => update.active
        ? [...current.filter((candidate) => candidate.userId !== update.userId), update]
        : current.filter((candidate) => candidate.userId !== update.userId));
    });
    const applyCall = (call: CallView) => {
      setCalls((current) => [call, ...current.filter((candidate) => candidate.id !== call.id)]);
      if (call.isIncoming) setSelectedCallId(call.id);
    };
    socket.on("call:incoming", applyCall);
    socket.on("call:updated", applyCall);
    socket.on("call:recording-updated", ({ sessionId }: { sessionId: string }) => {
      void getJson<CallView>(`/calls/${sessionId}`).then(applyCall).catch(() => undefined);
    });
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      socket.close();
      socketRef.current = null;
    };
  }, [currentUser.id]);

  useEffect(() => {
    const unread = messages.filter((message) => {
      if (message.senderId === currentUser.id || readPendingIdsRef.current.has(message.id)) return false;
      return message.deliveries.some((delivery) => delivery.recipientId === currentUser.id && !delivery.readAt && !delivery.revokedAt);
    });
    for (const message of unread) {
      readPendingIdsRef.current.add(message.id);
      void postJson<Message>(`/messages/${message.id}/read`, {})
        .then((updated) => setMessages((current) => upsertMessage(current, updated)))
        .catch(() => undefined)
        .finally(() => readPendingIdsRef.current.delete(message.id));
    }
  }, [currentUser.id, messages]);

  const visibleMessages = messages;
  const selectedMessage = messages.find((message) => message.id === selectedMessageId) ?? visibleMessages.at(-1);
  const attachments = messages.flatMap((message) => message.attachments.map((attachment) => ({ attachment, message })));
  const selectedMediaAsset = mediaLibrary.assets.find((asset) => asset.id === selectedAssetId);
  const selectedAttachment = attachments.find(({ attachment }) => attachment.assetId === selectedAssetId)?.attachment
    ?? selectedMessage?.attachments[0]
    ?? attachments.at(-1)?.attachment;
  const selectedPdf = selectedMediaAsset?.mimeType === "application/pdf"
    ? selectedMediaAsset
    : selectedAttachment?.mimeType === "application/pdf"
    ? selectedAttachment
    : attachments.find(({ attachment }) => attachment.mimeType === "application/pdf")?.attachment;
  const replyToMessage = messages.find((message) => message.id === replyToId);
  const selectedCall = calls.find((call) => call.id === selectedCallId);
  const currentLiveCall = calls.find((call) => (
    call.spaceId === activeSpaceId && ["starting", "ringing", "active"].includes(call.status)
  ));

  const targetUsers = roomUsers.filter((user) => user.id !== currentUser.id);
  const currentRoomMembership = roomMembers.find((member) => member.userId === currentUser.id);
  const canManageCurrentConversation = roomPresentation.ownerId === currentUser.id
    || (roomPresentation.mode !== "direct" && ["owner", "admin"].includes(currentRoomMembership?.role ?? ""));
  const canFetchSelectedReadReport = Boolean(
    selectedMessage && (selectedMessage.senderId === currentUser.id || canManageCurrentConversation)
  );
  const canOpenRoomReadReport = Boolean(
    selectedMessage
    && (selectedMessage.metadata.requiresConfirmation || canFetchSelectedReadReport)
  );

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

  async function startOrOpenCall(callType: CallType) {
    if (currentLiveCall) {
      setSelectedCallId(currentLiveCall.id);
      return;
    }
    if (!callCapabilities.available) {
      setNotice(callCapabilities.reason ?? "통화 서버가 설정되지 않았습니다.");
      return;
    }
    const effectiveAudience = getEffectiveAudience();
    if (roomPresentation.canSelectAudience && effectiveAudience.targetUserIds.length !== 1) {
      setNotice("숨김 허브 통화는 대화 대상을 한 명만 선택해야 합니다.");
      return;
    }
    setIsCallAction(true);
    try {
      const call = await postJson<CallView>("/calls", {
        callType,
        clientCallId: `web-call-${crypto.randomUUID()}`,
        spaceId: activeSpaceId,
        targetUserIds: effectiveAudience.targetUserIds
      });
      setCalls((current) => [call, ...current.filter((candidate) => candidate.id !== call.id)]);
      setSelectedCallId(call.id);
      setNotice(`${call.title} ${callType === "video" ? "영상" : "음성"} 통화를 시작했습니다.`);
    } catch (error) {
      setNotice(`통화 시작 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsCallAction(false);
    }
  }

  const applyCallUpdate = useCallback((call: CallView) => {
    setCalls((current) => [call, ...current.filter((candidate) => candidate.id !== call.id)]);
  }, []);

  function applyConversationView(view: ConversationView) {
    const nextUsers = mergeCurrentUser(view.users, currentUser);
    setActiveSpaceId(view.room.roomId);
    setRoomPresentation(view.room);
    setRoomUsers(nextUsers);
    setRoomMembers(view.roomMembers);
    setMessages(view.messages);
    setHasMoreMessages(Boolean(view.hasMore));
    setNextMessageCursor(view.nextCursor);
    setSelectedMessageId(view.messages.at(-1)?.id ?? "");
    setAudienceType("all");
    setTargetUserIds(view.room.visibleMemberIds.filter((id) => id !== currentUser.id).slice(0, 1));
    setReplyToId(undefined);
    setEditingMessageId(undefined);
    setComposer("");
    setTypingUsers([]);
    setSearchResults([]);
    setReadReportRows(undefined);
  }

  async function refreshSpaceList() {
    try {
      setSpaces(await getJson<ConversationListItem[]>("/spaces"));
    } catch {
      // The current room remains usable while the compact list retries on the next event.
    }
  }

  async function refreshMediaLibrary() {
    const parameters = new URLSearchParams();
    if (mediaDateFilter) parameters.set("date", mediaDateFilter);
    if (mediaPlaceFilter.trim()) parameters.set("place", mediaPlaceFilter.trim());
    if (mediaScopeFilter) parameters.set("scope", mediaScopeFilter);
    const query = parameters.toString();
    try {
      const library = await getJson<MediaLibraryView>(`/media/library${query ? `?${query}` : ""}`);
      setMediaLibrary(library);
      if (!selectedAssetId && library.assets[0]) setSelectedAssetId(library.assets[0].id);
    } catch (error) {
      setNotice(`미디어 보관함 동기화 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function refreshAiWorkbench(silent = false) {
    try {
      const [jobs, capabilities, profiles] = await Promise.all([
        getJson<AiJob[]>("/ai/jobs"),
        getJson<AiCapabilityView>("/ai/capabilities"),
        getJson<VoiceProfileView[]>("/ai/voice-profiles")
      ]);
      setAiJobs(jobs);
      setAiCapabilities(capabilities);
      setVoiceProfiles(profiles);
    } catch (error) {
      if (!silent) setNotice(`AI 작업 동기화 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function refreshSnapshot() {
    setIsSyncing(true);
    setSyncError("");

    try {
      const [snapshot, invitationRows, sessionRows, library, capabilities, callRows] = await Promise.all([
        getJson<MvpSnapshot>(`/mvp?spaceId=${encodeURIComponent(activeSpaceIdRef.current)}`),
        getJson<MembershipInvitationView[]>("/invitations"),
        getJson<DeviceSessionView[]>("/auth/sessions"),
        getJson<MediaLibraryView>("/media/library"),
        getJson<CallCapabilities>("/calls/capabilities"),
        getJson<CallView[]>(`/calls?spaceId=${encodeURIComponent(activeSpaceIdRef.current)}`)
      ]);
      applyConversationView(snapshot);
      setSpaces(snapshot.spaces ?? []);
      setInvitations(invitationRows);
      setSessions(sessionRows);
      setMediaLibrary(library);
      setCallCapabilities(capabilities);
      setCalls(callRows);
      if (library.assets[0]) setSelectedAssetId((current) => current || library.assets[0]!.id);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "업무방 동기화 실패");
    } finally {
      setIsSyncing(false);
    }
  }

  async function switchRoom(spaceId: string) {
    if (spaceId === activeSpaceId || isSyncing) return;
    setIsSyncing(true);
    setSyncError("");
    try {
      const view = await getJson<ConversationView>(`/spaces/${spaceId}/view`);
      activeSpaceIdRef.current = spaceId;
      applyConversationView(view);
      socketRef.current?.emit("room:join", { spaceId });
      const [spaceRows, callRows] = await Promise.all([
        getJson<ConversationListItem[]>("/spaces"),
        getJson<CallView[]>(`/calls?spaceId=${encodeURIComponent(spaceId)}`)
      ]);
      setSpaces(spaceRows);
      setCalls((current) => [
        ...callRows,
        ...current.filter((call) => call.spaceId !== spaceId && call.id === selectedCallId)
      ]);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "대화방을 열지 못했습니다.");
    } finally {
      setIsSyncing(false);
    }
  }

  async function loadOlderMessages() {
    if (!nextMessageCursor || isLoadingOlder) return;
    setIsLoadingOlder(true);
    try {
      const view = await getJson<ConversationView>(
        `/spaces/${activeSpaceId}/view?limit=40&before=${encodeURIComponent(nextMessageCursor)}`
      );
      setMessages((current) => mergeOlderMessages(view.messages, current));
      setHasMoreMessages(Boolean(view.hasMore));
      setNextMessageCursor(view.nextCursor);
    } catch (error) {
      setNotice(`이전 메시지 불러오기 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsLoadingOlder(false);
    }
  }

  async function searchConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    if (query.length < 2) {
      setNotice("검색어를 두 글자 이상 입력해 주세요.");
      return;
    }
    setIsSearching(true);
    try {
      const results = await getJson<Message[]>(
        `/spaces/${activeSpaceId}/search?q=${encodeURIComponent(query)}`
      );
      setSearchResults(results);
      setNotice(results.length ? `메시지 ${results.length}개를 찾았습니다.` : "검색 결과가 없습니다.");
    } catch (error) {
      setNotice(`검색 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsSearching(false);
    }
  }

  async function sendTextMessage(body = composer) {
    const trimmed = body.trim();

    if (!trimmed || isSending) {
      return;
    }

    setIsSending(true);
    try {
      let savedMessage: Message;
      if (editingMessageId) {
        savedMessage = await requestJson<Message>(`/messages/${editingMessageId}`, "PATCH", { body: trimmed });
      } else {
        const effectiveAudience = getEffectiveAudience();
        const result = await postJson<{ message: Message; replay: boolean }>("/messages", {
          audienceType: effectiveAudience.audienceType,
          body: trimmed,
          clientMessageId: `web-${crypto.randomUUID()}`,
          ...(replyToId ? { parentMessageId: replyToId } : {}),
          requiresConfirmation,
          spaceId: activeSpaceId,
          targetUserIds: effectiveAudience.targetUserIds
        });
        savedMessage = result.message;
      }

      setMessages((current) => upsertMessage(current, savedMessage));
      setSelectedMessageId(savedMessage.id);
      setComposer("");
      setReplyToId(undefined);
      setEditingMessageId(undefined);
      setRequiresConfirmation(false);
      socketRef.current?.emit("typing:set", { active: false, spaceId: activeSpaceId, targetUserIds: [] });
      setNotice(savedMessage.editedAt ? "수정한 메시지를 저장했습니다." : "메시지가 PostgreSQL에 저장되었습니다.");
      await refreshSpaceList();
    } catch (error) {
      setNotice(`메시지 전송 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsSending(false);
    }
  }

  function handleComposerChange(value: string) {
    setComposer(value);
    const effectiveAudience = getEffectiveAudience();
    socketRef.current?.emit("typing:set", {
      active: Boolean(value.trim()),
      spaceId: activeSpaceId,
      targetUserIds: effectiveAudience.targetUserIds
    });
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socketRef.current?.emit("typing:set", {
        active: false,
        spaceId: activeSpaceId,
        targetUserIds: effectiveAudience.targetUserIds
      });
    }, 1_200);
  }

  function beginReply(message: Message) {
    setReplyToId(message.id);
    setEditingMessageId(undefined);
    composerRef.current?.focus();
  }

  function beginEdit(message: Message) {
    setEditingMessageId(message.id);
    setReplyToId(undefined);
    setComposer(message.body);
    composerRef.current?.focus();
  }

  function cancelComposeContext() {
    setReplyToId(undefined);
    setEditingMessageId(undefined);
    setComposer("");
  }

  async function deleteMessage(message: Message) {
    try {
      await requestJson<MessageDeleteResult>(`/messages/${message.id}`, "DELETE");
      setMessages((current) => current.filter((candidate) => candidate.id !== message.id));
      setSelectedMessageId((current) => current === message.id ? "" : current);
      setNotice("메시지를 삭제했습니다.");
      await refreshSpaceList();
    } catch (error) {
      setNotice(`메시지 삭제 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function openReadReport(message: Message) {
    setSelectedMessageId(message.id);
    setActivePanel("reads");
    setReadReportRows(undefined);
    try {
      setReadReportRows(await getJson<ReadReportRow[]>(`/messages/${message.id}/read-report`));
    } catch (error) {
      setNotice(`읽음 리포트 조회 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
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
      const invite = await postJson<CreatedMembershipInvitation>("/invitations", {
        approvalPolicy,
        email,
        ...(approvalPolicy === "quorum_and_invitee" ? { requiredApprovalCount } : {}),
        role: inviteRole
      });

      setInvitations((current) => [invite, ...current.filter((candidate) => candidate.id !== invite.id)]);
      setLatestInviteCode(invite.inviteCode);
      setNotice(`${invite.email} 초대가 저장되었습니다. 초대 코드는 지금 한 번만 표시됩니다.`);
      setInviteEmail("");
    } catch (error) {
      setNotice(`게스트 초대 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsInviting(false);
    }
  }

  async function copyInviteCode() {
    if (!latestInviteCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(latestInviteCode);
      setNotice("초대 코드를 클립보드에 복사했습니다.");
    } catch {
      setNotice("클립보드 복사에 실패했습니다. 표시된 코드를 직접 선택해 주세요.");
    }
  }

  async function decideInvitation(invitationId: string, decision: "approved" | "rejected") {
    setIsInvitationAction(true);
    try {
      const updated = await postJson<MembershipInvitationView>(`/invitations/${invitationId}/decision`, { decision });
      setInvitations((current) => current.map((invitation) => invitation.id === updated.id ? updated : invitation));
      setNotice(decision === "approved" ? "가입 승인을 저장했습니다." : "가입 거절을 저장했습니다.");
    } catch (error) {
      setNotice(`승인 처리 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsInvitationAction(false);
    }
  }

  async function revokeInvitation(invitationId: string) {
    setIsInvitationAction(true);
    try {
      const updated = await postJson<MembershipInvitationView>(`/invitations/${invitationId}/revoke`, {});
      setInvitations((current) => current.map((invitation) => invitation.id === updated.id ? updated : invitation));
      setNotice("초대를 취소했습니다.");
    } catch (error) {
      setNotice(`초대 취소 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsInvitationAction(false);
    }
  }

  async function acceptReceivedInvitation() {
    if (!receivedInviteCode.trim()) {
      return;
    }
    setIsInvitationAction(true);
    try {
      const accepted = await postJson<InvitationAcceptanceResult>("/invitations/accept", {
        acceptGroupJoin: acceptExistingGroupJoin,
        acceptPrivacy: acceptExistingPrivacy,
        acceptTerms: acceptExistingTerms,
        inviteCode: receivedInviteCode.trim()
      });
      setReceivedInviteCode("");
      setAcceptExistingTerms(false);
      setAcceptExistingPrivacy(false);
      setAcceptExistingGroupJoin(false);
      setNotice(accepted.loginAllowed ? "초대 가입이 완료되었습니다." : "초대 수락이 저장되었고 구성원 승인을 기다립니다.");
      setInvitations(await getJson<MembershipInvitationView[]>("/invitations"));
    } catch (error) {
      setNotice(`초대 수락 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsInvitationAction(false);
    }
  }

  async function revokeDeviceSession(sessionId: string) {
    setIsSessionAction(true);
    try {
      await postJson<{ ok: boolean }>(`/auth/sessions/${sessionId}/revoke`, {});
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      setNotice("선택한 기기 세션을 종료했습니다.");
    } catch (error) {
      setNotice(`세션 종료 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsSessionAction(false);
    }
  }

  async function revokeOtherDeviceSessions() {
    setIsSessionAction(true);
    try {
      const result = await postJson<{ ok: boolean; revokedCount: number }>("/auth/sessions/revoke-others", {});
      setSessions((current) => current.filter((session) => session.current));
      setNotice(`다른 기기 세션 ${result.revokedCount}개를 종료했습니다.`);
    } catch (error) {
      setNotice(`다른 기기 종료 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsSessionAction(false);
    }
  }

  async function confirmSelectedRead() {
    if (!selectedMessage?.metadata.requiresConfirmation || isConfirmingRead) {
      return;
    }

    setIsConfirmingRead(true);
    try {
      const confirmedMessage = await postJson<Message>(`/messages/${selectedMessage.id}/confirm`, {});

      setMessages((current) => current.map((message) => message.id === confirmedMessage.id ? confirmedMessage : message));
      setSelectedMessageId(confirmedMessage.id);
      if (confirmedMessage.senderId === currentUser.id || canManageCurrentConversation) {
        setReadReportRows(await getJson<ReadReportRow[]>(`/messages/${confirmedMessage.id}/read-report`));
      } else {
        setReadReportRows(buildReadReport(confirmedMessage, roomUsers));
      }
      setNotice("확인 상태가 읽음 리포트에 저장되었습니다.");
    } catch (error) {
      setNotice(`확인 처리 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsConfirmingRead(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await uploadMedia(file, "file_upload");
  }

  async function shareScreenCapture() {
    let stream: MediaStream | undefined;
    try {
      const mediaDevices = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
      };

      if (!mediaDevices.getDisplayMedia) {
        setNotice("현재 브라우저는 화면 캡처 공유를 지원하지 않습니다.");
        return;
      }

      stream = await mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((resolve) => window.setTimeout(resolve, 250));

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("화면 캡처 이미지를 만들지 못했습니다.");
      const timestamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
      await uploadMedia(new File([blob], `화면캡처_${timestamp}.png`, { type: "image/png" }), "screen_capture");
    } catch (error) {
      setNotice(error instanceof Error && error.message.includes("만들지") ? error.message : "화면 캡처 공유가 취소되었습니다.");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  async function uploadMedia(
    file: File,
    source: MediaUploadSource,
    options?: { archiveOnly?: boolean; keepPanel?: PanelKey }
  ): Promise<MediaAssetView | undefined> {
    if (isUploading) return;
    const controller = new AbortController();
    const effectiveAudience = getEffectiveAudience();
    uploadAbortRef.current = controller;
    uploadIdRef.current = "";
    setRetryUpload({ file, source, ...(options ? { options } : {}) });
    setIsUploading(true);
    setUploadTask({ fileName: file.name, progress: 0, status: "hashing" });
    setActivePanel(options?.keepPanel ?? "files");
    try {
      const sha256Hex = await sha256Blob(file);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const session = await postJson<MediaUploadSessionView>("/media/uploads", {
        clientUploadId: `upload-${crypto.randomUUID()}`,
        declaredMimeType: file.type || "application/octet-stream",
        fileName: file.name,
        sha256Hex,
        sizeBytes: file.size,
        source
      });
      uploadIdRef.current = session.id;
      setUploadTask({ fileName: file.name, progress: 0, status: "uploading" });
      for (let index = 0; index < session.partCount; index += 1) {
        const partNumber = index + 1;
        const part = file.slice(index * session.partSizeBytes, Math.min(file.size, partNumber * session.partSizeBytes));
        const partHash = await sha256Blob(part);
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await putBinary(`/media/uploads/${session.id}/parts/${partNumber}`, part, partHash, controller.signal);
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (controller.signal.aborted || attempt === 3) break;
            await wait(250 * attempt);
          }
        }
        if (lastError) throw lastError;
        setUploadTask({ fileName: file.name, progress: Math.round((partNumber / session.partCount) * 90), status: "uploading" });
      }
      setUploadTask({ fileName: file.name, progress: 94, status: "processing" });
      const asset = await postJson<MediaAssetView>(`/media/uploads/${session.id}/complete`, { sha256Hex });
      setSelectedAssetId(asset.id);
      await refreshMediaLibrary();
      if (asset.processingStatus !== "ready") {
        setUploadTask({ fileName: file.name, progress: 100, status: "done" });
        setNotice(`${file.name} 파일은 보안 검사에서 격리되었습니다.`);
        return;
      }
      if (mediaMode === "share" && !options?.archiveOnly) {
        const result = await postJson<{ message: Message; replay: boolean }>(`/media/assets/${asset.id}/share`, {
          archiveScope: effectiveAudience.audienceType === "all" ? "shared" : "selected",
          audienceType: effectiveAudience.audienceType,
          caption: source === "screen_capture" ? "현재 화면 캡처 공유" : `${file.name} 공유`,
          clientMessageId: `media-share-${crypto.randomUUID()}`,
          spaceId: activeSpaceId,
          targetUserIds: effectiveAudience.targetUserIds
        });
        setMessages((current) => upsertMessage(current, result.message));
        setSelectedMessageId(result.message.id);
        setNotice(`${file.name} 파일을 현재 대상으로 공유했습니다.`);
      } else {
        setNotice(`${file.name} 파일을 내 보관함에 저장했습니다.`);
      }
      setUploadTask({ fileName: file.name, progress: 100, status: "done" });
      if (file.type === "application/pdf" && !options?.keepPanel) setActivePanel("pdf");
      await refreshMediaLibrary();
      return asset;
    } catch (error) {
      const aborted = controller.signal.aborted;
      setUploadTask({
        error: aborted ? "업로드를 취소했습니다." : error instanceof Error ? error.message : "알 수 없는 오류",
        fileName: file.name,
        progress: 0,
        status: aborted ? "idle" : "failed"
      });
      setNotice(aborted ? "파일 업로드를 취소했습니다." : `파일 업로드 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      uploadAbortRef.current = null;
      uploadIdRef.current = "";
      setIsUploading(false);
    }
  }

  async function abortMediaUpload() {
    setUploadTask((current) => ({ ...current, status: "aborting" }));
    uploadAbortRef.current?.abort();
    const uploadId = uploadIdRef.current;
    if (uploadId) await requestJson(`/media/uploads/${uploadId}`, "DELETE").catch(() => undefined);
  }

  async function retryMediaUpload() {
    if (retryUpload) await uploadMedia(retryUpload.file, retryUpload.source, retryUpload.options);
  }

  async function createSttFromVoice(file: File) {
    if (isAiAction || isUploading) return;
    setIsAiAction(true);
    try {
      const asset = await uploadMedia(file, "file_upload", { archiveOnly: true, keepPanel: "ai" });
      if (!asset || asset.processingStatus !== "ready" || asset.mediaKind !== "audio") {
        throw new Error("검사에 통과한 음성 파일만 STT에 사용할 수 있습니다.");
      }
      await postJson<AiJob>("/ai/jobs/stt", {
        assetId: asset.id,
        idempotencyKey: `stt-${crypto.randomUUID()}`,
        language: "auto"
      });
      await refreshAiWorkbench();
      setNotice("음성을 안전하게 저장하고 STT 초안 작업을 대기열에 넣었습니다.");
    } catch (error) {
      setNotice(`STT 요청 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsAiAction(false);
      setActivePanel("ai");
    }
  }

  async function createAiSummary() {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await postJson<AiJob>("/ai/jobs/summary", {
        idempotencyKey: `summary-${crypto.randomUUID()}`,
        spaceId: activeSpaceId
      });
      await refreshAiWorkbench();
      setNotice("내가 볼 수 있는 현재 대화만 고정해 요약을 요청했습니다.");
    } catch (error) {
      setNotice(`대화 요약 요청 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsAiAction(false);
    }
  }

  async function createAiTts(text: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await postJson<AiJob>("/ai/jobs/tts", {
        idempotencyKey: `tts-${crypto.randomUUID()}`,
        speed: 1,
        text,
        voiceId: "Sohee"
      });
      await refreshAiWorkbench();
      setNotice("Sohee 한국어 음성 작업을 요청했습니다.");
    } catch (error) {
      setNotice(`TTS 요청 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsAiAction(false);
    }
  }

  async function createAiAvatar(assetId: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await postJson<AiJob>("/ai/jobs/avatar", {
        assetId,
        consentToStoreSource: true,
        idempotencyKey: `avatar-${crypto.randomUUID()}`,
        style: "work-friendly"
      });
      await refreshAiWorkbench();
      setNotice("선택한 사진으로 업무용 캐리커처 초안을 요청했습니다.");
    } catch (error) {
      setNotice(`캐리커처 요청 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsAiAction(false);
    }
  }

  async function editAiTranscript(transcriptId: string, text: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await requestJson(`/ai/transcripts/${transcriptId}`, "PATCH", { text });
      await refreshAiWorkbench();
      setNotice("STT 초안을 저장했습니다.");
    } catch (error) {
      setNotice(`STT 초안 저장 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
      throw error;
    } finally {
      setIsAiAction(false);
    }
  }

  async function sendAiTranscript(transcriptId: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      const effectiveAudience = getEffectiveAudience();
      const result = await postJson<{ message: Message }>(`/ai/transcripts/${transcriptId}/send`, {
        audienceType: effectiveAudience.audienceType,
        clientMessageId: `stt-message-${crypto.randomUUID()}`,
        requiresConfirmation,
        spaceId: activeSpaceId,
        targetUserIds: effectiveAudience.targetUserIds
      });
      setMessages((current) => upsertMessage(current, result.message));
      setSelectedMessageId(result.message.id);
      await Promise.all([refreshAiWorkbench(), refreshSpaceList()]);
      setNotice("검토한 STT 문장을 현재 대화 대상으로 전송했습니다.");
    } catch (error) {
      setNotice(`STT 전송 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
      throw error;
    } finally {
      setIsAiAction(false);
    }
  }

  async function rejectAiTranscript(transcriptId: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await postJson(`/ai/transcripts/${transcriptId}/reject`, {});
      await refreshAiWorkbench();
      setNotice("STT 초안을 폐기했습니다.");
    } finally {
      setIsAiAction(false);
    }
  }

  async function retryAiJob(jobId: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await postJson(`/ai/jobs/${jobId}/retry`, {});
      await refreshAiWorkbench();
      setNotice("AI 작업을 다시 대기열에 넣었습니다.");
    } finally {
      setIsAiAction(false);
    }
  }

  async function cancelAiJob(jobId: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await postJson(`/ai/jobs/${jobId}/cancel`, {});
      await refreshAiWorkbench();
      setNotice("AI 작업을 취소했습니다.");
    } finally {
      setIsAiAction(false);
    }
  }

  async function createAiVoiceProfile(assetId: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      const consent = await postJson<{ id: string }>("/ai/voice-consents", {
        acknowledged: true,
        expiresInDays: 30,
        referenceAssetId: assetId
      });
      await postJson("/ai/voice-profiles", {
        consentId: consent.id,
        idempotencyKey: `voice-profile-${crypto.randomUUID()}`
      });
      await refreshAiWorkbench();
      setNotice("30일 목적 제한 동의와 함께 개인 음성 등록을 요청했습니다.");
    } catch (error) {
      setNotice(`개인 음성 등록 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setIsAiAction(false);
    }
  }

  async function revokeAiVoiceProfile(profileId: string) {
    if (isAiAction) return;
    setIsAiAction(true);
    try {
      await requestJson(`/ai/voice-profiles/${profileId}`, "DELETE");
      await refreshAiWorkbench();
      setNotice("음성 동의를 철회하고 파생 정보 삭제를 요청했습니다.");
    } finally {
      setIsAiAction(false);
    }
  }

  async function shareStoredAsset(asset: MediaAssetView) {
    const effectiveAudience = getEffectiveAudience();
    try {
      const result = await postJson<{ message: Message; replay: boolean }>(`/media/assets/${asset.id}/share`, {
        archiveScope: effectiveAudience.audienceType === "all" ? "shared" : "selected",
        audienceType: effectiveAudience.audienceType,
        caption: `${asset.fileName} 공유`,
        clientMessageId: `media-share-${crypto.randomUUID()}`,
        spaceId: activeSpaceId,
        targetUserIds: effectiveAudience.targetUserIds
      });
      setMessages((current) => upsertMessage(current, result.message));
      setSelectedMessageId(result.message.id);
      setNotice(`${asset.fileName} 파일을 현재 대상으로 공유했습니다.`);
      await refreshMediaLibrary();
    } catch (error) {
      setNotice(`파일 공유 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function revokeMediaShare(assetId: string, messageId: string) {
    try {
      await requestJson(`/media/assets/${assetId}/shares/${messageId}`, "DELETE");
      setMessages((current) => current.filter((message) => message.id !== messageId));
      setNotice("공유를 철회했습니다. 내 보관 원본은 유지됩니다.");
      await refreshMediaLibrary();
    } catch (error) {
      setNotice(`공유 철회 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function trashMediaAsset(assetId: string) {
    try {
      await requestJson(`/media/assets/${assetId}`, "DELETE");
      setSelectedAssetId("");
      setNotice("파일을 휴지통으로 이동하고 기존 공유를 철회했습니다.");
      await refreshMediaLibrary();
    } catch (error) {
      setNotice(`파일 삭제 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function downloadMedia(media: { downloadUrl?: string; fileName: string }) {
    if (!media.downloadUrl) return;
    try {
      const response = await fetchBinary(media.downloadUrl);
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = media.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch (error) {
      setNotice(`다운로드 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function saveMediaMetadata() {
    if (!selectedAssetId) return;
    try {
      const asset = await requestJson<MediaAssetView>(`/media/assets/${selectedAssetId}`, "PATCH", {
        capturedLocalAt: mediaCapturedDraft || undefined,
        placeName: mediaPlaceDraft
      });
      setMediaLibrary((current) => ({ ...current, assets: current.assets.map((item) => item.id === asset.id ? asset : item) }));
      setNotice("촬영 시각과 장소를 저장했습니다.");
    } catch (error) {
      setNotice(`미디어 정보 저장 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function createMediaAlbum() {
    if (!albumName.trim()) return;
    try {
      const album = await postJson<MediaLibraryView["albums"][number]>("/media/albums", { name: albumName.trim() });
      setMediaLibrary((current) => ({ ...current, albums: [album, ...current.albums] }));
      setSelectedAlbumId(album.id);
      setAlbumName("");
      setNotice("앨범을 만들었습니다.");
    } catch (error) {
      setNotice(`앨범 만들기 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  async function addMediaToAlbum(albumId: string, assetId: string) {
    if (!albumId || !assetId) return;
    try {
      const album = await postJson<MediaLibraryView["albums"][number]>(`/media/albums/${albumId}/items`, { assetId });
      setMediaLibrary((current) => ({ ...current, albums: current.albums.map((item) => item.id === album.id ? album : item) }));
      setNotice("선택한 파일을 앨범에 추가했습니다.");
    } catch (error) {
      setNotice(`앨범 추가 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  function popOut() {
    const url = new URL(window.location.href);
    url.searchParams.set("panel", activePanel);
    if (selectedAssetId) url.searchParams.set("asset", selectedAssetId);
    window.open(url.toString(), `hahatalk-${activePanel}-${Date.now()}`, "width=1320,height=840");
  }

  return (
    <main className="app-shell">
      <nav className="rail" aria-label="주요 이동">
        <div className="brand-mark">인</div>
        <div className="rail-actions">
          <button className="rail-button" data-active="true" title="채팅" type="button">
            <MessageCircle size={21} />
          </button>
          <button className="rail-button" onClick={onOpenContacts} title="사람" type="button">
            <Users size={21} />
          </button>
          <button className="rail-button" onClick={onOpenCalendar} title="일정" type="button">
            <CalendarDays size={21} />
          </button>
          <button className="rail-button" onClick={onOpenBroadcast} title="방송" type="button">
            <Radio size={21} />
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
          <form className="search-box" onSubmit={searchConversation}>
            <Search size={16} />
            <input
              aria-label="현재 대화 검색"
              className="text-input"
              placeholder="현재 대화 검색"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                if (!event.target.value) setSearchResults([]);
              }}
            />
            <button className="search-submit" disabled={isSearching} title="검색" type="submit">
              <Search size={16} />
            </button>
          </form>
        </div>
        <div className="room-list">
          {searchResults.length > 0 ? (
            <div className="search-results" aria-label="메시지 검색 결과">
              <div className="room-meta">검색 결과 {searchResults.length}개</div>
              {searchResults.map((message) => (
                <button
                  className="search-result"
                  key={message.id}
                  onClick={() => {
                    setMessages((current) => upsertMessage(current, message));
                    setSelectedMessageId(message.id);
                  }}
                  type="button"
                >
                  <strong>{message.body}</strong>
                  <span className="tiny">{formatDateTime(message.createdAt)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {spaces.map((space) => (
            <button
              className="room-item"
              data-active={space.room.roomId === activeSpaceId}
              key={space.room.roomId}
              onClick={() => void switchRoom(space.room.roomId)}
              type="button"
            >
              <span className="room-item-title">
                <strong>{space.room.title}</strong>
                {space.unreadCount > 0 ? <span className="unread-badge">{space.unreadCount}</span> : null}
              </span>
              <span className="room-meta">{space.lastMessagePreview ?? "대화를 시작하세요"}</span>
            </button>
          ))}
          {spaces.length === 0 && !isSyncing ? <div className="panel-muted empty-state">참여 중인 대화가 없습니다.</div> : null}
        </div>
      </aside>

      <section className="workspace" aria-label="채팅 업무 공간">
        <header className="workspace-header">
          <div>
            <h1 className="room-title">{roomPresentation.title}</h1>
            <div className="tiny">
              {roomPresentation.rosterVisible ? `허브 ${roomPresentation.memberCount ?? roomUsers.length}명` : "1:1 대화"}
              {` · ${currentUser.displayName} · ${authSession.role === "guest" ? "게스트 세션" : "내부 세션"}`}
              {authSession.permissions.canOpenReadReport ? " · 읽음 리포트 켜짐" : ""}
            </div>
          </div>
          <div className="header-actions">
            <span
              className="sync-chip"
              data-state={syncError ? "error" : isSyncing || realtimeState !== "online" ? "loading" : "ready"}
            >
              {syncError ? "동기화 실패" : isSyncing ? "저장 동기화 중" : realtimeState === "online" ? "저장 · 실시간" : "실시간 재연결"}
            </span>
            <button className="icon-button" onClick={() => void refreshSnapshot()} title="업무방 새로고침" type="button">
              <RefreshCw size={18} />
            </button>
            <button
              className="icon-button"
              data-active={Boolean(currentLiveCall)}
              disabled={isCallAction || (!callCapabilities.available && !currentLiveCall)}
              onClick={() => void startOrOpenCall("voice")}
              title={callCapabilities.available ? "음성 통화" : callCapabilities.reason ?? "통화 서버 설정 필요"}
              type="button"
            >
              <Phone size={18} />
            </button>
            <button
              className="icon-button"
              data-active={Boolean(currentLiveCall)}
              disabled={isCallAction || (!callCapabilities.available && !currentLiveCall)}
              onClick={() => void startOrOpenCall("video")}
              title={callCapabilities.available ? "영상 통화" : callCapabilities.reason ?? "통화 서버 설정 필요"}
              type="button"
            >
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

        {selectedCall ? (
          <CallDesk
            call={selectedCall}
            onDismiss={() => setSelectedCallId("")}
            onUpdated={applyCallUpdate}
          />
        ) : null}

        <div className="message-list" role="log">
          {hasMoreMessages ? (
            <button className="load-older-button" disabled={isLoadingOlder} onClick={() => void loadOlderMessages()} type="button">
              <ChevronUp size={16} /> {isLoadingOlder ? "불러오는 중" : "이전 메시지"}
            </button>
          ) : null}
          {syncError ? (
            <div className="conversation-state" role="alert">
              <strong>대화를 불러오지 못했습니다.</strong>
              <span>{syncError}</span>
              <button className="secondary-button" onClick={() => void refreshSnapshot()} type="button">다시 시도</button>
            </div>
          ) : null}
          {!syncError && !isSyncing && visibleMessages.length === 0 ? (
            <div className="conversation-state">
              <strong>아직 메시지가 없습니다.</strong>
              <span>첫 업무 대화를 시작해 보세요.</span>
            </div>
          ) : null}
          {visibleMessages.map((message) => {
            const sender = roomUsers.find((user) => user.id === message.senderId) ?? currentUser;
            const readCount = message.deliveries.filter((delivery) => delivery.readAt).length;
            const parentMessage = messages.find((candidate) => candidate.id === message.parentMessageId);
            const canReadMessageReport = message.senderId === currentUser.id || canManageCurrentConversation;
            const canDeleteMessage = message.senderId === currentUser.id
              || canManageCurrentConversation;

            return (
              <article
                className="message"
                data-own={message.senderId === currentUser.id}
                key={message.id}
                onClick={() => {
                  setSelectedMessageId(message.id);
                  setReadReportRows(undefined);
                }}
              >
                <img className="avatar" alt="" src={sender.character.thumbnailUrl} />
                <div className="message-bubble">
                  <div className="message-meta">
                    <strong>{message.senderId === currentUser.id ? "나" : sender.displayName}</strong>
                    <span>{formatTime(message.createdAt)}</span>
                    {message.editedAt ? <span>수정됨</span> : null}
                    <span className="audience-chip">{getAudienceLabel(message, roomUsers)}</span>
                    {message.metadata.requiresConfirmation ? <span className="status-chip">확인 요청</span> : null}
                  </div>
                  {parentMessage ? (
                    <button className="reply-reference" onClick={() => setSelectedMessageId(parentMessage.id)} type="button">
                      <Reply size={14} /> {parentMessage.body}
                    </button>
                  ) : null}
                  <p className="message-body">{message.body}</p>
                  {message.attachments.length > 0 ? (
                    <div className="attachment-strip">
                      {message.attachments.map((attachment) => (
                        <button
                          className="attachment-tile"
                          key={attachment.id}
                          onClick={() => {
                            setSelectedAssetId(attachment.assetId);
                            setActivePanel(attachment.mimeType === "application/pdf" ? "pdf" : "files");
                          }}
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
                    {canReadMessageReport ? <span className="tiny">읽음 {readCount}</span> : null}
                    <button className="message-action-button" onClick={(event) => { event.stopPropagation(); beginReply(message); }} title="답장" type="button">
                      <Reply size={15} />
                    </button>
                    {message.senderId === currentUser.id ? (
                      <button className="message-action-button" onClick={(event) => { event.stopPropagation(); beginEdit(message); }} title="수정" type="button">
                        <Pencil size={15} />
                      </button>
                    ) : null}
                    {canDeleteMessage ? (
                      <button className="message-action-button danger-action" onClick={(event) => { event.stopPropagation(); void deleteMessage(message); }} title="삭제" type="button">
                        <Trash2 size={15} />
                      </button>
                    ) : null}
                    {canReadMessageReport ? (
                      <button className="secondary-button" onClick={(event) => { event.stopPropagation(); void openReadReport(message); }} type="button">
                        <CheckCircle2 size={16} /> 리포트
                      </button>
                    ) : message.metadata.requiresConfirmation ? (
                      <button
                        className="secondary-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedMessageId(message.id);
                          setReadReportRows(undefined);
                          setActivePanel("reads");
                        }}
                        type="button"
                      >
                        <CheckCircle2 size={16} /> 확인
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
          {typingUsers.length > 0 ? (
            <div className="typing-indicator">{typingUsers.map((user) => user.displayName).join(", ")} 입력 중...</div>
          ) : null}
        </div>

        <footer className="composer">
          {replyToMessage || editingMessageId ? (
            <div className="composer-context">
              <span>
                <strong>{editingMessageId ? "메시지 수정" : "답장"}</strong>
                <span>{editingMessageId ? composer : replyToMessage?.body}</span>
              </span>
              <button className="icon-button" onClick={cancelComposeContext} title="취소" type="button"><X size={16} /></button>
            </div>
          ) : null}
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
            <div className="segmented-control composer-media-mode" aria-label="파일 처리 방식">
              <button data-active={mediaMode === "archive"} onClick={() => setMediaMode("archive")} type="button"><HardDrive size={14} /> 내 보관</button>
              <button data-active={mediaMode === "share"} onClick={() => setMediaMode("share")} type="button"><Share2 size={14} /> 대상 공유</button>
            </div>
            <button className="icon-button" disabled={isUploading} onClick={() => fileInputRef.current?.click()} title="파일 첨부" type="button">
              <Paperclip size={18} />
            </button>
            <button className="icon-button" disabled={isUploading} onClick={() => void shareScreenCapture()} title="화면 캡처" type="button">
              <Camera size={18} />
            </button>
            <button className="icon-button" onClick={() => setActivePanel("ai")} title="STT 작업대" type="button">
              <Mic2 size={18} />
            </button>
            <button className="icon-button" onClick={() => setActivePanel("ai")} title="TTS 작업대" type="button">
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
              onChange={(event) => handleComposerChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendTextMessage();
                }
              }}
              placeholder="메시지 입력"
              ref={composerRef}
              value={composer}
            />
            <button className="icon-button" disabled={isSending || !composer.trim()} onClick={() => void sendTextMessage()} title={editingMessageId ? "수정 저장" : "보내기"} type="button">
              <Send size={19} />
            </button>
          </div>
          <input
            hidden
            onChange={handleFileChange}
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/ogg,audio/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.json"
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
          {canOpenRoomReadReport ? (
            <button
              className="panel-tab"
              data-active={activePanel === "reads"}
              onClick={() => {
                if (selectedMessage && canFetchSelectedReadReport) {
                  void openReadReport(selectedMessage);
                } else {
                  setReadReportRows(undefined);
                  setActivePanel("reads");
                }
              }}
              title="읽음"
              type="button"
            >
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
          {activePanel === "files" ? (
            <MediaPanel
              albumName={albumName}
              attachments={attachments.map((item) => item.attachment)}
              capturedDraft={mediaCapturedDraft}
              currentUserId={currentUser.id}
              dateFilter={mediaDateFilter}
              isUploading={isUploading}
              library={mediaLibrary}
              onAbortUpload={() => void abortMediaUpload()}
              onAddToAlbum={(albumId, assetId) => void addMediaToAlbum(albumId, assetId)}
              onAlbumNameChange={setAlbumName}
              onCapturedDraftChange={setMediaCapturedDraft}
              onCreateAlbum={() => void createMediaAlbum()}
              onDateFilterChange={setMediaDateFilter}
              onDownload={(media) => void downloadMedia(media)}
              onPlaceDraftChange={setMediaPlaceDraft}
              onPlaceFilterChange={setMediaPlaceFilter}
              onRefresh={() => void refreshMediaLibrary()}
              onRetryUpload={() => void retryMediaUpload()}
              onRevokeShare={(assetId, messageId) => void revokeMediaShare(assetId, messageId)}
              onSaveMetadata={() => void saveMediaMetadata()}
              onScopeFilterChange={setMediaScopeFilter}
              onSelectAlbum={setSelectedAlbumId}
              onSelectAsset={setSelectedAssetId}
              onShareAsset={(asset) => void shareStoredAsset(asset)}
              onTrashAsset={(assetId) => void trashMediaAsset(assetId)}
              placeDraft={mediaPlaceDraft}
              placeFilter={mediaPlaceFilter}
              scopeFilter={mediaScopeFilter}
              selectedAlbumId={selectedAlbumId}
              selectedAssetId={selectedAssetId}
              uploadTask={uploadTask}
            />
          ) : activePanel === "ai" ? (
            <AiPanel
              {...(selectedMediaAsset ? { activeAsset: selectedMediaAsset } : {})}
              {...(aiCapabilities ? { capabilities: aiCapabilities } : {})}
              isBusy={isAiAction || isUploading}
              jobs={aiJobs}
              onCancel={cancelAiJob}
              onCreateAvatar={createAiAvatar}
              onCreateSummary={createAiSummary}
              onCreateTts={createAiTts}
              onCreateVoiceProfile={createAiVoiceProfile}
              onEditTranscript={editAiTranscript}
              onRejectTranscript={rejectAiTranscript}
              onRetry={retryAiJob}
              onRevokeVoiceProfile={revokeAiVoiceProfile}
              onSendTranscript={sendAiTranscript}
              onVoiceFile={createSttFromVoice}
              voiceProfiles={voiceProfiles}
            />
          ) : (
            <PanelBody
            activePanel={activePanel}
            acceptExistingGroupJoin={acceptExistingGroupJoin}
            acceptExistingPrivacy={acceptExistingPrivacy}
            acceptExistingTerms={acceptExistingTerms}
            approvalPolicy={approvalPolicy}
            attachments={attachments.map((item) => item.attachment)}
            canInviteGuests={authSession.permissions.canInviteGuests}
            currentUser={currentUser}
            invitations={invitations}
            inviteEmail={inviteEmail}
            inviteRole={inviteRole}
            isConfirmingRead={isConfirmingRead}
            isInvitationAction={isInvitationAction}
            isInviting={isInviting}
            isSessionAction={isSessionAction}
            latestInviteCode={latestInviteCode}
            notice={notice}
            onAcceptExistingGroupJoinChange={setAcceptExistingGroupJoin}
            onAcceptExistingPrivacyChange={setAcceptExistingPrivacy}
            onAcceptExistingTermsChange={setAcceptExistingTerms}
            onAcceptReceivedInvitation={() => void acceptReceivedInvitation()}
            onApprovalPolicyChange={setApprovalPolicy}
            onConfirmRead={() => void confirmSelectedRead()}
            onCopyInviteCode={() => void copyInviteCode()}
            onCreateInvite={() => void createInvite()}
            onDecideInvitation={(invitationId, decision) => void decideInvitation(invitationId, decision)}
            onInviteEmailChange={setInviteEmail}
            onInviteRoleChange={setInviteRole}
            onReceivedInviteCodeChange={setReceivedInviteCode}
            onRequiredApprovalCountChange={setRequiredApprovalCount}
            onRevokeInvitation={(invitationId) => void revokeInvitation(invitationId)}
            onRevokeOtherSessions={() => void revokeOtherDeviceSessions()}
            onRevokeSession={(sessionId) => void revokeDeviceSession(sessionId)}
            receivedInviteCode={receivedInviteCode}
            requiredApprovalCount={requiredApprovalCount}
            roomMembers={roomMembers}
            readReportRows={readReportRows}
            selectedMessage={selectedMessage}
            selectedPdf={selectedPdf}
            sessions={sessions}
            users={roomUsers}
            />
          )}
        </div>
      </aside>
    </main>
  );
}

function PanelBody({
  activePanel,
  acceptExistingGroupJoin,
  acceptExistingPrivacy,
  acceptExistingTerms,
  approvalPolicy,
  attachments,
  canInviteGuests,
  currentUser,
  invitations,
  inviteEmail,
  inviteRole,
  isConfirmingRead,
  isInvitationAction,
  isInviting,
  isSessionAction,
  latestInviteCode,
  notice,
  onAcceptExistingGroupJoinChange,
  onAcceptExistingPrivacyChange,
  onAcceptExistingTermsChange,
  onAcceptReceivedInvitation,
  onApprovalPolicyChange,
  onConfirmRead,
  onCopyInviteCode,
  onCreateInvite,
  onDecideInvitation,
  onInviteEmailChange,
  onInviteRoleChange,
  onReceivedInviteCodeChange,
  onRequiredApprovalCountChange,
  onRevokeInvitation,
  onRevokeOtherSessions,
  onRevokeSession,
  receivedInviteCode,
  requiredApprovalCount,
  readReportRows,
  roomMembers,
  selectedMessage,
  selectedPdf,
  sessions,
  users
}: {
  activePanel: PanelKey;
  acceptExistingGroupJoin: boolean;
  acceptExistingPrivacy: boolean;
  acceptExistingTerms: boolean;
  approvalPolicy: ApprovalPolicy;
  attachments: Attachment[];
  canInviteGuests: boolean;
  currentUser: User;
  invitations: MembershipInvitationView[];
  inviteEmail: string;
  inviteRole: "member" | "guest";
  isConfirmingRead: boolean;
  isInvitationAction: boolean;
  isInviting: boolean;
  isSessionAction: boolean;
  latestInviteCode: string;
  notice: string;
  onAcceptExistingGroupJoinChange: (value: boolean) => void;
  onAcceptExistingPrivacyChange: (value: boolean) => void;
  onAcceptExistingTermsChange: (value: boolean) => void;
  onAcceptReceivedInvitation: () => void;
  onApprovalPolicyChange: (value: ApprovalPolicy) => void;
  onConfirmRead: () => void;
  onCopyInviteCode: () => void;
  onCreateInvite: () => void;
  onDecideInvitation: (invitationId: string, decision: "approved" | "rejected") => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleChange: (value: "member" | "guest") => void;
  onReceivedInviteCodeChange: (value: string) => void;
  onRequiredApprovalCountChange: (value: number) => void;
  onRevokeInvitation: (invitationId: string) => void;
  onRevokeOtherSessions: () => void;
  onRevokeSession: (sessionId: string) => void;
  receivedInviteCode: string;
  requiredApprovalCount: number;
  readReportRows: ReadReportRow[] | undefined;
  roomMembers: RoomMember[];
  selectedMessage: Message | undefined;
  selectedPdf: Attachment | MediaAssetView | undefined;
  sessions: DeviceSessionView[];
  users: User[];
}) {
  if (activePanel === "reads") {
    if (!selectedMessage) {
      return <div className="panel-section panel-muted">읽음 상태를 확인할 메시지를 선택하세요.</div>;
    }
    return (
      <ReadPanel
        currentUser={currentUser}
        isConfirmingRead={isConfirmingRead}
        message={selectedMessage}
        onConfirmRead={onConfirmRead}
        reportRows={readReportRows}
        users={users}
      />
    );
  }

  if (activePanel === "pdf") {
    return <PdfPanel pdf={selectedPdf} />;
  }

  if (activePanel === "members") {
    return (
      <>
        {canInviteGuests ? (
          <div className="panel-section">
            <h2 className="panel-title">
              <Plus size={17} /> 대상 초대
            </h2>
            <label className="field">
              이메일
              <input className="text-input" disabled={isInviting} type="email" value={inviteEmail} onChange={(event) => onInviteEmailChange(event.target.value)} />
            </label>
            <div className="compact-field-grid">
              <label className="field">
                역할
                <select className="text-input" disabled={isInviting} value={inviteRole} onChange={(event) => onInviteRoleChange(event.target.value as "member" | "guest")}>
                  <option value="guest">외부 게스트</option>
                  <option value="member">내부 구성원</option>
                </select>
              </label>
              <label className="field">
                승인 정책
                <select className="text-input" disabled={isInviting} value={approvalPolicy} onChange={(event) => onApprovalPolicyChange(event.target.value as ApprovalPolicy)}>
                  <option value="owner_and_invitee">소유자 승인</option>
                  <option value="admins_and_invitee">관리자 승인</option>
                  <option value="all_members_and_invitee">구성원 전원</option>
                  <option value="quorum_and_invitee">정족수 승인</option>
                </select>
              </label>
            </div>
            {approvalPolicy === "quorum_and_invitee" ? (
              <label className="field">
                승인 정족수
                <input
                  className="text-input"
                  max={100}
                  min={1}
                  type="number"
                  value={requiredApprovalCount}
                  onChange={(event) => onRequiredApprovalCountChange(Number(event.target.value) || 1)}
                />
              </label>
            ) : null}
            <button className="primary-button" disabled={isInviting} onClick={onCreateInvite} style={{ marginTop: 10 }} type="button">
              {isInviting ? "초대 생성 중" : "초대 생성"}
            </button>
            {latestInviteCode ? (
              <div className="invite-code-box">
                <code>{latestInviteCode}</code>
                <button className="icon-button" onClick={onCopyInviteCode} title="초대 코드 복사" type="button">
                  <Copy size={17} />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="panel-section">
          <h2 className="panel-title">
            <KeyRound size={17} /> 받은 초대
          </h2>
          <input
            autoComplete="off"
            className="text-input"
            placeholder="초대 코드"
            value={receivedInviteCode}
            onChange={(event) => onReceivedInviteCodeChange(event.target.value)}
          />
          <div className="consent-list compact-consent-list">
            <label><input checked={acceptExistingTerms} onChange={(event) => onAcceptExistingTermsChange(event.target.checked)} type="checkbox" /> 이용약관</label>
            <label><input checked={acceptExistingPrivacy} onChange={(event) => onAcceptExistingPrivacyChange(event.target.checked)} type="checkbox" /> 개인정보</label>
            <label><input checked={acceptExistingGroupJoin} onChange={(event) => onAcceptExistingGroupJoinChange(event.target.checked)} type="checkbox" /> 그룹 가입</label>
          </div>
          <button
            className="secondary-button"
            disabled={isInvitationAction || !receivedInviteCode.trim()}
            onClick={onAcceptReceivedInvitation}
            type="button"
          >
            <UserCheck size={17} /> 초대 수락
          </button>
        </div>

        {invitations.length > 0 ? (
          <div className="panel-section">
            <h2 className="panel-title">
              <Inbox size={17} /> 초대와 승인
            </h2>
            <div className="invitation-list">
              {invitations.map((invitation) => (
                <div className="invitation-item" key={invitation.id}>
                  <div className="invitation-heading">
                    <span>
                      <strong>{invitation.email}</strong>
                      <span className="tiny" style={{ display: "block" }}>
                        {invitation.role === "guest" ? "게스트" : "구성원"} · {formatDateTime(invitation.createdAt)}
                      </span>
                    </span>
                    <span className="status-chip">{invitationStatusLabel(invitation.status)}</span>
                  </div>
                  {invitation.canManage && invitation.requiredApprovalCount !== undefined ? (
                    <div className="approval-meter">
                      <span style={{ width: `${Math.min(100, ((invitation.approvedCount ?? 0) / invitation.requiredApprovalCount) * 100)}%` }} />
                    </div>
                  ) : null}
                  <div className="invitation-actions">
                    {invitation.canDecide ? (
                      <>
                        <button className="secondary-button" disabled={isInvitationAction} onClick={() => onDecideInvitation(invitation.id, "approved")} type="button">
                          <UserCheck size={16} /> 승인
                        </button>
                        <button className="secondary-button" disabled={isInvitationAction} onClick={() => onDecideInvitation(invitation.id, "rejected")} type="button">
                          <XCircle size={16} /> 거절
                        </button>
                      </>
                    ) : null}
                    {invitation.canManage && ["pending_approval", "sent"].includes(invitation.status) ? (
                      <button className="icon-button" disabled={isInvitationAction} onClick={() => onRevokeInvitation(invitation.id)} title="초대 취소" type="button">
                        <XCircle size={17} />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="panel-section">
          <h2 className="panel-title">
            <Users size={17} /> 참여자
          </h2>
          {users.map((user) => {
            const memberRole = roomMembers.find((membership) => membership.userId === user.id)?.role;
            return (
              <div className="member-row" key={user.id}>
                <img alt="" src={user.character.thumbnailUrl} />
                <span>
                  <strong>{user.displayName}</strong>
                  <span className="tiny" style={{ display: "block" }}>
                    {user.email}
                  </span>
                </span>
                {memberRole === "guest" || memberRole === "subscriber"
                  ? <span className="guest-chip">게스트</span>
                  : <span className="tiny">내부</span>}
              </div>
            );
          })}
        </div>

        <div className="panel-section">
          <div className="panel-title-row">
            <h2 className="panel-title">
              <ShieldCheck size={17} /> 내 기기 세션
            </h2>
            {sessions.some((session) => !session.current) ? (
              <button className="icon-button" disabled={isSessionAction} onClick={onRevokeOtherSessions} title="다른 기기 모두 종료" type="button">
                <LogOut size={16} />
              </button>
            ) : null}
          </div>
          {sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <span>
                <strong>{session.current ? "현재 기기" : "다른 기기"}</strong>
                <span className="tiny session-agent">{session.userAgent}</span>
                <span className="tiny">최근 {formatDateTime(session.lastSeenAt)}</span>
              </span>
              {!session.current ? (
                <button className="icon-button" disabled={isSessionAction} onClick={() => onRevokeSession(session.id)} title="이 세션 종료" type="button">
                  <LogOut size={16} />
                </button>
              ) : <span className="audience-chip">사용 중</span>}
            </div>
          ))}
        </div>
        <div className="notice">{notice}</div>
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

function PdfPanel({ pdf }: { pdf: Attachment | MediaAssetView | undefined }) {
  return (
    <>
      <div className="panel-section">
        <h2 className="panel-title">
          <FileText size={17} /> PDF 문서
        </h2>
        <strong className="pdf-file-name">{pdf?.fileName ?? "PDF를 선택하세요"}</strong>
      </div>
      {pdf?.previewUrl ? (
        <PdfViewer fileName={pdf.fileName} url={pdf.previewUrl} />
      ) : (
        <div className="file-preview panel-muted">현재 대화에서 PDF를 선택하세요.</div>
      )}
    </>
  );
}

function ReadPanel({
  currentUser,
  isConfirmingRead,
  message,
  onConfirmRead,
  reportRows,
  users
}: {
  currentUser: User;
  isConfirmingRead: boolean;
  message: Message;
  onConfirmRead: () => void;
  reportRows: ReadReportRow[] | undefined;
  users: User[];
}) {
  const report = reportRows ?? buildReadReport(message, users);
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

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit"
  }).format(new Date(value));
}

function invitationStatusLabel(status: MembershipInvitationView["status"]) {
  return {
    accepted: "가입 완료",
    declined: "거절",
    expired: "만료",
    pending_approval: "승인 대기",
    revoked: "취소",
    sent: "수락 대기"
  }[status];
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

function mergeCurrentUser(users: User[], currentUser: User) {
  const mergedUsers = users.map((user) => user.id === currentUser.id ? currentUser : user);

  if (mergedUsers.some((user) => user.id === currentUser.id)) {
    return mergedUsers;
  }

  return [currentUser, ...mergedUsers];
}

function mergeCurrentMembership(
  memberships: RoomMember[],
  currentUser: User,
  role: AuthSession["role"],
  joinedAt: string
) {
  const membership: RoomMember = {
    joinedAt,
    role,
    roomId: demoRoom.id,
    userId: currentUser.id,
    viewMode: currentUser.id === demoRoom.ownerId ? "owner_console" : "direct_with_owner"
  };
  const existingIndex = memberships.findIndex((candidate) => candidate.userId === currentUser.id);
  if (existingIndex < 0) {
    return [...memberships, membership];
  }
  return memberships.map((candidate, index) => index === existingIndex ? { ...candidate, ...membership } : candidate);
}

async function sha256Blob(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function upsertMessage(messages: Message[], message: Message) {
  const next = messages.some((candidate) => candidate.id === message.id)
    ? messages.map((candidate) => candidate.id === message.id ? message : candidate)
    : [...messages, message];
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function mergeOlderMessages(older: Message[], current: Message[]) {
  const byId = new Map<string, Message>();
  for (const message of [...older, ...current]) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}
