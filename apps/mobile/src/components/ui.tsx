import type { LucideIcon } from "lucide-react-native";
import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type ViewStyle
} from "react-native";
import { AlertCircle, WifiOff } from "lucide-react-native";
import { colors, radii, spacing, typography } from "../theme";

export function Screen({ children, scroll = false, style }: PropsWithChildren<{ scroll?: boolean; style?: ViewStyle }>) {
  const body = scroll
    ? <ScrollView contentContainerStyle={[styles.screenBody, style]} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    : <View style={[styles.screenBody, style]}>{children}</View>;
  return <SafeAreaView style={styles.safe}>{body}</SafeAreaView>;
}

export function LoadingView({ label = "불러오는 중" }: { label?: string }) {
  return (
    <View style={styles.center} accessibilityRole="progressbar">
      <ActivityIndicator color={colors.teal} size="small" />
      <Text style={typography.caption}>{label}</Text>
    </View>
  );
}

export function ErrorBanner({ message, onPress }: { message: string; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      onPress={onPress}
      style={styles.errorBanner}
    >
      <AlertCircle color={colors.coral} size={17} />
      <Text style={styles.errorText} numberOfLines={3}>{message}</Text>
    </Pressable>
  );
}

export function OfflineBanner({ pending = 0 }: { pending?: number }) {
  return (
    <View style={styles.offlineBanner}>
      <WifiOff color={colors.amber} size={16} />
      <Text style={styles.offlineText}>오프라인{pending ? ` · 전송 대기 ${pending}` : ""}</Text>
    </View>
  );
}

export function IconButton({
  icon: Icon,
  label,
  tone = "default",
  ...props
}: Omit<PressableProps, "children"> & {
  icon: LucideIcon;
  label: string;
  tone?: "default" | "primary" | "danger";
}) {
  const foreground = tone === "primary" ? colors.inverse : tone === "danger" ? colors.coral : colors.ink;
  return (
    <Pressable
      {...props}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={8}
      style={(state) => [
        styles.iconButton,
        tone === "primary" && styles.iconButtonPrimary,
        tone === "danger" && styles.iconButtonDanger,
        state.pressed && styles.pressed,
        typeof props.style === "function" ? props.style(state) : props.style
      ]}
    >
      <Icon color={foreground} size={20} strokeWidth={2} />
    </Pressable>
  );
}

export function ActionButton({
  children,
  icon: Icon,
  loading = false,
  tone = "primary",
  ...props
}: Omit<PressableProps, "children"> & {
  children: ReactNode;
  icon?: LucideIcon;
  loading?: boolean;
  tone?: "primary" | "secondary" | "danger";
}) {
  const foreground = tone === "primary" ? colors.inverse : tone === "danger" ? colors.coral : colors.ink;
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      disabled={props.disabled || loading}
      style={(state) => [
        styles.actionButton,
        tone === "primary" ? styles.actionPrimary : tone === "danger" ? styles.actionDanger : styles.actionSecondary,
        (props.disabled || loading) && styles.disabled,
        state.pressed && styles.pressed,
        typeof props.style === "function" ? props.style(state) : props.style
      ]}
    >
      {loading ? <ActivityIndicator color={foreground} size="small" /> : Icon ? <Icon color={foreground} size={18} /> : null}
      <Text style={[styles.actionText, { color: foreground }]} numberOfLines={1}>{children}</Text>
    </Pressable>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><Icon color={colors.teal} size={25} /></View>
      <Text style={typography.heading}>{title}</Text>
      <Text style={[typography.caption, styles.emptyBody]}>{body}</Text>
      {action}
    </View>
  );
}

export function CharacterAvatar({ name, accent = colors.teal, size = 42 }: { name: string; accent?: string; size?: number }) {
  return (
    <View style={[styles.avatar, { backgroundColor: accent, height: size, width: size }]}>
      <Text style={[styles.avatarText, { fontSize: Math.max(13, Math.floor(size * 0.38)) }]}>{name.trim().slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: colors.canvas, flex: 1 },
  screenBody: { flexGrow: 1, padding: spacing.lg },
  center: { alignItems: "center", flex: 1, gap: spacing.sm, justifyContent: "center" },
  errorBanner: {
    alignItems: "flex-start",
    backgroundColor: colors.coralSoft,
    borderColor: "#F0C2B8",
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md
  },
  errorText: { color: colors.coral, flex: 1, fontSize: 13, lineHeight: 18 },
  offlineBanner: {
    alignItems: "center",
    backgroundColor: colors.amberSoft,
    borderBottomColor: "#E9D5A7",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    minHeight: 32,
    paddingHorizontal: spacing.md
  },
  offlineText: { color: colors.amber, fontSize: 12, fontWeight: "600" },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  iconButtonPrimary: { backgroundColor: colors.teal, borderColor: colors.teal },
  iconButtonDanger: { backgroundColor: colors.coralSoft, borderColor: "#F0C2B8" },
  pressed: { opacity: 0.68 },
  disabled: { opacity: 0.45 },
  actionButton: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    height: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.lg
  },
  actionPrimary: { backgroundColor: colors.teal, borderColor: colors.teal },
  actionSecondary: { backgroundColor: colors.surface, borderColor: colors.line },
  actionDanger: { backgroundColor: colors.coralSoft, borderColor: "#F0C2B8" },
  actionText: { fontSize: 14, fontWeight: "700" },
  empty: { alignItems: "center", flex: 1, gap: spacing.sm, justifyContent: "center", padding: spacing.xl },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: colors.tealSoft,
    borderRadius: radii.md,
    height: 48,
    justifyContent: "center",
    marginBottom: spacing.xs,
    width: 48
  },
  emptyBody: { maxWidth: 280, textAlign: "center" },
  avatar: { alignItems: "center", borderRadius: radii.md, justifyContent: "center" },
  avatarText: { color: colors.inverse, fontWeight: "800" }
});
