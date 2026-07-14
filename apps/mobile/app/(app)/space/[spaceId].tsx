import type {
  AudienceType,
  CallView,
  ConversationView,
  InitiateMediaUploadInput,
  Message,
  MessageDeleteResult,
  SendConversationMessageInput,
  ShareMediaAssetInput,
  TypingUpdate,
  User
} from "@hahatalk/contracts";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { randomUUID } from "expo-crypto";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import {
  BadgeCheck,
  Check,
  FileText,
  ImagePlus,
  Paperclip,
  Phone,
  Send,
  Smile,
  Video
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { io } from "socket.io-client";
import { CharacterAvatar, ErrorBanner, IconButton, LoadingView, OfflineBanner } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useConnectivity } from "@/providers/connectivity-provider";
import { colors, radii, spacing, typography } from "@/theme";

type SendResponse = { message: Message; replay: boolean };
const workEmojis = ["👍", "✅", "🙏", "🎉", "❓", "😢"];

function upsertMessage(messages: Message[], incoming: Message) {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index < 0) return [...messages, incoming].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return messages.map((message) => message.id === incoming.id ? incoming : message);
}

function initialAudience(view: ConversationView, currentUserId: string): { type: AudienceType; targets: string[] } {
  const others = view.users.filter((user) => user.id !== currentUserId).map((user) => user.id);
  if (!view.room.canSelectAudience) return { targets: others.slice(0, 1), type: "private" };
  if (view.room.mode === "hub_owner") return { targets: [], type: "selected" };
  if (view.room.mode === "direct") return { targets: others.slice(0, 1), type: "private" };
  return { targets: [], type: "all" };
}

function audienceText(type: AudienceType, targets: string[], users: User[]) {
  if (type === "all") return "전체 공개";
  const names = targets.map((id) => users.find((user) => user.id === id)?.displayName).filter(Boolean);
  if (type === "private") return names[0] ? `${names[0]}님과 1:1` : "1:1 대상 선택";
  return names.length ? `${names.length}명 선택` : "대상 선택";
}

function messageAudienceLabel(message: Message) {
  const audience = message.audiences[0];
  if (!audience || audience.audienceType === "all") return "전체";
  if (audience.audienceType === "role") return audience.targetRole ?? "역할";
  return audience.audienceType === "private" ? "1:1" : "선택";
}

