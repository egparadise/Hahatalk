import "react-native-gesture-handler";
import { registerGlobals } from "@livekit/react-native";
import { type Href, Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { LoadingView } from "@/components/ui";
import { registerForPush, setupNotificationRouting } from "@/lib/notifications";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { ConnectivityProvider } from "@/providers/connectivity-provider";
import { colors } from "@/theme";

registerGlobals();
void SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { booting, installationId, session } = useAuth();
  const router = useRouter();
  const userId = session?.session.user.id;

  useEffect(() => {
    if (!booting) void SplashScreen.hideAsync();
  }, [booting]);

  useEffect(() => {
    if (!userId) return;
    return setupNotificationRouting((route) => router.push(route as Href));
  }, [router, userId]);

  useEffect(() => {
    if (userId && installationId) void registerForPush(installationId).catch(() => undefined);
  }, [installationId, userId]);

  if (booting) return <LoadingView label="보안 세션 확인 중" />;

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{
        contentStyle: { backgroundColor: colors.canvas },
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.ink,
        headerTitleStyle: { fontSize: 17, fontWeight: "700" }
      }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Protected guard={!session}>
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={Boolean(session)}>
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ConnectivityProvider>
        <RootNavigator />
      </ConnectivityProvider>
    </AuthProvider>
  );
}
