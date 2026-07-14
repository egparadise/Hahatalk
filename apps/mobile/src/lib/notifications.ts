import type { MobileDeviceView, RegisterMobileDeviceInput } from "@hahatalk/contracts";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { mobileApi } from "./api-client";

const routePattern = /^\/(space|call|meeting|broadcast)\/[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const handledNotificationIds = new Set<string>();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true
  })
});

function safeRoute(value: unknown) {
  return typeof value === "string" && routePattern.test(value) ? value : null;
}

export function setupNotificationRouting(onRoute: (route: string) => void) {
  const handleResponse = (response: Notifications.NotificationResponse | null | undefined) => {
    const id = response?.notification.request.identifier;
    const route = safeRoute(response?.notification.request.content.data?.route);
    if (!id || !route || handledNotificationIds.has(id)) return;
    handledNotificationIds.add(id);
    if (handledNotificationIds.size > 32) handledNotificationIds.delete(handledNotificationIds.values().next().value!);
    onRoute(route);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    handleResponse(response);
  });
  void Notifications.getLastNotificationResponseAsync().then(handleResponse);
  return () => subscription.remove();
}

function projectId() {
  const configured = Constants.expoConfig?.extra?.eas?.projectId;
  const value = Constants.easConfig?.projectId ?? (typeof configured === "string" ? configured : undefined);
  return value && value !== "00000000-0000-0000-0000-000000000000" ? value : undefined;
}

export async function registerForPush(installationId: string): Promise<MobileDeviceView | null> {
  if (!Device.isDevice) return null;
  const easProjectId = projectId();
  if (!easProjectId) return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("messages", {
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      name: "HahaTalk messages",
      showBadge: true,
      sound: null,
      vibrationPattern: [0, 180]
    });
  }

  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted") permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted") return null;

  const token = await Notifications.getExpoPushTokenAsync({ projectId: easProjectId });
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const input: RegisterMobileDeviceInput = {
    appVersion: Application.nativeApplicationVersion ?? "0.17.0",
    capabilities: { calls: true, notifications: true },
    installationId,
    locale: resolved.locale || "ko-KR",
    osVersion: Device.osVersion ?? "unknown",
    platform: Platform.OS === "ios" ? "ios" : "android",
    pushProvider: "expo",
    pushToken: token.data,
    timezone: resolved.timeZone || "Asia/Seoul"
  };
  return mobileApi.request<MobileDeviceView>("/mobile/devices", {
    body: input as unknown as Record<string, unknown>,
    method: "POST"
  });
}
