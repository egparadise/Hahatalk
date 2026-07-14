import { Image } from "expo-image";
import { Eye, EyeOff, LogIn } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ActionButton, ErrorBanner, Screen } from "@/components/ui";
import { useAuth } from "@/providers/auth-provider";
import { colors, radii, spacing, typography } from "@/theme";

export default function SignInScreen() {
  const { busy, clearError, error, signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  async function submit() {
    if (!email.trim() || !password) return;
    await signIn(email, password).catch(() => undefined);
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen scroll style={styles.screen}>
        <View style={styles.brand}>
          <Image source={require("../../assets/app-icon.png")} style={styles.logo} contentFit="cover" />
          <View>
            <Text style={styles.brandName}>HahaTalk</Text>
            <Text style={styles.brandCompany}>INVIZ</Text>
          </View>
        </View>

        <View style={styles.form}>
          <Text style={typography.title}>로그인</Text>
          {error ? <ErrorBanner message={error} onPress={clearError} /> : null}

          <View style={styles.field}>
            <Text style={styles.label}>이메일</Text>
            <TextInput
              autoCapitalize="none"
              autoComplete="email"
              editable={!busy}
              inputMode="email"
              onChangeText={setEmail}
              onSubmitEditing={() => undefined}
              placeholder="name@company.com"
              placeholderTextColor={colors.faint}
              style={styles.input}
              value={email}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>비밀번호</Text>
            <View style={styles.passwordRow}>
              <TextInput
                autoCapitalize="none"
                autoComplete="current-password"
                editable={!busy}
                onChangeText={setPassword}
                onSubmitEditing={() => void submit()}
                placeholder="비밀번호"
                placeholderTextColor={colors.faint}
                secureTextEntry={!showPassword}
                style={styles.passwordInput}
                value={password}
              />
              <Pressable
                accessibilityLabel={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setShowPassword((value) => !value)}
                style={styles.passwordToggle}
              >
                {showPassword ? <EyeOff color={colors.muted} size={19} /> : <Eye color={colors.muted} size={19} />}
              </Pressable>
            </View>
          </View>

          <ActionButton
            disabled={!email.trim() || !password}
            icon={LogIn}
            loading={busy}
            onPress={() => void submit()}
          >
            로그인
          </ActionButton>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { backgroundColor: colors.canvas, flex: 1 },
  screen: { justifyContent: "center", paddingHorizontal: spacing.xl },
  brand: { alignItems: "center", flexDirection: "row", gap: spacing.md, marginBottom: spacing.xxl },
  logo: { borderRadius: radii.md, height: 58, width: 58 },
  brandName: { color: colors.ink, fontSize: 25, fontWeight: "800" },
  brandCompany: { color: colors.teal, fontSize: 11, fontWeight: "800" },
  form: { gap: spacing.lg },
  field: { gap: spacing.sm },
  label: typography.label,
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    height: 48,
    paddingHorizontal: spacing.md
  },
  passwordRow: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: "row",
    height: 48
  },
  passwordInput: { color: colors.ink, flex: 1, fontSize: 15, height: "100%", paddingHorizontal: spacing.md },
  passwordToggle: { alignItems: "center", height: 46, justifyContent: "center", width: 46 }
});
