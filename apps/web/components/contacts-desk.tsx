"use client";

import {
  Archive,
  CalendarDays,
  Check,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageCircle,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  type AuthSession,
  type ContactCollectionKind,
  type ContactCollectionMemberView,
  type ContactCollectionView,
  type ContactConsentDecision,
  type ContactConsentRequest,
  type ContactFollowUpState,
  type ContactPerson,
  type ContactRosterVisibility,
  type ContactsDashboard,
  type User
} from "@hahatalk/contracts";
import { getJson, postJson, requestJson } from "../lib/api-client";

type ContactsDeskProps = {
  authSession: AuthSession;
  currentUser: User;
  onLogout: () => void;
  onOpenCalendar: () => void;
  onOpenChat: () => void;
};

const kindLabels: Record<ContactCollectionKind, string> = {
  custom: "개인 분류",
  customers: "고객",
  family: "가족",
  service: "서비스",
  team: "업무 팀"
};

const consentLabels: Record<"pending" | ContactConsentDecision, string> = {
  denied: "거절",
  granted: "동의",
  pending: "대기",
  revoked: "철회"
};

export function ContactsDesk({ authSession, currentUser, onLogout, onOpenCalendar, onOpenChat }: ContactsDeskProps) {
  const [dashboard, setDashboard] = useState<ContactsDashboard | null>(null);
  const [selection, setSelection] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    void refresh();
  }, [authSession.user.id]);

  const selectedRequest = dashboard?.consentRequests.find(
    (request) => selection === requestKey(request.collectionId)
  );
  const selectedCollection = useMemo(() => {
    if (!dashboard) return undefined;
    return [...dashboard.ownedCollections, ...dashboard.sharedCollections].find(
      (collection) => selection === collectionKey(collection)
    );
  }, [dashboard, selection]);
  const selectedMember = selectedCollection?.isOwner
    ? selectedCollection.members.find((member) => member.person.id === selectedMemberId)
    : undefined;
  const roster = selectedCollection?.isOwner
    ? [
        { addedAt: selectedCollection.createdAt, person: selectedCollection.owner },
        ...selectedCollection.members
      ]
    : selectedCollection?.members ?? [];

  async function refresh(preferredSelection?: string) {
    if (dashboard) setIsRefreshing(true);
    else setIsLoading(true);
    setError("");
    try {
      const next = await getJson<ContactsDashboard>("/contacts");
      setDashboard(next);
      setSelection((current) => preferredSelection ?? (selectionExists(next, current) ? current : defaultSelection(next)));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "연락처를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  async function perform(
    action: string,
    successMessage: string,
    operation: () => Promise<unknown>,
    preferredSelection?: string
  ) {
    setBusyAction(action);
    setError("");
    setNotice("");
    try {
      await operation();
      await refresh(preferredSelection);
      setNotice(successMessage);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusyAction("");
    }
  }

  async function createCollection(input: { name: string; description: string; kind: ContactCollectionKind }) {
    let createdId = "";
    await perform(
      "create",
      "그룹을 만들었습니다.",
      async () => {
        const created = await postJson<ContactCollectionView>("/contact-collections", input);
        createdId = created.id;
      },
      undefined
    );
    if (createdId) {
      await refresh(`collection:owner:${createdId}`);
    }
  }

  function selectCollection(collection: ContactCollectionView) {
    setSelection(collectionKey(collection));
    setSelectedMemberId("");
    setNotice("");
  }

  function selectRequest(request: ContactConsentRequest) {
    setSelection(requestKey(request.collectionId));
    setSelectedMemberId("");
    setNotice("");
  }

  async function decideConsent(request: ContactConsentRequest, decision: ContactConsentDecision) {
    const nextSelection = decision === "granted"
      ? `collection:shared:${request.collectionId}`
      : requestKey(request.collectionId);
    await perform(
      `consent:${decision}`,
      decision === "granted" ? "공유에 동의했습니다." : "공유 요청을 거절했습니다.",
      () => postJson(`/contact-collections/${request.collectionId}/consent`, {
        decision,
        policyVersion: request.policyVersion
      }),
      nextSelection
    );
  }

  async function revokeConsent(collection: ContactCollectionView) {
    await perform(
      "consent:revoked",
      "공유 동의를 철회했습니다.",
      () => postJson(`/contact-collections/${collection.id}/consent`, {
        decision: "revoked",
        policyVersion: collection.policyVersion
      }),
      requestKey(collection.id)
    );
  }

  async function archiveCollection(collection: ContactCollectionView) {
    await perform(
      "archive",
      "그룹을 보관 처리했습니다.",
      () => requestJson(`/contact-collections/${collection.id}`, "DELETE", {}),
      ""
    );
  }

  return (
    <main className="app-shell contacts-shell">
      <nav className="rail" aria-label="주요 이동">
        <div className="brand-mark">인</div>
        <div className="rail-actions">
          <button className="rail-button" onClick={onOpenChat} title="채팅" type="button">
            <MessageCircle size={21} />
          </button>
          <button className="rail-button" data-active="true" title="사람" type="button">
            <Users size={21} />
          </button>
          <button className="rail-button" onClick={onOpenCalendar} title="일정" type="button">
            <CalendarDays size={21} />
          </button>
          <button className="rail-button" title="파일" type="button">
            <FolderOpen size={21} />
          </button>
        </div>
        <img className="avatar" alt="" src={currentUser.character.thumbnailUrl} />
      </nav>

      <aside className="sidebar contacts-sidebar">
        <div className="sidebar-header contacts-sidebar-title">
          <div>
            <div className="workspace-name">INVIZ WORKSPACE</div>
            <h2 className="section-title">연락처 그룹</h2>
          </div>
          <button className="icon-button" disabled={isRefreshing} onClick={() => void refresh()} title="새로고침" type="button">
            <RefreshCw className={isRefreshing ? "spin" : ""} size={17} />
          </button>
        </div>
        {dashboard?.canManage ? (
          <CreateCollectionForm disabled={Boolean(busyAction)} onCreate={createCollection} />
        ) : (
          <div className="contacts-access-label"><LockKeyhole size={15} /> 제한된 계정</div>
        )}
        <div className="room-list contact-collection-list">
          {dashboard?.consentRequests.length ? (
            <CollectionSection label="동의 요청" count={dashboard.consentRequests.length}>
              {dashboard.consentRequests.map((request) => (
                <button
                  className="room-item collection-item"
                  data-active={selection === requestKey(request.collectionId)}
                  key={`request:${request.collectionId}`}
                  onClick={() => selectRequest(request)}
                  type="button"
                >
                  <span className="room-item-title"><strong>{request.collectionName}</strong><ShieldCheck size={16} /></span>
                  <span className="room-meta">{request.owner.displayName} · {kindLabels[request.kind]}</span>
                </button>
              ))}
            </CollectionSection>
          ) : null}
          {dashboard?.ownedCollections.length ? (
            <CollectionSection label="내 그룹" count={dashboard.ownedCollections.length}>
              {dashboard.ownedCollections.map((collection) => (
                <CollectionButton
                  collection={collection}
                  isSelected={selection === collectionKey(collection)}
                  key={collection.id}
                  onClick={() => selectCollection(collection)}
                />
              ))}
            </CollectionSection>
          ) : null}
          {dashboard?.sharedCollections.length ? (
            <CollectionSection label="공유받은 그룹" count={dashboard.sharedCollections.length}>
              {dashboard.sharedCollections.map((collection) => (
                <CollectionButton
                  collection={collection}
                  isSelected={selection === collectionKey(collection)}
                  key={collection.id}
                  onClick={() => selectCollection(collection)}
                />
              ))}
            </CollectionSection>
          ) : null}
          {!isLoading && dashboard
            && dashboard.ownedCollections.length === 0
            && dashboard.sharedCollections.length === 0
            && dashboard.consentRequests.length === 0 ? (
              <div className="empty-state panel-muted">표시할 연락처 그룹이 없습니다.</div>
            ) : null}
        </div>
      </aside>

      <section className="workspace contacts-workspace" aria-label="연락처 업무 공간">
        <header className="workspace-header">
          <div>
            <h1 className="room-title">{selectedRequest?.collectionName ?? selectedCollection?.name ?? "연락처"}</h1>
            <div className="tiny">
              {selectedRequest
                ? "공유 동의 요청"
                : selectedCollection
                  ? `${kindLabels[selectedCollection.kind]} · ${selectedCollection.isOwner ? "내 그룹" : "공유 그룹"}`
                  : `${currentUser.displayName} · ${authSession.role === "guest" ? "게스트" : "내부 구성원"}`}
            </div>
          </div>
          <div className="header-actions">
            <button className="icon-button" onClick={() => setToolsOpen(true)} title="관리 패널" type="button">
              <PanelRightOpen size={18} />
            </button>
            <button className="icon-button" onClick={onLogout} title="로그아웃" type="button">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {error ? (
          <div className="contacts-status contacts-error" role="alert">
            <span>{error}</span>
            <button className="secondary-button" onClick={() => void refresh()} type="button"><RefreshCw size={15} /> 다시 시도</button>
          </div>
        ) : notice ? <div className="contacts-status contacts-notice">{notice}</div> : null}

        <div className="contacts-main">
          {isLoading ? (
            <div className="contacts-loading" aria-busy="true"><LoaderCircle className="spin" size={24} /></div>
          ) : selectedRequest ? (
            <ConsentRequestView
              busy={Boolean(busyAction)}
              onDecide={(decision) => void decideConsent(selectedRequest, decision)}
              request={selectedRequest}
            />
          ) : selectedCollection ? (
            <CollectionRoster
              collection={selectedCollection}
              onSelectMember={(member) => {
                if (member.privateDetails) {
                  setSelectedMemberId(member.person.id);
                  setToolsOpen(true);
                }
              }}
              roster={roster}
              selectedMemberId={selectedMemberId}
            />
          ) : (
            <div className="contacts-loading panel-muted">연락처 그룹을 선택하세요.</div>
          )}
        </div>
      </section>

      <aside className="right-panel contacts-tools" data-open={toolsOpen} aria-label="연락처 관리 패널">
        <div className="panel-header contacts-panel-header">
          <div>
            <div className="workspace-name">CONTACT CONTROL</div>
            <h2 className="panel-title">관리</h2>
          </div>
          <button className="icon-button contacts-tools-close" onClick={() => setToolsOpen(false)} title="관리 패널 닫기" type="button">
            <X size={18} />
          </button>
        </div>
        <div className="panel-content contacts-panel-content">
          {selectedRequest ? (
            <ConsentControl
              busy={Boolean(busyAction)}
              onDecide={(decision) => void decideConsent(selectedRequest, decision)}
              request={selectedRequest}
            />
          ) : selectedCollection?.isOwner ? (
            <>
              <CollectionSettings
                collection={selectedCollection}
                disabled={Boolean(busyAction)}
                key={`settings:${selectedCollection.id}:${selectedCollection.updatedAt}`}
                onArchive={() => void archiveCollection(selectedCollection)}
                onSave={(name, description) => void perform(
                  "collection:update",
                  "그룹 정보를 저장했습니다.",
                  () => requestJson(`/contact-collections/${selectedCollection.id}`, "PATCH", { description, name }),
                  collectionKey(selectedCollection)
                )}
              />
              <PolicySettings
                collection={selectedCollection}
                disabled={Boolean(busyAction)}
                key={`policy:${selectedCollection.id}:${selectedCollection.policyVersion}`}
                onSave={(visibility, rosterVisibility) => void perform(
                  "policy:update",
                  visibility === "shared" ? "공유 정책을 적용했습니다." : "소유자 전용으로 전환했습니다.",
                  () => postJson(`/contact-collections/${selectedCollection.id}/policy`, { rosterVisibility, visibility }),
                  collectionKey(selectedCollection)
                )}
              />
              <MemberAdder
                collection={selectedCollection}
                disabled={Boolean(busyAction)}
                key={`adder:${selectedCollection.id}:${selectedCollection.updatedAt}`}
                people={dashboard?.availablePeople ?? []}
                onAdd={(userId) => void perform(
                  "member:add",
                  "구성원을 추가했습니다.",
                  () => postJson(`/contact-collections/${selectedCollection.id}/members`, { userId }),
                  collectionKey(selectedCollection)
                )}
              />
              {selectedMember?.privateDetails ? (
                <MemberEditor
                  disabled={Boolean(busyAction)}
                  key={`member:${selectedCollection.id}:${selectedMember.person.id}:${selectedCollection.updatedAt}`}
                  member={selectedMember}
                  onRemove={() => void perform(
                    "member:remove",
                    "구성원을 그룹에서 제외했습니다.",
                    () => requestJson(
                      `/contact-collections/${selectedCollection.id}/members/${encodeURIComponent(selectedMember.person.id)}`,
                      "DELETE",
                      {}
                    ),
                    collectionKey(selectedCollection)
                  ).then(() => setSelectedMemberId(""))}
                  onSave={(payload) => void perform(
                    "member:update",
                    "관계 정보를 저장했습니다.",
                    () => requestJson(
                      `/contact-collections/${selectedCollection.id}/members/${encodeURIComponent(selectedMember.person.id)}`,
                      "PATCH",
                      payload
                    ),
                    collectionKey(selectedCollection)
                  )}
                />
              ) : null}
            </>
          ) : selectedCollection ? (
            <section className="contacts-control-section">
              <div className="control-title"><ShieldCheck size={17} /> 공유 동의</div>
              <div className="control-value">정책 버전 {selectedCollection.policyVersion}</div>
              <button
                className="secondary-button danger-button"
                disabled={Boolean(busyAction)}
                onClick={() => void revokeConsent(selectedCollection)}
                type="button"
              >
                <X size={16} /> 동의 철회
              </button>
            </section>
          ) : (
            <div className="empty-state panel-muted">선택한 그룹의 관리 항목이 표시됩니다.</div>
          )}
        </div>
      </aside>
    </main>
  );
}

