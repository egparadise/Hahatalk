import {
  LiveKitRoom,
  VideoTrack,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks
} from "@livekit/react-native";
import { useRouter } from "expo-router";
import { Camera, CameraOff, Mic, MicOff, PhoneOff, Radio } from "lucide-react-native";
import { useState } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { Track } from "livekit-client";
import { colors, radii, spacing, typography } from "../theme";

type LiveSessionRoomProps = {
  callType: "voice" | "video";
  serverUrl: string;
  title: string;
  token: string;
  onConnected: () => Promise<unknown>;
  onLeave: () => Promise<unknown>;
};

function RoomStage({ callType, title, onLeave }: Pick<LiveSessionRoomProps, "callType" | "title" | "onLeave">) {
  const router = useRouter();
  const room = useRoomContext();
  const connection = useConnectionState();
  const { isCameraEnabled, isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    try {
      await room.disconnect();
      await onLeave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "통화를 종료하지 못했습니다.");
    } finally {
      router.back();
    }
  }

  async function toggleMicrophone() {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "마이크를 바꾸지 못했습니다.");
    }
  }

  async function toggleCamera() {
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "카메라를 바꾸지 못했습니다.");
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <View style={styles.liveDot} />
        <View style={styles.headerCopy}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <Text style={styles.connection}>{connection === "connected" ? "연결됨" : "연결 중"}</Text>
        </View>
      </View>

      <View style={styles.stage}>
        {tracks.length ? (
          <View style={styles.trackGrid}>
            {tracks.map((track) => (
              <View key={track.publication.trackSid} style={[styles.trackCell, tracks.length === 1 && styles.trackCellSingle]}>
                <VideoTrack trackRef={track} style={styles.video} objectFit="cover" />
                <Text style={styles.participantName} numberOfLines={1}>{track.participant.name || track.participant.identity}</Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.audioStage}>
            <View style={styles.audioIcon}><Radio color={colors.teal} size={36} /></View>
            <Text style={typography.heading}>{connection === "connected" ? "음성 연결됨" : "미디어 연결 중"}</Text>
          </View>
        )}
      </View>

      {error ? <Text style={styles.error} numberOfLines={2}>{error}</Text> : null}
      <View style={styles.controls}>
        <Pressable accessibilityLabel={isMicrophoneEnabled ? "마이크 끄기" : "마이크 켜기"} accessibilityRole="button" onPress={() => void toggleMicrophone()} style={[styles.control, !isMicrophoneEnabled && styles.controlMuted]}>
          {isMicrophoneEnabled ? <Mic color={colors.inverse} size={22} /> : <MicOff color={colors.ink} size={22} />}
        </Pressable>
        {callType === "video" ? (
          <Pressable accessibilityLabel={isCameraEnabled ? "카메라 끄기" : "카메라 켜기"} accessibilityRole="button" onPress={() => void toggleCamera()} style={[styles.control, !isCameraEnabled && styles.controlMuted]}>
            {isCameraEnabled ? <Camera color={colors.inverse} size={22} /> : <CameraOff color={colors.ink} size={22} />}
          </Pressable>
        ) : null}
        <Pressable accessibilityLabel="통화 종료" accessibilityRole="button" disabled={leaving} onPress={() => void leave()} style={[styles.control, styles.controlEnd]}>
          <PhoneOff color={colors.inverse} size={23} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

export function LiveSessionRoom(props: LiveSessionRoomProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={styles.flex}>
      <LiveKitRoom
        audio
        connect
        onConnected={() => void props.onConnected().catch((cause) => setError(cause instanceof Error ? cause.message : "연결 상태를 저장하지 못했습니다."))}
        onError={(cause) => setError(cause.message)}
        options={{ adaptiveStream: true, dynacast: true }}
        serverUrl={props.serverUrl}
        token={props.token}
        video={props.callType === "video"}
      >
        <RoomStage callType={props.callType} onLeave={props.onLeave} title={props.title} />
      </LiveKitRoom>
      {error ? <View style={styles.connectionError}><Text style={styles.error}>{error}</Text></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { backgroundColor: colors.ink, flex: 1 },
  page: { backgroundColor: colors.ink, flex: 1 },
  header: { alignItems: "center", flexDirection: "row", gap: spacing.sm, minHeight: 58, paddingHorizontal: spacing.lg },
  liveDot: { backgroundColor: colors.coral, borderRadius: radii.pill, height: 8, width: 8 },
  headerCopy: { flex: 1 },
  title: { color: colors.inverse, fontSize: 16, fontWeight: "700" },
  connection: { color: "#AAB4B0", fontSize: 11 },
  stage: { flex: 1, padding: spacing.sm },
  trackGrid: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  trackCell: { backgroundColor: "#26332F", borderRadius: radii.md, height: "49%", overflow: "hidden", position: "relative", width: "48.5%" },
  trackCellSingle: { height: "100%", width: "100%" },
  video: { height: "100%", width: "100%" },
  participantName: { backgroundColor: colors.scrim, bottom: spacing.sm, color: colors.inverse, fontSize: 11, left: spacing.sm, maxWidth: "76%", paddingHorizontal: spacing.sm, paddingVertical: 4, position: "absolute" },
  audioStage: { alignItems: "center", flex: 1, gap: spacing.md, justifyContent: "center" },
  audioIcon: { alignItems: "center", backgroundColor: colors.tealSoft, borderRadius: radii.pill, height: 82, justifyContent: "center", width: 82 },
  controls: { alignItems: "center", flexDirection: "row", gap: spacing.lg, justifyContent: "center", minHeight: 86, paddingBottom: spacing.sm },
  control: { alignItems: "center", backgroundColor: colors.teal, borderRadius: radii.pill, height: 52, justifyContent: "center", width: 52 },
  controlMuted: { backgroundColor: colors.surfaceMuted },
  controlEnd: { backgroundColor: colors.coral, width: 62 },
  error: { color: "#FFB7AA", fontSize: 12, textAlign: "center" },
  connectionError: { backgroundColor: "#4A211C", left: spacing.md, padding: spacing.sm, position: "absolute", right: spacing.md, top: 64 }
});
