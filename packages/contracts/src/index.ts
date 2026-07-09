export type AudienceType = "all" | "selected" | "private" | "role";
export type MemberRole = "owner" | "admin" | "member" | "guest";
export type RoomType = "direct" | "group" | "smart_room" | "webinar_backstage";
export type MessageType =
  | "text"
  | "image"
  | "file"
  | "audio"
  | "video"
  | "system"
  | "schedule"
  | "poll"
  | "remote_support";
export type AiJobType = "stt" | "tts" | "summary" | "avatar_generation" | "transcript" | "search_index";
export type AiJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AttachmentPreviewStatus = "queued" | "ready" | "failed";
export type VirusScanStatus = "pending" | "clean" | "blocked";

export interface Organization {
  id: string;
  name: string;
  plan: "trial" | "business" | "enterprise";
}

export interface User {
  id: string;
  organizationId: string;
  email: string;
  phone?: string;
  displayName: string;
  status: "active" | "invited" | "suspended";
  lastSeenAt: string;
  character: CharacterPreset;
}

export interface Profile {
  userId: string;
  title: string;
  department: string;
  company: string;
  timezone: string;
}

export interface CharacterPreset {
  id: string;
  name: string;
  style: "3d-business" | "flat-work" | "guest";
  thumbnailUrl: string;
  accent: string;
}

export interface Room {
  id: string;
  organizationId: string;
  type: RoomType;
  name: string;
  ownerId: string;
  settings: {
    guestCanDownload: boolean;
    readReportEnabled: boolean;
    fileSharingEnabled: boolean;
  };
  createdAt: string;
}

export interface RoomMember {
  roomId: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
  mutedUntil?: string;
  lastReadMessageId?: string;
  lastReadAt?: string;
}

export interface MessageAudience {
  id: string;
  messageId: string;
  audienceType: AudienceType;
  targetUserId?: string;
  targetRole?: MemberRole;
}

export interface MessageRead {
  messageId: string;
  userId: string;
  readAt: string;
  confirmedAt?: string;
}

export interface Attachment {
  id: string;
  messageId: string;
  uploaderId: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailKey?: string;
  previewStatus: AttachmentPreviewStatus;
  virusScanStatus: VirusScanStatus;
  versionGroupId?: string;
  createdAt: string;
  objectUrl?: string;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  parentMessageId?: string;
  messageType: MessageType;
  body: string;
  metadata: {
    requiresConfirmation?: boolean;
    source?: "manual" | "screen_capture" | "file_upload" | "ai_draft";
    aiDraft?: boolean;
  };
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  audiences: MessageAudience[];
  reads: MessageRead[];
  attachments: Attachment[];
}

export interface Invite {
  id: string;
  roomId: string;
  invitedBy: string;
  email: string;
  role: MemberRole;
  status: "draft" | "sent" | "accepted" | "expired";
  createdAt: string;
}