function CreateCollectionForm({ disabled, onCreate }: {
  disabled: boolean;
  onCreate: (input: { name: string; description: string; kind: ContactCollectionKind }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ContactCollectionKind>("family");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    await onCreate({ description, kind, name });
    setName("");
    setDescription("");
  }

  return (
    <form className="sidebar-header contacts-create" onSubmit={(event) => void submit(event)}>
      <div className="contact-create-row">
        <input className="text-input" maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="새 그룹 이름" required value={name} />
        <button className="icon-button" disabled={disabled || !name.trim()} title="그룹 만들기" type="submit"><Plus size={18} /></button>
      </div>
      <select className="text-input compact-select" onChange={(event) => setKind(event.target.value as ContactCollectionKind)} value={kind}>
        {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input className="text-input" maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="설명" value={description} />
    </form>
  );
}

function CollectionSection({ children, count, label }: { children: React.ReactNode; count: number; label: string }) {
  return (
    <section className="collection-section">
      <div className="collection-section-title"><span>{label}</span><span>{count}</span></div>
      {children}
    </section>
  );
}

function CollectionButton({ collection, isSelected, onClick }: {
  collection: ContactCollectionView;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button className="room-item collection-item" data-active={isSelected} onClick={onClick} type="button">
      <span className="room-item-title">
        <strong>{collection.name}</strong>
        {collection.visibility === "shared" ? <Users size={16} /> : <LockKeyhole size={15} />}
      </span>
      <span className="room-meta">{kindLabels[collection.kind]} · {collection.members.length}명</span>
    </button>
  );
}

function ConsentRequestView({ busy, onDecide, request }: {
  busy: boolean;
  onDecide: (decision: "granted" | "denied") => void;
  request: ContactConsentRequest;
}) {
  return (
    <div className="consent-request-view">
      <div className="consent-owner-row">
        <img className="avatar" alt="" src={request.owner.character.thumbnailUrl} />
        <div><strong>{request.owner.displayName}</strong><span>{request.owner.email}</span></div>
      </div>
      <div className="contact-summary-band">
        <span>{kindLabels[request.kind]}</span>
        <span>정책 {request.policyVersion}</span>
        <span>{request.rosterVisibility === "shared" ? "동의 구성원 공개" : "소유자와 나만"}</span>
      </div>
      {request.collectionDescription ? <p className="contact-description">{request.collectionDescription}</p> : null}
      <section className="shared-field-list">
        <h2>공유 항목</h2>
        {request.sharedFields.map((field) => (
          <div key={field}><Check size={16} /> {sharedFieldLabel(field)}</div>
        ))}
      </section>
      <div className="consent-main-actions">
        <button className="primary-button" disabled={busy} onClick={() => onDecide("granted")} type="button"><ShieldCheck size={17} /> 동의</button>
        <button className="secondary-button" disabled={busy} onClick={() => onDecide("denied")} type="button"><X size={17} /> 거절</button>
      </div>
    </div>
  );
}

function CollectionRoster({ collection, onSelectMember, roster, selectedMemberId }: {
  collection: ContactCollectionView;
  onSelectMember: (member: ContactCollectionMemberView) => void;
  roster: ContactCollectionMemberView[];
  selectedMemberId: string;
}) {
  return (
    <div className="contact-roster-view">
      <div className="contact-summary-band">
        <span>{collection.visibility === "shared" ? "공유" : "소유자 전용"}</span>
        <span>정책 {collection.policyVersion}</span>
        <span>{roster.length}명</span>
      </div>
      {collection.description ? <p className="contact-description">{collection.description}</p> : null}
      <div className="contact-member-list">
        {roster.map((member) => {
          const isOwner = member.person.id === collection.owner.id;
          return (
            <button
              className="contact-member-item"
              data-active={selectedMemberId === member.person.id}
              disabled={!member.privateDetails}
              key={`${member.person.id}:${isOwner ? "owner" : "member"}`}
              onClick={() => onSelectMember(member)}
              type="button"
            >
              <img className="avatar" alt="" src={member.person.character.thumbnailUrl} />
              <span className="contact-person-copy">
                <strong>{member.person.displayName}</strong>
                <span>{member.privateDetails?.label || member.person.email}</span>
              </span>
              <span className="contact-member-state">
                {isOwner ? "소유자" : member.consentStatus ? consentLabels[member.consentStatus] : member.person.role === "guest" ? "게스트" : "구성원"}
              </span>
              {member.privateDetails ? <ChevronRight size={17} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConsentControl({ busy, onDecide, request }: {
  busy: boolean;
  onDecide: (decision: "granted" | "denied") => void;
  request: ContactConsentRequest;
}) {
  return (
    <section className="contacts-control-section">
      <div className="control-title"><ShieldCheck size={17} /> 공유 동의</div>
      <div className="control-value">{request.owner.displayName}</div>
      <div className="control-value">정책 버전 {request.policyVersion}</div>
      {request.myDecision ? <div className="status-chip">현재: {consentLabels[request.myDecision]}</div> : null}
      <div className="control-actions">
        <button className="primary-button" disabled={busy} onClick={() => onDecide("granted")} type="button"><Check size={16} /> 동의</button>
        <button className="secondary-button" disabled={busy} onClick={() => onDecide("denied")} type="button"><X size={16} /> 거절</button>
      </div>
    </section>
  );
}

function CollectionSettings({ collection, disabled, onArchive, onSave }: {
  collection: ContactCollectionView;
  disabled: boolean;
  onArchive: () => void;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description);
  return (
    <section className="contacts-control-section">
      <div className="control-title">그룹 정보</div>
      <label className="field">이름<input className="text-input" maxLength={80} onChange={(event) => setName(event.target.value)} value={name} /></label>
      <label className="field">설명<textarea className="text-input compact-textarea" maxLength={500} onChange={(event) => setDescription(event.target.value)} value={description} /></label>
      <div className="control-actions split-actions">
        <button className="secondary-button" disabled={disabled || !name.trim()} onClick={() => onSave(name, description)} type="button"><Save size={16} /> 저장</button>
        <button className="icon-button danger-button" disabled={disabled} onClick={onArchive} title="그룹 보관" type="button"><Archive size={17} /></button>
      </div>
    </section>
  );
}

function PolicySettings({ collection, disabled, onSave }: {
  collection: ContactCollectionView;
  disabled: boolean;
  onSave: (visibility: "owner_only" | "shared", rosterVisibility: ContactRosterVisibility) => void;
}) {
  const [visibility, setVisibility] = useState(collection.visibility);
  const [rosterVisibility, setRosterVisibility] = useState(collection.rosterVisibility);
  const shareable = collection.kind === "family" || collection.kind === "team";
  return (
    <section className="contacts-control-section">
      <div className="control-title"><LockKeyhole size={17} /> 공유 정책</div>
      <div className="segmented-control" aria-label="공유 범위">
        <button data-active={visibility === "owner_only"} onClick={() => setVisibility("owner_only")} type="button">나만</button>
        <button data-active={visibility === "shared"} disabled={!shareable} onClick={() => setVisibility("shared")} type="button">동의 후 공유</button>
      </div>
      <div className="segmented-control" aria-label="명단 공개">
        <button data-active={rosterVisibility === "shared"} onClick={() => setRosterVisibility("shared")} type="button">서로 보기</button>
        <button data-active={rosterVisibility === "owner_only"} onClick={() => setRosterVisibility("owner_only")} type="button">소유자와 나</button>
      </div>
      <button className="secondary-button control-save" disabled={disabled} onClick={() => onSave(visibility, rosterVisibility)} type="button"><Save size={16} /> 정책 적용</button>
    </section>
  );
}

function MemberAdder({ collection, disabled, onAdd, people }: {
  collection: ContactCollectionView;
  disabled: boolean;
  onAdd: (userId: string) => void;
  people: ContactPerson[];
}) {
  const existing = new Set([collection.owner.id, ...collection.members.map((member) => member.person.id)]);
  const options = people.filter((person) => !existing.has(person.id));
  const [userId, setUserId] = useState("");
  return (
    <section className="contacts-control-section">
      <div className="control-title"><UserPlus size={17} /> 구성원 추가</div>
      <select className="text-input" disabled={options.length === 0} onChange={(event) => setUserId(event.target.value)} value={userId}>
        <option value="">대상 선택</option>
        {options.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.email}</option>)}
      </select>
      <button className="secondary-button control-save" disabled={disabled || !userId} onClick={() => onAdd(userId)} type="button"><Plus size={16} /> 추가</button>
    </section>
  );
}

function MemberEditor({ disabled, member, onRemove, onSave }: {
  disabled: boolean;
  member: ContactCollectionMemberView;
  onRemove: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const details = member.privateDetails!;
  const [label, setLabel] = useState(details.label);
  const [notes, setNotes] = useState(details.notes);
  const [tags, setTags] = useState(details.tags.join(", "));
  const [followUpState, setFollowUpState] = useState<ContactFollowUpState>(details.followUpState);
  const [followUpAt, setFollowUpAt] = useState(toLocalDateTime(details.followUpAt));
  return (
    <section className="contacts-control-section member-editor">
      <div className="control-title"><img className="avatar" alt="" src={member.person.character.thumbnailUrl} /> {member.person.displayName}</div>
      <label className="field">관계 표시<input className="text-input" maxLength={80} onChange={(event) => setLabel(event.target.value)} value={label} /></label>
      <label className="field">태그<input className="text-input" maxLength={300} onChange={(event) => setTags(event.target.value)} value={tags} /></label>
      <label className="field">후속 상태
        <select className="text-input" onChange={(event) => setFollowUpState(event.target.value as ContactFollowUpState)} value={followUpState}>
          <option value="none">없음</option><option value="planned">예정</option><option value="waiting">대기</option><option value="completed">완료</option>
        </select>
      </label>
      <label className="field">후속 시간<input className="text-input" onChange={(event) => setFollowUpAt(event.target.value)} type="datetime-local" value={followUpAt} /></label>
      <label className="field">메모<textarea className="text-input member-notes" maxLength={2000} onChange={(event) => setNotes(event.target.value)} value={notes} /></label>
      <div className="control-actions split-actions">
        <button
          className="secondary-button"
          disabled={disabled}
          onClick={() => onSave({
            followUpAt: followUpAt ? new Date(followUpAt).toISOString() : null,
            followUpState,
            label,
            notes,
            tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean)
          })}
          type="button"
        ><Save size={16} /> 저장</button>
        <button className="icon-button danger-button" disabled={disabled} onClick={onRemove} title="구성원 제외" type="button"><Trash2 size={17} /></button>
      </div>
    </section>
  );
}

function collectionKey(collection: ContactCollectionView) {
  return `collection:${collection.isOwner ? "owner" : "shared"}:${collection.id}`;
}

function requestKey(collectionId: string) {
  return `request:${collectionId}`;
}

function selectionExists(dashboard: ContactsDashboard, selection: string) {
  return dashboard.consentRequests.some((request) => requestKey(request.collectionId) === selection)
    || [...dashboard.ownedCollections, ...dashboard.sharedCollections].some((collection) => collectionKey(collection) === selection);
}

function defaultSelection(dashboard: ContactsDashboard) {
  const request = dashboard.consentRequests[0];
  if (request) return requestKey(request.collectionId);
  const owned = dashboard.ownedCollections[0];
  if (owned) return collectionKey(owned);
  const shared = dashboard.sharedCollections[0];
  return shared ? collectionKey(shared) : "";
}

function sharedFieldLabel(field: string) {
  return {
    collection_description: "그룹 설명",
    collection_name: "그룹 이름",
    consenting_member_profiles: "동의한 구성원 프로필",
    owner_profile: "소유자 프로필"
  }[field] ?? field;
}

function toLocalDateTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
