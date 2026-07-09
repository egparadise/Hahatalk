import { describe, expect, it } from "vitest";
import {
  buildReadReport,
  createMessageAudience,
  demoMessages,
  demoRoomMembers,
  demoUsers,
  getAudienceLabel,
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
});

