import { Stack } from "expo-router";
import { colors } from "@/theme";

export default function AppLayout() {
  return (
    <Stack screenOptions={{
      contentStyle: { backgroundColor: colors.canvas },
      headerBackButtonDisplayMode: "minimal",
      headerShadowVisible: false,
      headerStyle: { backgroundColor: colors.surface },
      headerTintColor: colors.ink,
      headerTitleStyle: { fontSize: 17, fontWeight: "700" }
    }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="space/[spaceId]" options={{ title: "대화" }} />
      <Stack.Screen name="call/[callId]" options={{ headerShown: false, presentation: "fullScreenModal" }} />
      <Stack.Screen name="meeting/[meetingId]" options={{ headerShown: false, presentation: "fullScreenModal" }} />
      <Stack.Screen name="broadcast/[sessionId]" options={{ headerShown: false, presentation: "fullScreenModal" }} />
      <Stack.Screen name="media/[assetId]" options={{ title: "파일 보기" }} />
    </Stack>
  );
}
