import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "HahaTalk",
  slug: "hahatalk",
  owner: "egparadise",
  version: "0.17.0",
  orientation: "portrait",
  icon: "./assets/app-icon.png",
  scheme: "hahatalk",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "kr.co.inviz.hahatalk",
    buildNumber: "17",
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: "HahaTalk video calls need camera access.",
      NSMicrophoneUsageDescription: "HahaTalk voice and video calls need microphone access.",
      NSPhotoLibraryUsageDescription: "HahaTalk needs access to the photos you choose to share.",
      UIBackgroundModes: ["audio", "remote-notification"]
    }
  },
  android: {
    package: "kr.co.inviz.hahatalk",
    versionCode: 17,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0F9F8F"
    },
    permissions: [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.POST_NOTIFICATIONS"
    ]
  },
  plugins: [
    "expo-router",
    [
      "expo-secure-store",
      {
        configureAndroidBackup: true,
        faceIDPermission: "Allow HahaTalk to protect your signed-in session."
      }
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/notification-icon.png",
        color: "#0F9F8F",
        defaultChannel: "messages"
      }
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "HahaTalk only accesses photos you choose to share.",
        cameraPermission: "HahaTalk uses the camera only when you choose to take a photo.",
        microphonePermission: "HahaTalk uses the microphone for voice and video calls."
      }
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: "#F5F7F8",
        image: "./assets/splash-icon.png",
        imageWidth: 176
      }
    ],
    [
      "expo-video",
      {
        supportsPictureInPicture: true
      }
    ],
    "expo-sqlite",
    "@livekit/react-native-expo-plugin"
  ],
  experiments: {
    typedRoutes: true
  },
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "https://talk.inviz.co.kr/api",
    eas: {
      projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? "00000000-0000-0000-0000-000000000000"
    }
  }
});
