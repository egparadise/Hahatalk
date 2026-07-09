import { describe, expect, it } from "vitest";
import {
  buildReadReport,
  createAuthSession,
  createMessageAudience,
  demoAiJobs,
  demoOrganization,
  demoMessages,
  demoRoom,
  demoRoomMembers,
  demoUsers,
  findCharacterPreset,
  getAudienceLabel,
  isValidEmail,
  isMessageVisibleTo
} from "./index";

describe("Smart Room contracts", () => {
  it("keeps selected messages hidden from non-target guests", () => {
    const selectedMessage = demoMessages.find((message) => message.id === "msg-003");

    expect(selectedMessage).toBeDefined();
    expect(isMessageVisibleTo(selectedMessage!, "user-mina", demoRoomMembers)).toBe(true);
    expect(isMessageVisibleTo(selectedMessage!, "guest-hana", demoRoomMembers)).toBe(false);
  });

  it("labels all, selected, and private audiences", () => {
    expect(getAudienceLabel(demoMessages[0]!, demoUsers)).toBe("전체");
    expect(getAudienceLabel(demoMessages[2]!, demoUsers)).toBe("2명 선택");

    const privateAudiences = createMessageAudience("msg-private", "private", "user-you", ["user-mina"]);
    const privateMessage = { ...demoMessages[0]!, id: "msg-private", audiences: privateAudiences };

    expect(getAudienceLabel(privateMessage, demoUsers)).toBe("김미나와 비공개");
  });

  it("builds read and unread rows for every room user", () => {
    const report = buildReadReport(demoMessages[0]!, demoUsers);

    expect(report).toHaveLength(4);
    expect(report.some((row) => row.state === "unread")).toBe(true);
    expect(report.some((row) => row.confirmedAt)).toBe(true);
  });

  it("validates onboarding email and character fallback", () => {
    expect(isValidEmail(" Manager@Inviz.CO.KR ")).toBe(true);
    expect(isValidEmail("manager")).toBe(false);
    expect(findCharacterPreset("missing-character").id).toBe("char-calm-lead");
  });

  it("creates role-aware auth sessions for work and guest users", () => {
    const memberSession = createAuthSession(demoUsers[0]!, "member", demoRoom.id, "2026-07-09T10:00:00+09:00");
    const guestSession = createAuthSession(demoUsers[3]!, "guest", demoRoom.id, "2026-07-09T10:00:00+09:00");

    expect(memberSession.permissions.canInviteGuests).toBe(true);
    expect(memberSession.expiresAt).toBe("2026-07-09T09:00:00.000Z");
    expect(guestSession.permissions.canDownloadFiles).toBe(false);
    expect(guestSession.permissions.canOpenReadReport).toBe(false);
  });

  it("keeps the MVP snapshot shape explicit", () => {
    const snapshot = {
      organization: demoOrganization,
      room: demoRoom,
      users: demoUsers,
      roomMembers: demoRoomMembers,
      messages: demoMessages,
      aiJobs: demoAiJobs,
      invites: []
    };

    expect(snapshot.messages.length).toBeGreaterThan(0);
    expect(snapshot.roomMembers.some((member) => member.role === "guest")).toBe(true);
    expect(snapshot.invites).toHaveLength(0);
  });
});
