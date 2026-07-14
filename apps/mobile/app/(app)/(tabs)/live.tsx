import type { BroadcastChannelSummary, BroadcastDashboard } from "@hahatalk/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { Bell, BellOff, Radio, Users } from "lucide-react-native";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { CharacterAvatar, EmptyState, ErrorBanner } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { colors, radii, spacing, typography } from "@/theme";

function scheduleLabel(channel: BroadcastChannelSummary) {
  const session = channel.nextSession;
  if (!session) return "예정된 방송 없음";
  if (session.status === "live") return "지금 방송 중";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(session.scheduledFor));
}

export default function LiveScreen() {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<BroadcastDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDashboard(await mobileApi.request<BroadcastDashboard>("/broadcasts"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "방송 채널을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  async function toggleSubscription(channel: BroadcastChannelSummary) {
    try {
      if (channel.isSubscribed) {
        await mobileApi.request(`/broadcasts/channels/${channel.id}/subscription`, { method: "DELETE" });
      } else {
        await mobileApi.request(`/broadcasts/channels/${channel.id}/subscribe`, {
          body: { notificationLevel: "live_only" },
          method: "POST"
        });
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "구독 설정을 바꾸지 못했습니다.");
    }
  }

  const channels = dashboard?.channels ?? [];
  return (
    <View style={styles.page}>
      {error ? <View style={styles.banner}><ErrorBanner message={error} onPress={() => void load()} /></View> : null}
      <FlatList
        contentContainerStyle={channels.length ? styles.list : styles.emptyList}
        data={channels}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setLoading(true); void load(); }} tintColor={colors.teal} />}
        renderItem={({ item }) => {
          const live = item.nextSession?.status === "live";
          return (
            <Pressable
              accessibilityRole={item.nextSession ? "button" : "text"}
              disabled={!item.nextSession}
              onPress={() => item.nextSession && router.push({ pathname: "/(app)/broadcast/[sessionId]", params: { sessionId: item.nextSession.id } })}
              style={({ pressed }) => [styles.channel, pressed && styles.pressed]}
            >
              <CharacterAvatar accent={live ? colors.coral : colors.amber} name={item.name} size={48} />
              <View style={styles.channelCopy}>
                <View style={styles.channelTitleRow}>
                  <Text style={styles.channelTitle} numberOfLines={1}>{item.name}</Text>
                  {live ? <View style={styles.liveBadge}><Text style={styles.liveText}>LIVE</Text></View> : null}
                </View>
                <Text style={styles.schedule} numberOfLines={1}>{scheduleLabel(item)}</Text>
                <View style={styles.subscribers}><Users color={colors.faint} size={13} /><Text style={styles.subscriberText}>{item.subscriberCount}</Text></View>
              </View>
              {item.canSubscribe ? (
                <Pressable
                  accessibilityLabel={item.isSubscribed ? "구독 해제" : "방송 알림 구독"}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={(event) => { event.stopPropagation(); void toggleSubscription(item); }}
                  style={[styles.bell, item.isSubscribed && styles.bellActive]}
                >
                  {item.isSubscribed ? <Bell color={colors.teal} size={18} /> : <BellOff color={colors.muted} size={18} />}
                </Pressable>
              ) : null}
            </Pressable>
          );
        }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={!loading ? <EmptyState icon={Radio} title="방송 채널이 없습니다" body="조직에 공개된 채널이 생기면 이곳에 표시됩니다." /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  banner: { padding: spacing.md },
  list: { backgroundColor: colors.surface, paddingHorizontal: spacing.lg },
  emptyList: { flexGrow: 1 },
  channel: { alignItems: "center", flexDirection: "row", gap: spacing.md, minHeight: 82, paddingVertical: spacing.md },
  pressed: { opacity: 0.65 },
  channelCopy: { flex: 1, gap: 4 },
  channelTitleRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  channelTitle: { ...typography.body, flexShrink: 1, fontWeight: "700" },
  liveBadge: { backgroundColor: colors.coral, borderRadius: radii.sm, paddingHorizontal: 5, paddingVertical: 2 },
  liveText: { color: colors.inverse, fontSize: 9, fontWeight: "800" },
  schedule: typography.caption,
  subscribers: { alignItems: "center", flexDirection: "row", gap: 4 },
  subscriberText: { color: colors.faint, fontSize: 11 },
  bell: { alignItems: "center", backgroundColor: colors.surfaceMuted, borderRadius: radii.md, height: 38, justifyContent: "center", width: 38 },
  bellActive: { backgroundColor: colors.tealSoft },
  separator: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth, marginLeft: 60 }
});
