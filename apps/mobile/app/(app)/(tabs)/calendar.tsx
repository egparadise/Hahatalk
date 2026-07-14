import type { CalendarOccurrenceView, CalendarResponseStatus, CalendarWindowView } from "@hahatalk/contracts";
import { useFocusEffect } from "expo-router";
import { CalendarDays, Check, Clock3, HelpCircle, MapPin, X } from "lucide-react-native";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { EmptyState, ErrorBanner } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { colors, radii, spacing, typography } from "@/theme";

function windowPath() {
  const from = new Date();
  from.setDate(from.getDate() - 1);
  const to = new Date();
  to.setDate(to.getDate() + 45);
  return `/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

function dateLabel(event: CalendarOccurrenceView) {
  const start = new Date(event.occurrenceStartsAt);
  const end = new Date(event.occurrenceEndsAt);
  const day = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(start);
  if (event.allDay) return `${day} · 종일`;
  const format = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${format.format(start)} - ${format.format(end)}`;
}

const responseIcons: Record<Exclude<CalendarResponseStatus, "needs_action">, typeof Check> = {
  accepted: Check,
  declined: X,
  tentative: HelpCircle
};

export default function CalendarScreen() {
  const [events, setEvents] = useState<CalendarOccurrenceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [responding, setResponding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await mobileApi.request<CalendarWindowView>(windowPath());
      setEvents(result.occurrences);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "일정을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  async function respond(event: CalendarOccurrenceView, response: Exclude<CalendarResponseStatus, "needs_action">) {
    setResponding(event.id);
    try {
      await mobileApi.request(`/calendar/events/${event.id}/rsvp`, { body: { response }, method: "POST" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "응답을 저장하지 못했습니다.");
    } finally {
      setResponding(null);
    }
  }

  return (
    <View style={styles.page}>
      {error ? <View style={styles.banner}><ErrorBanner message={error} onPress={() => void load()} /></View> : null}
      <FlatList
        contentContainerStyle={events.length ? styles.list : styles.emptyList}
        data={events}
        keyExtractor={(item) => item.occurrenceKey}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setLoading(true); void load(); }} tintColor={colors.teal} />}
        renderItem={({ item }) => (
          <View style={[styles.event, item.status === "cancelled" && styles.cancelled]}>
            <View style={styles.eventHead}>
              <View style={styles.dateMarker}><Text style={styles.dateNumber}>{new Date(item.occurrenceStartsAt).getDate()}</Text></View>
              <View style={styles.eventCopy}>
                <Text style={styles.eventTitle} numberOfLines={2}>{item.title}</Text>
                <View style={styles.metaRow}><Clock3 color={colors.muted} size={14} /><Text style={styles.meta}>{dateLabel(item)}</Text></View>
                {item.location ? <View style={styles.metaRow}><MapPin color={colors.muted} size={14} /><Text style={styles.meta} numberOfLines={1}>{item.location}</Text></View> : null}
              </View>
            </View>
            {item.canRespond && item.status !== "cancelled" ? (
              <View style={styles.responses}>
                {(["accepted", "tentative", "declined"] as const).map((response) => {
                  const Icon = responseIcons[response];
                  const selected = item.myResponse === response;
                  return (
                    <Pressable
                      accessibilityLabel={response === "accepted" ? "참석" : response === "tentative" ? "미정" : "불참"}
                      accessibilityRole="button"
                      disabled={responding === item.id}
                      key={response}
                      onPress={() => void respond(item, response)}
                      style={[styles.response, selected && styles.responseSelected]}
                    >
                      <Icon color={selected ? colors.teal : colors.muted} size={16} />
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={!loading ? <EmptyState icon={CalendarDays} title="예정된 일정이 없습니다" body="새 일정이 등록되면 이곳에서 확인하고 응답할 수 있습니다." /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  banner: { padding: spacing.md },
  list: { backgroundColor: colors.surface, padding: spacing.lg },
  emptyList: { flexGrow: 1 },
  event: { gap: spacing.md, paddingVertical: spacing.lg },
  cancelled: { opacity: 0.5 },
  eventHead: { flexDirection: "row", gap: spacing.md },
  dateMarker: { alignItems: "center", backgroundColor: colors.tealSoft, borderRadius: radii.md, height: 42, justifyContent: "center", width: 42 },
  dateNumber: { color: colors.tealStrong, fontSize: 18, fontWeight: "800" },
  eventCopy: { flex: 1, gap: 5 },
  eventTitle: typography.heading,
  metaRow: { alignItems: "center", flexDirection: "row", gap: 6 },
  meta: { ...typography.caption, flex: 1 },
  responses: { flexDirection: "row", gap: spacing.sm, justifyContent: "flex-end" },
  response: { alignItems: "center", backgroundColor: colors.surfaceMuted, borderColor: colors.line, borderRadius: radii.md, borderWidth: 1, height: 34, justifyContent: "center", width: 42 },
  responseSelected: { backgroundColor: colors.tealSoft, borderColor: colors.teal },
  separator: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth }
});
