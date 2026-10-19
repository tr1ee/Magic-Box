import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckSquare,
  Download,
  ExternalLink,
  Filter,
  Globe2,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  RefreshCcw,
  RotateCcw,
  Search,
  Square,
  Wand2,
  X
} from "lucide-react";
import { clampPercent, formatBytes } from "../lib/format.js";
import { AppButton, classNames } from "../components/AppButton.jsx";
import IconBox from "../components/IconBox.jsx";

const emptyImageFilters = {
  search: "",
  host: "all",
  type: "all",
  minNumber: "",
  maxNumber: ""
};

function videoDownloadJobPercent(job) {
  if (!job) {
    return 0;
  }
  if (Number.isFinite(Number(job.percent))) {
    return clampPercent(job.percent);
  }

  return clampPercent((Number(job.progress) || 0) * 100);
}

function LazyImagePreview({ image, index, previewError, previewUrl, onOpen, onRequest }) {
  const frameRef = useRef(null);
  const [requested, setRequested] = useState(Boolean(previewUrl || previewError));

  useEffect(() => {
    if (previewUrl || previewError || requested) {
      return undefined;
    }
    const element = frameRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setRequested(true);
      onRequest(image, index);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRequested(true);
        onRequest(image, index);
        observer.disconnect();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [image, index, onRequest, previewError, previewUrl, requested]);

  return (
    <button
      ref={frameRef}
      className="preview-frame"
      type="button"
      onClick={onOpen}
      aria-label={`Open preview for ${image.filename || `image-${index + 1}`}`}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" />
      ) : previewError ? (
        <span>Preview unavailable</span>
      ) : requested ? (
        <Loader2 className="spin" size={20} />
      ) : (
        <ImageIcon className="preview-placeholder-icon" size={21} />
      )}
    </button>
  );
}

