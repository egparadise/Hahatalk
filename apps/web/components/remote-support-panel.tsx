"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleStop,
  Keyboard,
  MonitorCog,
  MousePointerClick,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  CallView,
  RemoteSupportCapabilities,
  RemoteSupportCommandKind,
  RemoteSupportConsentDecision,
  RemoteSupportScope,
  RemoteSupportSessionView
} from "@hahatalk/contracts";
import type { DesktopRemoteSupportStatus } from "../lib/api-client";

type Transition = "pause" | "resume" | "revoke" | "emergency-stop" | "end";

export function RemoteSupportPanel({
  agentStatus,
  capabilities,
  currentCall,
  isBusy,
  isDesktop,
  onActivate,
  onCommand,
  onCreate,
  onDecision,
  onRefresh,
  onTransition,
  sessions
}: {
  agentStatus?: DesktopRemoteSupportStatus;
  capabilities?: RemoteSupportCapabilities;
  currentCall?: CallView;
  isBusy: boolean;
  isDesktop: boolean;
  onActivate: (sessionId: string) => void;
  onCommand: (sessionId: string, kind: RemoteSupportCommandKind, payload: Record<string, unknown>) => void;
  onCreate: (targetUserId: string, scopes: RemoteSupportScope[]) => void;
  onDecision: (sessionId: string, scope: RemoteSupportScope, decision: "granted" | "denied") => void;
  onRefresh: () => void;
  onTransition: (sessionId: string, transition: Transition) => void;
  sessions: RemoteSupportSessionView[];
}) {
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [requestControl, setRequestControl] = useState(true);
  const eligibleTargets = useMemo(() => (
    currentCall?.status === "active"
      ? currentCall.participants.filter((participant) => (
          !participant.isSelf
          && participant.status === "joined"
          && participant.screenShareStatus === "active"
        ))
      : []
  ), [currentCall]);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
    ?? sessions.find((session) => ["requested", "approved", "active", "paused"].includes(session.status))
    ?? sessions[0];
  const hasLiveSession = sessions.some((session) => ["requested", "approved", "active", "paused"].includes(session.status));

  useEffect(() => {
    if (!selectedTargetId || !eligibleTargets.some((target) => target.person.id === selectedTargetId)) {
      setSelectedTargetId(eligibleTargets[0]?.person.id ?? "");
    }
  }, [eligibleTargets, selectedTargetId]);

  useEffect(() => {
    if (!selectedSessionId && selectedSession) setSelectedSessionId(selectedSession.id);
  }, [selectedSession, selectedSessionId]);

  return (
    <div className="remote-support-workbench">
      <section className="panel-section remote-support-heading">
        <div>
          <span className="remote-support-eyebrow">ATTENDED SUPPORT</span>
          <h2 className="panel-title"><MonitorCog size={17} /> 원격 지원</h2>
        </div>
        <button className="icon-button" disabled={isBusy} onClick={onRefresh} title="원격 지원 새로고침" type="button">
          <RefreshCw size={17} />
        </button>
      </section>

      <section className="panel-section remote-support-safety" data-state={capabilities?.agent.nativeInputAvailable ? "signed" : "dry-run"}>
        <ShieldCheck size={18} />
        <div>
          <strong>{capabilities?.agent.nativeInputAvailable ? "서명된 입력 에이전트" : "안전 검증 모드"}</strong>
          <span>{capabilities?.agent.nativeInputAvailable ? "네이티브 입력 사용 가능" : "명령은 기록·검증되지만 실제 PC 입력은 발생하지 않음"}</span>
        </div>
        <span className="status-chip">{agentStatus?.state ?? "stopped"}</span>
      </section>

      {!hasLiveSession ? (
        <section className="panel-section remote-support-request">
          <h3 className="panel-title"><MousePointerClick size={16} /> 지원 요청</h3>
          <div className="remote-target-list">
            {eligibleTargets.map((participant) => (
              <button
                className="remote-target"
                data-active={selectedTargetId === participant.person.id}
                key={participant.person.id}
                onClick={() => setSelectedTargetId(participant.person.id)}
                type="button"
              >
                <img alt="" className="avatar" src={participant.person.character.thumbnailUrl} />
                <span><strong>{participant.person.displayName}</strong><small>화면 공유 중</small></span>
                {selectedTargetId === participant.person.id ? <Check size={16} /> : null}
              </button>
            ))}
          </div>
          {eligibleTargets.length === 0 ? <p className="panel-muted">2인 통화에서 상대 화면 공유가 활성화되어야 합니다.</p> : null}
          <label className="remote-scope-row">
            <input checked disabled type="checkbox" />
            <span><strong>화면 보기</strong><small>현재 통화에서 직접 공유한 화면만</small></span>
          </label>
          <label className="remote-scope-row">
            <input checked={requestControl} onChange={(event) => setRequestControl(event.target.checked)} type="checkbox" />
            <span><strong>키보드·마우스 제어</strong><small>별도 동의, 일시정지 및 즉시 중지 가능</small></span>
          </label>
          <button
            className="primary-button"
            disabled={isBusy || !selectedTargetId || !currentCall}
            onClick={() => onCreate(selectedTargetId, requestControl ? ["screen_view", "remote_control"] : ["screen_view"])}
            type="button"
          >
            지원 요청
          </button>
        </section>
      ) : null}

      {sessions.length > 1 ? (
        <div className="remote-session-tabs" role="tablist">
          {sessions.slice(0, 6).map((session) => (
            <button
              data-active={selectedSession?.id === session.id}
              key={session.id}
              onClick={() => setSelectedSessionId(session.id)}
              role="tab"
              type="button"
            >
              {session.target.displayName} · {statusLabel(session.status)}
            </button>
          ))}
        </div>
      ) : null}

      {selectedSession ? (
        <section className="panel-section remote-session-detail">
          <div className="remote-session-title">
            <div>
              <strong>{selectedSession.requester.displayName} → {selectedSession.target.displayName}</strong>
              <span>{formatTime(selectedSession.requestedAt)} · 세대 {selectedSession.controlEpoch}</span>
            </div>
            <span className="status-chip" data-state={selectedSession.status}>{statusLabel(selectedSession.status)}</span>
          </div>

          <div className="remote-consent-list">
            {selectedSession.consents.map((consent) => (
              <div className="remote-consent-row" key={consent.id}>
                <span>
                  <strong>{scopeLabel(consent.scope)}</strong>
                  <small>{decisionLabel(consent.decision)}</small>
                </span>
                {selectedSession.canRespond && consent.decision === "pending" ? (
                  <span className="remote-inline-actions">
                    <button
                      className="icon-button"
                      disabled={isBusy}
                      onClick={() => onDecision(selectedSession.id, consent.scope, "granted")}
                      title={`${scopeLabel(consent.scope)} 동의`}
                      type="button"
                    ><Check size={16} /></button>
                    <button
                      className="icon-button danger-action"
                      disabled={isBusy}
                      onClick={() => onDecision(selectedSession.id, consent.scope, "denied")}
                      title={`${scopeLabel(consent.scope)} 거절`}
                      type="button"
                    ><X size={16} /></button>
                  </span>
                ) : <ConsentState decision={consent.decision} />}
              </div>
            ))}
          </div>

          <div className="remote-session-actions">
            {selectedSession.canActivateAgent ? (
              <button className="secondary-button" disabled={isBusy || !isDesktop} onClick={() => onActivate(selectedSession.id)} type="button">
                <Play size={16} /> 에이전트 시작
              </button>
            ) : null}
            {selectedSession.canPause ? (
              <button className="secondary-button" disabled={isBusy} onClick={() => onTransition(selectedSession.id, "pause")} type="button">
                <Pause size={16} /> 일시정지
              </button>
            ) : null}
            {selectedSession.canResume ? (
              <button className="secondary-button" disabled={isBusy} onClick={() => onTransition(selectedSession.id, "resume")} type="button">
                <Play size={16} /> 다시 승인
              </button>
            ) : null}
            {selectedSession.isTarget && ["requested", "approved", "active", "paused"].includes(selectedSession.status) ? (
              <button className="secondary-button danger-action" disabled={isBusy} onClick={() => onTransition(selectedSession.id, "emergency-stop")} type="button">
                <CircleStop size={16} /> 즉시 중지
              </button>
            ) : null}
            {selectedSession.canEnd ? (
              <button className="icon-button" disabled={isBusy} onClick={() => onTransition(selectedSession.id, "end")} title="지원 세션 종료" type="button">
                <X size={16} />
              </button>
            ) : null}
          </div>

          {selectedSession.canSendCommands ? (
            <RemoteControlPad
              disabled={isBusy}
              onCommand={(kind, payload) => onCommand(selectedSession.id, kind, payload)}
            />
          ) : null}

          {selectedSession.latestCommand ? (
            <div className="remote-command-result">
              <Keyboard size={15} />
              <span>#{selectedSession.latestCommand.sequence} {selectedSession.latestCommand.kind}</span>
              <strong>{selectedSession.latestCommand.status}</strong>
              {selectedSession.latestCommand.resultCode ? <small>{selectedSession.latestCommand.resultCode}</small> : null}
            </div>
          ) : null}

          {!isDesktop && selectedSession.canActivateAgent ? (
            <p className="remote-warning"><AlertTriangle size={15} /> 대상 PC의 HahaTalk Windows 앱에서 승인해야 합니다.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function RemoteControlPad({
  disabled,
  onCommand
}: {
  disabled: boolean;
  onCommand: (kind: RemoteSupportCommandKind, payload: Record<string, unknown>) => void;
}) {
  return (
    <div className="remote-control-pad">
      <div className="remote-pointer-grid" aria-label="원격 포인터 위치">
        <span />
        <button disabled={disabled} onClick={() => onCommand("pointer_move", { x: 0.5, y: 0.2 })} title="포인터 위로" type="button"><ArrowUp size={17} /></button>
        <span />
        <button disabled={disabled} onClick={() => onCommand("pointer_move", { x: 0.2, y: 0.5 })} title="포인터 왼쪽" type="button"><ArrowLeft size={17} /></button>
        <button disabled={disabled} onClick={() => onCommand("pointer_button", { action: "click", button: "left", x: 0.5, y: 0.5 })} title="가운데 클릭" type="button"><MousePointerClick size={17} /></button>
        <button disabled={disabled} onClick={() => onCommand("pointer_move", { x: 0.8, y: 0.5 })} title="포인터 오른쪽" type="button"><ArrowRight size={17} /></button>
        <button disabled={disabled} onClick={() => onCommand("wheel", { deltaX: 0, deltaY: -120 })} title="위로 스크롤" type="button"><ArrowUp size={17} /></button>
        <button disabled={disabled} onClick={() => onCommand("pointer_move", { x: 0.5, y: 0.8 })} title="포인터 아래로" type="button"><ArrowDown size={17} /></button>
        <button disabled={disabled} onClick={() => onCommand("wheel", { deltaX: 0, deltaY: 120 })} title="아래로 스크롤" type="button"><ArrowDown size={17} /></button>
      </div>
      <div className="remote-key-row">
        {[
          ["Tab", "Tab"],
          ["Enter", "Enter"],
          ["Esc", "Escape"]
        ].map(([label, code]) => (
          <button disabled={disabled} key={code} onClick={() => onCommand("key", { action: "press", code })} type="button">
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConsentState({ decision }: { decision: RemoteSupportConsentDecision }) {
  return decision === "granted"
    ? <Check className="remote-consent-icon" data-state="granted" size={17} />
    : <X className="remote-consent-icon" data-state={decision} size={17} />;
}

function scopeLabel(scope: RemoteSupportScope) {
  return {
    clipboard: "클립보드",
    file_transfer: "파일 전송",
    remote_control: "키보드·마우스 제어",
    screen_view: "화면 보기"
  }[scope];
}

function decisionLabel(decision: RemoteSupportConsentDecision) {
  return { denied: "거절됨", granted: "동의함", pending: "응답 대기", revoked: "철회됨" }[decision];
}

function statusLabel(status: RemoteSupportSessionView["status"]) {
  return {
    active: "연결됨",
    approved: "에이전트 대기",
    declined: "거절됨",
    ended: "종료됨",
    expired: "시간 만료",
    failed: "실패",
    paused: "일시정지",
    requested: "동의 대기",
    revoked: "중지됨"
  }[status];
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
