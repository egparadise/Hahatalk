"use client";

import {
  Ban,
  Check,
  FileAudio,
  Image as ImageIcon,
  LoaderCircle,
  Mic2,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Trash2,
  Volume2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AiCapabilityView, AiJob, MediaAssetView, VoiceProfileView, VoiceTranscriptView } from "@hahatalk/contracts";
import { resolveApiUrl } from "../lib/api-client";

type AiPanelProps = {
  activeAsset?: MediaAssetView;
  capabilities?: AiCapabilityView;
  isBusy: boolean;
  jobs: AiJob[];
  voiceProfiles: VoiceProfileView[];
  onCancel: (jobId: string) => Promise<void>;
  onCreateAvatar: (assetId: string) => Promise<void>;
  onCreateSummary: () => Promise<void>;
  onCreateTts: (text: string) => Promise<void>;
  onCreateVoiceProfile: (assetId: string) => Promise<void>;
  onEditTranscript: (transcriptId: string, text: string) => Promise<void>;
  onRejectTranscript: (transcriptId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onRevokeVoiceProfile: (profileId: string) => Promise<void>;
  onSendTranscript: (transcriptId: string) => Promise<void>;
  onVoiceFile: (file: File) => Promise<void>;
};

const jobLabels: Record<AiJob["jobType"], string> = {
  avatar_generation: "캐리커처",
  stt: "음성 받아쓰기",
  summary: "대화 요약",
  tts: "한국어 읽기",
  voice_profile_delete: "음성 정보 삭제",
  voice_profile_enrollment: "개인 음성 등록"
};

const statusLabels: Record<AiJob["status"], string> = {
  cancelled: "취소됨",
  failed: "실패",
  queued: "대기",
  running: "처리 중",
  succeeded: "완료"
};

export function AiPanel(props: AiPanelProps) {
  const [ttsText, setTtsText] = useState("");
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const activeWorkers = props.capabilities?.activeWorkers.length ?? 0;
  const selectedAudio = props.activeAsset?.mediaKind === "audio" ? props.activeAsset : undefined;
  const selectedImage = props.activeAsset?.mediaKind === "image" ? props.activeAsset : undefined;

  useEffect(() => () => {
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  async function toggleRecording() {
    const current = recorderRef.current;
    if (current?.state === "recording") {
      current.stop();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const candidates = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"];
    const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordingChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) recordingChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const outputType = recorder.mimeType || "audio/webm";
      const extension = outputType.includes("ogg") ? "ogg" : "webm";
      const blob = new Blob(recordingChunksRef.current, { type: outputType });
      recorder.stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setIsRecording(false);
      if (blob.size) {
        const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
        void props.onVoiceFile(new File([blob], `voice-${stamp}.${extension}`, { type: outputType }));
      }
    };
    recorderRef.current = recorder;
    recorder.start(500);
    setIsRecording(true);
  }

  return (
    <div className="ai-workbench">
      <section className="panel-section ai-capability-strip">
        <div>
          <span className="ai-eyebrow">AI WORKBENCH</span>
          <strong>{activeWorkers ? `작업자 ${activeWorkers}대 연결` : "작업자 대기"}</strong>
        </div>
        <span className="status-chip" data-state={activeWorkers ? "online" : "waiting"}>
          {props.capabilities?.redisDispatch === "configured" ? "Redis Stream" : "DB 복구 모드"}
        </span>
      </section>

      <section className="panel-section ai-command-section">
        <h2 className="panel-title"><Mic2 size={17} /> 음성을 글로</h2>
        <div className="ai-command-row">
          <button className="primary-button" disabled={props.isBusy} onClick={() => void toggleRecording()} type="button">
            {isRecording ? <Square size={16} /> : <Mic2 size={16} />}
            {isRecording ? "녹음 마치기" : "녹음 시작"}
          </button>
          <button className="icon-button" disabled={props.isBusy} onClick={() => audioInputRef.current?.click()} title="음성 파일 선택" type="button">
            <FileAudio size={18} />
          </button>
        </div>
        <input
          accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm,.m4a"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void props.onVoiceFile(file);
          }}
          ref={audioInputRef}
          type="file"
        />
        <p className="panel-muted">결과는 바로 전송되지 않고 수정 가능한 AI 초안으로 준비됩니다.</p>
      </section>

      <section className="panel-section ai-command-section">
        <div className="panel-title-row">
          <h2 className="panel-title"><Sparkles size={17} /> 현재 대화 정리</h2>
          <button className="icon-button" disabled={props.isBusy} onClick={() => void props.onCreateSummary()} title="대화 요약 만들기" type="button">
            <RefreshCw size={16} />
          </button>
        </div>
        <p className="panel-muted">내가 볼 수 있는 메시지만 고정해 요약, 결정사항, 할 일을 만듭니다.</p>
      </section>

      <section className="panel-section ai-command-section">
        <h2 className="panel-title"><Volume2 size={17} /> Sohee 한국어 읽기</h2>
        <textarea
          className="ai-tts-input"
          maxLength={4000}
          onChange={(event) => setTtsText(event.target.value)}
          placeholder="읽어 줄 문장을 입력하세요"
          value={ttsText}
        />
        <button
          className="secondary-button"
          disabled={props.isBusy || !ttsText.trim()}
          onClick={() => void props.onCreateTts(ttsText).then(() => setTtsText(""))}
          type="button"
        >
          <Play size={16} /> 음성 만들기
        </button>
      </section>

      <section className="panel-section ai-command-section">
        <h2 className="panel-title"><ImageIcon size={17} /> 캐리커처 아바타</h2>
        <p className="ai-source-label">{selectedImage ? selectedImage.fileName : "파일 패널에서 내 사진을 선택하세요."}</p>
        <button className="secondary-button" disabled={props.isBusy || !selectedImage} onClick={() => selectedImage && void props.onCreateAvatar(selectedImage.id)} type="button">
          <Sparkles size={16} /> 업무용 캐리커처 만들기
        </button>
      </section>

      <section className="panel-section ai-command-section">
        <h2 className="panel-title"><Volume2 size={17} /> 내 음성 프로필</h2>
        <p className="ai-source-label">{selectedAudio ? selectedAudio.fileName : "파일 패널에서 본인 음성을 선택하세요."}</p>
        <label className="ai-consent-line">
          <input checked={voiceConsent} onChange={(event) => setVoiceConsent(event.target.checked)} type="checkbox" />
          합성 표시·워터마크·즉시 철회 및 파생 정보 삭제 정책에 동의합니다.
        </label>
        <button
          className="secondary-button"
          disabled={props.isBusy || !selectedAudio || !voiceConsent}
          onClick={() => selectedAudio && void props.onCreateVoiceProfile(selectedAudio.id).then(() => setVoiceConsent(false))}
          type="button"
        >
          <Check size={16} /> 동의하고 등록
        </button>
        {props.voiceProfiles.map((profile) => (
          <div className="ai-profile-row" key={profile.id}>
            <span><strong>{profile.modelName}</strong><small>{voiceProfileStatus(profile.status)}</small></span>
            {!['deleted', 'deleting'].includes(profile.status) ? (
              <button className="icon-button" disabled={props.isBusy} onClick={() => void props.onRevokeVoiceProfile(profile.id)} title="동의 철회 및 삭제" type="button">
                <Trash2 size={16} />
              </button>
            ) : null}
          </div>
        ))}
      </section>

      <section className="panel-section ai-job-section">
        <div className="panel-title-row">
          <h2 className="panel-title"><Sparkles size={17} /> 작업 기록</h2>
          <span className="tiny">{props.jobs.length}건</span>
        </div>
        {props.jobs.length === 0 ? <p className="panel-muted">아직 AI 작업이 없습니다.</p> : props.jobs.map((job) => (
          <article className="ai-job-row" data-status={job.status} key={job.id}>
            <header>
              <span className="ai-job-icon">{job.jobType === "tts" ? <Volume2 size={17} /> : job.jobType === "stt" ? <Mic2 size={17} /> : <Sparkles size={17} />}</span>
              <span><strong>{jobLabels[job.jobType]}</strong><small>{job.model.name}</small></span>
              <span className="status-chip">{statusLabels[job.status]}</span>
            </header>
            {job.status === "running" ? <div className="ai-progress"><span style={{ width: `${job.progress}%` }} /></div> : null}
            {job.errorMessage ? <p className="ai-error">{job.errorMessage}</p> : null}
            {job.transcript?.reviewStatus === "ai_draft" ? (
              <TranscriptDraft
                disabled={props.isBusy}
                onEdit={props.onEditTranscript}
                onReject={props.onRejectTranscript}
                onSend={props.onSendTranscript}
                transcript={job.transcript}
              />
            ) : null}
            {job.jobType === "summary" && job.status === "succeeded" ? <SummaryResult result={job.resultJson} /> : null}
            {job.jobType === "tts" && job.status === "succeeded" && typeof job.resultJson?.mediaAssetId === "string" ? (
              <audio controls preload="none" src={resolveApiUrl(`/media/assets/${job.resultJson.mediaAssetId}/content?variant=original`)} />
            ) : null}
            {job.jobType === "avatar_generation" && job.status === "succeeded" && typeof job.resultJson?.mediaAssetId === "string" ? (
              <img className="ai-avatar-result" alt="AI가 만든 캐리커처" src={resolveApiUrl(`/media/assets/${job.resultJson.mediaAssetId}/content?variant=original`)} />
            ) : null}
            <footer>
              {job.status === "failed" ? <button className="mini-action" disabled={props.isBusy} onClick={() => void props.onRetry(job.id)} type="button"><RefreshCw size={13} /> 다시 시도</button> : null}
              {["queued", "running"].includes(job.status) ? <button className="mini-action" disabled={props.isBusy} onClick={() => void props.onCancel(job.id)} type="button"><Ban size={13} /> 취소</button> : null}
              <time>{formatDate(job.createdAt)}</time>
            </footer>
          </article>
        ))}
      </section>
    </div>
  );
}

