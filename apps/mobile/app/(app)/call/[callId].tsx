import type { CallJoinView, CallView } from "@hahatalk/contracts";
import { useLocalSearchParams } from "expo-router";
import { Phone } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { LiveSessionRoom } from "@/components/live-session-room";
import { ActionButton, EmptyState, ErrorBanner, LoadingView, Screen } from "@/components/ui";
import { mobileApi } from "@/lib/api-client";

export default function CallScreen() {
  const { callId } = useLocalSearchParams<{ callId: string }>();
  const [join, setJoin] = useState<CallJoinView | null>(null);
  const [call, setCall] = useState<CallView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const prepare = useCallback(async () => {
    if (!callId) return;
    setLoading(true);
    setError(null);
    try {
      const current = await mobileApi.request<CallView>(`/calls/${callId}`);
      setCall(current);
      if (!current.canJoin && !["starting", "ringing", "active"].includes(current.status)) return;
      const joined = await mobileApi.request<CallJoinView>(`/calls/${callId}/join`, { body: {}, method: "POST" });
      setCall(joined.call);
      setJoin(joined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "통화에 연결하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  if (loading) return <LoadingView label="통화 연결 준비 중" />;
  if (error) return <Screen><ErrorBanner message={error} /><ActionButton icon={Phone} onPress={() => void prepare()}>다시 연결</ActionButton></Screen>;
  if (!join || !call) return <Screen><EmptyState icon={Phone} title="종료된 통화입니다" body="이 통화에는 더 이상 참여할 수 없습니다." /></Screen>;

  return (
    <LiveSessionRoom
      callType={call.callType}
      onConnected={() => mobileApi.request(`/calls/${call.id}/connected`, { body: {}, method: "POST" })}
      onLeave={() => mobileApi.request(`/calls/${call.id}/leave`, { body: {}, method: "POST" })}
      serverUrl={join.serverUrl}
      title={call.title}
      token={join.token}
    />
  );
}
