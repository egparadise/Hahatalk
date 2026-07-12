"use client";

import {
  Archive,
  Download,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2,
  XCircle
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  Attachment,
  MediaAlbumView,
  MediaArchiveScope,
  MediaAssetView,
  MediaLibraryView
} from "@hahatalk/contracts";
import { fetchBinary, resolveApiUrl } from "../lib/api-client";
import { PdfViewer } from "./pdf-viewer";

export type MediaUploadTaskView = {
  fileName: string;
  progress: number;
  status: "idle" | "hashing" | "uploading" | "processing" | "done" | "failed" | "aborting";
  error?: string;
};

type MediaPanelProps = {
  albumName: string;
  attachments: Attachment[];
  capturedDraft: string;
  currentUserId: string;
  dateFilter: string;
  isUploading: boolean;
  library: MediaLibraryView;
  placeDraft: string;
  placeFilter: string;
  scopeFilter: "" | MediaArchiveScope;
  selectedAlbumId: string;
  selectedAssetId: string;
  uploadTask: MediaUploadTaskView;
  onAbortUpload: () => void;
  onAddToAlbum: (albumId: string, assetId: string) => void;
  onAlbumNameChange: (value: string) => void;
  onCapturedDraftChange: (value: string) => void;
  onCreateAlbum: () => void;
  onDateFilterChange: (value: string) => void;
  onDownload: (asset: { downloadUrl?: string; fileName: string }) => void;
  onPlaceDraftChange: (value: string) => void;
  onPlaceFilterChange: (value: string) => void;
  onRefresh: () => void;
  onRetryUpload: () => void;
  onRevokeShare: (assetId: string, messageId: string) => void;
  onSaveMetadata: () => void;
  onScopeFilterChange: (value: "" | MediaArchiveScope) => void;
  onSelectAlbum: (value: string) => void;
  onSelectAsset: (assetId: string) => void;
  onShareAsset: (asset: MediaAssetView) => void;
  onTrashAsset: (assetId: string) => void;
};

