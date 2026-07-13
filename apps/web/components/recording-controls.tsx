"use client";

import {
  Check,
  Circle,
  CircleStop,
  Clock3,
  Play,
  RotateCcw,
  ShieldAlert,
  X
} from "lucide-react";
import { useState } from "react";
import type { CallView, MeetingView, RecordingStatus, RecordingView } from "@hahatalk/contracts";
import { getJson, postJson } from "../lib/api-client";

type RecordingSessionView = CallView | MeetingView;

export function RecordingControls<T extends RecordingSessionView>({
  disabled,
  onUpdated,
  session,
  sessionPath
}: {
  disabled?: boolean;
  onUpdated: (session: T) => void;
  session: T;
  sessionPath: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recording = session.recording;
  const terminal = recording && ["consent_denied", "ready", "failed", "aborted"].includes(recording.status);

  async function run(path: string, payload: Record<string, string> = {}) {
    setBusy(true);
    setError("");
    try {
      await postJson<RecordingView>(`${sessionPath}/recording/${path}`, payload);
      onUpdated(await getJson<T>(sessionPath));
    } catch (nextError) {
      await getJson<T>(sessionPath).then(onUpdated).catch(() => undefined);
      setError(nextError instanceof Error ? nextError.message : "녹화 요청을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!recording && !session.canRequestRecording) return null;

  if (!recording) {
    return (
      <section className="recording-panel recording-panel-compact" aria-label="통화 녹화">
        <button
          className="recording-request-button"
          disabled={disabled || busy}
          onClick={() => void run("request")}
          type="button"
        >
          <Circle size={15} /> 녹화 요청
        </button>
        {error ? <span className="recording-error" role="alert">{error}</span> : null}
      </section>
    );
  }

  return (
    <section
      className="recording-panel"
      data-active={recording.status === "recording"}
      data-terminal={Boolean(terminal)}
      aria-label="녹화 동의 및 상태"
      aria-live="polite"
    >
      <header className="recording-panel-header">
        <span className="recording-state-icon">{recordingIcon(recording.status)}</span>
        <span>
          <strong>{recordingStatusLabel(recording.status)}</strong>
          <small>{recordingStatusDetail(recording)}</small>
        </span>
      </header>

      {!terminal ? (
        <div className="recording-consent-list">
          {recording.participants.map((participant) => (
            <div data-consent={participant.consentStatus} key={participant.person.id}>
              <img alt="" src={participant.person.character.thumbnailUrl} />
              <span>
                <strong>{participant.person.displayName}{participant.isSelf ? " (나)" : ""}</strong>
                <small>{consentStatusLabel(participant.consentStatus)}</small>
              </span>
              {participant.consentStatus === "granted" ? <Check size={15} />
                : participant.consentStatus === "denied" || participant.consentStatus === "revoked" ? <X size={15} />
                : <Clock3 size={14} />}
            </div>
          ))}
        </div>
      ) : null}

      <div className="recording-actions">
        {recording.canRespond ? (
          <>
            <button
              className="recording-action approve"
              disabled={disabled || busy}
              onClick={() => void run("consent", { decision: "granted", policyVersion: recording.policyVersion })}
              type="button"
            >
              <Check size={15} /> 동의
            </button>
            <button
              className="recording-action reject"
              disabled={disabled || busy}
              onClick={() => void run("consent", { decision: "denied", policyVersion: recording.policyVersion })}
              type="button"
            >
              <X size={15} /> 거부
            </button>
          </>
        ) : null}
        {recording.canStart ? (
          <button className="recording-action approve" disabled={disabled || busy} onClick={() => void run("start")} type="button">
            <Play size={15} /> 녹화 시작
          </button>
        ) : null}
        {recording.canStop ? (
          <button className="recording-action stop" disabled={disabled || busy} onClick={() => void run("stop", { reason: "host_stopped" })} type="button">
            <CircleStop size={15} /> 녹화 중지
          </button>
        ) : recording.canRevoke ? (
          <button className="recording-action reject" disabled={disabled || busy} onClick={() => void run("stop", { reason: "consent_revoked" })} type="button">
            <ShieldAlert size={15} /> 동의 철회
          </button>
        ) : null}
        {terminal && session.canRequestRecording ? (
          <button className="recording-action" disabled={disabled || busy} onClick={() => void run("request")} type="button">
            <RotateCcw size={15} /> 새 녹화 요청
          </button>
        ) : null}
      </div>
      {error ? <div className="recording-error" role="alert">{error}</div> : null}
    </section>
  );
}

function recordingIcon(status: RecordingStatus) {
  if (status === "recording") return <Circle fill="currentColor" size={14} />;
  if (["consent_denied", "failed", "aborted"].includes(status)) return <ShieldAlert size={16} />;
  if (status === "ready") return <Check size={16} />;
  if (["stopping", "processing"].includes(status)) return <Clock3 size={16} />;
  return <Circle size={15} />;
}

function recordingStatusLabel(status: RecordingStatus) {
  return {
    aborted: "녹화 요청 종료",
    consent_denied: "녹화 거부됨",
    consent_granted: "모두 동의함",
    consent_pending: "녹화 동의 요청",
    failed: "녹화 실패",
    processing: "녹화 파일 처리 중",
    ready: "녹화 완료",
    recording: "REC 녹화 중",
    starting: "녹화 시작 중",
    stopping: "녹화 중지 중"
  }[status];
}

function recordingStatusDetail(recording: RecordingView) {
  if (recording.status === "consent_pending") {
    const pending = recording.participants.filter((participant) => participant.consentStatus === "pending").length;
    return `${recording.requestedBy.displayName} 요청 · ${pending}명 응답 대기`;
  }
  if (recording.status === "recording") return "참여자는 언제든 동의를 철회할 수 있습니다.";
  if (recording.status === "ready") return "녹화 파일이 안전하게 저장되었습니다.";
  if (recording.status === "failed") return recording.failureCode ? `오류 코드: ${recording.failureCode}` : "녹화 상태를 확인해 주세요.";
  if (recording.status === "consent_denied") return "한 명 이상이 녹화에 동의하지 않았습니다.";
  if (recording.status === "aborted") return "녹화를 시작하지 않고 종료했습니다.";
  return "참여자 동의와 녹화 상태를 확인하고 있습니다.";
}

function consentStatusLabel(status: RecordingView["participants"][number]["consentStatus"]) {
  return {
    denied: "거부",
    granted: "동의",
    not_requested: "요청 전",
    pending: "응답 대기",
    revoked: "동의 철회"
  }[status];
}
