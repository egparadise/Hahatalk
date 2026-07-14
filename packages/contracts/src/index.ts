export type AudienceType = "all" | "selected" | "private" | "role";
export type MemberRole = "owner" | "admin" | "member" | "guest" | "subscriber";
export type ConversationType = "direct" | "open_group" | "hub" | "broadcast_channel" | "meeting_backstage";
export type RoomType = ConversationType;
export type RosterVisibility = "shared" | "owner_only" | "subscriber_count_only";
export type MemberViewMode = "owner_console" | "shared_room" | "direct_with_owner" | "channel";
export type RoomPresentationMode = "direct" | "group" | "hub_owner" | "channel" | "meeting";
export type MessageDeliveryMode = "direct" | "shared" | "hub_fanout" | "hub_announcement" | "broadcast" | "role";
export type MessageDeliveryStatus = "pending" | "delivered" | "failed" | "revoked";
export type MessageType =
  | "text"
  | "image"
  | "file"
  | "audio"
  | "video"
  | "system"
  | "schedule"
  | "poll"
  | "sticker"
  | "remote_support";
export type AiJobType =
  | "stt"
  | "tts"
  | "summary"
  | "avatar_generation"
  | "voice_profile_enrollment"
  | "voice_profile_delete";
export type AiJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AttachmentPreviewStatus = "queued" | "ready" | "unavailable" | "failed";
export type VirusScanStatus = "pending" | "clean" | "blocked" | "failed";
export type MediaArchiveScope = "private_archive" | "shared" | "selected";
export type MediaKind = "image" | "video" | "audio" | "pdf" | "text" | "office" | "file";
export type MediaProcessingStatus = "processing" | "ready" | "blocked" | "failed";
export type MediaUploadSource = "file_upload" | "screen_capture" | "ai_generated";
export type MediaUploadStatus = "initiated" | "uploading" | "completing" | "completed" | "aborted" | "expired" | "failed";
export type ApprovalPolicy = "owner_and_invitee" | "admins_and_invitee" | "all_members_and_invitee" | "quorum_and_invitee";
export type InvitationStatus = "pending_approval" | "sent" | "accepted" | "declined" | "expired" | "revoked";
export type InvitationDecision = "approved" | "rejected";
export type ContactCollectionKind = "family" | "team" | "customers" | "service" | "custom";
export type ContactCollectionVisibility = "owner_only" | "shared";
export type ContactRosterVisibility = "shared" | "owner_only";
export type ContactConsentDecision = "granted" | "denied" | "revoked";
export type ContactFollowUpState = "none" | "planned" | "waiting" | "completed";
export type CalendarEventVisibility = "private" | "attendees" | "space";
export type CalendarEventStatus = "scheduled" | "cancelled";
export type CalendarResponseStatus = "needs_action" | "accepted" | "declined" | "tentative";
export type CalendarRecurrenceFrequency = "daily" | "weekly" | "monthly";
export type CalendarWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type CallType = "voice" | "video";
export type CallStatus = "starting" | "ringing" | "active" | "ended" | "cancelled" | "failed" | "expired";
export type CallParticipantStatus = "invited" | "connecting" | "joined" | "declined" | "left" | "removed" | "missed";
export type CallParticipantRole = "host" | "participant";
export type ScreenShareStatus = "off" | "starting" | "active";
export type ScreenShareStopReason =
  | "user_stopped"
  | "capture_cancelled"
  | "track_ended"
  | "publish_failed"
  | "permission_changed";
export type RecordingStatus =
  | "consent_pending"
  | "consent_denied"
  | "consent_granted"
  | "starting"
  | "recording"
  | "stopping"
  | "processing"
  | "ready"
  | "failed"
  | "aborted";
export type RecordingConsentDecision = "granted" | "denied";
export type RecordingConsentStatus = "not_requested" | "pending" | RecordingConsentDecision | "revoked";
export type RecordingStopReason = "host_stopped" | "consent_revoked" | "session_ended" | "provider_failed";
export type MeetingStatus = "scheduled" | "starting" | "lobby_open" | "active" | "ended" | "cancelled" | "failed" | "expired";
export type MeetingRole = "host" | "cohost" | "speaker" | "attendee";
export type MeetingParticipantStatus =
  | "invited"
  | "waiting"
  | "admitted"
  | "connecting"
  | "joined"
  | "declined"
  | "left"
  | "removed"
  | "missed";
export type BroadcastChannelVisibility = "organization" | "unlisted";
export type BroadcastSubscriptionStatus = "active" | "muted" | "blocked" | "left";
export type BroadcastNotificationLevel = "all" | "live_only" | "off";
export type BroadcastChatMode = "disabled" | "subscribers" | "moderated";
export type BroadcastStatus = "scheduled" | "starting" | "live" | "ended" | "cancelled" | "failed";
export type BroadcastRole = "host" | "cohost" | "speaker" | "viewer";
export type BroadcastParticipantStatus = "not_joined" | "connecting" | "joined" | "left" | "removed";
export type BroadcastMessageKind = "chat" | "question" | "announcement";
export type BroadcastMessageStatus = "pending" | "published" | "hidden" | "dismissed" | "deleted";
export type BroadcastModerationAction = "publish" | "hide" | "restore" | "dismiss";
export type BroadcastReaction = "like" | "applause" | "thanks" | "question" | "celebrate";
export type BroadcastReplayStatus = "not_requested" | "processing" | "ready" | "failed" | "unavailable";

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
    rosterVisibility: RosterVisibility;
    guestCanDownload: boolean;
    readReportEnabled: boolean;
    fileSharingEnabled: boolean;
    publicAnnouncementsEnabled: boolean;
  };
  createdAt: string;
}