export function MediaPanel(props: MediaPanelProps) {
  const selectedAsset = props.library.assets.find((asset) => asset.id === props.selectedAssetId);
  const selectedAttachment = props.attachments.find((attachment) => attachment.assetId === props.selectedAssetId)
    ?? props.attachments.at(-1);
  const preview = selectedAsset ?? selectedAttachment;

  return (
    <>
      {props.uploadTask.status !== "idle" ? (
        <section className="panel-section media-upload-status" aria-live="polite">
          <div className="panel-title-row">
            <h2 className="panel-title"><LoaderCircle className={props.isUploading ? "spin" : ""} size={17} /> 전송</h2>
            {props.isUploading ? (
              <button className="icon-button" onClick={props.onAbortUpload} title="업로드 취소" type="button"><Square size={15} /></button>
            ) : props.uploadTask.status === "failed" ? (
              <button className="icon-button" onClick={props.onRetryUpload} title="다시 시도" type="button"><RotateCcw size={16} /></button>
            ) : null}
          </div>
          <strong className="media-file-name">{props.uploadTask.fileName}</strong>
          <div className="media-progress" aria-label={`업로드 ${props.uploadTask.progress}%`}>
            <span style={{ width: `${props.uploadTask.progress}%` }} />
          </div>
          <span className="tiny">{uploadStatusLabel(props.uploadTask)}</span>
        </section>
      ) : null}

      <section className="panel-section">
        <div className="panel-title-row">
          <h2 className="panel-title"><Archive size={17} /> 내 보관함</h2>
          <button className="icon-button" onClick={props.onRefresh} title="보관함 새로고침" type="button"><RefreshCw size={16} /></button>
        </div>
        <div className="media-filter-grid">
          <label className="field">날짜<input className="text-input" type="date" value={props.dateFilter} onChange={(event) => props.onDateFilterChange(event.target.value)} /></label>
          <label className="field">장소<input className="text-input" placeholder="장소" value={props.placeFilter} onChange={(event) => props.onPlaceFilterChange(event.target.value)} /></label>
        </div>
        <div className="segmented-control media-scope-control" aria-label="보관 범위">
          {([
            ["", "전체"],
            ["private_archive", "내 보관"],
            ["shared", "전체 공유"],
            ["selected", "선택 공유"]
          ] as const).map(([value, label]) => (
            <button data-active={props.scopeFilter === value} key={value || "all"} onClick={() => props.onScopeFilterChange(value)} type="button">{label}</button>
          ))}
        </div>
        <button className="secondary-button media-search-button" onClick={props.onRefresh} type="button"><Search size={16} /> 찾기</button>

        <div className="media-library-list">
          {props.library.assets.length === 0 ? <p className="panel-muted">조건에 맞는 보관 파일이 없습니다.</p> : props.library.assets.map((asset) => (
            <div className="media-library-row" data-selected={asset.id === props.selectedAssetId} key={asset.id}>
              <button className="media-library-main" onClick={() => props.onSelectAsset(asset.id)} type="button">
                {asset.mediaKind === "image" ? <ImageIcon size={20} /> : <FileText size={20} />}
                <span><strong>{asset.fileName}</strong><small>{formatBytes(asset.sizeBytes)} · {scopeLabel(asset.archiveScope)}</small></span>
              </button>
              <div className="media-row-actions">
                {asset.processingStatus === "ready" ? <button className="icon-button" onClick={() => props.onShareAsset(asset)} title="현재 대상으로 공유" type="button"><Send size={15} /></button> : null}
                {asset.downloadUrl ? <button className="icon-button" onClick={() => props.onDownload(asset)} title="다운로드" type="button"><Download size={15} /></button> : null}
                <button className="icon-button danger-button" onClick={() => props.onTrashAsset(asset.id)} title="휴지통으로 이동" type="button"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-section">
        <h2 className="panel-title"><FolderOpen size={17} /> 앨범</h2>
        <div className="media-inline-form">
          <input className="text-input" maxLength={80} placeholder="새 앨범 이름" value={props.albumName} onChange={(event) => props.onAlbumNameChange(event.target.value)} />
          <button className="icon-button" disabled={!props.albumName.trim()} onClick={props.onCreateAlbum} title="앨범 만들기" type="button"><Plus size={16} /></button>
        </div>
        {props.library.albums.length > 0 && props.selectedAssetId ? (
          <div className="media-inline-form">
            <select className="text-input" value={props.selectedAlbumId} onChange={(event) => props.onSelectAlbum(event.target.value)}>
              <option value="">앨범 선택</option>
              {props.library.albums.map((album) => <option key={album.id} value={album.id}>{album.name} ({album.assetIds.length})</option>)}
            </select>
            <button className="icon-button" disabled={!props.selectedAlbumId} onClick={() => props.onAddToAlbum(props.selectedAlbumId, props.selectedAssetId)} title="선택 파일을 앨범에 추가" type="button"><Plus size={16} /></button>
          </div>
        ) : null}
        <AlbumList albums={props.library.albums} onSelectAsset={props.onSelectAsset} />
      </section>

      {selectedAsset ? (
        <section className="panel-section">
          <h2 className="panel-title"><MapPin size={17} /> 날짜와 장소</h2>
          <label className="field">촬영 시각<input className="text-input" type="datetime-local" value={props.capturedDraft} onChange={(event) => props.onCapturedDraftChange(event.target.value)} /></label>
          <label className="field">장소<input className="text-input" maxLength={120} value={props.placeDraft} onChange={(event) => props.onPlaceDraftChange(event.target.value)} /></label>
          <button className="secondary-button" onClick={props.onSaveMetadata} type="button">저장</button>
        </section>
      ) : null}

      <section className="panel-section">
        <h2 className="panel-title"><FolderOpen size={17} /> 현재 대화 파일</h2>
        {props.attachments.length === 0 ? <p className="panel-muted">공유된 파일이 없습니다.</p> : props.attachments.map((attachment) => (
          <div className="media-library-row" data-selected={attachment.assetId === props.selectedAssetId} key={attachment.id}>
            <button className="media-library-main" onClick={() => props.onSelectAsset(attachment.assetId)} type="button">
              {attachment.mediaKind === "image" ? <ImageIcon size={20} /> : <FileText size={20} />}
              <span><strong>{attachment.fileName}</strong><small>{formatBytes(attachment.sizeBytes)} · {attachment.virusScanStatus}</small></span>
            </button>
            <div className="media-row-actions">
              {attachment.downloadUrl ? <button className="icon-button" onClick={() => props.onDownload(attachment)} title="다운로드" type="button"><Download size={15} /></button> : null}
              {attachment.uploaderId === props.currentUserId ? (
                <button className="icon-button danger-button" onClick={() => props.onRevokeShare(attachment.assetId, attachment.messageId)} title="공유 철회" type="button"><XCircle size={15} /></button>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <section className="panel-section">
        <h2 className="panel-title"><FileText size={17} /> 미리보기</h2>
        <MediaPreview media={preview} />
      </section>
    </>
  );
}

function AlbumList({ albums, onSelectAsset }: { albums: MediaAlbumView[]; onSelectAsset: (assetId: string) => void }) {
  if (!albums.length) return <p className="panel-muted">만든 앨범이 없습니다.</p>;
  return <div className="album-list">{albums.map((album) => (
    <div className="album-row" key={album.id}>
      <span><strong>{album.name}</strong><small>{album.assetIds.length}개</small></span>
      {album.assetIds[0] ? <button className="icon-button" onClick={() => onSelectAsset(album.assetIds[0]!)} title="앨범 첫 파일 열기" type="button"><FolderOpen size={15} /></button> : null}
    </div>
  ))}</div>;
}

function MediaPreview({ media }: { media: Attachment | MediaAssetView | undefined }) {
  if (!media) return <div className="file-preview panel-muted">파일 없음</div>;
  if (("processingStatus" in media && media.processingStatus === "blocked") || media.virusScanStatus === "blocked") {
    return <div className="file-preview blocked-preview"><XCircle size={28} /><strong>격리된 파일</strong></div>;
  }
  if (!media.previewUrl) return <div className="file-preview"><FileText size={30} /><strong>{media.fileName}</strong><span className="tiny">미리보기 없음</span></div>;
  if (media.mimeType === "application/pdf") return <PdfViewer fileName={media.fileName} url={media.previewUrl} />;
  const source = resolveApiUrl(media.previewUrl);
  if (media.mimeType.startsWith("image/")) return <div className="file-preview"><img alt={media.fileName} crossOrigin="use-credentials" src={source} /></div>;
  if (media.mimeType.startsWith("video/")) return <div className="file-preview"><video controls crossOrigin="use-credentials" src={source} /></div>;
  if (media.mimeType.startsWith("audio/")) return <div className="file-preview audio-preview"><audio controls crossOrigin="use-credentials" src={source} /></div>;
  if (media.mediaKind === "text") return <TextPreview url={media.previewUrl} />;
  return <div className="file-preview"><FileText size={30} /><strong>{media.fileName}</strong><span className="tiny">{media.mimeType}</span></div>;
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState("불러오는 중");
  useEffect(() => {
    const controller = new AbortController();
    void fetchBinary(url, controller.signal)
      .then((response) => response.text())
      .then((value) => setText(value.slice(0, 20_000)))
      .catch(() => setText("텍스트 미리보기를 열지 못했습니다."));
    return () => controller.abort();
  }, [url]);
  return <pre className="text-preview">{text}</pre>;
}

function uploadStatusLabel(task: MediaUploadTaskView) {
  if (task.status === "failed") return task.error ?? "업로드 실패";
  return {
    aborting: "취소 중",
    done: "완료",
    hashing: "무결성 확인 중",
    idle: "",
    processing: "보안 검사 중",
    uploading: `업로드 ${task.progress}%`
  }[task.status];
}

function scopeLabel(scope: MediaArchiveScope) {
  return { private_archive: "내 보관", selected: "선택 공유", shared: "전체 공유" }[scope];
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
