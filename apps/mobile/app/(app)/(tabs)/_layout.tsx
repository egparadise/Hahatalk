import { Tabs } from "expo-router";
import { CalendarDays, MessageCircle, Radio, Settings } from "lucide-react-native";
import { colors } from "@/theme";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{
      headerShadowVisible: false,
      headerStyle: { backgroundColor: colors.surface },
      headerTitleStyle: { color: colors.ink, fontSize: 18, fontWeight: "700" },
      tabBarActiveTintColor: colors.teal,
      tabBarInactiveTintColor: colors.faint,
      tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line, height: 62, paddingBottom: 6, paddingTop: 5 }
    }}>
      <Tabs.Screen name="chats" options={{
        headerTitle: "대화",
        tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size} />,
        tabBarLabel: "대화"
      }} />
      <Tabs.Screen name="calendar" options={{
        headerTitle: "일정",
        tabBarIcon: ({ color, size }) => <CalendarDays color={color} size={size} />,
        tabBarLabel: "일정"
      }} />
      <Tabs.Screen name="live" options={{
        headerTitle: "라이브",
        tabBarIcon: ({ color, size }) => <Radio color={color} size={size} />,
        tabBarLabel: "라이브"
      }} />
      <Tabs.Screen name="settings" options={{
        headerTitle: "설정",
        tabBarIcon: ({ color, size }) => <Settings color={color} size={size} />,
        tabBarLabel: "설정"
      }} />
    </Tabs>
  );
}
