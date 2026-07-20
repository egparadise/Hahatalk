import type { MobileCapabilitiesView, MobileDeviceView } from "@hahatalk/contracts";
import { Bell, CheckCircle2, LogOut, RefreshCw, ShieldCheck, Smartphone, Wifi, WifiOff } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ActionButton, CharacterAvatar, ErrorBanner, Screen } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useConnectivity } from "@/providers/connectivity-provider";
import { colors, spacing, typography } from "@/theme";

export default function SettingsScreen() {
  const { busy, session, signOut } = useAuth();
  const { connected, failedCount, flushNow, pendingCount, retryFailed, syncing } = useConnectivity();
  const [capabilities, setCapabilities] = useState<MobileCapabilitiesView | null>(null);
  const [devices, setDevices] = useState<MobileDeviceView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [capabilityView, deviceRows] = await Promise.all([
        mobileApi.request<MobileCapabilitiesView>(`/mobile/capabilities?platform=${process.env.EXPO_OS === "ios" ? "ios" : "android"}`),
        mobileApi.request<MobileDeviceView[]>("/mobile/devices")
      ]);
      setCapabilities(capabilityView);
      setDevices(deviceRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "설정을 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const user = session?.session.user;
  return (
    <Screen scroll style={styles.screen}>
      {error ? <ErrorBanner message={error} onPress={() => void load()} /> : null}

      {user ? (
        <View style={styles.profile}>
          <CharacterAvatar accent={user.character.accent} name={user.displayName} size={54} />
          <View style={styles.profileCopy}>
            <Text style={typography.heading}>{user.displayName}</Text>
            <Text style={typography.caption}>{user.email}</Text>
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>동기화</Text>
        <View style={styles.settingRow}>
          {connected ? <Wifi color={colors.teal} size={20} /> : <WifiOff color={colors.amber} size={20} />}
          <View style={styles.settingCopy}>
            <Text style={styles.settingName}>{connected ? "온라인" : "오프라인"}</Text>
            <Text style={typography.caption}>대기 {pendingCount} · 확인 필요 {failedCount}</Text>
          </View>
          <ActionButton
            icon={RefreshCw}
            loading={syncing}
            onPress={() => void (failedCount ? retryFailed() : flushNow())}
            tone="secondary"
          >
            동기화
          </ActionButton>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>이 단말</Text>
        <View style={styles.settingRow}>
          <Smartphone color={colors.blue} size={20} />
          <View style={styles.settingCopy}>
            <Text style={styles.settingName}>{devices.find((device) => device.current)?.platform === "ios" ? "iPhone / iPad" : "Android"}</Text>
            <Text style={typography.caption}>{devices.find((device) => device.current)?.appVersion ?? "0.19.0"}</Text>
          </View>
          <CheckCircle2 color={colors.teal} size={20} />
        </View>
        <View style={styles.settingRow}>
          <Bell color={colors.amber} size={20} />
          <View style={styles.settingCopy}>
            <Text style={styles.settingName}>알림</Text>
            <Text style={typography.caption}>{capabilities?.push.registrationAvailable ? "등록 가능" : "서버 설정 대기"}</Text>
          </View>
        </View>
        <View style={styles.settingRow}>
          <ShieldCheck color={colors.teal} size={20} />
          <View style={styles.settingCopy}>
            <Text style={styles.settingName}>오프라인 저장</Text>
            <Text style={typography.caption}>AES-256-GCM · 최대 {capabilities?.offlineQueue.maxItems ?? 50}건</Text>
          </View>
        </View>
      </View>

      <ActionButton icon={LogOut} loading={busy} onPress={() => void signOut()} tone="danger">로그아웃</ActionButton>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { gap: spacing.xl, paddingBottom: spacing.xxl },
  profile: { alignItems: "center", flexDirection: "row", gap: spacing.md, paddingVertical: spacing.sm },
  profileCopy: { flex: 1, gap: 3 },
  section: { borderTopColor: colors.line, borderTopWidth: 1, gap: spacing.sm, paddingTop: spacing.lg },
  sectionTitle: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  settingRow: { alignItems: "center", flexDirection: "row", gap: spacing.md, minHeight: 54, paddingVertical: spacing.sm },
  settingCopy: { flex: 1, gap: 3 },
  settingName: { color: colors.ink, fontSize: 14, fontWeight: "600" }
});