function TranscriptDraft({
  disabled,
  onEdit,
  onReject,
  onSend,
  transcript
}: {
  disabled: boolean;
  onEdit: (transcriptId: string, text: string) => Promise<void>;
  onReject: (transcriptId: string) => Promise<void>;
  onSend: (transcriptId: string) => Promise<void>;
  transcript: VoiceTranscriptView;
}) {
  const [text, setText] = useState(transcript.editedText ?? transcript.draftText);
  useEffect(() => setText(transcript.editedText ?? transcript.draftText), [transcript.draftText, transcript.editedText]);
  return (
    <div className="ai-transcript-draft">
      <span>AI 초안 · 검토 후 전송</span>
      <textarea maxLength={10000} onChange={(event) => setText(event.target.value)} value={text} />
      <div>
        <button className="mini-action" disabled={disabled || !text.trim()} onClick={() => void onEdit(transcript.id, text)} type="button"><Check size={13} /> 초안 저장</button>
        <button className="mini-action primary" disabled={disabled || !text.trim()} onClick={() => void onEdit(transcript.id, text).then(() => onSend(transcript.id))} type="button"><Send size={13} /> 현재 대상으로 전송</button>
        <button className="icon-button" disabled={disabled} onClick={() => void onReject(transcript.id)} title="초안 폐기" type="button"><Trash2 size={14} /></button>
      </div>
    </div>
  );
}

function SummaryResult({ result }: { result: Record<string, unknown> | undefined }) {
  if (!result || typeof result.summary !== "string") return null;
  const decisions = Array.isArray(result.decisions) ? result.decisions.filter((value): value is string => typeof value === "string") : [];
  const tasks = Array.isArray(result.tasks) ? result.tasks.filter((value): value is { title: string } => Boolean(value) && typeof value === "object" && typeof (value as { title?: unknown }).title === "string") : [];
  return (
    <div className="ai-summary-result">
      <span>AI 요약 초안</span>
      <p>{result.summary}</p>
      {decisions.length ? <><strong>결정사항</strong><ul>{decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul></> : null}
      {tasks.length ? <><strong>할 일</strong><ul>{tasks.map((task) => <li key={task.title}>{task.title}</li>)}</ul></> : null}
    </div>
  );
}

function voiceProfileStatus(status: VoiceProfileView["status"]) {
  return ({ active: "사용 가능", deleted: "삭제 완료", deleting: "파생 정보 삭제 중", pending: "등록 대기", revoked: "철회됨" } as const)[status];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value));
}
