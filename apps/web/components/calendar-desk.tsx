"use client";

import {
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Edit3,
  FolderOpen,
  LoaderCircle,
  LogOut,
  MapPin,
  MessageCircle,
  PanelRightOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Users,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type AuthSession,
  type CalendarContext,
  type CalendarEventView,
  type CalendarEventVisibility,
  type CalendarOccurrenceView,
  type CalendarRecurrenceFrequency,
  type CalendarReminderView,
  type CalendarResponseStatus,
  type CalendarSpaceOption,
  type CalendarWindowView,
  type CreateCalendarEventInput,
  type User
} from "@hahatalk/contracts";
import { getJson, postJson, requestJson } from "../lib/api-client";

type CalendarDeskProps = {
  authSession: AuthSession;
  currentUser: User;
  onLogout: () => void;
  onOpenChat: () => void;
  onOpenContacts: () => void;
};

type EditorMode = "create" | "edit" | "detail";
type RecurrenceEndMode = "count" | "until";
type EventFormState = {
  allDay: boolean;
  attendeeIds: string[];
  description: string;
  endDate: string;
  endTime: string;
  location: string;
  recurrenceCount: number;
  recurrenceEndMode: RecurrenceEndMode;
  recurrenceFrequency: "none" | CalendarRecurrenceFrequency;
  recurrenceInterval: number;
  recurrenceUntil: string;
  reminderOffsetsMinutes: number[];
  spaceId: string;
  startDate: string;
  startTime: string;
  timezone: string;
  title: string;
  version?: number;
  visibility: CalendarEventVisibility;
};

const weekdayLabels = ["월", "화", "수", "목", "금", "토", "일"];
const responseLabels: Record<CalendarResponseStatus, string> = {
  accepted: "참석",
  declined: "불참",
  needs_action: "응답 대기",
  tentative: "미정"
};
const visibilityLabels: Record<CalendarEventVisibility, string> = {
  attendees: "선택 참석자",
  private: "나만",
  space: "대화 전체"
};
const reminderOptions = [
  { label: "정시", value: 0 },
  { label: "10분 전", value: 10 },
  { label: "1시간 전", value: 60 },
  { label: "하루 전", value: 1_440 }
];

