import { Redirect } from "expo-router";
import { useAuth } from "@/providers/auth-provider";

export default function Index() {
  const { session } = useAuth();
  return <Redirect href={session ? "/(app)/(tabs)/chats" : "/(auth)/sign-in"} />;
}
