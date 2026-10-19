import { useEffect, useState } from "react";
import {
  Check,
  CheckSquare,
  Download,
  ExternalLink,
  Filter,
  Globe2,
  ListChecks,
  Loader2,
  RefreshCcw,
  Search,
  Square,
  Video,
  Wand2,
  X
} from "lucide-react";
import { clampPercent, formatBytes } from "../lib/format.js";
import { AppButton, classNames } from "../components/AppButton.jsx";
import IconBox from "../components/IconBox.jsx";

const emptyVideoFilters = {
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

function videoPosterUrl(video) {
  if (!video?.poster) {
    return "";
  }

  const params = new URLSearchParams({
    url: video.poster,
    referer: video.referer || video.sourcePage || ""
  });
  return `/api/images/preview?${params.toString()}`;
}

function videoVariants(video) {
  if (Array.isArray(video?.variants) && video.variants.length) {
    return video.variants;
  }

  return video ? [video] : [];
}

function videoQualityLabel(video, fallback = "Source") {
  if (video?.qualityLabel) {
    return video.qualityLabel;
  }
  if (video?.qualityHeight) {
    return `${video.qualityHeight}p`;
  }
  return fallback;
}

function videoVariantValue(variant, index = 0) {
  if (variant?.id) {
    return variant.id;
  }
  const parts = [
    variant?.extractor,
    variant?.formatId,
    variant?.formatSelector,
    variant?.url
  ].filter(Boolean);
  return parts.length ? parts.join("|") : String(index);
}

function VideoPoster({ video }) {
  const posterUrl = videoPosterUrl(video);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [posterUrl]);

  if (!posterUrl || failed) {
    return (
      <span className="video-preview-placeholder">
        <Video size={28} />
        <small>Open preview</small>
      </span>
    );
  }

  return <img src={posterUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function VideosTab({
  videoBrowser,
  videoUseBrowserLogin,
  videoCookiesFile,
  videoDownloadJob,
  videoDownloadResult,
  videoEntries,
  videoFilterOptions,
  videoFilters,
  videoPageUrl,
  videoScan,
  videoVerification,
  videoStatus,
  isDownloadingVideos,
  isScanningVideos,
  isVerifyingVideo,
  onClearVideos,
  onClearVisibleVideos,
  onCancelVideoDownload,
  onVideoBrowserChange,
  onVideoUseBrowserLoginChange,
  onVideoCookiesFileChange,
  onDownloadVideos,
  onOpenVideo,
  onRangeSelectSubmit,
  onRangeSelectValueChange,
  onResetVideoFilters,
  onScanVideos,
  onVerifyVideos,
  onSelectAllVideos,
  onSelectFailedVideos,
  onSelectVisibleVideos,
  onToggleVideo,
  onVideoFilterChange,
  onVideoQualityChange,
  onVideoPageUrlChange,
  videoRangeSelectValue,
  visibleVideoEntries,
  selectedVideoKeys
}) {
  const videos = Array.isArray(videoScan.videos) ? videoScan.videos : [];
  const selectedVideoEntries = videoEntries.filter((entry) => selectedVideoKeys.has(entry.key));
  const selectedVideos = selectedVideoEntries.map((entry) => entry.video);
  const selectedVisibleCount = visibleVideoEntries.filter((entry) => selectedVideoKeys.has(entry.key)).length;
  const selectedBytes = videoDownloadResult?.files?.reduce((total, file) => total + (file.bytes || 0), 0) || 0;
  const activeVideoJob = isDownloadingVideos ? videoDownloadJob : null;
  const activeJobItems = Array.isArray(activeVideoJob?.items) ? activeVideoJob.items : [];
  const activeJobItem = activeJobItems.find((item) => item.status === "downloading")
    || activeJobItems.find((item) => item.status === "queued")
    || activeJobItems[0];
  const progressPercent = videoDownloadJobPercent(activeVideoJob);
  const progressBytesDownloaded = activeVideoJob?.bytesDownloaded || 0;
  const progressBytesTotal = activeVideoJob?.bytesTotal || selectedVideos.reduce((total, video) => total + (video.bytes || 0), 0);
  const downloadedVideos = activeVideoJob ? activeVideoJob.downloaded || 0 : videoDownloadResult?.downloaded || 0;
  const requestedVideos = activeVideoJob ? activeVideoJob.requested || 0 : videoDownloadResult?.requested || 0;
  const statusBytes = activeVideoJob ? progressBytesDownloaded : selectedBytes;
  const hasActiveFilters = Object.entries(videoFilters).some(([key, value]) => value && value !== emptyVideoFilters[key]);
  const needsBilibiliLogin = videoVerification?.reason === "bilibili-login";

  return (
    <section className="tab-surface video-surface" role="tabpanel" aria-label="Videos">
      <form className="page-url-row" onSubmit={onScanVideos}>
        <label htmlFor="video-page-url">Video link, share text or BV ID</label>
        <div className="url-control">
          <Globe2 size={22} />
          <input
            id="video-page-url"
            value={videoPageUrl}
            onChange={(event) => onVideoPageUrlChange(event.target.value)}
            placeholder="Paste a BiliBili / Douyin link, share text or BV ID"
            spellCheck="false"
          />
        </div>
        <AppButton tone="primary" className="scan-button" type="submit" disabled={isScanningVideos || !videoPageUrl.trim()}>
          {isScanningVideos ? <Loader2 className="spin" size={23} /> : <Wand2 size={23} />}
          Scan videos
        </AppButton>
      </form>

      {videoVerification?.canVerifyInBrowser ? (
        <div className="video-verification-card" aria-label="Browser verification" aria-busy={isVerifyingVideo}>
          <div>
            <strong>{isVerifyingVideo ? "Waiting for browser verification" : needsBilibiliLogin ? "Sign in to restore BiliBili quality" : "This site needs browser verification"}</strong>
            <p>{videoVerification.message}</p>
            <small>{needsBilibiliLogin
              ? "Sign in to BiliBili in the dedicated browser window and keep it open. Your site session is saved for future scans. Available quality depends on the video and your account."
              : "Complete the verification in the dedicated browser window that opens. Keep it open; scanning continues automatically when verification is complete."}</small>
          </div>
          <AppButton tone="primary" type="button" onClick={onVerifyVideos} disabled={isScanningVideos}>
            {isVerifyingVideo ? <Loader2 className="spin" size={20} /> : <Globe2 size={20} />}
            {isVerifyingVideo ? "Waiting for verification..." : needsBilibiliLogin ? "Sign in to BiliBili and rescan" : "Verify in browser and retry"}
          </AppButton>
        </div>
      ) : null}

      <div className="bilibili-auth-row">
        <div className="bilibili-quick-guide">
          <strong>BiliBili &amp; Douyin</strong>
          <small>The highest available video quality is selected automatically. Original quality depends on what the site provides and your account can access.</small>
          <div className="bilibili-format-chips" aria-label="Video output choices">
            <span>Best available quality</span>
            <span>1080p+ when available</span>
            <span>MP3 audio</span>
          </div>
        </div>
        <div className="bilibili-login-controls">
          <label className="bilibili-auth-toggle">
            <input
              type="checkbox"
              checked={videoUseBrowserLogin}
              onChange={(event) => onVideoUseBrowserLoginChange(event.target.checked)}
            />
            <span>
              <strong>Use external browser login</strong>
              <small>Optional alternative: use another browser or cookies.txt. Saved site sessions are reused automatically.</small>
            </span>
          </label>
          <select
            aria-label="Video login browser"
            value={videoBrowser}
            onChange={(event) => onVideoBrowserChange(event.target.value)}
            disabled={!videoUseBrowserLogin || Boolean(videoCookiesFile?.trim())}
          >
            <option value="edge">Microsoft Edge</option>
            <option value="chrome">Google Chrome</option>
            <option value="firefox">Mozilla Firefox</option>
          </select>
          {videoUseBrowserLogin ? (
            <div className="video-cookies-file-control">
              <label htmlFor="video-cookies-file">Cookies file path (optional)</label>
              <input
                id="video-cookies-file"
                value={videoCookiesFile}
                onChange={(event) => onVideoCookiesFileChange(event.target.value)}
                placeholder={"C:\\Users\\you\\Downloads\\cookies.txt"}
                spellCheck="false"
                autoComplete="off"
                aria-describedby="video-cookies-file-help"
              />
              <small id="video-cookies-file-help">If browser cookies cannot be decrypted, use an exported Netscape cookies.txt file. This local file replaces the browser selection; its path is not saved.</small>
            </div>
          ) : null}
        </div>
        <p>
          BiliBili public access often stops at 480p. Enable login and scan again for qualities available to your account. Douyin may also need a fresh login to find the video.
        </p>
        {videoScan.authenticationWarning ? <p className="bilibili-auth-warning" role="status">{videoScan.authenticationWarning}</p> : null}
        {videoScan.qualityWarning ? <p className="bilibili-auth-warning" role="status">{videoScan.qualityWarning}</p> : null}
      </div>

      <div className="filter-bar" aria-label="Video filters">
        <div className="filter-heading">
          <Filter size={19} />
          <strong>Filters</strong>
          {hasActiveFilters ? <span>{visibleVideoEntries.length}/{videos.length} visible</span> : <span>{videos.length} visible</span>}
        </div>
        <label className="filter-control search-filter">
          <span>Search</span>
          <div className="filter-input-with-icon">
            <Search size={17} />
            <input
              value={videoFilters.search}
              onChange={(event) => onVideoFilterChange("search", event.target.value)}
              placeholder="filename, host, URL"
              spellCheck="false"
              disabled={!videos.length}
            />
          </div>
        </label>
        <label className="filter-control">
          <span>Host</span>
          <select value={videoFilters.host} onChange={(event) => onVideoFilterChange("host", event.target.value)} disabled={!videos.length}>
            <option value="all">All hosts</option>
            {videoFilterOptions.hosts.map((host) => (
              <option key={host} value={host}>{host}</option>
            ))}
          </select>
        </label>
        <label className="filter-control">
          <span>Type</span>
          <select value={videoFilters.type} onChange={(event) => onVideoFilterChange("type", event.target.value)} disabled={!videos.length}>
            <option value="all">All types</option>
            {videoFilterOptions.types.map((type) => (
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
            value={videoFilters.minNumber}
            onChange={(event) => onVideoFilterChange("minNumber", event.target.value)}
            disabled={!videos.length}
          />
        </label>
        <label className="filter-control number-filter">
          <span>Max</span>
          <input
            min="1"
            type="number"
            inputMode="numeric"
            value={videoFilters.maxNumber}
            onChange={(event) => onVideoFilterChange("maxNumber", event.target.value)}
            disabled={!videos.length}
          />
        </label>
        <AppButton tone="secondary" onClick={onResetVideoFilters} disabled={!hasActiveFilters}>
          <RefreshCcw size={17} />
          Reset
        </AppButton>
      </div>

      <div className="action-row">
        <div className="action-group image-selection-actions">
          <AppButton tone="secondary" onClick={onSelectAllVideos} disabled={!videos.length}>
            <CheckSquare size={20} />
            Select all
          </AppButton>
          <AppButton tone="secondary" onClick={onSelectVisibleVideos} disabled={!visibleVideoEntries.length}>
            <ListChecks size={20} />
            Select visible
          </AppButton>
          <AppButton tone="secondary" onClick={onClearVisibleVideos} disabled={!visibleVideoEntries.length || !selectedVisibleCount}>
            <Square size={20} />
            Clear visible
          </AppButton>
          <AppButton tone="secondary" onClick={onClearVideos} disabled={!videos.length}>
            <X size={18} />
            Clear all
          </AppButton>
          <form className="page-select-control range-select-control" onSubmit={onRangeSelectSubmit}>
            <label htmlFor="video-range-select">Range</label>
            <input
              id="video-range-select"
              type="text"
              placeholder="1-20, odd, failed"
              value={videoRangeSelectValue}
              onChange={(event) => onRangeSelectValueChange(event.target.value)}
              disabled={!videos.length}
            />
            <AppButton
              tone="secondary"
              className="page-select-button"
              type="submit"
              disabled={!videos.length || !videoRangeSelectValue.trim()}
            >
              <Check size={18} />
              Select
            </AppButton>
          </form>
        </div>
        <div className="action-group align-end">
          <AppButton
            tone="secondary"
            onClick={() => onOpenVideo(selectedVideoEntries[0]?.video, selectedVideoEntries[0]?.index)}
            disabled={!selectedVideoEntries.length}
          >
            <ExternalLink size={20} />
            Open preview
          </AppButton>
          <AppButton tone="accent" onClick={onDownloadVideos} disabled={isDownloadingVideos || !selectedVideos.length}>
            {isDownloadingVideos ? <Loader2 className="spin" size={20} /> : <Download size={21} />}
            Download selected
          </AppButton>
          {isDownloadingVideos ? (
            <AppButton tone="secondary" onClick={onCancelVideoDownload}>
              <X size={18} />
              Stop
            </AppButton>
          ) : null}
        </div>
      </div>

      {activeVideoJob ? (
        <div className="download-progress-panel" role="status" aria-label="Video download progress">
          <div className="download-progress-header">
            <strong>{activeJobItem?.filename || "Downloading video"}</strong>
            <span>{progressPercent}%</span>
          </div>
          <div className="download-progress-track" aria-hidden="true">
            <i style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="download-progress-meta">
            <span>
              {formatBytes(progressBytesDownloaded)} / {progressBytesTotal ? formatBytes(progressBytesTotal) : "Unknown size"}
            </span>
            <span>{activeVideoJob.completed || 0}/{activeVideoJob.requested || selectedVideos.length} finished</span>
          </div>
        </div>
      ) : null}

      <div className="data-table video-table" aria-label="Scanned videos">
        <div className="table-head video-grid">
          <span className="check-cell">
            <IconBox checked={visibleVideoEntries.length > 0 && selectedVisibleCount === visibleVideoEntries.length} muted />
          </span>
          <span>Preview</span>
          <span>Filename</span>
          <span>Quality</span>
          <span>Source URL</span>
          <span>Open</span>
        </div>

        {visibleVideoEntries.length ? (
          visibleVideoEntries.map(({ video, index, key, host, type, number }) => {
            const checked = selectedVideoKeys.has(key);
            const variants = videoVariants(video);
            const selectedQualityUrl = video.selectedQualityUrl || video.url || variants[0]?.url || "";
            const selectedVariant = variants.find((variant) =>
              variant.url === selectedQualityUrl &&
              (!video.formatId || variant.formatId === video.formatId)
            ) || variants[0];
            const selectedQualityValue = video.selectedQualityKey || videoVariantValue(selectedVariant, 0);
            const qualityLabel = videoQualityLabel(video, "Source");
            return (
              <div className="table-row video-grid" key={key}>
                <button
                  className="check-cell selection-check"
                  type="button"
                  aria-label={`${checked ? "Deselect" : "Select"} ${video.filename || `video-${index + 1}`}`}
                  aria-pressed={checked}
                  onClick={() => onToggleVideo(key)}
                >
                  <IconBox checked={checked} />
                </button>
                <button
                  className="preview-frame video-preview-frame"
                  type="button"
                  onClick={() => onOpenVideo(video, index)}
                  aria-label={`Open preview for ${video.filename}`}
                >
                  <VideoPoster video={video} />
                </button>
                <div className="filename-cell">
                  <strong>{video.filename || `video-${index + 1}`}</strong>
                  <small>
                    {[
                      qualityLabel,
                      video.bytes ? formatBytes(video.bytes) : video.displaySize,
                      video.contentType || video.kind || `${type} from ${host}`
                    ].filter(Boolean).join(" - ")} - #{number}
                  </small>
                </div>
                <div className="quality-cell">
                  {variants.length > 1 ? (
                    <select
                      value={selectedQualityValue}
                      onChange={(event) => onVideoQualityChange(key, event.target.value)}
                      aria-label={`Quality for ${video.filename || `video-${index + 1}`}`}
                    >
                      {variants.map((variant, variantIndex) => (
                        <option key={videoVariantValue(variant, variantIndex)} value={videoVariantValue(variant, variantIndex)}>
                          {[
                            videoQualityLabel(variant, `Source ${variantIndex + 1}`),
                            variant.bytes ? formatBytes(variant.bytes) : variant.displaySize
                          ].filter(Boolean).join(" - ")}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="quality-pill">{qualityLabel}</span>
                  )}
                </div>
                <span className="source-cell">{video.url}</span>
                <AppButton tone="secondary" className="open-row-button" onClick={() => onOpenVideo(video, index)}>
                  <ExternalLink size={18} />
                  Open
                </AppButton>
              </div>
            );
          })
        ) : videos.length ? (
          <div className="empty-table-state">
            <Search size={42} />
            <h2>No videos match</h2>
            <p>Adjust the filters to bring scanned videos back into view.</p>
          </div>
        ) : (
          <div className="empty-table-state">
            <Video size={42} />
            <h2>No videos scanned yet</h2>
            <p>Paste a page URL, then scan to preview downloadable videos.</p>
          </div>
        )}
      </div>

      <footer className="status-bar">
        <div className="status-cluster">
          <span className={classNames("status-orb", videoStatus.tone)}>
            {videoStatus.tone === "busy" ? <Loader2 className="spin" size={21} /> : <Check size={21} />}
          </span>
          <strong>{videoStatus.message}</strong>
        </div>
        <span>Found: {videos.length} videos</span>
        <span>Visible: {visibleVideoEntries.length} videos</span>
        <span>Selected: {selectedVideos.length} videos</span>
        <span>
          Downloaded: {downloadedVideos}
          {requestedVideos ? `/${requestedVideos}` : ""} videos ({formatBytes(statusBytes)})
        </span>
        {videoDownloadResult?.failed ? (
          <div className="summary-status-actions">
            <AppButton tone="outline" className="summary-status-button" onClick={onSelectFailedVideos}>
              Select failed
            </AppButton>
          </div>
        ) : null}
        <span className="ready-mark">Ready</span>
      </footer>
    </section>
  );
}

export default VideosTab;
