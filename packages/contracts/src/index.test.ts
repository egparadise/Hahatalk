import { describe, expect, it } from "vitest";
import {
  buildReadReport,
  confirmMessageRead,
  createAuthSession,
  createDemoStorageKey,
  createMessageAudience,
  createMessageDeliveryPlan,
  demoAiJobs,
  demoOrganization,
  demoMessages,
  demoRoom,
  demoRoomMembers,
  demoUsers,
  findCharacterPreset,
  getMessageTypeForMime,
  getAudienceLabel,
  getRoomPresentationForViewer,
  isValidEmail,
  isMessageVisibleTo,
  projectMessageForViewer,
  type MvpSnapshot,
  type Room
} from "./index";

describe("HahaTalk conversation contracts", () => {
  it("keeps selected hub messages hidden from non-target participants", () => {
    const selectedMessage = demoMessages.find((message) => message.id === "msg-003");

    expect(selectedMessage).toBeDefined();
    expect(isMessageVisibleTo(selectedMessage!, "user-mina", demoRoomMembers)).toBe(true);
    expect(isMessageVisibleTo(selectedMessage!, "guest-hana", demoRoomMembers)).toBe(false);
  });

  it("shows a hub participant only a direct conversation with the owner", () => {
    const presentation = getRoomPresentationForViewer(demoRoom, demoRoomMembers, demoUsers, "user-mina");

    expect(presentation.mode).toBe("direct");
    expect(presentation.title).toBe("이과장");
    expect(presentation.rosterVisible).toBe(false);
    expect(presentation.memberCount).toBeUndefined();
    expect(new Set(presentation.visibleMemberIds)).toEqual(new Set(["user-you", "user-mina"]));
  });

  it("keeps the full hub roster and audience controls in the owner console", () => {
    const presentation = getRoomPresentationForViewer(demoRoom, demoRoomMembers, demoUsers, "user-you");

    expect(presentation.mode).toBe("hub_owner");
    expect(presentation.rosterVisible).toBe(true);
    expect(presentation.canSelectAudience).toBe(true);
    expect(presentation.memberCount).toBe(4);
  });

  it("fans an owner announcement into isolated participant threads", () => {
    const plan = createMessageDeliveryPlan(
      demoRoom,
      demoRoomMembers,
      "msg-plan-owner",
      "user-you",
      "all",
      [],
      "2026-07-10T09:00:00+09:00"
    );

    expect(plan.deliveryMode).toBe("hub_announcement");
    expect(plan.deliveries).toHaveLength(4);
    expect(plan.deliveries.find((delivery) => delivery.recipientId === "user-mina")?.threadKey).toBe(
      "room-smart-sales:spoke:user-mina"
    );
    expect(plan.deliveries.find((delivery) => delivery.recipientId === "user-jun")?.threadKey).toBe(
      "room-smart-sales:spoke:user-jun"
    );
  });

  it("normalizes every hub participant reply to a private owner conversation", () => {
    const plan = createMessageDeliveryPlan(
      demoRoom,
      demoRoomMembers,
      "msg-plan-reply",
      "user-mina",
      "all",
      ["user-jun", "guest-hana"],
      "2026-07-10T09:01:00+09:00"
    );

    expect(plan.deliveryMode).toBe("direct");
    expect(plan.normalizedAudienceType).toBe("private");
    expect(plan.normalizedTargetUserIds).toEqual(["user-you"]);
    expect(plan.deliveries.map((delivery) => delivery.recipientId).sort()).toEqual(["user-mina", "user-you"]);
    expect(new Set(plan.deliveries.map((delivery) => delivery.threadKey))).toEqual(
      new Set(["room-smart-sales:spoke:user-mina"])
    );
  });

  it("sanitizes hub messages before returning them to a participant", () => {
    const announcement = demoMessages[0]!;
    const projected = projectMessageForViewer(announcement, demoRoom, demoRoomMembers, "user-mina");

    expect(projected).toBeDefined();
    expect(projected?.deliveryMode).toBe("hub_announcement");
    expect(projected?.deliveries).toHaveLength(1);
    expect(projected?.deliveries[0]?.recipientId).toBe("user-mina");
    expect(projected?.audiences).toEqual([expect.objectContaining({ audienceType: "all" })]);
    expect(projected?.audiences[0]).not.toHaveProperty("targetUserId");
  });

  it("labels all, selected, and private audiences", () => {
    expect(getAudienceLabel(demoMessages[0]!, demoUsers)).toBe("전체 공지");
    expect(getAudienceLabel(demoMessages[2]!, demoUsers)).toBe("1명 선택");

    const privateAudiences = createMessageAudience("msg-private", "private", "user-you", ["user-mina"]);
    const privateMessage = { ...demoMessages[0]!, id: "msg-private", deliveryMode: "direct" as const, audiences: privateAudiences };

    expect(getAudienceLabel(privateMessage, demoUsers)).toBe("김미나와 비공개");
  });

  it("builds read and unread rows only for actual deliveries", () => {
    const announcementReport = buildReadReport(demoMessages[0]!, demoUsers);
    const selectedReport = buildReadReport(demoMessages[2]!, demoUsers);

    expect(announcementReport).toHaveLength(4);
    expect(announcementReport.some((row) => row.state === "unread")).toBe(true);
    expect(announcementReport.some((row) => row.confirmedAt)).toBe(true);
    expect(selectedReport.map((row) => row.user.id).sort()).toEqual(["user-mina", "user-you"]);
  });

  it("validates onboarding email and character fallback", () => {
    expect(isValidEmail(" Manager@Inviz.CO.KR ")).toBe(true);
    expect(isValidEmail("manager")).toBe(false);
    expect(findCharacterPreset("missing-character").id).toBe("char-calm-lead");
  });

  it("creates role-aware auth sessions for work and guest users", () => {
    const memberSession = createAuthSession(demoUsers[0]!, "owner", demoRoom.id, "2026-07-09T10:00:00+09:00");
    const guestSession = createAuthSession(demoUsers[3]!, "guest", demoRoom.id, "2026-07-09T10:00:00+09:00");
    const hiddenHubAdminSession = createAuthSession(
      demoUsers[1]!,
      "admin",
      demoRoom.id,
      "2026-07-09T10:00:00+09:00",
      demoRoom
    );

    expect(memberSession.permissions.canInviteGuests).toBe(true);
    expect(memberSession.expiresAt).toBe("2026-07-09T09:00:00.000Z");
    expect(guestSession.permissions.canDownloadFiles).toBe(false);
    expect(guestSession.permissions.canOpenReadReport).toBe(false);
    expect(hiddenHubAdminSession.permissions.canInviteGuests).toBe(false);
    expect(hiddenHubAdminSession.permissions.canOpenReadReport).toBe(false);
    expect(hiddenHubAdminSession.permissions.canCreateBroadcast).toBe(false);
  });

  it("keeps the participant-safe MVP snapshot shape explicit", () => {
    const room = getRoomPresentationForViewer(demoRoom, demoRoomMembers, demoUsers, "user-you");
    const snapshot: MvpSnapshot = {
      organization: demoOrganization,
      room,
      users: demoUsers,
      roomMembers: demoRoomMembers,
      messages: demoMessages,
      aiJobs: demoAiJobs,
      invites: []
    };

    expect(snapshot.room.mode).toBe("hub_owner");
    expect(snapshot.messages.length).toBeGreaterThan(0);
    expect(snapshot.roomMembers.some((member) => member.role === "guest")).toBe(true);
    expect(snapshot.invites).toHaveLength(0);
  });

  it("maps attachment mime types and storage keys for metadata-only upload", () => {
    expect(getMessageTypeForMime("image/png")).toBe("image");
    expect(getMessageTypeForMime("video/mp4")).toBe("video");
    expect(getMessageTypeForMime("audio/ogg")).toBe("audio");
    expect(getMessageTypeForMime("application/pdf")).toBe("file");
    expect(createDemoStorageKey("Proposal V1.pdf", "2026-07-09T10:00:00+09:00")).toContain("proposal-v1.pdf");
  });

  it("confirms delivered messages without losing the original read time", () => {
    const confirmed = confirmMessageRead(demoMessages[0]!, "user-jun", "2026-07-09T10:05:00+09:00");
    const row = confirmed.deliveries.find((delivery) => delivery.recipientId === "user-jun");

    expect(row?.readAt).toBe("2026-07-09T10:03:45+09:00");
    expect(row?.confirmedAt).toBe("2026-07-09T10:05:00+09:00");

    const unreadConfirmed = confirmMessageRead(demoMessages[0]!, "guest-hana", "2026-07-09T10:06:00+09:00");
    const guestRow = unreadConfirmed.deliveries.find((delivery) => delivery.recipientId === "guest-hana");

    expect(guestRow?.readAt).toBe("2026-07-09T10:06:00+09:00");
    expect(guestRow?.confirmedAt).toBe("2026-07-09T10:06:00+09:00");
    expect(() => confirmMessageRead(demoMessages[2]!, "guest-hana")).toThrow("not a recipient");
  });

  it("keeps traditional group rooms shared and roster-visible", () => {
    const groupRoom: Room = {
      ...demoRoom,
      id: "room-open-group",
      type: "open_group",
      name: "공개 단체방",
      settings: { ...demoRoom.settings, rosterVisibility: "shared" }
    };
    const groupMembers = demoRoomMembers.map((member) => ({
      ...member,
      roomId: groupRoom.id,
      viewMode: "shared_room" as const
    }));
    const presentation = getRoomPresentationForViewer(groupRoom, groupMembers, demoUsers, "user-mina");
    const plan = createMessageDeliveryPlan(groupRoom, groupMembers, "msg-group", "user-mina", "all", []);

    expect(presentation.mode).toBe("group");
    expect(presentation.rosterVisible).toBe(true);
    expect(plan.deliveryMode).toBe("shared");
    expect(plan.deliveries).toHaveLength(4);
  });
});
