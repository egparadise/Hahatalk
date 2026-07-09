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
  type Invite,
  type LoginInput,
  type Message,
  type RoomMember,
  type SignupInput,
  type User
} from "@hahatalk/contracts";

interface SendMessageInput {
  senderId: string;
  body: string;
  audienceType: AudienceType;
  targetUserIds: string[];
  requiresConfirmation?: boolean;
}

interface CreateInviteInput {
  email: string;
  role: "member" | "guest";
  invitedBy: string;
}

@Injectable()
export class DemoStore {
  private readonly users: User[] = [...demoUsers];
  private readonly roomMembers: RoomMember[] = [...demoRoomMembers];
  private readonly messages: Message[] = [...demoMessages];
  private readonly invites: Invite[] = [];
  private readonly sessions: AuthSession[] = [];

  snapshot() {
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
    const id = `msg-${Date.now()}`;
    const now = new Date().toISOString();
    const message: Message = {
      id,
      roomId: demoRoom.id,
      senderId: input.senderId,
      messageType: "text",
      body: input.body,
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
    const invite: Invite = {
      id: `invite-${Date.now()}`,
      roomId: demoRoom.id,
      invitedBy: input.invitedBy,
      email: input.email,
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