export function CalendarDesk({ authSession, currentUser, onLogout, onOpenChat, onOpenContacts }: CalendarDeskProps) {
  const initialToday = localDate(new Date(), "Asia/Seoul");
  const [context, setContext] = useState<CalendarContext | null>(null);
  const [windowView, setWindowView] = useState<CalendarWindowView>({
    from: "",
    occurrences: [],
    reminders: [],
    to: ""
  });
  const [month, setMonth] = useState(`${initialToday.slice(0, 7)}-01`);
  const [selectedDate, setSelectedDate] = useState(initialToday);
  const [selectedOccurrenceKey, setSelectedOccurrenceKey] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("detail");
  const [form, setForm] = useState<EventFormState>(() => newEventForm(initialToday, "", ""));
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);

  const gridDates = useMemo(() => calendarGrid(month), [month]);
  const occurrencesByDate = useMemo(() => {
    const result = new Map<string, CalendarOccurrenceView[]>();
    for (const occurrence of windowView.occurrences) {
      const date = occurrence.occurrenceStartsLocal.slice(0, 10);
      result.set(date, [...(result.get(date) ?? []), occurrence]);
    }
    return result;
  }, [windowView.occurrences]);
  const selectedDayOccurrences = occurrencesByDate.get(selectedDate) ?? [];
  const selectedOccurrence = windowView.occurrences.find((item) => item.occurrenceKey === selectedOccurrenceKey)
    ?? windowView.occurrences.find((item) => item.id === selectedEventId);
  const selectedSpace = context?.spaces.find((space) => space.id === form.spaceId);

  useEffect(() => {
    let active = true;
    void getJson<CalendarContext>("/calendar/context")
      .then((next) => {
        if (!active) return;
        setContext(next);
        const today = localDate(new Date(), next.defaultTimezone);
        setMonth(`${today.slice(0, 7)}-01`);
        setSelectedDate(today);
        setForm((current) => ({
          ...current,
          spaceId: current.spaceId || next.spaces[0]?.id || "",
          timezone: current.timezone || next.defaultTimezone
        }));
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "일정 컨텍스트를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [authSession.user.id]);

  useEffect(() => {
    void refreshWindow(month);
  }, [month, authSession.user.id]);

  async function refreshWindow(targetMonth = month, preferredEventId?: string) {
    if (windowView.from) setIsRefreshing(true);
    else setIsLoading(true);
    setError("");
    try {
      const dates = calendarGrid(targetMonth);
      const from = new Date(`${addDays(dates[0]!, -2)}T00:00:00.000Z`);
      const to = new Date(`${addDays(dates.at(-1)!, 3)}T00:00:00.000Z`);
      const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
      const next = await getJson<CalendarWindowView>(`/calendar/events?${query}`);
      setWindowView(next);
      const preferred = preferredEventId
        ? next.occurrences.find((item) => item.id === preferredEventId)
        : next.occurrences.find((item) => item.occurrenceKey === selectedOccurrenceKey);
      if (preferred) {
        setSelectedEventId(preferred.id);
        setSelectedOccurrenceKey(preferred.occurrenceKey);
        setSelectedDate(preferred.occurrenceStartsLocal.slice(0, 10));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "일정을 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  function moveMonth(offset: number) {
    const next = shiftMonth(month, offset);
    setMonth(next);
    setSelectedDate(next);
    setSelectedOccurrenceKey("");
    setSelectedEventId("");
    setEditorMode("detail");
  }

  function selectOccurrence(occurrence: CalendarOccurrenceView) {
    setSelectedDate(occurrence.occurrenceStartsLocal.slice(0, 10));
    setSelectedEventId(occurrence.id);
    setSelectedOccurrenceKey(occurrence.occurrenceKey);
    setEditorMode("detail");
    setToolsOpen(true);
    setNotice("");
  }

  function beginCreate(date = selectedDate) {
    setForm(newEventForm(date, context?.defaultTimezone ?? "Asia/Seoul", context?.spaces[0]?.id ?? ""));
    setEditorMode("create");
    setToolsOpen(true);
    setNotice("");
    setError("");
  }

  function beginEdit(event: CalendarOccurrenceView) {
    setForm(eventForm(event));
    setEditorMode("edit");
    setToolsOpen(true);
    setNotice("");
    setError("");
  }

  async function saveEvent() {
    setBusyAction("save");
    setError("");
    setNotice("");
    try {
      const payload = eventPayload(form);
      const saved = editorMode === "edit" && selectedOccurrence
        ? await requestJson<CalendarEventView>(`/calendar/events/${selectedOccurrence.id}`, "PATCH", {
            ...payload,
            version: form.version
          })
        : await postJson<CalendarEventView>("/calendar/events", { ...payload });
      await refreshWindow(month, saved.id);
      setEditorMode("detail");
      setNotice(editorMode === "edit" ? "일정을 수정했습니다." : "일정을 만들었습니다.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "일정을 저장하지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  async function cancelEvent(event: CalendarOccurrenceView) {
    if (!window.confirm(`'${event.title}' 일정을 취소할까요?`)) return;
    setBusyAction("cancel");
    setError("");
    try {
      await postJson(`/calendar/events/${event.id}/cancel`, { reason: "사용자 취소", version: event.version });
      await refreshWindow(month, event.id);
      setNotice("일정을 취소했습니다.");
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "일정을 취소하지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  async function respond(event: CalendarOccurrenceView, response: Exclude<CalendarResponseStatus, "needs_action">) {
    setBusyAction(`rsvp:${response}`);
    setError("");
    try {
      await postJson(`/calendar/events/${event.id}/rsvp`, { response });
      await refreshWindow(month, event.id);
      setNotice(`참석 응답: ${responseLabels[response]}`);
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : "참석 응답을 저장하지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  async function dismissReminder(reminder: CalendarReminderView) {
    setBusyAction(`reminder:${reminder.reminderId}`);
    setError("");
    try {
      await postJson(`/calendar/events/${reminder.eventId}/reminders/${reminder.reminderId}/dismiss`, {
        occurrenceStartsAt: reminder.occurrenceStartsAt
      });
      await refreshWindow();
      setNotice("알림을 확인했습니다.");
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : "알림을 처리하지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  function popOut() {
    const url = new URL(window.location.href);
    url.searchParams.set("desk", "calendar");
    window.open(url, "hahatalk-calendar", "width=1280,height=820");
  }

  return (
    <main className="app-shell calendar-shell">
      <nav className="rail" aria-label="주요 이동">
        <div className="brand-mark">인</div>
        <div className="rail-actions">
          <button className="rail-button" onClick={onOpenChat} title="채팅" type="button"><MessageCircle size={21} /></button>
          <button className="rail-button" onClick={onOpenContacts} title="사람" type="button"><Users size={21} /></button>
          <button className="rail-button" data-active="true" title="일정" type="button"><CalendarDays size={21} /></button>
          <button className="rail-button" title="파일" type="button"><FolderOpen size={21} /></button>
        </div>
        <img className="avatar" alt="" src={currentUser.character.thumbnailUrl} />
      </nav>

      <aside className="sidebar calendar-sidebar">
        <div className="sidebar-header calendar-sidebar-header">
          <div>
            <div className="workspace-name">INVIZ CALENDAR</div>
            <h2 className="section-title">{formatMonth(month)}</h2>
          </div>
          <button className="icon-button" disabled={isRefreshing} onClick={() => void refreshWindow()} title="일정 새로고침" type="button">
            <RefreshCw className={isRefreshing ? "spin" : ""} size={17} />
          </button>
        </div>
        <div className="calendar-sidebar-actions">
          <button className="primary-button" onClick={() => beginCreate()} type="button"><Plus size={17} /> 새 일정</button>
        </div>
        <div className="calendar-sidebar-scroll">
          {windowView.reminders.length ? (
            <section className="calendar-reminders" aria-label="도착한 알림">
              <div className="calendar-section-label"><span><Bell size={14} /> 도착한 알림</span><strong>{windowView.reminders.length}</strong></div>
              {windowView.reminders.map((reminder) => (
                <div className="calendar-reminder-row" key={`${reminder.reminderId}:${reminder.occurrenceStartsAt}`}>
                  <button onClick={() => {
                    const occurrence = windowView.occurrences.find((item) => item.occurrenceKey === reminder.occurrenceKey);
                    if (occurrence) selectOccurrence(occurrence);
                  }} type="button">
                    <strong>{reminder.title}</strong>
                    <span>{formatDateTime(reminder.occurrenceStartsAt)} · {reminder.creatorDisplayName}</span>
                  </button>
                  <button className="icon-button" disabled={busyAction === `reminder:${reminder.reminderId}`} onClick={() => void dismissReminder(reminder)} title="알림 확인" type="button"><Check size={15} /></button>
                </div>
              ))}
            </section>
          ) : null}
          <section className="calendar-agenda" aria-label="선택한 날짜 일정">
            <div className="calendar-section-label"><span><Clock3 size={14} /> {formatDayTitle(selectedDate)}</span><strong>{selectedDayOccurrences.length}</strong></div>
            {selectedDayOccurrences.length ? selectedDayOccurrences.map((occurrence) => (
              <button
                className="agenda-item"
                data-active={occurrence.occurrenceKey === selectedOccurrence?.occurrenceKey}
                data-status={occurrence.status}
                key={occurrence.occurrenceKey}
                onClick={() => selectOccurrence(occurrence)}
                type="button"
              >
                <span>{occurrence.allDay ? "종일" : occurrence.occurrenceStartsLocal.slice(11, 16)}</span>
                <strong>{occurrence.title}</strong>
              </button>
            )) : <div className="empty-state panel-muted">등록된 일정이 없습니다.</div>}
          </section>
        </div>
      </aside>

      <section className="workspace calendar-workspace" aria-label="월간 일정">
        <header className="workspace-header calendar-workspace-header">
          <div>
            <h1 className="room-title">{formatMonth(month)}</h1>
            <div className="tiny">{currentUser.displayName} · {context?.defaultTimezone ?? "Asia/Seoul"}</div>
          </div>
          <div className="header-actions">
            <button className="icon-button" onClick={() => moveMonth(-1)} title="이전 달" type="button"><ChevronLeft size={18} /></button>
            <button className="secondary-button" onClick={() => {
              const today = localDate(new Date(), context?.defaultTimezone ?? "Asia/Seoul");
              setMonth(`${today.slice(0, 7)}-01`);
              setSelectedDate(today);
            }} type="button">오늘</button>
            <button className="icon-button" onClick={() => moveMonth(1)} title="다음 달" type="button"><ChevronRight size={18} /></button>
            <button className="icon-button" onClick={() => setToolsOpen(true)} title="일정 패널" type="button"><PanelRightOpen size={18} /></button>
            <button className="icon-button" onClick={popOut} title="일정 별도 창" type="button"><CalendarDays size={18} /></button>
            <button className="icon-button" onClick={onLogout} title="로그아웃" type="button"><LogOut size={18} /></button>
          </div>
        </header>
        {error ? (
          <div className="contacts-status contacts-error" role="alert">
            <span>{error}</span>
            <button className="secondary-button" onClick={() => void refreshWindow()} type="button"><RotateCcw size={15} /> 다시 시도</button>
          </div>
        ) : notice ? <div className="contacts-status contacts-notice">{notice}</div> : null}
        <div className="calendar-board">
          <div className="calendar-weekdays">{weekdayLabels.map((label) => <span key={label}>{label}</span>)}</div>
          {isLoading ? <div className="calendar-loading"><LoaderCircle className="spin" size={26} /></div> : (
            <div className="calendar-grid">
              {gridDates.map((date) => {
                const items = occurrencesByDate.get(date) ?? [];
                return (
                  <div className="calendar-day" data-outside={date.slice(0, 7) !== month.slice(0, 7)} data-selected={date === selectedDate} key={date}>
                    <button className="calendar-day-number" data-today={date === localDate(new Date(), context?.defaultTimezone ?? "Asia/Seoul")} onClick={() => {
                      setSelectedDate(date);
                      setSelectedOccurrenceKey(items[0]?.occurrenceKey ?? "");
                      setSelectedEventId(items[0]?.id ?? "");
                    }} type="button">{Number(date.slice(-2))}</button>
                    <div className="calendar-day-events">
                      {items.slice(0, 3).map((occurrence) => (
                        <button
                          className="calendar-event-pill"
                          data-active={occurrence.occurrenceKey === selectedOccurrence?.occurrenceKey}
                          data-status={occurrence.status}
                          data-visibility={occurrence.visibility}
                          key={occurrence.occurrenceKey}
                          onClick={() => selectOccurrence(occurrence)}
                          title={occurrence.title}
                          type="button"
                        >
                          <span>{occurrence.allDay ? "종일" : occurrence.occurrenceStartsLocal.slice(11, 16)}</span>
                          <strong>{occurrence.title}</strong>
                        </button>
                      ))}
                      {items.length > 3 ? <button className="calendar-more" onClick={() => setSelectedDate(date)} type="button">+{items.length - 3}</button> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <aside className="right-panel calendar-tools" data-open={toolsOpen} aria-label="일정 상세 패널">
        <div className="panel-header calendar-panel-header">
          <div>
            <div className="workspace-name">SCHEDULE DESK</div>
            <h2 className="panel-title">{editorMode === "create" ? "새 일정" : editorMode === "edit" ? "일정 수정" : "일정 상세"}</h2>
          </div>
          <button className="icon-button calendar-tools-close" onClick={() => setToolsOpen(false)} title="일정 패널 닫기" type="button"><X size={18} /></button>
        </div>
        <div className="panel-content calendar-panel-content">
          {editorMode === "create" || editorMode === "edit" ? (
            <EventEditor
              context={context}
              disabled={busyAction === "save"}
              form={form}
              onCancel={() => setEditorMode("detail")}
              onChange={setForm}
              onSave={() => void saveEvent()}
              selectedSpace={selectedSpace}
            />
          ) : selectedOccurrence ? (
            <EventDetail
              busyAction={busyAction}
              event={selectedOccurrence}
              onCancel={() => void cancelEvent(selectedOccurrence)}
              onEdit={() => beginEdit(selectedOccurrence)}
              onRespond={(response) => void respond(selectedOccurrence, response)}
            />
          ) : (
            <div className="calendar-empty-detail">
              <CalendarDays size={28} />
              <span>{formatDayTitle(selectedDate)}</span>
              <button className="primary-button" onClick={() => beginCreate()} type="button"><Plus size={16} /> 일정 만들기</button>
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}

function EventEditor({ context, disabled, form, onCancel, onChange, onSave, selectedSpace }: {
  context: CalendarContext | null;
  disabled: boolean;
  form: EventFormState;
  onCancel: () => void;
  onChange: (value: EventFormState) => void;
  onSave: () => void;
  selectedSpace: CalendarSpaceOption | undefined;
}) {
  const patch = (value: Partial<EventFormState>) => onChange({ ...form, ...value });
  const toggleAttendee = (id: string) => patch({
    attendeeIds: form.attendeeIds.includes(id)
      ? form.attendeeIds.filter((candidate) => candidate !== id)
      : [...form.attendeeIds, id]
  });
  const toggleReminder = (offset: number) => patch({
    reminderOffsetsMinutes: form.reminderOffsetsMinutes.includes(offset)
      ? form.reminderOffsetsMinutes.filter((candidate) => candidate !== offset)
      : [...form.reminderOffsetsMinutes, offset]
  });
  return (
    <form className="calendar-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <label className="field">제목<input className="text-input" maxLength={160} onChange={(event) => patch({ title: event.target.value })} required value={form.title} /></label>
      <div className="segmented-control calendar-visibility" aria-label="공개 범위">
        {(["private", "attendees", "space"] as CalendarEventVisibility[]).map((visibility) => (
          <button
            data-active={form.visibility === visibility}
            disabled={visibility === "space" && !selectedSpace?.canInviteAll}
            key={visibility}
            onClick={() => patch({ attendeeIds: [], visibility })}
            type="button"
          >{visibilityLabels[visibility]}</button>
        ))}
      </div>
      {form.visibility !== "private" ? (
        <label className="field">대화
          <select className="text-input" onChange={(event) => patch({ attendeeIds: [], spaceId: event.target.value })} value={form.spaceId}>
            <option value="">선택</option>
            {context?.spaces.map((space) => <option key={space.id} value={space.id}>{space.title}</option>)}
          </select>
        </label>
      ) : null}
      {form.visibility === "attendees" ? (
        <div className="field">참석자
          <div className="calendar-attendee-picker">
            {selectedSpace?.people.length ? selectedSpace.people.map((person) => (
              <button data-active={form.attendeeIds.includes(person.id)} key={person.id} onClick={() => toggleAttendee(person.id)} type="button">
                <img className="avatar" alt="" src={person.character.thumbnailUrl} /> {person.displayName}
              </button>
            )) : <span className="panel-muted">선택 가능한 참석자가 없습니다.</span>}
          </div>
        </div>
      ) : null}
      {form.visibility === "space" && selectedSpace ? <div className="notice">대상 {selectedSpace.people.length}명 · 현재 구성원 기준</div> : null}
      <div className="calendar-form-row">
        <label className="field">시작일<input className="text-input" onChange={(event) => patch({ startDate: event.target.value })} type="date" value={form.startDate} /></label>
        <label className="field">시작 시각<input className="text-input" disabled={form.allDay} onChange={(event) => patch({ startTime: event.target.value })} type="time" value={form.startTime} /></label>
      </div>
      <div className="calendar-form-row">
        <label className="field">종료일<input className="text-input" onChange={(event) => patch({ endDate: event.target.value })} type="date" value={form.endDate} /></label>
        <label className="field">종료 시각<input className="text-input" disabled={form.allDay} onChange={(event) => patch({ endTime: event.target.value })} type="time" value={form.endTime} /></label>
      </div>
      <label className="calendar-checkbox"><input checked={form.allDay} onChange={(event) => patch({ allDay: event.target.checked, endDate: event.target.checked ? addDays(form.startDate, 1) : form.endDate, endTime: event.target.checked ? "00:00" : form.endTime, startTime: event.target.checked ? "00:00" : form.startTime })} type="checkbox" /> 종일</label>
      <label className="field">시간대<input className="text-input" onChange={(event) => patch({ timezone: event.target.value })} value={form.timezone} /></label>
      <label className="field"><span><MapPin size={14} /> 장소</span><input className="text-input" maxLength={200} onChange={(event) => patch({ location: event.target.value })} value={form.location} /></label>
      <label className="field">메모<textarea className="text-input compact-textarea" maxLength={4_000} onChange={(event) => patch({ description: event.target.value })} value={form.description} /></label>
      <div className="calendar-form-row">
        <label className="field">반복
          <select className="text-input" onChange={(event) => patch({ recurrenceFrequency: event.target.value as EventFormState["recurrenceFrequency"] })} value={form.recurrenceFrequency}>
            <option value="none">반복 안 함</option><option value="daily">매일</option><option value="weekly">매주</option><option value="monthly">매월</option>
          </select>
        </label>
        {form.recurrenceFrequency !== "none" ? <label className="field">간격<input className="text-input" max={12} min={1} onChange={(event) => patch({ recurrenceInterval: Number(event.target.value) })} type="number" value={form.recurrenceInterval} /></label> : <span />}
      </div>
      {form.recurrenceFrequency !== "none" ? (
        <div className="calendar-recurrence-end">
          <div className="segmented-control">
            <button data-active={form.recurrenceEndMode === "count"} onClick={() => patch({ recurrenceEndMode: "count" })} type="button">횟수</button>
            <button data-active={form.recurrenceEndMode === "until"} onClick={() => patch({ recurrenceEndMode: "until" })} type="button">종료일</button>
          </div>
          {form.recurrenceEndMode === "count"
            ? <input className="text-input" max={366} min={2} onChange={(event) => patch({ recurrenceCount: Number(event.target.value) })} type="number" value={form.recurrenceCount} />
            : <input className="text-input" min={addDays(form.startDate, 1)} onChange={(event) => patch({ recurrenceUntil: event.target.value })} type="date" value={form.recurrenceUntil} />}
        </div>
      ) : null}
      <div className="field">알림
        <div className="calendar-reminder-picker">
          {reminderOptions.map((option) => <label key={option.value}><input checked={form.reminderOffsetsMinutes.includes(option.value)} onChange={() => toggleReminder(option.value)} type="checkbox" /> {option.label}</label>)}
        </div>
      </div>
      <div className="calendar-editor-actions">
        <button className="secondary-button" disabled={disabled} onClick={onCancel} type="button"><X size={16} /> 닫기</button>
        <button className="primary-button" disabled={disabled || !form.title.trim()} type="submit"><Save size={16} /> {disabled ? "저장 중" : "저장"}</button>
      </div>
    </form>
  );
}

function EventDetail({ busyAction, event, onCancel, onEdit, onRespond }: {
  busyAction: string;
  event: CalendarOccurrenceView;
  onCancel: () => void;
  onEdit: () => void;
  onRespond: (response: Exclude<CalendarResponseStatus, "needs_action">) => void;
}) {
  return (
    <div className="calendar-detail">
      <section className="calendar-detail-heading" data-status={event.status}>
        <div className="calendar-detail-chips"><span>{visibilityLabels[event.visibility]}</span>{event.recurrence ? <span>{recurrenceLabel(event)}</span> : null}{event.status === "cancelled" ? <span>취소됨</span> : null}</div>
        <h3>{event.title}</h3>
        <div className="calendar-detail-time"><Clock3 size={16} /><span>{formatOccurrenceRange(event)}</span></div>
        {event.location ? <div className="calendar-detail-time"><MapPin size={16} /><span>{event.location}</span></div> : null}
      </section>
      {event.description ? <section className="calendar-detail-section"><p>{event.description}</p></section> : null}
      <section className="calendar-detail-section calendar-creator-row">
        <img className="avatar" alt="" src={event.creator.character.thumbnailUrl} />
        <span><strong>{event.creator.displayName}</strong><small>작성자 · {event.timezone}</small></span>
      </section>
      {event.canRespond ? (
        <section className="calendar-detail-section">
          <div className="calendar-section-label"><span>내 참석 응답</span><strong>{responseLabels[event.myResponse ?? "needs_action"]}</strong></div>
          <div className="segmented-control calendar-rsvp">
            <button data-active={event.myResponse === "accepted"} disabled={Boolean(busyAction)} onClick={() => onRespond("accepted")} type="button">참석</button>
            <button data-active={event.myResponse === "tentative"} disabled={Boolean(busyAction)} onClick={() => onRespond("tentative")} type="button">미정</button>
            <button data-active={event.myResponse === "declined"} disabled={Boolean(busyAction)} onClick={() => onRespond("declined")} type="button">불참</button>
          </div>
        </section>
      ) : event.myResponse ? <section className="calendar-detail-section"><strong>내 응답 · {responseLabels[event.myResponse]}</strong></section> : null}
      {event.isCreator ? (
        <section className="calendar-detail-section">
          <div className="calendar-section-label"><span><Users size={14} /> 참석 현황</span><strong>{event.attendees?.length ?? 0}</strong></div>
          <div className="calendar-attendee-list">
            {event.attendees?.map((attendee) => (
              <div key={attendee.person.id}><img className="avatar" alt="" src={attendee.person.character.thumbnailUrl} /><span><strong>{attendee.person.displayName}</strong><small>{responseLabels[attendee.response]}</small></span></div>
            ))}
            {!event.attendees?.length ? <span className="panel-muted">참석자가 없습니다.</span> : null}
          </div>
        </section>
      ) : null}
      {event.cancellationReason ? <section className="notice">{event.cancellationReason}</section> : null}
      {event.isCreator && event.status === "scheduled" ? (
        <div className="calendar-editor-actions calendar-detail-actions">
          <button className="secondary-button danger-button" disabled={Boolean(busyAction)} onClick={onCancel} type="button"><Trash2 size={16} /> 취소</button>
          <button className="primary-button" disabled={Boolean(busyAction)} onClick={onEdit} type="button"><Edit3 size={16} /> 수정</button>
        </div>
      ) : null}
    </div>
  );
}

function eventPayload(form: EventFormState): CreateCalendarEventInput {
  const recurrence = form.recurrenceFrequency === "none" ? undefined : {
    frequency: form.recurrenceFrequency,
    interval: form.recurrenceInterval,
    ...(form.recurrenceFrequency === "weekly" ? { weekdays: [isoWeekday(form.startDate)] } : {}),
    ...(form.recurrenceEndMode === "count" ? { count: form.recurrenceCount } : { untilLocalDate: form.recurrenceUntil })
  };
  return {
    allDay: form.allDay,
    attendeeIds: form.visibility === "attendees" ? form.attendeeIds : [],
    description: form.description,
    endsLocal: `${form.endDate}T${form.allDay ? "00:00" : form.endTime}:00`,
    location: form.location,
    ...(recurrence ? { recurrence } : {}),
    reminderOffsetsMinutes: form.reminderOffsetsMinutes,
    ...(form.visibility !== "private" && form.spaceId ? { spaceId: form.spaceId } : {}),
    startsLocal: `${form.startDate}T${form.allDay ? "00:00" : form.startTime}:00`,
    timezone: form.timezone,
    title: form.title,
    visibility: form.visibility
  };
}

function newEventForm(date: string, timezone: string, spaceId: string): EventFormState {
  return {
    allDay: false,
    attendeeIds: [],
    description: "",
    endDate: date,
    endTime: "10:00",
    location: "",
    recurrenceCount: 10,
    recurrenceEndMode: "count",
    recurrenceFrequency: "none",
    recurrenceInterval: 1,
    recurrenceUntil: addDays(date, 28),
    reminderOffsetsMinutes: [10],
    spaceId,
    startDate: date,
    startTime: "09:00",
    timezone,
    title: "",
    visibility: "private"
  };
}

function eventForm(event: CalendarEventView): EventFormState {
  const recurrence = event.recurrence;
  return {
    allDay: event.allDay,
    attendeeIds: event.attendees?.map((attendee) => attendee.person.id) ?? [],
    description: event.description,
    endDate: event.endsLocal.slice(0, 10),
    endTime: event.endsLocal.slice(11, 16),
    location: event.location,
    recurrenceCount: recurrence?.count ?? 10,
    recurrenceEndMode: recurrence?.untilLocalDate ? "until" : "count",
    recurrenceFrequency: recurrence?.frequency ?? "none",
    recurrenceInterval: recurrence?.interval ?? 1,
    recurrenceUntil: recurrence?.untilLocalDate ?? addDays(event.startsLocal.slice(0, 10), 28),
    reminderOffsetsMinutes: event.reminderOffsetsMinutes ?? [],
    spaceId: event.space?.id ?? "",
    startDate: event.startsLocal.slice(0, 10),
    startTime: event.startsLocal.slice(11, 16),
    timezone: event.timezone,
    title: event.title,
    version: event.version,
    visibility: event.visibility
  };
}

function calendarGrid(month: string) {
  const first = new Date(`${month}T00:00:00.000Z`);
  const isoDay = first.getUTCDay() === 0 ? 7 : first.getUTCDay();
  const start = new Date(first.getTime() - (isoDay - 1) * 86_400_000);
  return Array.from({ length: 42 }, (_, index) => start.toISOString().slice(0, 10)).map((date, index) => addDays(date, index));
}

function shiftMonth(month: string, offset: number) {
  const date = new Date(`${month}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isoWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return (day === 0 ? 7 : day) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

function localDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatMonth(month: string) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", timeZone: "UTC", year: "numeric" }).format(new Date(`${month}T00:00:00Z`));
}

function formatDayTitle(date: string) {
  return new Intl.DateTimeFormat("ko-KR", { day: "numeric", month: "long", timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T00:00:00Z`));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { day: "numeric", hour: "2-digit", minute: "2-digit", month: "short" }).format(new Date(value));
}

function formatOccurrenceRange(event: CalendarOccurrenceView) {
  const start = event.occurrenceStartsLocal;
  const end = event.occurrenceEndsLocal;
  if (event.allDay) return `${start.slice(0, 10)} 종일`;
  return start.slice(0, 10) === end.slice(0, 10)
    ? `${start.slice(0, 10)} ${start.slice(11, 16)}-${end.slice(11, 16)}`
    : `${start.slice(0, 16)} - ${end.slice(0, 16)}`;
}

function recurrenceLabel(event: CalendarEventView) {
  const recurrence = event.recurrence!;
  const unit = recurrence.frequency === "daily" ? "일" : recurrence.frequency === "weekly" ? "주" : "개월";
  const end = recurrence.count ? `${recurrence.count}회` : `${recurrence.untilLocalDate}까지`;
  return `${recurrence.interval}${unit}마다 · ${end}`;
}