function ImagesTab({
  downloadResult,
  imageDownloadJob,
  imageEntries,
  imageFilterOptions,
  imageFilters,
  imagePageUrl,
  imageScan,
  imageStatus,
  isDownloadingImages,
  isScanningImages,
  onClearImages,
  onClearVisibleImages,
  onDownloadImages,
  onCancelImageDownload,
  onImageFilterChange,
  onImagePageUrlChange,
  onOpenImage,
  onOpenDownloadSummary,
  onRangeSelectSubmit,
  onRangeSelectValueChange,
  onResetImageFilters,
  onScanImages,
  onSelectAllImages,
  onSelectFailedImages,
  onRetryFailedImages,
  onSelectVisibleImages,
  onToggleImage,
  previewErrors,
  previewUrls,
  onRequestPreview,
  rangeSelectValue,
  visibleImageEntries,
  selectedImageKeys
}) {
  const images = Array.isArray(imageScan.images) ? imageScan.images : [];
  const selectedImageEntries = imageEntries.filter((entry) => selectedImageKeys.has(entry.key));
  const selectedImages = selectedImageEntries.map((entry) => entry.image);
  const selectedVisibleCount = visibleImageEntries.filter((entry) => selectedImageKeys.has(entry.key)).length;
  const selectedBytes = downloadResult?.files?.reduce((total, file) => total + (file.bytes || 0), 0) || 0;
  const activeImageJob = isDownloadingImages ? imageDownloadJob : null;
  const progressPercent = videoDownloadJobPercent(activeImageJob);
  const imageJobItems = Array.isArray(imageDownloadJob?.items) ? imageDownloadJob.items : [];
  const imageJobItemMap = useMemo(() => new Map(imageJobItems.map((item) => [Number(item.outputIndex), item])), [imageJobItems]);
  const activeJobItem = imageJobItems.find((item) => ["downloading", "retrying"].includes(item.status));
  const hasActiveFilters = Object.entries(imageFilters).some(([key, value]) => value && value !== emptyImageFilters[key]);

  return (
    <section className="tab-surface image-surface" role="tabpanel" aria-label="Images">
      <form className="page-url-row" onSubmit={onScanImages}>
        <label htmlFor="page-url">Page URL</label>
        <div className="url-control">
          <Globe2 size={22} />
          <input
            id="page-url"
            value={imagePageUrl}
            onChange={(event) => onImagePageUrlChange(event.target.value)}
            placeholder="https://example.com/gallery"
            spellCheck="false"
          />
        </div>
        <AppButton tone="primary" className="scan-button" type="submit" disabled={isScanningImages || !imagePageUrl.trim()}>
          {isScanningImages ? <Loader2 className="spin" size={23} /> : <Wand2 size={23} />}
          Scan images
        </AppButton>
      </form>

      <div className="filter-bar" aria-label="Image filters">
        <div className="filter-heading">
          <Filter size={19} />
          <strong>Filters</strong>
          {hasActiveFilters ? <span>{visibleImageEntries.length}/{images.length} visible</span> : <span>{images.length} visible</span>}
        </div>
        <label className="filter-control search-filter">
          <span>Search</span>
          <div className="filter-input-with-icon">
            <Search size={17} />
            <input
              value={imageFilters.search}
              onChange={(event) => onImageFilterChange("search", event.target.value)}
              placeholder="filename, host, URL"
              spellCheck="false"
              disabled={!images.length}
            />
          </div>
        </label>
        <label className="filter-control">
          <span>Host</span>
          <select value={imageFilters.host} onChange={(event) => onImageFilterChange("host", event.target.value)} disabled={!images.length}>
            <option value="all">All hosts</option>
            {imageFilterOptions.hosts.map((host) => (
              <option key={host} value={host}>{host}</option>
            ))}
          </select>
        </label>
        <label className="filter-control">
          <span>Type</span>
          <select value={imageFilters.type} onChange={(event) => onImageFilterChange("type", event.target.value)} disabled={!images.length}>
            <option value="all">All types</option>
            {imageFilterOptions.types.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="filter-control number-filter">
          <span>Min</span>
          <input
            min="1"
            type="number"
            inputMode="numeric"
            value={imageFilters.minNumber}
            onChange={(event) => onImageFilterChange("minNumber", event.target.value)}
            disabled={!images.length}
          />
        </label>
        <label className="filter-control number-filter">
          <span>Max</span>
          <input
            min="1"
            type="number"
            inputMode="numeric"
            value={imageFilters.maxNumber}
            onChange={(event) => onImageFilterChange("maxNumber", event.target.value)}
            disabled={!images.length}
          />
        </label>
        <AppButton tone="secondary" onClick={onResetImageFilters} disabled={!hasActiveFilters}>
          <RefreshCcw size={17} />
          Reset
        </AppButton>
      </div>

      <div className="action-row">
        <div className="action-group image-selection-actions">
          <AppButton tone="secondary" onClick={onSelectAllImages} disabled={!images.length}>
            <CheckSquare size={20} />
            Select all
          </AppButton>
          <AppButton tone="secondary" onClick={onSelectVisibleImages} disabled={!visibleImageEntries.length}>
            <ListChecks size={20} />
            Select visible
          </AppButton>
          <AppButton tone="secondary" onClick={onClearVisibleImages} disabled={!visibleImageEntries.length || !selectedVisibleCount}>
            <Square size={20} />
            Clear visible
          </AppButton>
          <AppButton tone="secondary" onClick={onClearImages} disabled={!images.length}>
            <X size={18} />
            Clear all
          </AppButton>
          <form className="page-select-control range-select-control" onSubmit={onRangeSelectSubmit}>
            <label htmlFor="image-range-select">Range</label>
            <input
              id="image-range-select"
              type="text"
              placeholder="1-20, odd, failed"
              value={rangeSelectValue}
              onChange={(event) => onRangeSelectValueChange(event.target.value)}
              disabled={!images.length}
            />
            <AppButton
              tone="secondary"
              className="page-select-button"
              type="submit"
              disabled={!images.length || !rangeSelectValue.trim()}
            >
              <Check size={18} />
              Select
            </AppButton>
          </form>
        </div>
        <div className="action-group align-end">
          <AppButton
            tone="secondary"
            onClick={() => onOpenImage(selectedImageEntries[0]?.image, selectedImageEntries[0]?.index)}
            disabled={!selectedImageEntries.length}
          >
            <ExternalLink size={20} />
            Open preview
          </AppButton>
          <AppButton tone="accent" onClick={onDownloadImages} disabled={isDownloadingImages || !selectedImages.length}>
            {isDownloadingImages ? <Loader2 className="spin" size={20} /> : <Download size={21} />}
            Download selected
          </AppButton>
          {isDownloadingImages ? (
            <AppButton tone="secondary" onClick={onCancelImageDownload}>
              <X size={18} />
              Stop
            </AppButton>
          ) : downloadResult?.failed ? (
            <AppButton tone="secondary" onClick={onRetryFailedImages}>
              <RotateCcw size={18} />
              Retry failed
            </AppButton>
          ) : null}
        </div>
      </div>

      {activeImageJob ? (
        <div className="download-progress-panel" role="status" aria-label="Image download progress">
          <div className="download-progress-header">
            <strong>{activeJobItem?.filename || activeImageJob.activeFilename || "Preparing images"}</strong>
            <span>{progressPercent}%</span>
          </div>
          <div className="download-progress-track" aria-hidden="true">
            <i style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="download-progress-meta">
            <span>
              {formatBytes(activeImageJob.bytesDownloaded || 0)} / {activeImageJob.bytesTotal ? formatBytes(activeImageJob.bytesTotal) : "Size discovered while downloading"}
            </span>
            <span>
              {activeImageJob.completed || 0}/{activeImageJob.requested || selectedImages.length} finished · {activeImageJob.failed || 0} failed · {activeImageJob.skipped || 0} skipped
            </span>
          </div>
        </div>
      ) : null}

      <div className="data-table image-table" aria-label="Scanned images">
        <div className="table-head image-grid">
          <span className="check-cell">
            <IconBox checked={visibleImageEntries.length > 0 && selectedVisibleCount === visibleImageEntries.length} muted />
          </span>
          <span>Preview</span>
          <span>Filename</span>
          <span>Source URL</span>
          <span>Open</span>
        </div>

        {visibleImageEntries.length ? (
          visibleImageEntries.map(({ image, index, key, host, type, number }) => {
            const checked = selectedImageKeys.has(key);
            const previewUrl = previewUrls[key];
            const previewError = previewErrors[key];
            const jobItem = imageJobItemMap.get(Number(image.listIndex || image.pageNumber || index + 1));
            return (
              <div className="table-row image-grid" key={key}>
                <button
                  className="check-cell selection-check"
                  type="button"
                  aria-label={`${checked ? "Deselect" : "Select"} ${image.filename || `image-${index + 1}`}`}
                  aria-pressed={checked}
                  onClick={() => onToggleImage(key)}
                >
                  <IconBox checked={checked} />
                </button>
                <LazyImagePreview
                  key={`${key}:${image.url}`}
                  image={image}
                  index={index}
                  previewError={previewError}
                  previewUrl={previewUrl}
                  onOpen={() => onOpenImage(image, index)}
                  onRequest={onRequestPreview}
                />
                <div className="filename-cell">
                  <strong>{image.filename || `image-${index + 1}`}</strong>
                  <small>{image.displaySize || image.kind || `${type} from ${host}`} - #{number}</small>
                  {jobItem ? <span className={classNames("image-row-status", `is-${jobItem.status}`)}>{jobItem.status}</span> : null}
                </div>
                <span className="source-cell">{image.url}</span>
                <AppButton tone="secondary" className="open-row-button" onClick={() => onOpenImage(image, index)}>
                  <ExternalLink size={18} />
                  Open
                </AppButton>
              </div>
            );
          })
        ) : images.length ? (
          <div className="empty-table-state">
            <Search size={42} />
            <h2>No images match</h2>
            <p>Adjust the filters to bring scanned images back into view.</p>
          </div>
        ) : (
          <div className="empty-table-state">
            <ImageIcon size={42} />
            <h2>No images scanned yet</h2>
            <p>Paste a gallery or page URL, then scan to preview downloadable images.</p>
          </div>
        )}
      </div>

      <footer className="status-bar">
        <div className="status-cluster">
          <span className={classNames("status-orb", imageStatus.tone)}>
            {imageStatus.tone === "busy" ? <Loader2 className="spin" size={21} /> : <Check size={21} />}
          </span>
          <strong>{imageStatus.message}</strong>
        </div>
        <span>Found: {images.length} images</span>
        <span>Visible: {visibleImageEntries.length} images</span>
        <span>Selected: {selectedImages.length} images</span>
        {imageScan.galleryName ? <span>Gallery folder: {imageScan.galleryName}</span> : null}
        <span>
          Downloaded: {downloadResult?.downloaded || 0}
          {downloadResult?.requested ? `/${downloadResult.requested}` : ""} images ({formatBytes(selectedBytes)})
        </span>
        {downloadResult?.skipped ? <span>Skipped: {downloadResult.skipped}</span> : null}
        {downloadResult?.failed ? <span>Failed: {downloadResult.failed}</span> : null}
        {downloadResult ? (
          <div className="summary-status-actions">
            <AppButton tone="secondary" className="summary-status-button" onClick={onOpenDownloadSummary}>
              View summary
            </AppButton>
            {downloadResult.failed ? (
              <AppButton tone="outline" className="summary-status-button" onClick={onSelectFailedImages}>
                Select failed
              </AppButton>
            ) : null}
          </div>
        ) : null}
        <span className="ready-mark">Ready</span>
      </footer>
    </section>
  );
}

export default ImagesTab;
