"use client";

import { FileWarning, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchBinary } from "../lib/api-client";

export function PdfViewer({ fileName, url }: { fileName: string; url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let loadingTask: { destroy: () => Promise<void> } | undefined;
    const renderTasks: Array<{ cancel: () => void }> = [];

    void (async () => {
      setState("loading");
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      const response = await fetchBinary(url, controller.signal);
      const data = await response.arrayBuffer();
      if (!active) return;
      const task = pdfjs.getDocument({ data });
      loadingTask = task;
      const pdfDocument = await task.promise;
      const container = containerRef.current;
      if (!active || !container) return;
      container.replaceChildren();
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        if (!active) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(260, container.clientWidth - 4);
        const viewport = page.getViewport({ scale: Math.min(2, availableWidth / baseViewport.width) });
        const canvas = window.document.createElement("canvas");
        canvas.className = "pdf-canvas";
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.setAttribute("aria-label", `${fileName} ${pageNumber}쪽`);
        container.append(canvas);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("PDF canvas is unavailable.");
        const renderTask = page.render({ canvas, canvasContext: context, viewport });
        renderTasks.push(renderTask);
        await renderTask.promise;
      }
      if (active) setState("ready");
    })().catch((error: unknown) => {
      if (active && !(error instanceof DOMException && error.name === "AbortError")) setState("failed");
    });

    return () => {
      active = false;
      controller.abort();
      for (const task of renderTasks) task.cancel();
      void loadingTask?.destroy();
    };
  }, [fileName, url]);

  return (
    <div className="pdf-viewer" aria-busy={state === "loading"}>
      {state === "loading" ? <div className="preview-state"><LoaderCircle className="spin" size={24} /> 문서 여는 중</div> : null}
      {state === "failed" ? <div className="preview-state"><FileWarning size={24} /> PDF를 열지 못했습니다.</div> : null}
      <div className="pdf-canvas-list" hidden={state === "failed"} ref={containerRef} />
    </div>
  );
}