export interface AiJob {
  id: string;
  organizationId: string;
  requestedBy: string;
  jobType: AiJobType;
  status: AiJobStatus;
  result?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface AuditLog {
  id: string;
  organizationId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface SignupInput {
  displayName: string;
  email: string;
  characterId: string;
  inviteCode?: string;
}

export interface LoginInput {
  email: string;
}

export interface SendMessageInput {
  senderId: string;
  body: string;
  audienceType: AudienceType;
  targetUserIds: string[];
  requiresConfirmation?: boolean;
}

export interface CreateInviteInput {
  email: string;
  role: "member" | "guest";
  invitedBy: string;
}

export interface AuthSession {
  token: string;
  user: User;
  roomId: string;
  role: MemberRole;
  permissions: {
    canInviteGuests: boolean;
    canUploadFiles: boolean;
    canOpenReadReport: boolean;
    canDownloadFiles: boolean;
  };
  createdAt: string;
  expiresAt: string;
}

export interface MvpSnapshot {
  organization: Organization;
  room: Room;
  users: User[];
  roomMembers: RoomMember[];
  messages: Message[];
  aiJobs: AiJob[];
  invites: Invite[];
}

export const demoOrganization: Organization = {
  id: "org-inviz",
  name: "Inviz",
  plan: "business"
};

export const characterPresets: CharacterPreset[] = [
  {
    id: "char-calm-lead",
    name: "차분한 리더",
    style: "3d-business",
    thumbnailUrl: "/characters/calm-lead.svg",
    accent: "#0f9f8f"
  },
  {
    id: "char-focus-maker",
    name: "집중형 메이커",
    style: "3d-business",
    thumbnailUrl: "/characters/focus-maker.svg",
    accent: "#e1a325"
  },
  {
    id: "char-customer-guest",
    name: "게스트 안내",
    style: "guest",
    thumbnailUrl: "/characters/customer-guest.svg",
    accent: "#6b7cff"
  }
];

export const demoUsers: User[] = [
  {
    id: "user-you",
    organizationId: demoOrganization.id,
    email: "you@inviz.co.kr",
    displayName: "나",
    status: "active",
    lastSeenAt: "2026-07-09T10:15:00+09:00",
    character: characterPresets[0]!
  },
  {
    id: "user-mina",
    organizationId: demoOrganization.id,
    email: "mina@inviz.co.kr",
    displayName: "김미나",
    status: "active",
    lastSeenAt: "2026-07-09T10:14:00+09:00",
    character: characterPresets[1]!
  },
  {
    id: "user-jun",
    organizationId: demoOrganization.id,
    email: "jun@inviz.co.kr",
    displayName: "박준",
    status: "active",
    lastSeenAt: "2026-07-09T10:12:00+09:00",
    character: characterPresets[0]!
  },
  {
    id: "guest-hana",
    organizationId: demoOrganization.id,
    email: "hana.customer@example.com",
    displayName: "한고객",
    status: "invited",
    lastSeenAt: "2026-07-09T09:50:00+09:00",
    character: characterPresets[2]!
  }
];

export const demoRoom: Room = {
  id: "room-smart-sales",
  organizationId: demoOrganization.id,
  type: "smart_room",
  name: "프로젝트 A Smart Room",
  ownerId: "user-you",
  settings: {
    guestCanDownload: false,
    readReportEnabled: true,
    fileSharingEnabled: true
  },
  createdAt: "2026-07-09T09:30:00+09:00"
};

export const demoRoomMembers: RoomMember[] = demoUsers.map((user, index) => {
  const member: RoomMember = {
    roomId: demoRoom.id,
    userId: user.id,
    role: user.id === "user-you" ? "owner" : user.id.startsWith("guest") ? "guest" : index === 1 ? "admin" : "member",
    joinedAt: "2026-07-09T09:31:00+09:00"
  };

  if (index < 3) {
    member.lastReadAt = `2026-07-09T10:1${index}:00+09:00`;
  }

  return member;
});

export const demoMessages: Message[] = [
  {
    id: "msg-001",
    roomId: demoRoom.id,
    senderId: "user-you",
    messageType: "text",
    body: "오늘 고객 미팅 자료와 체크리스트를 이 방에서 같이 봅시다.",
    metadata: { requiresConfirmation: true },
    createdAt: "2026-07-09T10:00:00+09:00",
    audiences: [{ id: "aud-001", messageId: "msg-001", audienceType: "all" }],
    reads: [
      { messageId: "msg-001", userId: "user-you", readAt: "2026-07-09T10:00:02+09:00", confirmedAt: "2026-07-09T10:00:03+09:00" },
      { messageId: "msg-001", userId: "user-mina", readAt: "2026-07-09T10:01:11+09:00", confirmedAt: "2026-07-09T10:02:04+09:00" },
      { messageId: "msg-001", userId: "user-jun", readAt: "2026-07-09T10:03:45+09:00" }
    ],
    attachments: []
  },
  {
    id: "msg-002",
    roomId: demoRoom.id,
    senderId: "user-mina",
    messageType: "file",
    body: "제안서 PDF 초안 올립니다. 오른쪽 문서 패널에서 봐주세요.",
    metadata: { source: "file_upload" },
    createdAt: "2026-07-09T10:04:00+09:00",
    audiences: [{ id: "aud-002", messageId: "msg-002", audienceType: "all" }],
    reads: [
      { messageId: "msg-002", userId: "user-you", readAt: "2026-07-09T10:04:20+09:00" },
      { messageId: "msg-002", userId: "user-mina", readAt: "2026-07-09T10:04:01+09:00" }
    ],
    attachments: [
      {
        id: "att-proposal-pdf",
        messageId: "msg-002",
        uploaderId: "user-mina",
        storageKey: "demo/proposal-v1.pdf",
        fileName: "프로젝트A_제안서_v1.pdf",
        mimeType: "application/pdf",
        sizeBytes: 428000,
        previewStatus: "ready",
        virusScanStatus: "clean",
        createdAt: "2026-07-09T10:04:00+09:00"
      }
    ]
  },
  {
    id: "msg-003",
    roomId: demoRoom.id,
    senderId: "user-you",
    messageType: "text",
    body: "미나님, 가격표는 내부 검토 후 고객에게 공개합시다.",
    metadata: {},
    createdAt: "2026-07-09T10:06:00+09:00",
    audiences: [
      { id: "aud-003-you", messageId: "msg-003", audienceType: "selected", targetUserId: "user-you" },
      { id: "aud-003-mina", messageId: "msg-003", audienceType: "selected", targetUserId: "user-mina" }
    ],
    reads: [
      { messageId: "msg-003", userId: "user-you", readAt: "2026-07-09T10:06:01+09:00" },
      { messageId: "msg-003", userId: "user-mina", readAt: "2026-07-09T10:06:31+09:00" }
    ],
    attachments: []
  },
  {
    id: "msg-004",
    roomId: demoRoom.id,
    senderId: "guest-hana",
    messageType: "text",
    body: "외부 고객 계정에서는 초대받은 자료만 보이도록 확인했습니다.",
    metadata: {},
    createdAt: "2026-07-09T10:08:00+09:00",
    audiences: [{ id: "aud-004", messageId: "msg-004", audienceType: "all" }],
    reads: [
      { messageId: "msg-004", userId: "user-you", readAt: "2026-07-09T10:08:20+09:00" },
      { messageId: "msg-004", userId: "guest-hana", readAt: "2026-07-09T10:08:01+09:00" }
    ],
    attachments: []
  }
];

export const demoAiJobs: AiJob[] = [
  {
    id: "ai-001",
    organizationId: demoOrganization.id,
    requestedBy: "user-you",
    jobType: "summary",
    status: "queued",
    createdAt: "2026-07-09T10:09:00+09:00",
    result: "회의록 초안은 채팅을 막지 않고 백그라운드에서 생성됩니다."
  },
  {
    id: "ai-002",
    organizationId: demoOrganization.id,
    requestedBy: "user-mina",
    jobType: "stt",
    status: "running",
    createdAt: "2026-07-09T10:10:00+09:00"
  }
];

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export function findCharacterPreset(characterId: string): CharacterPreset {
  return characterPresets.find((character) => character.id === characterId) ?? characterPresets[0]!;
}

export function createAuthSession(
  user: User,
  role: MemberRole,
  roomId: string,
  createdAt = new Date().toISOString()
): AuthSession {
  const expiresAt = new Date(createdAt);
  expiresAt.setHours(expiresAt.getHours() + 8);

  const isGuest = role === "guest";

  return {
    token: `demo-session-${user.id}-${Date.parse(createdAt) || Date.now()}`,
    user,
    roomId,
    role,
    permissions: {
      canInviteGuests: !isGuest,
      canUploadFiles: !isGuest,
      canOpenReadReport: !isGuest,
      canDownloadFiles: !isGuest
    },
    createdAt,
    expiresAt: expiresAt.toISOString()
  };
}

export function isMessageVisibleTo(message: Message, userId: string, members: RoomMember[]): boolean {
  const member = members.find((candidate) => candidate.userId === userId);

  if (!member || message.deletedAt) {
    return false;
  }

  return message.audiences.some((audience) => {
    if (audience.audienceType === "all") {
      return true;
    }

    if (audience.audienceType === "selected" || audience.audienceType === "private") {
      return audience.targetUserId === userId || message.senderId === userId;
    }

    return Boolean(audience.targetRole && audience.targetRole === member.role);
  });
}

export function getAudienceLabel(message: Message, users: User[]): string {
  const firstAudience = message.audiences[0];

  if (!firstAudience || firstAudience.audienceType === "all") {
    return "전체";
  }

  if (firstAudience.audienceType === "role") {
    return `${firstAudience.targetRole ?? "role"} 권한`;
  }

  const targetNames = message.audiences
    .map((audience) => users.find((user) => user.id === audience.targetUserId)?.displayName)
    .filter((name): name is string => Boolean(name));

  if (firstAudience.audienceType === "private") {
    const privateTargetNames = message.audiences
      .filter((audience) => audience.targetUserId && audience.targetUserId !== message.senderId)
      .map((audience) => users.find((user) => user.id === audience.targetUserId)?.displayName)
      .filter((name): name is string => Boolean(name));

    return `${privateTargetNames[0] ?? targetNames[0] ?? "대상"}와 비공개`;
  }

  return `${targetNames.length}명 선택`;
}

export function buildReadReport(message: Message, users: User[]) {
  const readsByUser = new Map(message.reads.map((read) => [read.userId, read]));

  return users.map((user) => {
    const read = readsByUser.get(user.id);

    return {
      user,
      readAt: read?.readAt,
      confirmedAt: read?.confirmedAt,
      state: read ? "read" as const : "unread" as const
    };
  });
}

export function createMessageAudience(
  messageId: string,
  audienceType: AudienceType,
  senderId: string,
  targetUserIds: string[]
): MessageAudience[] {
  if (audienceType === "all") {
    return [{ id: `${messageId}-aud-all`, messageId, audienceType: "all" }];
  }

  const uniqueTargetIds = new Set([senderId, ...targetUserIds]);

  return Array.from(uniqueTargetIds).map((targetUserId) => ({
    id: `${messageId}-aud-${targetUserId}`,
    messageId,
    audienceType,
    targetUserId
  }));
}