export interface RoomMember {
  roomId: string;
  userId: string;
  role: MemberRole;
  viewMode: MemberViewMode;
  joinedAt: string;
  mutedUntil?: string;
  lastReadMessageId?: string;
  lastReadAt?: string;
}

export interface RoomPresentation {
  roomId: string;
  mode: RoomPresentationMode;
  title: string;
  ownerId: string;
  visibleMemberIds: string[];
  rosterVisible: boolean;
  canSelectAudience: boolean;
  publicAnnouncementsEnabled: boolean;
  memberCount?: number;
}

export interface MessageAudience {
  id: string;
  messageId: string;
  audienceType: AudienceType;
  targetUserId?: string;
  targetRole?: MemberRole;
}

export interface MessageDelivery {
  id: string;
  messageId: string;
  recipientId: string;
  threadKey: string;
  status: MessageDeliveryStatus;
  deliveredAt?: string;
  readAt?: string;
  confirmedAt?: string;
  revokedAt?: string;
}

export interface Attachment {
  id: string;
  assetId: string;
  messageId: string;
  uploaderId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  mediaKind: MediaKind;
  mediaVisibility: MediaArchiveScope;
  previewStatus: AttachmentPreviewStatus;
  virusScanStatus: VirusScanStatus;
  source: MediaUploadSource;
  previewUrl?: string;
  downloadUrl?: string;
  canDownload: boolean;
  capturedAt?: string;
  capturedTimezone?: string;
  placeName?: string;
  createdAt: string;
  objectUrl?: string;
}

export interface MediaAssetView {
  id: string;
  ownerId: string;
  fileName: string;
  mimeType: string;
  mediaKind: MediaKind;
  sizeBytes: number;
  sha256Hex?: string;
  archiveScope: MediaArchiveScope;
  processingStatus: MediaProcessingStatus;
  previewStatus: AttachmentPreviewStatus;
  virusScanStatus: VirusScanStatus;
  source: MediaUploadSource;
  previewUrl?: string;
  downloadUrl?: string;
  canDownload: boolean;
  capturedAt?: string;
  capturedTimezone?: string;
  placeName?: string;
  createdAt: string;
}

export interface MediaUploadSessionView {
  id: string;
  clientUploadId: string;
  fileName: string;
  declaredMimeType: string;
  sizeBytes: number;
  partSizeBytes: number;
  partCount: number;
  uploadedPartNumbers: number[];
  status: MediaUploadStatus;
  expiresAt: string;
  asset?: MediaAssetView;
}

