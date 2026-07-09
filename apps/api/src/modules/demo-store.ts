import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  buildReadReport,
  createAuthSession,
  createMessageAudience,
  demoAiJobs,
  demoMessages,
  demoOrganization,
  demoRoom,
  demoRoomMembers,
  demoUsers,
  findCharacterPreset,
  createDemoStorageKey,
  confirmMessageRead,
  getMessageTypeForMime,
  isValidEmail,
  normalizeEmail,
  type AudienceType,
  type AuthSession,
  type ConfirmMessageReadInput,
  type LoginInput,
  type Message,
  type MvpSnapshot,
  type RoomMember,
  type CreateInviteInput,
  type CreateAttachmentMessageInput,
  type Invite,
  type SendMessageInput,
  type SignupInput,
  type User
} from "@hahatalk/contracts";

@Injectable()
export class DemoStore {
  private readonly users: User[] = [...demoUsers];
  private readonly roomMembers: RoomMember[] = [...demoRoomMembers];
  private readonly messages: Message[] = [...demoMessages];
  private readonly invites: Invite[] = [];
  private readonly sessions: AuthSession[] = [];

  snapshot(): MvpSnapshot {
    return {
      organization: demoOrganization,
      room: demoRoom,
      users: this.users,
      roomMembers: this.roomMembers,
      messages: this.messages,
      aiJobs: demoAiJobs,
      invites: this.invites
    };
  }

  signup(input: SignupInput) {
    const displayName = input.displayName.trim();
    const email = normalizeEmail(input.email);

    if (displayName.length < 2) {
      throw new BadRequestException("displayName must be at least 2 characters.");
    }

    if (!isValidEmail(email)) {
      throw new BadRequestException("email must be valid.");
    }

    const currentUser = this.users[0]!;
    const user: User = {
      ...currentUser,
      displayName,
      email,
      status: "active",
      character: findCharacterPreset(input.characterId),
      lastSeenAt: new Date().toISOString()
    };

    this.users[0] = user;
    const session = createAuthSession(user, this.getMemberRole(user.id), demoRoom.id);
    this.sessions.push(session);

    return session;
  }

  login(input: LoginInput) {
    const email = normalizeEmail(input.email);

    if (!isValidEmail(email)) {
      throw new BadRequestException("email must be valid.");
    }

    const user = this.users.find((candidate) => normalizeEmail(candidate.email) === email);

    if (!user) {
      throw new NotFoundException("No HahaTalk user exists for this email.");
    }

    const session = createAuthSession(user, this.getMemberRole(user.id), demoRoom.id);
    this.sessions.push(session);

    return session;
  }

  sendMessage(input: SendMessageInput) {
    const body = input.body.trim();

    if (!body) {
      throw new BadRequestException("message body must not be empty.");
    }

    const id = `msg-${Date.now()}`;
    const now = new Date().toISOString();
    const message: Message = {
      id,
      roomId: demoRoom.id,
      senderId: input.senderId,
      messageType: "text",
      body,
      metadata: input.requiresConfirmation ? { requiresConfirmation: true } : {},
      createdAt: now,
      audiences: createMessageAudience(id, input.audienceType, input.senderId, input.targetUserIds),
      reads: [{ messageId: id, userId: input.senderId, readAt: now }],
      attachments: []
    };

    this.messages.push(message);
    return message;
  }

  createInvite(input: CreateInviteInput) {
    const email = normalizeEmail(input.email);

    if (!isValidEmail(email)) {
      throw new BadRequestException("invite email must be valid.");
    }

    const invite: Invite = {
      id: `invite-${Date.now()}`,
      roomId: demoRoom.id,
      invitedBy: input.invitedBy,
      email,
      role: input.role,
      status: "sent",
      createdAt: new Date().toISOString()
    };

    this.invites.push(invite);
    return invite;
  }

  createAttachmentMessage(input: CreateAttachmentMessageInput) {
    const fileName = input.fileName.trim();
    const mimeType = input.mimeType.trim() || "application/octet-stream";

    if (!fileName) {
      throw new BadRequestException("fileName must not be empty.");
    }

    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new BadRequestException("sizeBytes must be greater than 0.");
    }

    const id = `msg-attachment-${Date.now()}`;
    const attachmentId = `att-${Date.now()}`;
    const now = new Date().toISOString();
    const messageType = getMessageTypeForMime(mimeType);
    const attachment = {
      id: attachmentId,
      messageId: id,
      uploaderId: input.uploaderId,
      storageKey: createDemoStorageKey(fileName, now),
      fileName,
      mimeType,
      sizeBytes: input.sizeBytes,
      previewStatus: "ready" as const,
      virusScanStatus: "clean" as const,
      createdAt: now
    };
    const message: Message = {
      id,
      roomId: demoRoom.id,
      senderId: input.uploaderId,
      messageType,
      body: input.source === "screen_capture" ? "현재 화면 캡처 공유" : `${fileName} 공유`,
      metadata: { source: input.source },
      createdAt: now,
      audiences: createMessageAudience(id, input.audienceType, input.uploaderId, input.targetUserIds),
      reads: [{ messageId: id, userId: input.uploaderId, readAt: now }],
      attachments: [attachment]
    };

    this.messages.push(message);
    return message;
  }

  readReport(messageId: string) {
    const message = this.messages.find((candidate) => candidate.id === messageId);

    if (!message) {
      return [];
    }

    return buildReadReport(message, this.users);
  }

  confirmRead(messageId: string, input: ConfirmMessageReadInput) {
    const messageIndex = this.messages.findIndex((candidate) => candidate.id === messageId);

    if (messageIndex < 0) {
      throw new NotFoundException("Message not found.");
    }

    const message = this.messages[messageIndex]!;
    const confirmedMessage = confirmMessageRead(message, input.userId);
    this.messages[messageIndex] = confirmedMessage;

    return confirmedMessage;
  }

  private getMemberRole(userId: string) {
    return this.roomMembers.find((member) => member.userId === userId)?.role ?? "member";
  }
}