function MessageBubble({ message, currentUserId, users, onAttachment, onConfirm }: {
  message: Message;
  currentUserId: string;
  users: User[];
  onAttachment: (assetId: string) => void;
  onConfirm: (messageId: string) => void;
}) {
  const mine = message.senderId === currentUserId;
  const sender = users.find((user) => user.id === message.senderId);
  const ownDelivery = message.deliveries.find((delivery) => delivery.recipientId === currentUserId);
  const otherDeliveries = message.deliveries.filter((delivery) => delivery.recipientId !== currentUserId);
  const unread = otherDeliveries.filter((delivery) => !delivery.readAt).length;
  const needsConfirmation = Boolean(message.metadata.requiresConfirmation) && !mine && !ownDelivery?.confirmedAt;
  return (
    <View style={[styles.messageRow, mine && styles.messageRowMine]}>
      {!mine ? <CharacterAvatar accent={sender?.character.accent ?? colors.teal} name={sender?.displayName ?? "?"} size={30} /> : null}
      <View style={[styles.messageGroup, mine && styles.messageGroupMine]}>
        {!mine ? <Text style={styles.senderName}>{sender?.displayName ?? "알 수 없음"}</Text> : null}
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
          <View style={styles.bubbleAudience}>
            <Text style={[styles.audienceMini, mine && styles.audienceMiniMine]}>{messageAudienceLabel(message)}</Text>
            {message.metadata.requiresConfirmation ? <BadgeCheck color={mine ? colors.tealStrong : colors.amber} size={13} /> : null}
          </View>
          {message.body ? <Text style={styles.messageBody}>{message.body}</Text> : null}
          {message.attachments.map((attachment) => (
            <Pressable
              accessibilityLabel={`${attachment.fileName} 열기`}
              accessibilityRole="button"
              key={attachment.id}
              onPress={() => onAttachment(attachment.assetId)}
              style={styles.attachment}
            >
              {attachment.mediaKind === "image" ? <ImagePlus color={colors.blue} size={18} /> : <FileText color={colors.amber} size={18} />}
              <View style={styles.attachmentCopy}>
                <Text style={styles.attachmentName} numberOfLines={1}>{attachment.fileName}</Text>
                <Text style={styles.attachmentMeta}>{Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB</Text>
              </View>
            </Pressable>
          ))}
          {needsConfirmation ? (
            <Pressable accessibilityRole="button" onPress={() => onConfirm(message.id)} style={styles.confirmButton}>
              <Check color={colors.teal} size={15} /><Text style={styles.confirmText}>확인했습니다</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={[styles.messageMetaRow, mine && styles.messageMetaRowMine]}>
          {mine && unread > 0 ? <Text style={styles.unread}>{unread}</Text> : null}
          {mine && otherDeliveries.length > 0 && unread === 0 ? <Text style={styles.read}>읽음</Text> : null}
          <Text style={styles.messageTime}>{new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt))}</Text>
        </View>
      </View>
    </View>
  );
}

export default function SpaceScreen() {
  const { spaceId } = useLocalSearchParams<{ spaceId: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const { session } = useAuth();
  const { connected, pendingCount, sendMessage } = useConnectivity();
  const listRef = useRef<FlatList<Message>>(null);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTargets = useRef<string[]>([]);
  const [view, setView] = useState<ConversationView | null>(null);
  const [body, setBody] = useState("");
  const [audienceType, setAudienceType] = useState<AudienceType>("all");
  const [targets, setTargets] = useState<string[]>([]);
  const [requiresConfirmation, setRequiresConfirmation] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [typingUsers, setTypingUsers] = useState<TypingUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentUserId = session?.session.user.id ?? "";

  const load = useCallback(async () => {
    if (!spaceId) return;
    try {
      const next = await mobileApi.request<ConversationView>(`/spaces/${spaceId}/view?limit=60`);
      setView(next);
      const initial = initialAudience(next, currentUserId);
      setAudienceType(initial.type);
      setTargets(initial.targets);
      navigation.setOptions({ title: next.room.title });
      const latestUnread = [...next.messages].reverse().find((message) => message.senderId !== currentUserId);
      if (latestUnread) void mobileApi.request(`/messages/${latestUnread.id}/read`, { body: {}, method: "POST" }).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "대화를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [currentUserId, navigation, spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!spaceId || !session) return;
    const socket = io(mobileApi.baseUrl(), {
      auth: { accessToken: session.accessToken },
      transports: ["websocket"]
    });
    socketRef.current = socket;
    socket.on("connect", () => socket.emit("room:join", { spaceId }));
    const applyMessage = (message: Message) => {
      if (message.roomId !== spaceId) return;
      setView((current) => current ? { ...current, messages: upsertMessage(current.messages, message) } : current);
      if (message.senderId !== currentUserId) {
        void mobileApi.request(`/messages/${message.id}/read`, { body: {}, method: "POST" }).catch(() => undefined);
      }
    };
    socket.on("message:created", applyMessage);
    socket.on("message:updated", applyMessage);
    socket.on("message:delivery-updated", applyMessage);
    socket.on("message:deleted", (deleted: MessageDeleteResult) => {
      setView((current) => current ? { ...current, messages: current.messages.filter((message) => message.id !== deleted.id) } : current);
    });
    socket.on("typing:updated", (update: TypingUpdate) => {
      if (update.spaceId !== spaceId || update.userId === currentUserId) return;
      setTypingUsers((current) => update.active
        ? [...current.filter((item) => item.userId !== update.userId), update]
        : current.filter((item) => item.userId !== update.userId));
    });
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      socket.emit("typing:set", { active: false, spaceId, targetUserIds: typingTargets.current });
      socketRef.current = null;
      socket.disconnect();
    };
  }, [currentUserId, session, spaceId]);

  const others = useMemo(() => view?.users.filter((user) => user.id !== currentUserId) ?? [], [currentUserId, view]);
  const audienceValid = audienceType === "all" || targets.length > 0;

  function chooseAudience(type: AudienceType) {
    setAudienceType(type);
    if (type === "all") setTargets([]);
    if (type === "private") setTargets((current) => current.length ? current.slice(0, 1) : others.slice(0, 1).map((user) => user.id));
  }

  function toggleTarget(userId: string) {
    setTargets((current) => {
      if (audienceType === "private") return [userId];
      return current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId];
    });
  }

  async function submit() {
    const text = body.trim();
    if (!text || !spaceId || !audienceValid || sending) return;
    const input: SendConversationMessageInput = {
      audienceType,
      body: text,
      clientMessageId: `mobile-${randomUUID()}`,
      requiresConfirmation,
      spaceId,
      targetUserIds: targets
    };
    setSending(true);
    setError(null);
    try {
      const result = await sendMessage(input);
      setBody("");
      if (typingTimer.current) clearTimeout(typingTimer.current);
      socketRef.current?.emit("typing:set", { active: false, spaceId, targetUserIds: typingTargets.current });
      setRequiresConfirmation(false);
      setShowEmoji(false);
      if (!result.queued) {
        const response = result.response as SendResponse;
        setView((current) => current ? { ...current, messages: upsertMessage(current.messages, response.message) } : current);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "메시지를 보내지 못했습니다.");
    } finally {
      setSending(false);
    }
  }

  function onChangeBody(value: string) {
    setBody(value);
    if (!view || !session || !socketRef.current) return;
    const targetUserIds = audienceType === "all" ? others.map((user) => user.id) : targets;
    typingTargets.current = targetUserIds;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    socketRef.current.emit("typing:set", { active: Boolean(value), spaceId, targetUserIds });
    typingTimer.current = setTimeout(() => {
      socketRef.current?.emit("typing:set", { active: false, spaceId, targetUserIds });
      typingTimer.current = null;
    }, 900);
  }

  async function startCall(callType: "voice" | "video") {
    if (!spaceId) return;
    const targetUserIds = targets.length ? targets : others.map((user) => user.id);
    if (!targetUserIds.length) return;
    setError(null);
    try {
      const call = await mobileApi.request<CallView>("/calls", {
        body: { callType, clientCallId: `mobile-call-${randomUUID()}`, spaceId, targetUserIds },
        method: "POST"
      });
      router.push({ pathname: "/(app)/call/[callId]", params: { callId: call.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "통화를 시작하지 못했습니다.");
    }
  }

  async function sharePickedFile(file: File, fileName: string, mimeType: string) {
    if (!spaceId || !audienceValid) return;
    setSending(true);
    setError(null);
    try {
      const uploadInput: InitiateMediaUploadInput = {
        clientUploadId: `mobile-upload-${randomUUID()}`,
        declaredMimeType: mimeType || "application/octet-stream",
        fileName,
        sizeBytes: file.size,
        source: "file_upload"
      };
      const upload = await mobileApi.uploadFile(file, uploadInput);
      if (!upload.asset) throw new Error("업로드한 파일 정보를 확인하지 못했습니다.");
      const shareInput: ShareMediaAssetInput = {
        archiveScope: audienceType === "all" ? "shared" : "selected",
        audienceType,
        clientMessageId: `mobile-media-${randomUUID()}`,
        spaceId,
        targetUserIds: targets
      };
      const response = await mobileApi.shareAsset(upload.asset.id, shareInput) as SendResponse;
      setView((current) => current ? { ...current, messages: upsertMessage(current.messages, response.message) } : current);
      setShowAttach(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "파일을 공유하지 못했습니다.");
    } finally {
      setSending(false);
    }
  }

  async function pickPhoto() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.9 });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    const file = new File(asset.uri);
    await sharePickedFile(file, asset.fileName ?? `photo-${Date.now()}.jpg`, asset.mimeType ?? "image/jpeg");
  }

  async function pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    await sharePickedFile(new File(asset.uri), asset.name, asset.mimeType ?? "application/octet-stream");
  }

  async function confirm(messageId: string) {
    try {
      const message = await mobileApi.request<Message>(`/messages/${messageId}/confirm`, { body: {}, method: "POST" });
      setView((current) => current ? { ...current, messages: upsertMessage(current.messages, message) } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "확인 상태를 저장하지 못했습니다.");
    }
  }

  if (loading || !view) return <LoadingView label="대화 불러오는 중" />;

  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}>
      {!connected ? <OfflineBanner pending={pendingCount} /> : null}
      {error ? <View style={styles.errorWrap}><ErrorBanner message={error} onPress={() => setError(null)} /></View> : null}

      <View style={styles.roomTools}>
        <Text style={styles.roomMode}>{view.room.mode === "hub_owner" ? "Smart Room" : view.room.mode === "group" ? "단체방" : "1:1 대화"}</Text>
        <View style={styles.callTools}>
          <IconButton icon={Phone} label="음성 통화" onPress={() => void startCall("voice")} />
          <IconButton icon={Video} label="영상 통화" onPress={() => void startCall("video")} />
        </View>
      </View>

      <FlatList
        contentContainerStyle={styles.messages}
        data={view.messages}
        keyExtractor={(message) => message.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ref={listRef}
        renderItem={({ item }) => (
          <MessageBubble
            currentUserId={currentUserId}
            message={item}
            onAttachment={(assetId) => router.push({ pathname: "/(app)/media/[assetId]", params: { assetId } })}
            onConfirm={(messageId) => void confirm(messageId)}
            users={view.users}
          />
        )}
        ListFooterComponent={typingUsers.length ? <Text style={styles.typing}>입력 중...</Text> : null}
      />

      <View style={styles.composerArea}>
        <View style={styles.audienceSummary}>
          <Text style={styles.audienceSummaryLabel}>받는 사람</Text>
          <Text style={styles.audienceSummaryValue}>{audienceText(audienceType, targets, view.users)}</Text>
        </View>

        {view.room.canSelectAudience ? (
          <View style={styles.segmented}>
            {(["all", "selected", "private"] as const).map((type) => (
              <Pressable
                accessibilityRole="button"
                key={type}
                onPress={() => chooseAudience(type)}
                style={[styles.segment, audienceType === type && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, audienceType === type && styles.segmentTextActive]}>
                  {type === "all" ? "전체" : type === "selected" ? "선택" : "1:1"}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {audienceType !== "all" ? (
          <ScrollView horizontal contentContainerStyle={styles.targets} showsHorizontalScrollIndicator={false}>
            {others.map((user) => {
              const selected = targets.includes(user.id);
              return (
                <Pressable key={user.id} onPress={() => toggleTarget(user.id)} style={[styles.target, selected && styles.targetSelected]}>
                  <Text style={[styles.targetText, selected && styles.targetTextSelected]}>{user.displayName}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {showEmoji ? (
          <View style={styles.emojiRow}>
            {workEmojis.map((emoji) => <Pressable key={emoji} onPress={() => setBody((value) => `${value}${emoji}`)} style={styles.emoji}><Text style={styles.emojiText}>{emoji}</Text></Pressable>)}
          </View>
        ) : null}

        {showAttach ? (
          <View style={styles.attachRow}>
            <Pressable onPress={() => void pickPhoto()} style={styles.attachAction}><ImagePlus color={colors.blue} size={21} /><Text style={styles.attachLabel}>사진·동영상</Text></Pressable>
            <Pressable onPress={() => void pickDocument()} style={styles.attachAction}><FileText color={colors.amber} size={21} /><Text style={styles.attachLabel}>파일</Text></Pressable>
          </View>
        ) : null}

        <View style={styles.composerRow}>
          <IconButton icon={Paperclip} label="파일 첨부" onPress={() => setShowAttach((value) => !value)} />
          <View style={styles.inputShell}>
            <TextInput
              maxLength={10_000}
              multiline
              onChangeText={onChangeBody}
              placeholder={audienceValid ? "메시지" : "받는 사람을 선택하세요"}
              placeholderTextColor={colors.faint}
              style={styles.input}
              value={body}
            />
            <Pressable accessibilityLabel="이모티콘" accessibilityRole="button" onPress={() => setShowEmoji((value) => !value)} style={styles.inlineButton}>
              <Smile color={colors.muted} size={19} />
            </Pressable>
          </View>
          <IconButton icon={Send} label="메시지 보내기" onPress={() => void submit()} tone={body.trim() && audienceValid ? "primary" : "default"} />
        </View>

        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: requiresConfirmation }} onPress={() => setRequiresConfirmation((value) => !value)} style={styles.confirmToggle}>
          <View style={[styles.checkbox, requiresConfirmation && styles.checkboxChecked]}>{requiresConfirmation ? <Check color={colors.inverse} size={13} /> : null}</View>
          <Text style={styles.confirmToggleText}>확인 요청</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  errorWrap: { padding: spacing.sm },
  roomTools: { alignItems: "center", backgroundColor: colors.surface, borderBottomColor: colors.line, borderBottomWidth: 1, flexDirection: "row", minHeight: 52, paddingHorizontal: spacing.md },
  roomMode: { color: colors.muted, flex: 1, fontSize: 12, fontWeight: "700" },
  callTools: { flexDirection: "row", gap: spacing.sm },
  messages: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.lg },
  messageRow: { alignItems: "flex-start", flexDirection: "row", gap: spacing.sm },
  messageRowMine: { justifyContent: "flex-end" },
  messageGroup: { alignItems: "flex-start", maxWidth: "82%" },
  messageGroupMine: { alignItems: "flex-end" },
  senderName: { color: colors.muted, fontSize: 11, marginBottom: 4 },
  bubble: { borderRadius: radii.md, gap: spacing.xs, maxWidth: "100%", paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleMine: { backgroundColor: colors.tealSoft, borderBottomRightRadius: radii.sm },
  bubbleOther: { backgroundColor: colors.surface, borderBottomLeftRadius: radii.sm, borderColor: colors.line, borderWidth: 1 },
  bubbleAudience: { alignItems: "center", flexDirection: "row", gap: 4 },
  audienceMini: { color: colors.muted, fontSize: 10, fontWeight: "700" },
  audienceMiniMine: { color: colors.tealStrong },
  messageBody: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  messageMetaRow: { alignItems: "center", flexDirection: "row", gap: 4, marginTop: 3 },
  messageMetaRowMine: { justifyContent: "flex-end" },
  messageTime: { color: colors.faint, fontSize: 10 },
  unread: { color: colors.amber, fontSize: 10, fontWeight: "700" },
  read: { color: colors.teal, fontSize: 10 },
  attachment: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.65)", borderRadius: radii.md, flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs, minWidth: 190, padding: spacing.sm },
  attachmentCopy: { flex: 1, minWidth: 0 },
  attachmentName: { color: colors.ink, fontSize: 12, fontWeight: "600" },
  attachmentMeta: { color: colors.faint, fontSize: 10 },
  confirmButton: { alignItems: "center", borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 5, justifyContent: "center", marginTop: spacing.xs, paddingTop: spacing.sm },
  confirmText: { color: colors.teal, fontSize: 12, fontWeight: "700" },
  typing: { color: colors.muted, fontSize: 11, marginLeft: spacing.xl },
  composerArea: { backgroundColor: colors.surface, borderTopColor: colors.line, borderTopWidth: 1, gap: spacing.sm, padding: spacing.sm },
  audienceSummary: { alignItems: "center", flexDirection: "row", gap: spacing.sm, minHeight: 24, paddingHorizontal: spacing.xs },
  audienceSummaryLabel: { color: colors.muted, fontSize: 11, fontWeight: "600" },
  audienceSummaryValue: { color: colors.tealStrong, flex: 1, fontSize: 12, fontWeight: "700" },
  segmented: { backgroundColor: colors.surfaceMuted, borderRadius: radii.md, flexDirection: "row", padding: 2 },
  segment: { alignItems: "center", borderRadius: 6, flex: 1, height: 32, justifyContent: "center" },
  segmentActive: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1 },
  segmentText: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  segmentTextActive: { color: colors.ink },
  targets: { gap: spacing.sm, paddingVertical: 2 },
  target: { backgroundColor: colors.surfaceMuted, borderColor: colors.line, borderRadius: radii.pill, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: 7 },
  targetSelected: { backgroundColor: colors.tealSoft, borderColor: colors.teal },
  targetText: { color: colors.muted, fontSize: 12 },
  targetTextSelected: { color: colors.tealStrong, fontWeight: "700" },
  emojiRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.xs },
  emoji: { alignItems: "center", backgroundColor: colors.surfaceMuted, borderRadius: radii.md, height: 36, justifyContent: "center", width: 36 },
  emojiText: { fontSize: 20 },
  attachRow: { flexDirection: "row", gap: spacing.sm },
  attachAction: { alignItems: "center", backgroundColor: colors.surfaceMuted, borderRadius: radii.md, flex: 1, flexDirection: "row", gap: spacing.sm, justifyContent: "center", minHeight: 44 },
  attachLabel: { color: colors.ink, fontSize: 12, fontWeight: "600" },
  composerRow: { alignItems: "flex-end", flexDirection: "row", gap: spacing.sm },
  inputShell: { alignItems: "flex-end", backgroundColor: colors.canvas, borderColor: colors.line, borderRadius: radii.md, borderWidth: 1, flex: 1, flexDirection: "row", minHeight: 40 },
  input: { color: colors.ink, flex: 1, fontSize: 15, lineHeight: 20, maxHeight: 104, minHeight: 40, paddingHorizontal: spacing.md, paddingVertical: 9 },
  inlineButton: { alignItems: "center", height: 40, justifyContent: "center", width: 40 },
  confirmToggle: { alignItems: "center", alignSelf: "flex-start", flexDirection: "row", gap: 6, paddingHorizontal: spacing.xs, paddingVertical: 2 },
  checkbox: { alignItems: "center", borderColor: colors.line, borderRadius: radii.sm, borderWidth: 1, height: 18, justifyContent: "center", width: 18 },
  checkboxChecked: { backgroundColor: colors.teal, borderColor: colors.teal },
  confirmToggleText: { color: colors.muted, fontSize: 11 }
});