export interface MediaAlbumView {
  id: string;
  name: string;
  description: string;
  assetIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MediaLibraryView {
  assets: MediaAssetView[];
  albums: MediaAlbumView[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface InitiateMediaUploadInput {
  clientUploadId: string;
  fileName: string;
  declaredMimeType: string;
  sizeBytes: number;
  sha256Hex?: string;
  source: MediaUploadSource;
}

export interface ShareMediaAssetInput {
  spaceId: string;
  clientMessageId: string;
  audienceType: AudienceType;
  targetUserIds: string[];
  targetRole?: MemberRole;
  caption?: string;
  archiveScope: Exclude<MediaArchiveScope, "private_archive">;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  parentMessageId?: string;
  messageType: MessageType;
  deliveryMode: MessageDeliveryMode;
  body: string;
  metadata: {
    requiresConfirmation?: boolean;
    source?: "manual" | "screen_capture" | "file_upload" | "ai_draft";
    aiDraft?: boolean;
    mediaVisibility?: "private_archive" | "shared" | "selected";
  };
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  audiences: MessageAudience[];
  deliveries: MessageDelivery[];
  attachments: Attachment[];
}

export interface Invite {
  id: string;
  roomId: string;
  invitedBy: string;
  email: string;
  role: MemberRole;
  status: "draft" | "pending_approval" | "sent" | "accepted" | "declined" | "expired";
  approvalPolicy: ApprovalPolicy;
  requiredApprovalCount: number;
  createdAt: string;
}

export interface MembershipInvitationView {
  id: string;
  email: string;
  role: "member" | "guest";
  status: InvitationStatus;
  inviterDisplayName: string;
  createdAt: string;
  expiresAt: string;
  inviteeAcceptedAt?: string;
  canDecide: boolean;
  canManage: boolean;
  myDecision?: InvitationDecision;
  approvalPolicy?: ApprovalPolicy;
  requiredApprovalCount?: number;
  approvedCount?: number;
}

export interface CreatedMembershipInvitation extends MembershipInvitationView {
  inviteCode: string;
}

export interface InvitationPreview {
  organizationName: string;
  inviterDisplayName: string;
  emailMasked: string;
  role: "member" | "guest";
  expiresAt: string;
  accountClaimed: boolean;
}

export interface InvitationAcceptanceResult {
  email: string;
  role: "member" | "guest";
  status: "accepted" | "pending_approval";
  loginAllowed: boolean;
}

export interface ContactPerson {
  id: string;
  displayName: string;
  email: string;
  role: MemberRole;
  character: CharacterPreset;
}

export interface ContactPrivateDetails {
  label: string;
  notes: string;
  tags: string[];
  followUpState: ContactFollowUpState;
  followUpAt?: string;
  sortOrder: number;
}

export interface ContactCollectionMemberView {
  person: ContactPerson;
  addedAt: string;
  privateDetails?: ContactPrivateDetails;
  consentStatus?: "pending" | ContactConsentDecision;
}

export interface ContactCollectionView {
  id: string;
  name: string;
  description: string;
  kind: ContactCollectionKind;
  visibility: ContactCollectionVisibility;
  rosterVisibility: ContactRosterVisibility;
  policyVersion: number;
  owner: ContactPerson;
  isOwner: boolean;
  members: ContactCollectionMemberView[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactConsentRequest {
  collectionId: string;
  collectionName: string;
  collectionDescription: string;
  kind: "family" | "team";
  owner: ContactPerson;
  policyVersion: number;
  rosterVisibility: ContactRosterVisibility;
  sharedFields: string[];
  myDecision?: ContactConsentDecision;
  requestedAt: string;
}

export interface ContactsDashboard {
  canManage: boolean;
  ownedCollections: ContactCollectionView[];
  sharedCollections: ContactCollectionView[];
  consentRequests: ContactConsentRequest[];
  availablePeople: ContactPerson[];
}

export interface ContactConsentResult {
  collectionId: string;
  policyVersion: number;
  decision: ContactConsentDecision;
  decidedAt: string;
}

export interface CalendarRecurrence {
  frequency: CalendarRecurrenceFrequency;
  interval: number;
  weekdays?: CalendarWeekday[];
  count?: number;
  untilLocalDate?: string;
}

export interface CalendarPerson {
  id: string;
  displayName: string;
  role: MemberRole;
  character: CharacterPreset;
}

export interface CalendarSpaceOption {
  id: string;
  title: string;
  mode: RoomPresentationMode;
  canInviteAll: boolean;
  people: CalendarPerson[];
}

export interface CalendarContext {
  defaultTimezone: string;
  spaces: CalendarSpaceOption[];
}

export interface CalendarAttendeeView {
  person: CalendarPerson;
  response: CalendarResponseStatus;
  respondedAt?: string;
}

export interface CalendarAttendeeCounts {
  accepted: number;
  declined: number;
  needsAction: number;
  tentative: number;
}

export interface CalendarEventView {
  id: string;
  title: string;
  description: string;
  location: string;
  visibility: CalendarEventVisibility;
  status: CalendarEventStatus;
  timezone: string;
  startsLocal: string;
  endsLocal: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  recurrence?: CalendarRecurrence;
  version: number;
  creator: CalendarPerson;
  isCreator: boolean;
  canEdit: boolean;
  canCancel: boolean;
  canRespond: boolean;
  myResponse?: CalendarResponseStatus;
  attendees?: CalendarAttendeeView[];
  attendeeCounts?: CalendarAttendeeCounts;
  reminderOffsetsMinutes?: number[];
  space?: Pick<CalendarSpaceOption, "id" | "title" | "mode">;
  cancellationReason?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarOccurrenceView extends CalendarEventView {
  occurrenceKey: string;
  occurrenceStartsLocal: string;
  occurrenceEndsLocal: string;
  occurrenceStartsAt: string;
  occurrenceEndsAt: string;
}

export interface CalendarReminderView {
  reminderId: string;
  eventId: string;
  occurrenceKey: string;
  occurrenceStartsAt: string;
  triggerAt: string;
  title: string;
  creatorDisplayName: string;
}

export interface CalendarWindowView {
  from: string;
  to: string;
  occurrences: CalendarOccurrenceView[];
  reminders: CalendarReminderView[];
}

export interface CreateCalendarEventInput {
  title: string;
  description?: string;
  location?: string;
  visibility: CalendarEventVisibility;
  spaceId?: string;
  attendeeIds: string[];
  startsLocal: string;
  endsLocal: string;
  timezone: string;
  allDay: boolean;
  recurrence?: CalendarRecurrence;
  reminderOffsetsMinutes: number[];
}

export interface UpdateCalendarEventInput extends CreateCalendarEventInput {
  version: number;
}

export interface CancelCalendarEventInput {
  version: number;
  reason?: string;
}

export interface RespondCalendarEventInput {
  response: Exclude<CalendarResponseStatus, "needs_action">;
}

export interface DismissCalendarReminderInput {
  occurrenceStartsAt: string;
}

export interface DeviceSessionView {
  id: string;
  current: boolean;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AiJob {
  id: string;
  organizationId: string;
  requestedBy: string;
  jobType: AiJobType;
  status: AiJobStatus;
  model: {
    capability: string;
    deploymentMode: "local" | "private_server" | "managed_api";
    name: string;
    provider: string;
  };
  attemptCount: number;
  maxAttempts: number;
  progress: number;
  inputAssetId?: string;
  spaceId?: string;
  transcript?: VoiceTranscriptView;
  resultJson?: Record<string, unknown>;
  result?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AiCapabilityView {
  chatIndependent: true;
  durableQueue: true;
  redisDispatch: "configured" | "database_poll";
  protocolVersion: 1;
  activeWorkers: Array<{
    workerId: string;
    capabilities: string[];
    lastSeenAt: string;
  }>;
  models: Array<{
    capability: string;
    deploymentMode: "local" | "private_server" | "managed_api";
    enabled: boolean;
    modelFamily: string;
    name: string;
    provider: string;
  }>;
}

export interface VoiceTranscriptView {
  id: string;
  aiJobId: string;
  sourceAssetId: string;
  language: string;
  draftText: string;
  editedText?: string;
  reviewStatus: "ai_draft" | "sending" | "reviewed" | "rejected";
  approvedMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiSummaryResult {
  aiGenerated: true;
  summary: string;
  decisions: string[];
  tasks: Array<{ assignee?: string; title: string }>;
}

export interface VoiceProfileConsentView {
  id: string;
  referenceAssetId: string;
  purpose: "personal_tts";
  policyVersion: string;
  status: "active" | "revoked" | "expired";
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface VoiceProfileView {
  id: string;
  referenceAssetId: string;
  consentId: string;
  modelName: string;
  status: "pending" | "active" | "revoked" | "deleting" | "deleted";
  watermarkRequired: true;
  createdAt: string;
  revokedAt?: string;
  deletedAt?: string;
}

export interface AvatarProfileView {
  id: string;
  sourceAssetId?: string;
  displayAssetId?: string;
  avatarType: "preset" | "photo" | "caricature" | "animated_2d";
  style: string;
  aiGenerated: boolean;
  consentToStoreSource: boolean;
  status: "pending" | "active" | "rejected" | "deleted";
  createdAt: string;
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
  password: string;
  characterId: string;
  inviteCode?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface SendMessageInput {
  senderId: string;
  body: string;
  audienceType: AudienceType;
  targetUserIds: string[];
  targetRole?: MemberRole;
  requiresConfirmation?: boolean;
}

export interface SendConversationMessageInput {
  spaceId: string;
  clientMessageId: string;
  body: string;
  audienceType: AudienceType;
  targetUserIds: string[];
  targetRole?: MemberRole;
  parentMessageId?: string;
  requiresConfirmation?: boolean;
}

export interface CreateInviteInput {
  email: string;
  role: "member" | "guest";
  invitedBy: string;
  approvalPolicy?: ApprovalPolicy;
}

export interface CreateAttachmentMessageInput {
  uploaderId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  audienceType: AudienceType;
  targetUserIds: string[];
  targetRole?: MemberRole;
  source: "file_upload" | "screen_capture";
  mediaVisibility?: "private_archive" | "shared" | "selected";
}

export interface ConfirmMessageReadInput {
  userId: string;
}

export interface AuthPermissions {
  canInviteGuests: boolean;
  canUploadFiles: boolean;
  canOpenReadReport: boolean;
  canDownloadFiles: boolean;
  canCreateBroadcast: boolean;
  canRequestRemoteSupport: boolean;
}

export interface AuthSession {
  user: User;
  roomId: string;
  role: MemberRole;
  permissions: AuthPermissions;
  createdAt: string;
  expiresAt: string;
}

export interface ConversationView {
  room: RoomPresentation;
  users: User[];
  roomMembers: RoomMember[];
  messages: Message[];
  hasMore?: boolean;
  nextCursor?: string;
}

export interface ConversationListItem {
  room: RoomPresentation;
  unreadCount: number;
  lastMessageAt?: string;
  lastMessagePreview?: string;
}

export interface CallCapabilities {
  available: boolean;
  provider: "livekit";
  deployment: "local" | "remote" | "unconfigured";
  tokenTtlSeconds: number;
  reason?: string;
  recording: RecordingCapabilities;
}

export interface RecordingCapabilities {
  available: boolean;
  provider: "livekit-egress";
  deployment: "local" | "remote" | "unconfigured";
  mode: "room_composite";
  outputFormat: "mp4";
  policyVersion: string;
  reason?: string;
}

export interface RecordingConsentView {
  person: Pick<User, "id" | "displayName" | "character">;
  role: CallParticipantRole | MeetingRole;
  consentStatus: RecordingConsentStatus;
  isSelf: boolean;
  respondedAt?: string;
}

export interface RecordingView {
  id: string;
  status: RecordingStatus;
  policyVersion: string;
  requestedAt: string;
  requestedBy: Pick<User, "id" | "displayName" | "character">;
  participants: RecordingConsentView[];
  allConsented: boolean;
  myConsentStatus: RecordingConsentStatus;
  canRespond: boolean;
  canStart: boolean;
  canStop: boolean;
  canRevoke: boolean;
  consentCompletedAt?: string;
  startedAt?: string;
  stopRequestedAt?: string;
  endedAt?: string;
  failureCode?: string;
}

export interface CallParticipantView {
  mediaIdentity: string;
  person: Pick<User, "id" | "displayName" | "character">;
  role: CallParticipantRole;
  status: CallParticipantStatus;
  screenShareStatus: ScreenShareStatus;
  screenShareStartedAt?: string;
  isSelf: boolean;
  invitedAt: string;
  joinedAt?: string;
  leftAt?: string;
}

export interface CallView {
  id: string;
  spaceId: string;
  callType: CallType;
  status: CallStatus;
  title: string;
  isCreator: boolean;
  isIncoming: boolean;
  canJoin: boolean;
  canDecline: boolean;
  canLeave: boolean;
  canEnd: boolean;
  canShareScreen: boolean;
  canRequestRecording: boolean;
  recording?: RecordingView;
  participants: CallParticipantView[];
  createdAt: string;
  expiresAt: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
}

export interface StartCallInput {
  clientCallId: string;
  spaceId: string;
  callType: CallType;
  targetUserIds: string[];
}

export interface CallJoinView {
  call: CallView;
  serverUrl: string;
  token: string;
  tokenExpiresAt: string;
}

export interface MeetingRoleAssignment {
  userId: string;
  role: Exclude<MeetingRole, "host">;
}

export interface MeetingParticipantView {
  mediaIdentity: string;
  person: Pick<User, "id" | "displayName" | "character">;
  role: MeetingRole;
  status: MeetingParticipantStatus;
  eventResponse: CalendarResponseStatus;
  isSelf: boolean;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  screenShareStatus: ScreenShareStatus;
  screenShareStartedAt?: string;
  invitedAt: string;
  waitingAt?: string;
  admittedAt?: string;
  joinedAt?: string;
  leftAt?: string;
}

export interface MeetingView {
  id: string;
  eventId: string;
  spaceId: string;
  occurrenceStartsAt: string;
  occurrenceEndsAt: string;
  lobbyOpensAt: string;
  lobbyClosesAt: string;
  callType: CallType;
  status: MeetingStatus;
  title: string;
  version: number;
  isCreator: boolean;
  myRole: MeetingRole;
  myStatus: MeetingParticipantStatus;
  canOpen: boolean;
  canEnter: boolean;
  canJoin: boolean;
  canLeave: boolean;
  canEnd: boolean;
  canAdmit: boolean;
  canManageRoles: boolean;
  canShareScreen: boolean;
  canRequestRecording: boolean;
  recording?: RecordingView;
  participants: MeetingParticipantView[];
  waitingCount?: number;
  createdAt: string;
  openedAt?: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
}

export interface ScheduleMeetingInput {
  clientMeetingId: string;
  eventId: string;
  occurrenceStartsAt: string;
  callType: CallType;
  roleAssignments: MeetingRoleAssignment[];
}

export interface MeetingJoinView {
  meeting: MeetingView;
  serverUrl: string;
  token: string;
  tokenExpiresAt: string;
}

export interface BroadcastChannelSummary {
  id: string;
  handle: string;
  name: string;
  description: string;
  visibility: BroadcastChannelVisibility;
  owner: Pick<User, "id" | "displayName" | "character">;
  isOwner: boolean;
  isSubscribed: boolean;
  subscriberCount: number;
  canManage: boolean;
  canSubscribe: boolean;
  subscriptionStatus?: BroadcastSubscriptionStatus;
  notificationLevel?: BroadcastNotificationLevel;
  nextSession?: BroadcastSessionSummary;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastSessionSummary {
  id: string;
  channelId: string;
  title: string;
  description: string;
  callType: CallType;
  chatMode: BroadcastChatMode;
  status: BroadcastStatus;
  scheduledFor: string;
  expectedEndAt: string;
  viewerCount: number;
  replayStatus: BroadcastReplayStatus;
  startedAt?: string;
  endedAt?: string;
}

export interface BroadcastParticipantView {
  person: Pick<User, "id" | "displayName" | "character">;
  role: BroadcastRole;
  status: BroadcastParticipantStatus;
  isSelf: boolean;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  joinedAt?: string;
  leftAt?: string;
}

export interface BroadcastMessageView {
  id: string;
  kind: BroadcastMessageKind;
  status: BroadcastMessageStatus;
  body: string;
  senderLabel: string;
  senderRole: BroadcastRole;
  isMine: boolean;
  canModerate: boolean;
  version: number;
  sender?: Pick<User, "id" | "displayName" | "character">;
  moderatedAt?: string;
  createdAt: string;
}

export interface BroadcastReactionCount {
  reaction: BroadcastReaction;
  count: number;
}

export interface BroadcastReplayView {
  status: BroadcastReplayStatus;
  canOpen: boolean;
  unavailableReason?: string;
  mediaAssetId?: string;
  availableAt?: string;
}

export interface BroadcastSessionView extends BroadcastSessionSummary {
  channel: BroadcastChannelSummary;
  version: number;
  myRole: BroadcastRole;
  myStatus: BroadcastParticipantStatus;
  canStart: boolean;
  canJoin: boolean;
  canLeave: boolean;
  canEnd: boolean;
  canModerate: boolean;
  canManageRoles: boolean;
  canSendChat: boolean;
  canAskQuestion: boolean;
  canRequestPrivateService: boolean;
  onStageParticipants: BroadcastParticipantView[];
  moderationParticipants?: BroadcastParticipantView[];
  messages: BroadcastMessageView[];
  reactionCounts: BroadcastReactionCount[];
  replay: BroadcastReplayView;
  endReason?: string;
}

export interface BroadcastDashboard {
  capabilities: CallCapabilities;
  canCreateChannel: boolean;
  channels: BroadcastChannelSummary[];
}

export interface BroadcastJoinView {
  broadcast: BroadcastSessionView;
  serverUrl: string;
  token: string;
  tokenExpiresAt: string;
}

export interface CreateBroadcastChannelInput {
  handle: string;
  name: string;
  description?: string;
  visibility: BroadcastChannelVisibility;
}

export interface ScheduleBroadcastInput {
  clientSessionId: string;
  title: string;
  description?: string;
  callType: CallType;
  chatMode: BroadcastChatMode;
  scheduledFor: string;
  expectedEndAt: string;
  viewerLimit: number;
  replayRequested: boolean;
}

export interface BroadcastSubscriptionInput {
  notificationLevel: BroadcastNotificationLevel;
}

export interface CreateBroadcastMessageInput {
  clientMessageId: string;
  kind: BroadcastMessageKind;
  body: string;
}

export interface ModerateBroadcastMessageInput {
  action: BroadcastModerationAction;
  version: number;
}

export interface SendBroadcastReactionInput {
  clientReactionId: string;
  reaction: BroadcastReaction;
}

export interface ChangeBroadcastRoleInput {
  role: Exclude<BroadcastRole, "host">;
  version: number;
}

export interface BroadcastPrivateHandoffView {
  channelId: string;
  spaceId: string;
  owner: Pick<User, "id" | "displayName" | "character">;
  created: boolean;
}

export interface StopScreenShareInput {
  reason: ScreenShareStopReason;
}

export interface RecordingConsentInput {
  decision: RecordingConsentDecision;
  policyVersion: string;
}

export interface StopRecordingInput {
  reason: Extract<RecordingStopReason, "host_stopped" | "consent_revoked">;
}

export interface MvpSnapshot extends ConversationView {
  organization: Organization;
  aiJobs: AiJob[];
  invites: Invite[];
  spaces?: ConversationListItem[];
}

export interface MessageDeleteResult {
  id: string;
  deletedAt: string;
}

export interface TypingUpdate {
  spaceId: string;
  userId: string;
  displayName: string;
  active: boolean;
}

export interface MessageDeliveryPlan {
  deliveryMode: MessageDeliveryMode;
  normalizedAudienceType: AudienceType;
  normalizedTargetUserIds: string[];
  deliveries: MessageDelivery[];
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
    displayName: "이과장",
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
  type: "hub",
  name: "프로젝트 A 허브방",
  ownerId: "user-you",
  settings: {
    rosterVisibility: "owner_only",
    guestCanDownload: false,
    readReportEnabled: true,
    fileSharingEnabled: true,
    publicAnnouncementsEnabled: true
  },
  createdAt: "2026-07-09T09:30:00+09:00"
};

export const demoRoomMembers: RoomMember[] = demoUsers.map((user, index) => {
  const isOwner = user.id === demoRoom.ownerId;
  const member: RoomMember = {
    roomId: demoRoom.id,
    userId: user.id,
    role: isOwner ? "owner" : user.id.startsWith("guest") ? "guest" : index === 1 ? "admin" : "member",
    viewMode: isOwner ? "owner_console" : "direct_with_owner",
    joinedAt: "2026-07-09T09:31:00+09:00"
  };

  if (index < 3) {
    member.lastReadAt = `2026-07-09T10:1${index}:00+09:00`;
  }

  return member;
});

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
  createdAt = new Date().toISOString(),
  roomScope?: Pick<Room, "type" | "ownerId">,
  absoluteExpiresAt?: string
): AuthSession {
  const expiresAt = absoluteExpiresAt ? new Date(absoluteExpiresAt) : new Date(createdAt);
  if (!absoluteExpiresAt) {
    expiresAt.setHours(expiresAt.getHours() + 12);
  }

  const isGuest = role === "guest" || role === "subscriber";
  const isManager = role === "owner" || role === "admin";
  const isHiddenHubParticipant = roomScope?.type === "hub" && roomScope.ownerId !== user.id;
  const canManageConversation = isManager && !isHiddenHubParticipant;

  return {
    user,
    roomId,
    role,
    permissions: {
      canInviteGuests: canManageConversation,
      canUploadFiles: !isGuest,
      canOpenReadReport: canManageConversation,
      canDownloadFiles: !isGuest,
      canCreateBroadcast: canManageConversation,
      canRequestRemoteSupport: !isGuest
    },
    createdAt,
    expiresAt: expiresAt.toISOString()
  };
}

export function getMessageTypeForMime(mimeType: string): MessageType {
  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  return "file";
}

export function createDemoStorageKey(fileName: string, createdAt = new Date().toISOString()): string {
  const safeName = fileName.trim().toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
  return `demo/${Date.parse(createdAt) || Date.now()}-${safeName}`;
}

export function createMessageAudience(
  messageId: string,
  audienceType: AudienceType,
  senderId: string,
  targetUserIds: string[],
  targetRole?: MemberRole
): MessageAudience[] {
  if (audienceType === "all") {
    return [{ id: `${messageId}-aud-all`, messageId, audienceType: "all" }];
  }

  if (audienceType === "role") {
    return [{ id: `${messageId}-aud-role-${targetRole ?? "member"}`, messageId, audienceType, targetRole: targetRole ?? "member" }];
  }

  const uniqueTargetIds = new Set([senderId, ...targetUserIds]);

  return Array.from(uniqueTargetIds).map((targetUserId) => ({
    id: `${messageId}-aud-${targetUserId}`,
    messageId,
    audienceType,
    targetUserId
  }));
}

export function createMessageDeliveryPlan(
  room: Room,
  members: RoomMember[],
  messageId: string,
  senderId: string,
  audienceType: AudienceType,
  targetUserIds: string[],
  createdAt = new Date().toISOString(),
  targetRole?: MemberRole
): MessageDeliveryPlan {
  const senderMember = members.find((member) => member.roomId === room.id && member.userId === senderId);

  if (!senderMember) {
    throw new Error("Sender is not a member of this conversation.");
  }

  const roomMembers = members.filter((member) => member.roomId === room.id);
  const validMemberIds = new Set(roomMembers.map((member) => member.userId));
  const validTargetIds = Array.from(new Set(targetUserIds.filter((userId) => validMemberIds.has(userId) && userId !== senderId)));
  const isOwner = senderId === room.ownerId || senderMember.role === "owner";
  let deliveryMode: MessageDeliveryMode;
  let normalizedAudienceType = audienceType;
  let normalizedTargetUserIds = validTargetIds;
  let recipientIds: string[];

  if (room.type === "hub") {
    if (!isOwner) {
      deliveryMode = "direct";
      normalizedAudienceType = "private";
      normalizedTargetUserIds = [room.ownerId];
      recipientIds = [senderId, room.ownerId];
    } else if (audienceType === "all") {
      deliveryMode = "hub_announcement";
      recipientIds = roomMembers.map((member) => member.userId);
    } else if (audienceType === "role") {
      deliveryMode = "role";
      const role = targetRole ?? "member";
      normalizedTargetUserIds = roomMembers.filter((member) => member.role === role).map((member) => member.userId);
      recipientIds = [senderId, ...normalizedTargetUserIds];
    } else {
      normalizedTargetUserIds = audienceType === "private" ? validTargetIds.slice(0, 1) : validTargetIds;
      deliveryMode = audienceType === "private" ? "direct" : "hub_fanout";
      recipientIds = [senderId, ...normalizedTargetUserIds];
    }
  } else if (room.type === "broadcast_channel") {
    if (!isOwner && senderMember.role !== "admin") {
      throw new Error("Only a channel owner or admin can publish a broadcast message.");
    }

    deliveryMode = "broadcast";
    normalizedAudienceType = "all";
    normalizedTargetUserIds = [];
    recipientIds = roomMembers.map((member) => member.userId);
  } else if (room.type === "direct") {
    deliveryMode = "direct";
    normalizedAudienceType = "private";
    normalizedTargetUserIds = roomMembers.filter((member) => member.userId !== senderId).map((member) => member.userId);
    recipientIds = roomMembers.map((member) => member.userId);
  } else if (audienceType === "all") {
    deliveryMode = "shared";
    recipientIds = roomMembers.map((member) => member.userId);
  } else if (audienceType === "role") {
    deliveryMode = "role";
    const role = targetRole ?? "member";
    normalizedTargetUserIds = roomMembers.filter((member) => member.role === role).map((member) => member.userId);
    recipientIds = [senderId, ...normalizedTargetUserIds];
  } else {
    normalizedTargetUserIds = audienceType === "private" ? validTargetIds.slice(0, 1) : validTargetIds;
    deliveryMode = audienceType === "private" ? "direct" : "shared";
    recipientIds = [senderId, ...normalizedTargetUserIds];
  }

  const uniqueRecipientIds = Array.from(new Set(recipientIds.filter((userId) => validMemberIds.has(userId))));
  const deliveries = uniqueRecipientIds.map((recipientId): MessageDelivery => {
    const delivery: MessageDelivery = {
      id: `${messageId}-delivery-${recipientId}`,
      messageId,
      recipientId,
      threadKey: getThreadKey(room, senderId, recipientId),
      status: "delivered",
      deliveredAt: createdAt
    };

    if (recipientId === senderId) {
      delivery.readAt = createdAt;
    }

    return delivery;
  });

  return {
    deliveryMode,
    normalizedAudienceType,
    normalizedTargetUserIds,
    deliveries
  };
}

export function getRoomPresentationForViewer(
  room: Room,
  members: RoomMember[],
  users: User[],
  viewerId: string
): RoomPresentation {
  const roomMembers = members.filter((member) => member.roomId === room.id);
  const viewerMember = roomMembers.find((member) => member.userId === viewerId);

  if (!viewerMember) {
    throw new Error("Viewer is not a member of this conversation.");
  }

  if (room.type === "hub" && viewerId !== room.ownerId) {
    const owner = users.find((user) => user.id === room.ownerId);

    return {
      roomId: room.id,
      mode: "direct",
      title: owner?.displayName ?? "대화 상대",
      ownerId: room.ownerId,
      visibleMemberIds: [viewerId, room.ownerId],
      rosterVisible: false,
      canSelectAudience: false,
      publicAnnouncementsEnabled: room.settings.publicAnnouncementsEnabled
    };
  }

  if (room.type === "hub") {
    return {
      roomId: room.id,
      mode: "hub_owner",
      title: room.name,
      ownerId: room.ownerId,
      visibleMemberIds: roomMembers.map((member) => member.userId),
      rosterVisible: true,
      canSelectAudience: true,
      publicAnnouncementsEnabled: room.settings.publicAnnouncementsEnabled,
      memberCount: roomMembers.length
    };
  }

  if (room.type === "direct") {
    const counterpart = users.find((user) => user.id !== viewerId && roomMembers.some((member) => member.userId === user.id));

    return {
      roomId: room.id,
      mode: "direct",
      title: counterpart?.displayName ?? room.name,
      ownerId: room.ownerId,
      visibleMemberIds: roomMembers.map((member) => member.userId),
      rosterVisible: false,
      canSelectAudience: false,
      publicAnnouncementsEnabled: false
    };
  }

  const mode: RoomPresentationMode = room.type === "broadcast_channel"
    ? "channel"
    : room.type === "meeting_backstage"
      ? "meeting"
      : "group";

  return {
    roomId: room.id,
    mode,
    title: room.name,
    ownerId: room.ownerId,
    visibleMemberIds: roomMembers.map((member) => member.userId),
    rosterVisible: room.settings.rosterVisibility === "shared",
    canSelectAudience: room.type === "open_group",
    publicAnnouncementsEnabled: room.settings.publicAnnouncementsEnabled,
    memberCount: roomMembers.length
  };
}

export function projectMessageForViewer(
  message: Message,
  room: Room,
  members: RoomMember[],
  viewerId: string
): Message | undefined {
  const member = members.find((candidate) => candidate.roomId === room.id && candidate.userId === viewerId);
  const ownDelivery = message.deliveries.find((delivery) => delivery.recipientId === viewerId && !delivery.revokedAt);

  if (!member || message.deletedAt || !ownDelivery) {
    return undefined;
  }

  if (room.type !== "hub" || viewerId === room.ownerId) {
    return message;
  }

  const isAnnouncement = message.deliveryMode === "hub_announcement";

  const projectedAudience: MessageAudience = {
    id: `${message.id}-aud-viewer-${viewerId}`,
    messageId: message.id,
    audienceType: isAnnouncement ? "all" : "private"
  };

  if (!isAnnouncement) {
    projectedAudience.targetUserId = viewerId;
  }

  return {
    ...message,
    deliveryMode: isAnnouncement ? "hub_announcement" : "direct",
    audiences: [projectedAudience],
    deliveries: [ownDelivery]
  };
}

export function isMessageVisibleTo(message: Message, userId: string, members: RoomMember[]): boolean {
  const member = members.find((candidate) => candidate.roomId === message.roomId && candidate.userId === userId);

  if (!member || message.deletedAt) {
    return false;
  }

  return message.deliveries.some((delivery) => delivery.recipientId === userId && !delivery.revokedAt);
}

export function getAudienceLabel(message: Message, users: User[]): string {
  const firstAudience = message.audiences[0];

  if (!firstAudience || firstAudience.audienceType === "all") {
    return message.deliveryMode === "hub_announcement" ? "전체 공지" : "전체";
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

  return `${targetNames.filter((name) => name !== users.find((user) => user.id === message.senderId)?.displayName).length}명 선택`;
}

export function buildReadReport(message: Message, users: User[]) {
  return message.deliveries
    .map((delivery) => {
      const user = users.find((candidate) => candidate.id === delivery.recipientId);

      if (!user) {
        return undefined;
      }

      return {
        user,
        readAt: delivery.readAt,
        confirmedAt: delivery.confirmedAt,
        state: delivery.readAt ? "read" as const : "unread" as const
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export function confirmMessageRead(message: Message, userId: string, confirmedAt = new Date().toISOString()): Message {
  const existingDelivery = message.deliveries.find((delivery) => delivery.recipientId === userId && !delivery.revokedAt);

  if (!existingDelivery) {
    throw new Error("User is not a recipient of this message.");
  }

  return {
    ...message,
    deliveries: message.deliveries.map((delivery) => delivery.recipientId === userId
      ? { ...delivery, confirmedAt, readAt: delivery.readAt || confirmedAt }
      : delivery)
  };
}

function getThreadKey(room: Room, senderId: string, recipientId: string): string {
  if (room.type !== "hub") {
    return `${room.id}:shared`;
  }

  if (senderId === room.ownerId) {
    return recipientId === room.ownerId ? `${room.id}:owner-console` : `${room.id}:spoke:${recipientId}`;
  }

  return `${room.id}:spoke:${senderId}`;
}

function buildDemoMessage({
  id,
  senderId,
  body,
  messageType = "text",
  audienceType,
  targetUserIds = [],
  createdAt,
  metadata = {},
  deliveryReads = {},
  attachments = []
}: {
  id: string;
  senderId: string;
  body: string;
  messageType?: MessageType;
  audienceType: AudienceType;
  targetUserIds?: string[];
  createdAt: string;
  metadata?: Message["metadata"];
  deliveryReads?: Record<string, { readAt?: string; confirmedAt?: string }>;
  attachments?: Attachment[];
}): Message {
  const plan = createMessageDeliveryPlan(
    demoRoom,
    demoRoomMembers,
    id,
    senderId,
    audienceType,
    targetUserIds,
    createdAt
  );

  return {
    id,
    roomId: demoRoom.id,
    senderId,
    messageType,
    deliveryMode: plan.deliveryMode,
    body,
    metadata,
    createdAt,
    audiences: createMessageAudience(id, plan.normalizedAudienceType, senderId, plan.normalizedTargetUserIds),
    deliveries: plan.deliveries.map((delivery) => ({ ...delivery, ...deliveryReads[delivery.recipientId] })),
    attachments,
  };
}

export const demoMessages: Message[] = [
  buildDemoMessage({
    id: "msg-001",
    senderId: "user-you",
    body: "오늘 고객 미팅 자료와 체크리스트를 이 방에서 같이 봅시다.",
    audienceType: "all",
    createdAt: "2026-07-09T10:00:00+09:00",
    metadata: { requiresConfirmation: true },
    deliveryReads: {
      "user-you": { readAt: "2026-07-09T10:00:02+09:00", confirmedAt: "2026-07-09T10:00:03+09:00" },
      "user-mina": { readAt: "2026-07-09T10:01:11+09:00", confirmedAt: "2026-07-09T10:02:04+09:00" },
      "user-jun": { readAt: "2026-07-09T10:03:45+09:00" }
    }
  }),
  buildDemoMessage({
    id: "msg-002",
    senderId: "user-mina",
    messageType: "file",
    body: "제안서 PDF 초안 올립니다. 오른쪽 문서 패널에서 봐주세요.",
    audienceType: "private",
    targetUserIds: ["user-you"],
    createdAt: "2026-07-09T10:04:00+09:00",
    metadata: { source: "file_upload", mediaVisibility: "shared" },
    deliveryReads: {
      "user-you": { readAt: "2026-07-09T10:04:20+09:00" },
      "user-mina": { readAt: "2026-07-09T10:04:01+09:00" }
    },
    attachments: [
      {
        id: "att-proposal-pdf",
        assetId: "asset-proposal-pdf",
        messageId: "msg-002",
        uploaderId: "user-mina",
        fileName: "프로젝트A_제안서_v1.pdf",
        mimeType: "application/pdf",
        mediaKind: "pdf",
        mediaVisibility: "shared",
        sizeBytes: 428000,
        previewStatus: "ready",
        virusScanStatus: "clean",
        source: "file_upload",
        canDownload: true,
        createdAt: "2026-07-09T10:04:00+09:00"
      }
    ]
  }),
  buildDemoMessage({
    id: "msg-003",
    senderId: "user-you",
    body: "미나님, 가격표는 내부 검토 후 고객에게 공개합시다.",
    audienceType: "selected",
    targetUserIds: ["user-mina"],
    createdAt: "2026-07-09T10:06:00+09:00",
    deliveryReads: {
      "user-you": { readAt: "2026-07-09T10:06:01+09:00" },
      "user-mina": { readAt: "2026-07-09T10:06:31+09:00" }
    }
  }),
  buildDemoMessage({
    id: "msg-004",
    senderId: "guest-hana",
    body: "외부 고객 계정에서는 나와 담당자의 대화만 보이는 것을 확인했습니다.",
    audienceType: "all",
    createdAt: "2026-07-09T10:08:00+09:00",
    deliveryReads: {
      "user-you": { readAt: "2026-07-09T10:08:20+09:00" },
      "guest-hana": { readAt: "2026-07-09T10:08:01+09:00" }
    }
  })
];

export const demoAiJobs: AiJob[] = [
  {
    id: "ai-001",
    organizationId: demoOrganization.id,
    requestedBy: "user-you",
    jobType: "summary",
    status: "queued",
    model: { capability: "summary", deploymentMode: "local", name: "Qwen3.5-4B", provider: "qwen" },
    attemptCount: 0,
    maxAttempts: 3,
    progress: 0,
    createdAt: "2026-07-09T10:09:00+09:00",
    result: "회의록 초안은 채팅을 막지 않고 백그라운드에서 생성됩니다."
  },
  {
    id: "ai-002",
    organizationId: demoOrganization.id,
    requestedBy: "user-mina",
    jobType: "stt",
    status: "running",
    model: { capability: "stt", deploymentMode: "local", name: "large-v3-turbo", provider: "faster-whisper" },
    attemptCount: 1,
    maxAttempts: 3,
    progress: 35,
    createdAt: "2026-07-09T10:10:00+09:00"
  }
];
