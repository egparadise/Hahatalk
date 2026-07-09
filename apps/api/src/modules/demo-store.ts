import { Injectable } from "@nestjs/common";
import {
  buildReadReport,
  createMessageAudience,
  demoAiJobs,
  demoMessages,
  demoOrganization,
  demoRoom,
  demoRoomMembers,
  demoUsers,
  type AudienceType,
  type Invite,
  type Message
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
  private readonly messages: Message[] = [...demoMessages];
  private readonly invites: Invite[] = [];

  snapshot() {
    return {
      organization: demoOrganization,
      room: demoRoom,
      users: demoUsers,
      roomMembers: demoRoomMembers,
      messages: this.messages,
      aiJobs: demoAiJobs,
      invites: this.invites
    };
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

    return buildReadReport(message, demoUsers);
  }
}
