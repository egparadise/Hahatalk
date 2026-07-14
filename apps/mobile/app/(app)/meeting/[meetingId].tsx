import type { MeetingJoinView, MeetingView } from "@hahatalk/contracts";
import { useLocalSearchParams } from "expo-router";
import { DoorOpen, RefreshCw, Users } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { LiveSessionRoom } from "@/components/live-session-room";
import { ActionButton, EmptyState, ErrorBanner, LoadingView, Screen } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { colors, spacing, typography } from "@/theme";

export default function MeetingScreen() {
  const { meetingId } = useLocalSearchParams<{ meetingId: string }>();
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [join, setJoin] = useState<MeetingJoinView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const checking = useRef(false);

  const prepare = useCallback(async (enterLobby: boolean) => {
    if (!meetingId || checking.current) return;
    checking.current = true;
    setError(null);
    try {
      let current = await mobileApi.request<MeetingView>(`/meetings/${meetingId}`);
      if (enterLobby && current.canEnter) {
        current = await mobileApi.request<MeetingView>(`/meetings/${meetingId}/enter`, { body: {}, method: "POST" });
      }
      setMeeting(current);
      if (current.canJoin) {
        const joined = await mobileApi.request<MeetingJoinView>(`/meetings/${meetingId}/join`, { body: {}, method: "POST" });
        setMeeting(joined.meeting);
        setJoin(joined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "회의에 입장하지 못했습니다.");
    } finally {
      checking.current = false;
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    void prepare(true);
  }, [prepare]);

  useEffect(() => {
    if (join || !meeting || ["ended", "cancelled", "failed", "expired"].includes(meeting.status)) return;
    const interval = setInterval(() => void prepare(false), 2_500);
    return () => clearInterval(interval);
  }, [join, meeting, prepare]);

  async function openLobby() {
    if (!meeting) return;
    try {
      const opened = await mobileApi.request<MeetingView>(`/meetings/${meeting.id}/open`, {
        body: { version: meeting.version },
        method: "POST"
      });
      setMeeting(opened);
      await prepare(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "회의실을 열지 못했습니다.");
    }
  }

  if (loading) return <LoadingView label="회의실 확인 중" />;
  if (join && meeting) {
    return (
      <LiveSessionRoom
        callType={meeting.callType}
        onConnected={() => mobileApi.request(`/meetings/${meeting.id}/connected`, { body: {}, method: "POST" })}
        onLeave={() => mobileApi.request(`/meetings/${meeting.id}/leave`, { body: {}, method: "POST" })}
        serverUrl={join.serverUrl}
        title={meeting.title}
        token={join.token}
      />
    );
  }

  return (
    <Screen style={styles.screen}>
      {error ? <ErrorBanner message={error} /> : null}
      {meeting && !["ended", "cancelled", "failed", "expired"].includes(meeting.status) ? (
        <View style={styles.lobby}>
          <View style={styles.icon}><Users color={colors.teal} size={30} /></View>
          <Text style={typography.heading}>{meeting.title}</Text>
          <Text style={styles.status}>{meeting.myStatus === "waiting" ? "입장 승인 대기 중" : "회의 시작 대기 중"}</Text>
          {meeting.canOpen ? <ActionButton icon={DoorOpen} onPress={() => void openLobby()}>회의실 열기</ActionButton> : null}
          <ActionButton icon={RefreshCw} onPress={() => void prepare(false)} tone="secondary">새로고침</ActionButton>
        </View>
      ) : (
        <EmptyState icon={Users} title="회의가 종료되었습니다" body="이 회의에는 더 이상 입장할 수 없습니다." />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md },
  lobby: { alignItems: "center", flex: 1, gap: spacing.md, justifyContent: "center" },
  icon: { alignItems: "center", backgroundColor: colors.tealSoft, height: 58, justifyContent: "center", width: 58 },
  status: { ...typography.caption, marginBottom: spacing.sm }
});
