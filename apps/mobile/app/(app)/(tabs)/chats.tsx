import type { ConversationListItem } from "@hahatalk/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { ChevronRight, MessageCircle } from "lucide-react-native";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { CharacterAvatar, EmptyState, ErrorBanner, OfflineBanner } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { useConnectivity } from "@/providers/connectivity-provider";
import { colors, radii, spacing, typography } from "@/theme";

function timeLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" }).format(date);
}

function accentFor(item: ConversationListItem) {
  if (item.room.mode === "hub_owner") return colors.coral;
  if (item.room.mode === "group") return colors.blue;
  if (item.room.mode === "channel") return colors.amber;
  return colors.teal;
}

export default function ChatsScreen() {
  const router = useRouter();
  const { connected, pendingCount } = useConnectivity();
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await mobileApi.request<ConversationListItem[]>("/spaces"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "대화 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  return (
    <View style={styles.page}>
      {!connected ? <OfflineBanner pending={pendingCount} /> : null}
      {error ? <View style={styles.banner}><ErrorBanner message={error} onPress={() => void load()} /></View> : null}
      <FlatList
        contentContainerStyle={items.length ? styles.list : styles.emptyList}
        data={items}
        keyExtractor={(item) => item.room.roomId}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setLoading(true); void load(); }} tintColor={colors.teal} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityLabel={`${item.room.title} 대화 열기`}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/(app)/space/[spaceId]", params: { spaceId: item.room.roomId } })}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <CharacterAvatar accent={accentFor(item)} name={item.room.title} size={46} />
            <View style={styles.copy}>
              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1}>{item.room.title}</Text>
                <Text style={styles.time}>{timeLabel(item.lastMessageAt)}</Text>
              </View>
              <View style={styles.previewRow}>
                <Text style={styles.preview} numberOfLines={1}>{item.lastMessagePreview || "새 대화를 시작하세요"}</Text>
                {item.unreadCount > 0 ? (
                  <View style={styles.badge}><Text style={styles.badgeText}>{Math.min(item.unreadCount, 99)}</Text></View>
                ) : null}
              </View>
            </View>
            <ChevronRight color={colors.faint} size={18} />
          </Pressable>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={!loading ? (
          <EmptyState icon={MessageCircle} title="대화가 없습니다" body="초대받은 대화방이 이곳에 표시됩니다." />
        ) : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  banner: { padding: spacing.md },
  list: { backgroundColor: colors.surface, paddingHorizontal: spacing.lg },
  emptyList: { flexGrow: 1 },
  row: { alignItems: "center", flexDirection: "row", gap: spacing.md, minHeight: 76, paddingVertical: spacing.md },
  pressed: { opacity: 0.62 },
  copy: { flex: 1, gap: 5, minWidth: 0 },
  titleRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  title: { ...typography.body, flex: 1, fontWeight: "700" },
  time: { color: colors.faint, fontSize: 11 },
  previewRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  preview: { ...typography.caption, flex: 1 },
  badge: { alignItems: "center", backgroundColor: colors.coral, borderRadius: radii.pill, minWidth: 20, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { color: colors.inverse, fontSize: 11, fontWeight: "700" },
  separator: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth, marginLeft: 58 }
});
