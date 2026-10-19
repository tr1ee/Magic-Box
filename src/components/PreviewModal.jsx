import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { formatBytes } from "../lib/format.js";

function VideoModalPreview({ preview }) {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [preview.previewUrl]);

  if (hasError) {
    return (
      <div className="preview-loading">
        <X size={28} />
        <span>Preview unavailable.</span>
      </div>
    );
  }

  return (
    <video
      src={preview.previewUrl}
      poster={preview.poster || undefined}
      controls
      autoPlay
      muted
      playsInline
      preload="metadata"
      onError={() => setHasError(true)}
    />
  );
}

export default function PreviewModal({ preview, onClose }) {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => { setImageFailed(false); }, [preview?.previewUrl]);
  useEffect(() => {
    if (!preview) return undefined;
    const previous = document.activeElement;
    closeRef.current?.focus();
    const handleKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); }
      if (event.key === "Tab") {
        const controls = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), video[controls], [tabindex="0"]') || [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previous?.focus?.(); };
  }, [Boolean(preview)]);
  if (!preview) {
    return null;
  }

  const videoMeta = preview.mediaType === "video"
    ? [
        preview.qualityLabel,
        preview.bytes ? formatBytes(preview.bytes) : preview.displaySize,
        preview.contentType
      ].filter(Boolean).join(" - ")
    : "";

  return (
    <div className="preview-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="preview-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={preview.mediaType === "video" ? "Video preview" : "Image preview"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="preview-modal-header">
          <div>
            <strong>{preview.title || "Image preview"}</strong>
            {preview.pageLabel ? <span>{preview.pageLabel}</span> : null}
          </div>
          <button className="icon-button" type="button" aria-label="Close preview" ref={closeRef} onClick={onClose}>
            <X size={21} />
          </button>
        </header>
        <div className="preview-modal-body">
          {preview.isLoading ? (
            <div className="preview-loading">
              <Loader2 className="spin" size={28} />
              <span>Loading preview...</span>
            </div>
          ) : preview.previewUrl && preview.mediaType === "video" ? (
            <VideoModalPreview preview={preview} />
          ) : preview.previewUrl && !imageFailed ? (
            <img src={preview.previewUrl} alt={preview.title || "Preview"} onError={() => setImageFailed(true)} />
          ) : (
            <div className="preview-loading">
              <X size={28} />
              <span>Preview unavailable.</span>
            </div>
          )}
        </div>
        <footer className="preview-modal-meta">
          {videoMeta ? <p className="preview-file-meta">{videoMeta}</p> : null}
          {preview.error ? <p className="preview-error-meta">{preview.error}</p> : null}
          {preview.sourcePage ? <code>{preview.sourcePage}</code> : null}
          {preview.sourceUrl ? <code>{preview.sourceUrl}</code> : null}
        </footer>
      </section>
    </div>
  );
}
