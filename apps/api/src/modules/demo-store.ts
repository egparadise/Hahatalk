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
  isValidEmail,
  normalizeEmail,
  type AudienceType,
  type AuthSession,
  type LoginInput,
  type Message,
  type MvpSnapshot,
  type RoomMember,
  type CreateInviteInput,
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

  readReport(messageId: string) {
    const message = this.messages.find((candidate) => candidate.id === messageId);

    if (!message) {
      return [];
    }

    return buildReadReport(message, this.users);
  }

  private getMemberRole(userId: string) {
    return this.roomMembers.find((member) => member.userId === userId)?.role ?? "member";
  }
}
