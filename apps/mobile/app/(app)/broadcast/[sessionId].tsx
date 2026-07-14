import type { BroadcastJoinView, BroadcastSessionView } from "@hahatalk/contracts";
import { useLocalSearchParams } from "expo-router";
import { Play, Radio, RefreshCw } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { LiveSessionRoom } from "@/components/live-session-room";
import { ActionButton, EmptyState, ErrorBanner, LoadingView, Screen } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { colors, spacing, typography } from "@/theme";

export default function BroadcastScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const [broadcast, setBroadcast] = useState<BroadcastSessionView | null>(null);
  const [join, setJoin] = useState<BroadcastJoinView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const prepare = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    try {
      const current = await mobileApi.request<BroadcastSessionView>(`/broadcasts/sessions/${sessionId}`);
      setBroadcast(current);
      if (current.canJoin) {
        const joined = await mobileApi.request<BroadcastJoinView>(`/broadcasts/sessions/${sessionId}/join`, { body: {}, method: "POST" });
        setBroadcast(joined.broadcast);
        setJoin(joined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "방송에 입장하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  async function start() {
    if (!broadcast) return;
    try {
      await mobileApi.request(`/broadcasts/sessions/${broadcast.id}/start`, {
        body: { version: broadcast.version },
        method: "POST"
      });
      await prepare();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "방송을 시작하지 못했습니다.");
    }
  }

  if (loading) return <LoadingView label="방송 확인 중" />;
  if (join && broadcast) {
    return (
      <LiveSessionRoom
        callType={broadcast.callType}
        onConnected={() => mobileApi.request(`/broadcasts/sessions/${broadcast.id}/connected`, { body: {}, method: "POST" })}
        onLeave={() => mobileApi.request(`/broadcasts/sessions/${broadcast.id}/leave`, { body: {}, method: "POST" })}
        serverUrl={join.serverUrl}
        title={broadcast.title}
        token={join.token}
      />
    );
  }

  return (
    <Screen style={styles.screen}>
      {error ? <ErrorBanner message={error} /> : null}
      {broadcast && !["ended", "cancelled", "failed"].includes(broadcast.status) ? (
        <View style={styles.waiting}>
          <View style={styles.icon}><Radio color={colors.coral} size={31} /></View>
          <Text style={typography.heading}>{broadcast.title}</Text>
          <Text style={styles.status}>{broadcast.status === "scheduled" ? "방송 시작 전" : "연결 준비 중"}</Text>
          {broadcast.canStart ? <ActionButton icon={Play} onPress={() => void start()}>방송 시작</ActionButton> : null}
          <ActionButton icon={RefreshCw} onPress={() => void prepare()} tone="secondary">새로고침</ActionButton>
        </View>
      ) : (
        <EmptyState icon={Radio} title="방송이 종료되었습니다" body="재생 가능한 다시보기가 있으면 채널에 표시됩니다." />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md },
  waiting: { alignItems: "center", flex: 1, gap: spacing.md, justifyContent: "center" },
  icon: { alignItems: "center", backgroundColor: colors.coralSoft, height: 58, justifyContent: "center", width: 58 },
  status: { ...typography.caption, marginBottom: spacing.sm }
});
