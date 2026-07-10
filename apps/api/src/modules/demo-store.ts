import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  buildReadReport,
  createMessageAudience,
  createMessageDeliveryPlan,
  demoAiJobs,
  demoMessages,
  demoOrganization,
  demoRoom,
  demoRoomMembers,
  demoUsers,
  createDemoStorageKey,
  confirmMessageRead,
  getMessageTypeForMime,
  getRoomPresentationForViewer,
  isValidEmail,
  normalizeEmail,
  projectMessageForViewer,
  type ConfirmMessageReadInput,
  type ConversationView,
  type MemberRole,
  type Message,
  type MvpSnapshot,
  type RoomMember,
  type CreateInviteInput,
  type CreateAttachmentMessageInput,
  type Invite,
  type SendMessageInput,
  type User
} from "@hahatalk/contracts";

@Injectable()
export class DemoStore {
  private readonly users: User[] = [...demoUsers];
  private readonly roomMembers: RoomMember[] = [...demoRoomMembers];
  private readonly messages: Message[] = [...demoMessages];
  private readonly invites: Invite[] = [];

  ensureUser(user: User, role: MemberRole) {
    const userIndex = this.users.findIndex((candidate) => candidate.id === user.id);
    if (userIndex >= 0) {
      this.users[userIndex] = user;
    } else {
      this.users.push(user);
    }

    const membershipIndex = this.roomMembers.findIndex(
      (membership) => membership.roomId === demoRoom.id && membership.userId === user.id
    );
    const currentMembership = membershipIndex >= 0 ? this.roomMembers[membershipIndex] : undefined;
    const membership: RoomMember = {
      joinedAt: currentMembership?.joinedAt ?? new Date().toISOString(),
      role,
      roomId: demoRoom.id,
      userId: user.id,
      viewMode: user.id === demoRoom.ownerId ? "owner_console" : "direct_with_owner"
    };
    if (membershipIndex >= 0) {
      this.roomMembers[membershipIndex] = { ...currentMembership!, ...membership };
    } else {
      this.roomMembers.push(membership);
    }
  }

  snapshot(viewerId = demoRoom.ownerId): MvpSnapshot {
    const view = this.conversationView(viewerId);
    const isOwner = viewerId === demoRoom.ownerId;

    return {
      organization: demoOrganization,
      ...view,
      aiJobs: isOwner ? demoAiJobs : demoAiJobs.filter((job) => job.requestedBy === viewerId),
      invites: isOwner ? this.invites : []
    };
  }

  conversationView(viewerId: string, roomId = demoRoom.id): ConversationView {
    if (roomId !== demoRoom.id) {
      throw new NotFoundException("Conversation not found.");
    }

    if (!this.roomMembers.some((member) => member.roomId === demoRoom.id && member.userId === viewerId)) {
      throw new NotFoundException("Conversation membership not found.");
    }

    const room = getRoomPresentationForViewer(demoRoom, this.roomMembers, this.users, viewerId);
    const visibleMemberIds = new Set(room.visibleMemberIds);
    const messages = this.messages
      .map((message) => projectMessageForViewer(message, demoRoom, this.roomMembers, viewerId))
      .filter((message): message is Message => Boolean(message));

    return {
      room,
      users: this.users.filter((user) => visibleMemberIds.has(user.id)),
      roomMembers: this.roomMembers.filter((member) => visibleMemberIds.has(member.userId)),
      messages
    };
  }

  sendMessage(input: SendMessageInput) {
    const body = input.body.trim();

    if (!body) {
      throw new BadRequestException("message body must not be empty.");
    }

    const id = `msg-${Date.now()}`;
    const now = new Date().toISOString();
    const plan = createMessageDeliveryPlan(
      demoRoom,
      this.roomMembers,
      id,
      input.senderId,
      input.audienceType,
      input.targetUserIds,
      now,
      input.targetRole
    );

    if (plan.normalizedAudienceType !== "all" && plan.normalizedTargetUserIds.length === 0) {
      throw new BadRequestException("At least one valid message target is required.");
    }

    const message: Message = {
      id,
      roomId: demoRoom.id,
      senderId: input.senderId,
      messageType: "text",
      deliveryMode: plan.deliveryMode,
      body,
      metadata: input.requiresConfirmation ? { requiresConfirmation: true } : {},
      createdAt: now,
      audiences: createMessageAudience(
        id,
        plan.normalizedAudienceType,
        input.senderId,
        plan.normalizedTargetUserIds,
        input.targetRole
      ),
      deliveries: plan.deliveries,
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
      status: "pending_approval",
      approvalPolicy: input.approvalPolicy ?? "admins_and_invitee",
      requiredApprovalCount: input.approvalPolicy === "owner_and_invitee" ? 2 : 3,
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
    const plan = createMessageDeliveryPlan(
      demoRoom,
      this.roomMembers,
      id,
      input.uploaderId,
      input.audienceType,
      input.targetUserIds,
      now,
      input.targetRole
    );

    if (plan.normalizedAudienceType !== "all" && plan.normalizedTargetUserIds.length === 0) {
      throw new BadRequestException("At least one valid attachment target is required.");
    }

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
      deliveryMode: plan.deliveryMode,
      body: input.source === "screen_capture" ? "현재 화면 캡처 공유" : `${fileName} 공유`,
      metadata: { source: input.source, mediaVisibility: input.mediaVisibility ?? "shared" },
      createdAt: now,
      audiences: createMessageAudience(
        id,
        plan.normalizedAudienceType,
        input.uploaderId,
        plan.normalizedTargetUserIds,
        input.targetRole
      ),
      deliveries: plan.deliveries,
      attachments: [attachment]
    };

    this.messages.push(message);
    return message;
  }

  readReport(messageId: string, viewerId = demoRoom.ownerId) {
    const message = this.messages.find((candidate) => candidate.id === messageId);

    if (!message) {
      return [];
    }

    const projectedMessage = projectMessageForViewer(message, demoRoom, this.roomMembers, viewerId);

    if (!projectedMessage) {
      return [];
    }

    return buildReadReport(projectedMessage, this.users);
  }

  confirmRead(messageId: string, input: ConfirmMessageReadInput) {
    const messageIndex = this.messages.findIndex((candidate) => candidate.id === messageId);

    if (messageIndex < 0) {
      throw new NotFoundException("Message not found.");
    }

    const message = this.messages[messageIndex]!;

    if (!message.deliveries.some((delivery) => delivery.recipientId === input.userId && !delivery.revokedAt)) {
      throw new BadRequestException("User is not a recipient of this message.");
    }

    const confirmedMessage = confirmMessageRead(message, input.userId);
    this.messages[messageIndex] = confirmedMessage;

    return confirmedMessage;
  }

  messageForViewer(messageId: string, viewerId: string) {
    const message = this.messages.find((candidate) => candidate.id === messageId);

    if (!message) {
      return undefined;
    }

    return projectMessageForViewer(message, demoRoom, this.roomMembers, viewerId);
  }
}
