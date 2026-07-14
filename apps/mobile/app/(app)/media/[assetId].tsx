import type { MediaAssetView } from "@hahatalk/contracts";
import { Image } from "expo-image";
import { File, Paths } from "expo-file-system";
import { useLocalSearchParams, useNavigation } from "expo-router";
import * as Sharing from "expo-sharing";
import { VideoView, useVideoPlayer } from "expo-video";
import { Download, FileText, Share2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ActionButton, EmptyState, ErrorBanner, LoadingView, Screen } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { colors, spacing, typography } from "@/theme";

function VideoPreview({ uri, headers }: { uri: string; headers: Record<string, string> }) {
  const player = useVideoPlayer({ headers, uri }, (instance) => {
    instance.loop = false;
  });
  return <VideoView allowsPictureInPicture fullscreenOptions={{ enable: true }} nativeControls player={player} style={styles.video} />;
}

function safeFileName(value: string) {
  const sanitized = value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
  return sanitized || `hahatalk-${Date.now()}`;
}

export default function MediaScreen() {
  const { assetId } = useLocalSearchParams<{ assetId: string }>();
  const navigation = useNavigation();
  const { session } = useAuth();
  const [asset, setAsset] = useState<MediaAssetView | null>(null);
  const [uri, setUri] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessToken = session?.accessToken;
  const headers = useMemo(() => accessToken ? {
    Authorization: `Bearer ${accessToken}`,
    "X-HahaTalk-Client": "mobile-v1"
  } : { "X-HahaTalk-Client": "mobile-v1" }, [accessToken]);

  const load = useCallback(async () => {
    if (!assetId) return;
    setError(null);
    try {
      const next = await mobileApi.request<MediaAssetView>(`/media/assets/${assetId}`);
      setAsset(next);
      setUri(await mobileApi.contentUrl(assetId, next.previewStatus === "ready" ? "preview" : "original"));
      navigation.setOptions({ title: next.fileName });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "파일을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [assetId, navigation]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refresh = () => void mobileApi.ensureFreshAccess().catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [assetId]);

  async function openWithSystem() {
    if (!asset || !assetId || !asset.canDownload) return;
    setOpening(true);
    setError(null);
    try {
      await mobileApi.ensureFreshAccess();
      const destination = new File(Paths.cache, safeFileName(asset.fileName));
      const downloaded = await File.downloadFileAsync(
        `${mobileApi.baseUrl()}/media/assets/${assetId}/content?variant=original&download=1`,
        destination,
        { headers: mobileApi.authorizationHeaders(), idempotent: true }
      );
      if (!await Sharing.isAvailableAsync()) throw new Error("이 단말에서는 파일 열기를 사용할 수 없습니다.");
      await Sharing.shareAsync(downloaded.uri, { dialogTitle: asset.fileName, mimeType: asset.mimeType });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "파일을 열지 못했습니다.");
    } finally {
      setOpening(false);
    }
  }

  if (loading) return <LoadingView label="파일 준비 중" />;
  if (!asset || !uri) return <Screen><EmptyState icon={FileText} title="파일을 열 수 없습니다" body={error ?? "파일이 삭제되었거나 접근 권한이 없습니다."} /></Screen>;

  return (
    <Screen style={styles.screen}>
      {error ? <ErrorBanner message={error} onPress={() => setError(null)} /> : null}
      <View style={styles.preview}>
        {asset.mediaKind === "image" ? (
          <ScrollView contentContainerStyle={styles.imageScroll} maximumZoomScale={4} minimumZoomScale={1}>
            <Image contentFit="contain" source={{ headers, uri }} style={styles.image} />
          </ScrollView>
        ) : asset.mediaKind === "video" ? (
          <VideoPreview headers={headers} uri={uri} />
        ) : (
          <View style={styles.document}>
            <FileText color={asset.mediaKind === "pdf" ? colors.coral : colors.amber} size={44} />
            <Text style={typography.heading} numberOfLines={2}>{asset.fileName}</Text>
            <Text style={typography.caption}>{asset.mediaKind.toUpperCase()} · {Math.max(1, Math.round(asset.sizeBytes / 1024))} KB</Text>
          </View>
        )}
      </View>
      <View style={styles.meta}>
        <Text style={styles.metaName} numberOfLines={2}>{asset.fileName}</Text>
        <Text style={typography.caption}>{asset.mimeType}</Text>
        {asset.capturedAt ? <Text style={typography.caption}>{new Date(asset.capturedAt).toLocaleString("ko-KR")}</Text> : null}
        {asset.placeName ? <Text style={typography.caption}>{asset.placeName}</Text> : null}
      </View>
      {asset.canDownload ? <ActionButton icon={asset.mediaKind === "image" || asset.mediaKind === "video" ? Share2 : Download} loading={opening} onPress={() => void openWithSystem()}>다른 앱으로 열기</ActionButton> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, paddingBottom: spacing.xl },
  preview: { backgroundColor: colors.surfaceMuted, flex: 1, minHeight: 280, overflow: "hidden" },
  imageScroll: { flexGrow: 1 },
  image: { flex: 1, minHeight: 320, width: "100%" },
  video: { flex: 1, minHeight: 320, width: "100%" },
  document: { alignItems: "center", flex: 1, gap: spacing.md, justifyContent: "center", padding: spacing.xl },
  meta: { borderTopColor: colors.line, borderTopWidth: 1, gap: 4, paddingTop: spacing.md },
  metaName: { color: colors.ink, fontSize: 14, fontWeight: "700" }
});
