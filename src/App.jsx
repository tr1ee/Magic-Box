import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Check,
  ChevronRight,
  Download,
  Factory,
  Files,
  FolderOpen,
  History,
  Image as ImageIcon,
  Loader2,
  Menu,
  Mic,
  Sparkles,
  Video,
  X
} from "lucide-react";
import { api, retryableStatusError } from "./lib/api.js";
import { formatBytes } from "./lib/format.js";
import { clampPaneSize, readStoredPaneSize, storePaneSize } from "./lib/panes.js";
import { AppButton, classNames } from "./components/AppButton.jsx";
import AccessibleConfirmationDialog from "./components/AccessibleConfirmationDialog.jsx";
import PreviewModal from "./components/PreviewModal.jsx";

const LazyAssistant = lazy(() => import("./Assistant.jsx"));
const LazyFileTransferPage = lazy(() => import("./pages/FileTransferPage.jsx"));
const LazyFormatFactoryPage = lazy(() => import("./FormatFactory.jsx"));
const LazyHistoryPage = lazy(() => import("./pages/HistoryPage.jsx"));
const LazyImageDownloaderPage = lazy(() => import("./pages/ImageDownloaderPage.jsx"));
const LazyTorrentDownloaderPage = lazy(() => import("./pages/TorrentDownloaderPage.jsx"));
const LazyVideoDownloaderPage = lazy(() => import("./pages/VideoDownloaderPage.jsx"));
const LazyVoiceClonePage = lazy(() => import("./pages/VoiceClonePage.jsx"));

const emptyImageScan = {
  pageUrl: "",
  galleryName: "",
  count: 0,
  images: []
};
const emptyVideoScan = {
  pageUrl: "",
  count: 0,
  videos: []
};
const emptyImageFilters = {
  search: "",
  host: "all",
  type: "all",
  minNumber: "",
  maxNumber: ""
};
const emptyVideoFilters = {
  search: "",
  host: "all",
  type: "all",
  minNumber: "",
  maxNumber: ""
};
const DOWNLOAD_PATH_STORAGE_KEY = "magicBox.downloadPath";
const TOOL_PATHS_STORAGE_KEY = "magicBox.toolPaths.v1";
const DEFAULT_IMAGE_GALLERY_ROOT = "H:\\em";
const IMAGE_GALLERY_ROOT_MIGRATION_KEY = "magicBox.imageGalleryRoot.v1";
const DOWNLOAD_TOOL_IDS = ["torrents", "images", "videos", "voice-clone", "file-transfer", "format-factory"];
const IMAGE_SESSION_STORAGE_KEY = "magicBox.imageSession.v1";
const VIDEO_SESSION_STORAGE_KEY = "magicBox.videoSession.v1";
const OPENING_SEEN_STORAGE_KEY = "magicBox.openingSeen.v1";
const ACTIVE_VIEW_STORAGE_KEY = "magicBox.activeView.v1";
const TORRENT_SIDEBAR_WIDTH_STORAGE_KEY = "magicBox.torrentSidebarWidth.v1";
const OPENING_NAV_ITEMS = [
  { id: "toolbox", label: "Toolbox" },
  { id: "images", label: "Downloads" },
  { id: "voice-clone", label: "Voice Studio" },
  { id: "history", label: "History" }
];
const OPENING_PARTICLES = Array.from({ length: 18 }, (_, index) => ({
  id: index,
  left: `${8 + ((index * 17) % 88)}%`,
  top: `${12 + ((index * 23) % 76)}%`,
  delay: `${-((index * 0.73) % 8)}s`,
  duration: `${6.5 + (index % 5) * 1.2}s`,
  size: `${2 + (index % 4)}px`
}));

function readStoredActiveView() {
  if (/^#\/assistant(?:\/|$)/u.test(window.location.hash)) return "assistant";
  try {
    const stored = window.localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY);
    return ["toolbox", "assistant", "images", "videos", "voice-clone", "file-transfer", "format-factory", "history", "torrents"].includes(stored)
      ? stored
      : "toolbox";
  } catch {
    return "toolbox";
  }
}

function shouldShowOpeningPage() {
  try {
    return window.localStorage.getItem(OPENING_SEEN_STORAGE_KEY) !== "true";
  } catch {
    return true;
  }
}
const IMAGE_SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const IMAGE_SCAN_TIMEOUT_MESSAGE = "Image scan took more than 5 minutes. Try scanning again or use a smaller page.";
const VIDEO_SCAN_TIMEOUT_MS = 11 * 60 * 1000;
const VIDEO_SCAN_TIMEOUT_MESSAGE = "Video scan took more than 10 minutes. This site may be blocking automated access.";
const VIDEO_VERIFICATION_TIMEOUT_MS = 3 * 60 * 1000;
const VIDEO_VERIFICATION_TIMEOUT_MESSAGE = "Browser verification timed out. Retry and complete the verification in the dedicated browser window.";

function readStoredDownloadPath() {
  try {
    return window.localStorage.getItem(DOWNLOAD_PATH_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeDownloadPath(downloadPath) {
  try {
    if (downloadPath) {
      window.localStorage.setItem(DOWNLOAD_PATH_STORAGE_KEY, downloadPath);
    }
  } catch {
  }
}

function readStoredToolPaths() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(TOOL_PATHS_STORAGE_KEY) || "{}");
    return DOWNLOAD_TOOL_IDS.reduce((paths, toolId) => {
      if (typeof stored?.[toolId] === "string" && stored[toolId].trim()) {
        paths[toolId] = stored[toolId];
      }
      return paths;
    }, {});
  } catch {
    return {};
  }
}

function storeToolPaths(toolPaths) {
  try {
    window.localStorage.setItem(TOOL_PATHS_STORAGE_KEY, JSON.stringify(toolPaths));
  } catch {
    // Folder selection still works when local storage is unavailable.
  }
}

function shouldMigrateImageGalleryRoot() {
  try {
    return window.localStorage.getItem(IMAGE_GALLERY_ROOT_MIGRATION_KEY) !== "true";
  } catch {
    return false;
  }
}

function markImageGalleryRootMigrated() {
  try {
    window.localStorage.setItem(IMAGE_GALLERY_ROOT_MIGRATION_KEY, "true");
  } catch {
  }
}

function resolvedToolPaths({ storedPaths = {}, savedPaths = {}, legacyPath = "", platform = "", imageRootPath = "" } = {}) {
  return DOWNLOAD_TOOL_IDS.reduce((paths, toolId) => {
    const fallbackPath = toolId === "images" && platform === "win32"
      ? DEFAULT_IMAGE_GALLERY_ROOT
      : legacyPath;
    paths[toolId] = toolId === "images" && imageRootPath
      ? imageRootPath
      : storedPaths[toolId] || savedPaths[toolId] || fallbackPath;
    return paths;
  }, {});
}

function readStoredImageSession() {
  try {
    const stored = window.localStorage.getItem(IMAGE_SESSION_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const session = JSON.parse(stored);
    if (!session?.imageScan || !Array.isArray(session.imageScan.images) || !session.imageScan.images.length) {
      return null;
    }

    return {
      imagePageUrl: typeof session.imagePageUrl === "string" ? session.imagePageUrl : "",
      imageScan: session.imageScan,
      selectedImageKeys: Array.isArray(session.selectedImageKeys) ? session.selectedImageKeys : [],
      downloadResult: session.downloadResult || null,
      savedAt: Number(session.savedAt || 0)
    };
  } catch {
    return null;
  }
}

function storeImageSession(session) {
  try {
    window.localStorage.setItem(IMAGE_SESSION_STORAGE_KEY, JSON.stringify({
      ...session,
      savedAt: Date.now()
    }));
  } catch {
  }
}

function clearStoredImageSession() {
  try {
    window.localStorage.removeItem(IMAGE_SESSION_STORAGE_KEY);
  } catch {
  }
}

function readStoredVideoSession() {
  try {
    const stored = window.localStorage.getItem(VIDEO_SESSION_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const session = JSON.parse(stored);
    if (!session?.videoScan || !Array.isArray(session.videoScan.videos) || !session.videoScan.videos.length) {
      return null;
    }

    return {
      videoPageUrl: typeof session.videoPageUrl === "string" ? session.videoPageUrl : "",
      videoScan: session.videoScan,
      selectedVideoKeys: Array.isArray(session.selectedVideoKeys) ? session.selectedVideoKeys : [],
      videoDownloadResult: session.videoDownloadResult || null,
      savedAt: Number(session.savedAt || 0)
    };
  } catch {
    return null;
  }
}

function storeVideoSession(session) {
  try {
    window.localStorage.setItem(VIDEO_SESSION_STORAGE_KEY, JSON.stringify({
      ...session,
      savedAt: Date.now()
    }));
  } catch {
  }
}

function clearStoredVideoSession() {
  try {
    window.localStorage.removeItem(VIDEO_SESSION_STORAGE_KEY);
  } catch {
  }
}

async function notifyDesktop(title, message, tone = "info") {
  if (!message) {
    return false;
  }

  try {
    if (window.magicBox?.notify) {
      await window.magicBox.notify(title, message, tone);
      return true;
    }
  } catch {
  }

  try {
    const host = window.chrome?.webview?.hostObjects?.magicBoxHost;
    if (host?.Notify) {
      await host.Notify(title, message, tone);
      return true;
    }
  } catch {
  }

  try {
    if ("Notification" in window && window.Notification.permission === "granted") {
      new window.Notification(title || "Magic Box", { body: message });
      return true;
    }
  } catch {
  }

  return false;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

async function previewBlob(image) {
  const response = await fetch("/api/images/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Preview failed.");
  }

  return response.blob();
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function videoDownloadJobPercent(job) {
  if (!job) {
    return 0;
  }
  if (Number.isFinite(Number(job.percent))) {
    return clampPercent(job.percent);
  }

  return clampPercent((Number(job.progress) || 0) * 100);
}

function imageKey(image, index) {
  const crop = image.crop
    ? `${image.crop.x}:${image.crop.y}:${image.crop.width}:${image.crop.height}`
    : "full";
  const stableIndex = image.listIndex || image.pageNumber || index + 1;
  return `${stableIndex}:${crop}`;
}

function sourceName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

function imageOutputDir(downloadPath, platform) {
  if (!downloadPath) {
    return "";
  }

  return downloadPath;
}

function videoOutputDir(downloadPath, platform) {
  if (!downloadPath) {
    return "";
  }

  const separator = platform === "win32" ? "\\" : "/";
  return `${downloadPath.replace(/[\\/]+$/, "")}${separator}video-downloads`;
}

function videoPreviewUrl(video) {
  const params = new URLSearchParams({
    url: video.url || "",
    referer: video.referer || video.sourcePage || ""
  });
  if (video.httpHeaders && Object.keys(video.httpHeaders).length) {
    params.set("headers", JSON.stringify(video.httpHeaders));
  }
  return `/api/videos/preview?${params.toString()}`;
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

function videoWithVariant(video, variant, index) {
  if (!video || !variant) {
    return video;
  }

  return {
    ...video,
    ...variant,
    id: video.id || variant.id || `video-${index + 1}`,
    listIndex: video.listIndex || index + 1,
    variants: videoVariants(video),
    selectedQualityUrl: variant.url,
    selectedQualityKey: videoVariantValue(variant, index),
    poster: variant.poster || video.poster || "",
    sourcePage: variant.sourcePage || video.sourcePage || "",
    referer: variant.referer || video.referer || video.sourcePage || "",
    originalLabel: video.originalLabel || variant.originalLabel || null,
    qualityLabel: videoQualityLabel(variant),
    qualityHeight: variant.qualityHeight || null,
    qualityRank: variant.qualityRank || variant.qualityHeight || null,
    extractor: variant.extractor || video.extractor || null,
    extractorKey: variant.extractorKey || video.extractorKey || null,
    pageUrl: variant.pageUrl || video.pageUrl || null,
    formatId: variant.formatId || video.formatId || null,
    formatSelector: variant.formatSelector || video.formatSelector || null,
    formatExt: variant.formatExt || video.formatExt || null,
    hasAudio: typeof variant.hasAudio === "boolean" ? variant.hasAudio : video.hasAudio,
    httpHeaders: variant.httpHeaders || video.httpHeaders || null
  };
}

function imageHost(image) {
  try {
    return new URL(image.url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function imageType(image) {
  if (image.crop || image.isCrop) {
    return "slice";
  }

  try {
    const extension = image.filename
      ? image.filename.split(".").pop()
      : new URL(image.url).pathname.split(".").pop();
    return extension ? extension.toLowerCase().replace(/[^a-z0-9]+/g, "") || "image" : "image";
  } catch {
    return "image";
  }
}

function imageNumber(image, index) {
  return image.pageNumber || image.listIndex || index + 1;
}

function imageEntryMeta(image, index) {
  return {
    image,
    index,
    key: imageKey(image, index),
    host: imageHost(image),
    type: imageType(image),
    number: imageNumber(image, index)
  };
}

function videoKey(video, index) {
  const stableIndex = video.listIndex || index + 1;
  return `${stableIndex}:${video.id || video.url || ""}`;
}

function videoHost(video) {
  try {
    return new URL(video.url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function videoType(video) {
  try {
    const extension = video.filename
      ? video.filename.split(".").pop()
      : new URL(video.url).pathname.split(".").pop();
    return extension ? extension.toLowerCase().replace(/[^a-z0-9]+/g, "") || "video" : "video";
  } catch {
    return "video";
  }
}

function videoNumber(video, index) {
  return video.listIndex || index + 1;
}

function videoEntryMeta(video, index) {
  return {
    video,
    index,
    key: videoKey(video, index),
    host: videoHost(video),
    type: videoType(video),
    number: videoNumber(video, index)
  };
}

function matchesImageFilters(entry, filters) {
  const search = filters.search.trim().toLowerCase();
  if (search) {
    const haystack = [
      entry.image.filename,
      entry.image.url,
      entry.image.sourcePage,
      entry.image.originalLabel,
      entry.host,
      entry.type
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(search)) {
      return false;
    }
  }

  if (filters.host !== "all" && entry.host !== filters.host) {
    return false;
  }

  if (filters.type !== "all" && entry.type !== filters.type) {
    return false;
  }

  const minNumber = Number(filters.minNumber);
  if (Number.isFinite(minNumber) && filters.minNumber !== "" && entry.number < minNumber) {
    return false;
  }

  const maxNumber = Number(filters.maxNumber);
  if (Number.isFinite(maxNumber) && filters.maxNumber !== "" && entry.number > maxNumber) {
    return false;
  }

  return true;
}

function matchesVideoFilters(entry, filters) {
  const search = filters.search.trim().toLowerCase();
  if (search) {
    const haystack = [
      entry.video.filename,
      entry.video.url,
      entry.video.sourcePage,
      entry.video.originalLabel,
      entry.host,
      entry.type
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(search)) {
      return false;
    }
  }

  if (filters.host !== "all" && entry.host !== filters.host) {
    return false;
  }

  if (filters.type !== "all" && entry.type !== filters.type) {
    return false;
  }

  const minNumber = Number(filters.minNumber);
  if (Number.isFinite(minNumber) && filters.minNumber !== "" && entry.number < minNumber) {
    return false;
  }

  const maxNumber = Number(filters.maxNumber);
  if (Number.isFinite(maxNumber) && filters.maxNumber !== "" && entry.number > maxNumber) {
    return false;
  }

  return true;
}

function rangeTokenKeys(token, allEntries, visibleEntries, failedKeys) {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  if (normalized === "visible") {
    return visibleEntries.map((entry) => entry.key);
  }

  if (normalized === "failed") {
    return allEntries.filter((entry) => failedKeys.has(entry.key)).map((entry) => entry.key);
  }

  if (normalized === "odd" || normalized === "even") {
    const parity = normalized === "odd" ? 1 : 0;
    return visibleEntries
      .filter((entry) => entry.number % 2 === parity)
      .map((entry) => entry.key);
  }

  const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(normalized);
  if (rangeMatch) {
    const start = Math.min(Number(rangeMatch[1]), Number(rangeMatch[2]));
    const end = Math.max(Number(rangeMatch[1]), Number(rangeMatch[2]));
    return allEntries
      .filter((entry) => entry.number >= start && entry.number <= end)
      .map((entry) => entry.key);
  }

  const number = Number(normalized);
  if (Number.isInteger(number) && number > 0) {
    return allEntries
      .filter((entry) => entry.number === number || entry.index + 1 === number)
      .map((entry) => entry.key);
  }

  return [];
}

function rangeExpressionKeySet(expression, allEntries, visibleEntries, failedKeys) {
  const keys = new Set();
  expression
    .split(",")
    .flatMap((token) => rangeTokenKeys(token, allEntries, visibleEntries, failedKeys))
    .forEach((key) => keys.add(key));
  return keys;
}

function sameNumber(left, right) {
  return Number(left || 0) > 0 && Number(left) === Number(right || 0);
}

function sameText(left, right) {
  return Boolean(left && right && String(left) === String(right));
}

function failureMatchesImage(failure, image, index) {
  if (!failure || !image) {
    return false;
  }

  if (sameNumber(failure.listIndex, index + 1) || sameNumber(failure.pageNumber, image.pageNumber)) {
    return true;
  }

  const failureSourcePage = failure.sourcePage || failure.referer;
  const imageSourcePage = image.sourcePage || image.referer;
  const sourcePagesMatch = sameText(failureSourcePage, imageSourcePage);
  const filenamesMatch = sameText(failure.filename, image.filename);
  return (
    sameText(failure.url, image.url) ||
    sameText(failure.url, image.originalUrl) ||
    sameText(failure.originalUrl, image.originalUrl) ||
    (filenamesMatch && (!failureSourcePage || !imageSourcePage || sourcePagesMatch))
  );
}

function failedImageKeySet(images, failures) {
  const nextKeys = new Set();
  if (!Array.isArray(images) || !Array.isArray(failures) || !failures.length) {
    return nextKeys;
  }

  images.forEach((image, index) => {
    if (failures.some((failure) => failureMatchesImage(failure, image, index))) {
      nextKeys.add(imageKey(image, index));
    }
  });

  return nextKeys;
}

function imagesWithFailureUpdates(images, failures) {
  if (!Array.isArray(images) || !Array.isArray(failures) || !failures.length) {
    return images;
  }

  return images.map((image, index) => {
    const failure = failures.find((item) => failureMatchesImage(item, image, index));
    if (!failure) {
      return image;
    }

    return {
      ...image,
      url: failure.url || image.url,
      referer: failure.referer || image.referer,
      sourcePage: failure.sourcePage || image.sourcePage,
      originalUrl: failure.originalUrl || image.originalUrl,
      originalLabel: failure.originalLabel || image.originalLabel,
      filename: failure.filename || image.filename,
      pageNumber: failure.pageNumber || image.pageNumber,
      listIndex: failure.listIndex || image.listIndex || index + 1,
      displaySize: failure.displaySize || image.displaySize,
      kind: failure.kind || image.kind
    };
  });
}

function imagesWithDownloadUpdates(images, result) {
  const updates = [
    ...(Array.isArray(result?.files) ? result.files : []),
    ...(Array.isArray(result?.skippedDuplicates) ? result.skippedDuplicates : []),
    ...(Array.isArray(result?.failures) ? result.failures : [])
  ].map((item) => ({
    ...item,
    url: item.sourceUrl || item.url
  }));
  return imagesWithFailureUpdates(images, updates);
}

function imageJobSelection(images, items, statuses = ["failed", "cancelled"]) {
  const selectedStatuses = new Set(statuses);
  const relevant = (Array.isArray(items) ? items : []).filter((item) => selectedStatuses.has(item.status));
  const keys = new Set();
  images.forEach((image, index) => {
    if (relevant.some((item) => (
      sameNumber(item.listIndex, image.listIndex || index + 1)
      || sameNumber(item.pageNumber, image.pageNumber)
      || sameNumber(item.outputIndex, image.listIndex || image.pageNumber || index + 1)
    ))) {
      keys.add(imageKey(image, index));
    }
  });
  return keys;
}

function failureMatchesVideo(failure, video, index) {
  if (!failure || !video) {
    return false;
  }

  if (sameNumber(failure.listIndex, video.listIndex || index + 1)) {
    return true;
  }

  const failureSourcePage = failure.sourcePage || failure.referer;
  const videoSourcePage = video.sourcePage || video.referer;
  const sourcePagesMatch = sameText(failureSourcePage, videoSourcePage);
  const filenamesMatch = sameText(failure.filename, video.filename);
  return (
    sameText(failure.url, video.url) ||
    (filenamesMatch && (!failureSourcePage || !videoSourcePage || sourcePagesMatch))
  );
}

function failedVideoKeySet(videos, failures) {
  const nextKeys = new Set();
  if (!Array.isArray(videos) || !Array.isArray(failures) || !failures.length) {
    return nextKeys;
  }

  videos.forEach((video, index) => {
    if (failures.some((failure) => failureMatchesVideo(failure, video, index))) {
      nextKeys.add(videoKey(video, index));
    }
  });

  return nextKeys;
}

function videosWithFailureUpdates(videos, failures) {
  if (!Array.isArray(videos) || !Array.isArray(failures) || !failures.length) {
    return videos;
  }

  return videos.map((video, index) => {
    const failure = failures.find((item) => failureMatchesVideo(item, video, index));
    if (!failure) {
      return video;
    }

    return {
      ...video,
      url: failure.url || video.url,
      referer: failure.referer || video.referer,
      sourcePage: failure.sourcePage || video.sourcePage,
      poster: failure.poster || video.poster,
      filename: failure.filename || video.filename,
      listIndex: failure.listIndex || video.listIndex || index + 1,
      displaySize: failure.displaySize || video.displaySize,
      kind: failure.kind || video.kind
    };
  });
}

function sameStructuredValue(left, right) {
  if (left === right) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function failureStateLabel(failure) {
  if (failure?.retryable) {
    return failure.autoRetried ? "Temporary, retried" : "Temporary";
  }

  return failure?.autoRetried ? "Retried" : "Not retryable";
}

function downloadNotice(result) {
  if (!result) {
    return "";
  }

  if (result.failed) {
    const retryText = result.autoRetried
      ? ` Auto retry checked ${result.autoRetried} temporary failure(s).`
      : "";
    const retryableText = result.retryableFailed
      ? ` ${result.retryableFailed} may work if retried later.`
      : "";
    const skippedText = result.skipped ? ` ${result.skipped} duplicate(s) skipped.` : "";
    return `${result.downloaded} of ${result.requested} saved.${skippedText} ${result.failed} failed and are selected for retry.${retryText}${retryableText}`;
  }

  if (result.skipped) {
    return `${result.downloaded} image(s) downloaded. ${result.skipped} duplicate(s) skipped.`;
  }

  if (result.autoRetried) {
    return `${result.downloaded} image(s) downloaded after auto retry.`;
  }

  return `${result.downloaded} image(s) downloaded.`;
}

function videoDownloadNotice(result) {
  if (!result) {
    return "";
  }

  if (result.failed) {
    return `${result.downloaded} of ${result.requested} video(s) saved. ${result.failed} failed and are selected for retry.`;
  }

  return `${result.downloaded} video(s) downloaded.`;
}

function StaggeredText({ baseDelay = 0, text }) {
  return (
    <span className="opening-staggered-text" aria-label={text}>
      {Array.from(text).map((character, index) => (
        <span
          aria-hidden="true"
          className="opening-character"
          key={`${character}-${index}`}
          style={{ "--character-delay": `${baseDelay + index * 0.055}s` }}
        >
          {character === " " ? "\u00A0" : character}
        </span>
      ))}
    </span>
  );
}

function OpeningPage({ onEnter }) {
  const [isLeaving, setIsLeaving] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const transitionTimerRef = useRef(null);
  const visualRef = useRef(null);

  useEffect(() => () => window.clearTimeout(transitionTimerRef.current), []);

  const enterApp = useCallback((destination = "toolbox") => {
    if (isLeaving) {
      return;
    }
    setIsLeaving(true);
    setIsMenuOpen(false);
    transitionTimerRef.current = window.setTimeout(() => onEnter(destination), 360);
  }, [isLeaving, onEnter]);

  const handlePointerMove = useCallback((event) => {
    const visual = visualRef.current;
    if (!visual) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const horizontal = clampPaneSize((event.clientX - bounds.left) / bounds.width, 0, 1);
    const vertical = clampPaneSize((event.clientY - bounds.top) / bounds.height, 0, 1);
    visual.style.setProperty("--opening-shift-x", `${(horizontal - 0.5) * -18}px`);
    visual.style.setProperty("--opening-shift-y", `${(vertical - 0.5) * -12}px`);
    visual.style.setProperty("--opening-light-x", `${horizontal * 100}%`);
    visual.style.setProperty("--opening-light-y", `${vertical * 100}%`);
  }, []);

  const resetPointerEffect = useCallback(() => {
    const visual = visualRef.current;
    if (!visual) {
      return;
    }
    visual.style.setProperty("--opening-shift-x", "0px");
    visual.style.setProperty("--opening-shift-y", "0px");
    visual.style.setProperty("--opening-light-x", "48%");
    visual.style.setProperty("--opening-light-y", "42%");
  }, []);

  return (
    <main
      className={classNames("opening-page", isLeaving && "is-leaving")}
      aria-label="Magic Box opening page"
      onPointerLeave={resetPointerEffect}
      onPointerMove={handlePointerMove}
    >
      <div className="opening-visual" ref={visualRef} aria-hidden="true">
        <div className="opening-organic-field" />
        <div className="opening-portrait">
          <img src="/assets/magic-box-girl.jpg" alt="" />
        </div>
        <div className="opening-light-field" />
        <div className="opening-grain" />
        <div className="opening-particles">
          {OPENING_PARTICLES.map((particle) => (
            <span
              key={particle.id}
              style={{
                "--particle-delay": particle.delay,
                "--particle-duration": particle.duration,
                "--particle-size": particle.size,
                left: particle.left,
                top: particle.top
              }}
            />
          ))}
        </div>
      </div>

      <header className="opening-header">
        <button className="opening-brand" type="button" onClick={() => enterApp("toolbox")}>
          Magic Box
        </button>

        <nav className="opening-nav" aria-label="Opening destinations">
          {OPENING_NAV_ITEMS.map((item) => (
            <button key={item.id} type="button" onClick={() => enterApp(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>

        <button
          className="opening-menu-button"
          type="button"
          aria-label={isMenuOpen ? "Close opening menu" : "Open opening menu"}
          aria-expanded={isMenuOpen}
          onClick={() => setIsMenuOpen((current) => !current)}
        >
          {isMenuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </header>

      {isMenuOpen ? (
        <nav className="opening-mobile-menu" aria-label="Opening mobile destinations">
          {OPENING_NAV_ITEMS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              style={{ "--menu-item-delay": `${0.05 + index * 0.06}s` }}
              onClick={() => enterApp(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}

      <section className="opening-hero">
        <h1>
          <StaggeredText text="OPEN THE" />
          <StaggeredText baseDelay={0.5} text="MAGIC BOX" />
        </h1>
        <p>
          <span className="opening-subtitle-line opening-subtitle-line-first">
            Download, discover, transform, and create —
          </span>{" "}
          <span className="opening-subtitle-line">
            your local digital toolbox, ready when you are.
          </span>
        </p>
        <button className="opening-cta liquid-glass" type="button" onClick={() => enterApp("toolbox")}>
          <span>Open the Toolbox</span>
          <ChevronRight size={18} />
        </button>
      </section>
    </main>
  );
}

function DownloadSummary({ isRetrying, onClose, onRetryFailedImages, onSelectFailedImages, result }) {
  if (!result) {
    return null;
  }

  const files = Array.isArray(result.files) ? result.files : [];
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const skippedDuplicates = Array.isArray(result.skippedDuplicates) ? result.skippedDuplicates : [];
  const savedBytes = files.reduce((total, file) => total + (file.bytes || 0), 0);
  const totalAttempts = Number(result.attempts || 0);
  const autoRetried = Number(result.autoRetried || 0);
  const retryableFailed = Number(result.retryableFailed || failures.filter((failure) => failure.retryable).length);
  const refreshedCount = files.filter((file) => file.refreshSucceeded).length;

  return (
    <div className="summary-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={classNames("download-summary", failures.length && "has-failures")}
        role="dialog"
        aria-modal="true"
        aria-label="Download summary"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>Download summary</strong>
            <span>{result.downloaded || 0}/{result.requested || 0} saved, {skippedDuplicates.length} skipped ({formatBytes(savedBytes)})</span>
          </div>
          <div className="summary-actions">
            <AppButton tone="secondary" onClick={onSelectFailedImages} disabled={!failures.length}>
              Select failed
            </AppButton>
            <AppButton tone="accent" onClick={onRetryFailedImages} disabled={!failures.length || isRetrying}>
              {isRetrying ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              Retry failed
            </AppButton>
            <button className="icon-button" type="button" aria-label="Close download summary" onClick={onClose}>
              <X size={21} />
            </button>
          </div>
        </header>
        {result.outputDir ? (
          <p className="summary-path">
            Saved to <code>{result.outputDir}</code>
          </p>
        ) : null}
        {(totalAttempts || autoRetried || retryableFailed) ? (
          <div className="summary-metrics" aria-label="Download retry details">
            {totalAttempts ? <span>{totalAttempts} request attempt(s)</span> : null}
            {autoRetried ? <span>{autoRetried} auto retried</span> : null}
            {retryableFailed ? <span>{retryableFailed} still temporary</span> : null}
            {refreshedCount ? <span>{refreshedCount} expired URL(s) refreshed</span> : null}
            {skippedDuplicates.length ? <span>{skippedDuplicates.length} duplicate skipped</span> : null}
          </div>
        ) : null}
        {skippedDuplicates.length ? (
          <div className="failure-list" aria-label="Skipped duplicates">
            {skippedDuplicates.map((skipped, index) => (
              <article className="failure-item skipped-item" key={`${skipped.sha256 || skipped.url || index}`}>
                <strong>{skipped.pageLabel || (skipped.pageNumber ? `Page ${skipped.pageNumber}` : `Item ${skipped.listIndex || index + 1}`)}</strong>
                <span>{skipped.filename || "Duplicate image"}</span>
                <div className="failure-tags">
                  <span className="failure-tag">Duplicate</span>
                  {skipped.duplicateOf ? <span className="failure-tag">{skipped.duplicateOf}</span> : null}
                </div>
                {skipped.url ? <code>{skipped.url}</code> : null}
              </article>
            ))}
          </div>
        ) : null}
        {failures.length ? (
          <div className="failure-list" aria-label="Failed pages">
            {failures.map((failure, index) => (
              <article className="failure-item" key={`${failure.url || failure.sourcePage || index}`}>
                <strong>{failure.pageLabel || (failure.pageNumber ? `Page ${failure.pageNumber}` : `Item ${index + 1}`)}</strong>
                <span>{failure.filename || "Image"}</span>
                <div className="failure-tags">
                  <span className={classNames("failure-tag", failure.retryable && "retryable")}>
                    {failureStateLabel(failure)}
                  </span>
                  {failure.attempts ? <span className="failure-tag">{failure.attempts} attempt(s)</span> : null}
                  {failure.errorCode ? <span className="failure-tag">{failure.errorCode}</span> : null}
                  {failure.refreshAttempted ? <span className="failure-tag">URL refresh attempted</span> : null}
                </div>
                <small>{failure.error || "Download failed."}</small>
                {failure.sourcePage ? <code>{failure.sourcePage}</code> : null}
                {failure.url ? <code>{failure.url}</code> : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="summary-ok">All selected images downloaded successfully.</p>
        )}
      </section>
    </div>
  );
}

const TOOLBOX_WORLDS = [
  {
    id: "assistant",
    title: "Private Assistant",
    worldTitle: "Quiet Observatory",
    edition: "08 / PRIVATE",
    icon: Sparkles
  },
  {
    id: "torrents",
    title: "Torrent Downloader",
    worldTitle: "Abyssal Current",
    edition: "01 / CURRENT",
    icon: Download
  },
  {
    id: "images",
    title: "Image Downloader",
    worldTitle: "Lumen Archive",
    edition: "02 / SPECIMEN",
    icon: ImageIcon
  },
  {
    id: "videos",
    title: "Video Downloader",
    worldTitle: "Nocturne Theater",
    edition: "03 / MOTION",
    icon: Video
  },
  {
    id: "voice-clone",
    title: "Voice Clone",
    worldTitle: "Resonance Grove",
    edition: "04 / ECHO",
    icon: Mic
  },
  {
    id: "file-transfer",
    title: "File Transfer",
    worldTitle: "Transit Portal",
    edition: "05 / BRIDGE",
    icon: Files
  },
  {
    id: "format-factory",
    title: "Format Factory",
    worldTitle: "Alchemy Foundry",
    edition: "06 / TRANSMUTE",
    icon: Factory
  },
  {
    id: "history",
    title: "History",
    worldTitle: "Memory Archive",
    edition: "07 / RECORD",
    icon: History
  }
];

const DRAG_COMMIT_DISTANCE_PX = 72;
const DRAG_FLING_VELOCITY = 0.45;

function carouselOffset(index, activeIndex, count) {
  let offset = index - activeIndex;
  const half = Math.floor(count / 2);
  if (offset > half) offset -= count;
  if (offset < -half) offset += count;
  return offset;
}

function WorldPoster({ active, offset, onActivate, onOpen, world }) {
  const Icon = world.icon;
  const distance = Math.abs(offset);

  return (
    <button
      aria-label={`Open ${world.title}`}
      aria-current={active ? "true" : undefined}
      className={classNames("world-poster", active && "is-active")}
      data-world={world.id}
      onClick={() => onOpen(world.id)}
      onFocus={onActivate}
      onMouseEnter={onActivate}
      style={{
        "--carousel-offset": offset,
        "--carousel-depth": `${distance * -128}px`,
        "--carousel-turn": `${offset * -42}deg`,
        "--carousel-scale": Math.max(0.7, 1 - distance * 0.1),
        "--carousel-opacity": Math.max(0.2, 1 - distance * 0.2),
        "--carousel-z": TOOLBOX_WORLDS.length - distance
      }}
      tabIndex={active ? 0 : -1}
      type="button"
    >
      <span className="world-poster-art" aria-hidden="true">
        <span className="poster-form poster-form-one" />
        <span className="poster-form poster-form-two" />
        <span className="poster-form poster-form-three" />
        <span className="poster-form poster-form-four" />
        <span className="poster-form poster-form-five" />
        <span className="poster-grain" />
      </span>
      <span className="world-poster-edition">{world.edition}</span>
      <span className="world-poster-copy">
        <span className="world-poster-world">{world.worldTitle}</span>
        <strong>{world.title}</strong>
        <span className="world-poster-enter">
          <Icon size={18} />
          <span>Enter world</span>
          <ChevronRight size={20} />
        </span>
      </span>
    </button>
  );
}

export function ToolboxHome({ initialWorldId = TOOLBOX_WORLDS[0].id, onNavigate }) {
  const [activeIndex, setActiveIndex] = useState(() => {
    const initialIndex = TOOLBOX_WORLDS.findIndex((world) => world.id === initialWorldId);
    return initialIndex >= 0 ? initialIndex : 0;
  });
  const [isDragging, setIsDragging] = useState(false);
  const pointerStartRef = useRef(null);
  const stageRef = useRef(null);
  const didDragRef = useRef(false);
  const suppressClickRef = useRef(false);
  const wheelLockRef = useRef(false);
  const count = TOOLBOX_WORLDS.length;

  const moveCarousel = useCallback((direction) => {
    setActiveIndex((current) => (current + direction + count) % count);
  }, [count]);

  useEffect(() => {
    const nextIndex = TOOLBOX_WORLDS.findIndex((world) => world.id === initialWorldId);
    setActiveIndex(nextIndex >= 0 ? nextIndex : 0);
    setIsDragging(false);
    stageRef.current?.style.setProperty("--carousel-drag-offset", "0px");
  }, [initialWorldId]);

  function handleKeyDown(event) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveCarousel(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      moveCarousel(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onNavigate(TOOLBOX_WORLDS[activeIndex].id);
    }
  }

  function handleWheel(event) {
    if (wheelLockRef.current || Math.abs(event.deltaX) + Math.abs(event.deltaY) < 8) {
      return;
    }
    event.preventDefault();
    wheelLockRef.current = true;
    moveCarousel((event.deltaX || event.deltaY) > 0 ? 1 : -1);
    window.setTimeout(() => {
      wheelLockRef.current = false;
    }, 260);
  }

  function handlePointerDown(event) {
    if (event.button !== 0 || event.target.closest?.(".poster-carousel-arrow, .poster-carousel-dots")) {
      return;
    }
    const timestamp = event.timeStamp || performance.now();
    pointerStartRef.current = {
      id: event.pointerId,
      x: event.clientX,
      lastX: event.clientX,
      lastTimestamp: timestamp,
      velocity: 0,
      worldId: event.target.closest?.(".world-poster")?.dataset.world || ""
    };
    didDragRef.current = false;
    setIsDragging(false);
    event.currentTarget.style.setProperty("--carousel-drag-offset", "0px");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    const pointerStart = pointerStartRef.current;
    if (pointerStart?.id !== event.pointerId) return;
    const timestamp = event.timeStamp || performance.now();
    pointerStart.velocity = (event.clientX - pointerStart.lastX) / Math.max(1, timestamp - pointerStart.lastTimestamp);
    pointerStart.lastX = event.clientX;
    pointerStart.lastTimestamp = timestamp;
    const offset = clampPaneSize(event.clientX - pointerStart.x, -420, 420);
    if (!didDragRef.current && Math.abs(offset) > 4) {
      didDragRef.current = true;
      setIsDragging(true);
    }
    event.currentTarget.style.setProperty("--carousel-drag-offset", `${offset}px`);
  }

  function handlePointerUp(event) {
    if (pointerStartRef.current?.id !== event.pointerId) return;
    const pointerStart = pointerStartRef.current;
    const distance = event.clientX - pointerStart.x;
    const wasDragging = didDragRef.current;
    const commitDrag = Math.abs(distance) >= DRAG_COMMIT_DISTANCE_PX || Math.abs(pointerStart.velocity) >= DRAG_FLING_VELOCITY;
    pointerStartRef.current = null;
    didDragRef.current = false;
    setIsDragging(false);
    event.currentTarget.style.setProperty("--carousel-drag-offset", "0px");
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (commitDrag) {
      moveCarousel((distance || pointerStart.velocity) > 0 ? -1 : 1);
    }
    if (!wasDragging && pointerStart.worldId) {
      event.preventDefault();
      suppressClickRef.current = true;
      onNavigate(pointerStart.worldId);
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    } else if (wasDragging) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }

  function handlePointerCancel(event) {
    pointerStartRef.current = null;
    didDragRef.current = false;
    setIsDragging(false);
    event.currentTarget.style.setProperty("--carousel-drag-offset", "0px");
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }

  function handleClickCapture(event) {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function openWorld(worldId) {
    onNavigate(worldId);
  }

  function activateWorld(index) {
    if (!pointerStartRef.current) {
      setActiveIndex(index);
    }
  }

  const activeWorld = TOOLBOX_WORLDS[activeIndex];

  return (
    <section className="toolbox-home poster-library-home" aria-label="Magic Box function worlds">
      <div
        className={classNames("poster-carousel-stage", isDragging && "is-dragging")}
        aria-label="Tool carousel. Hover a cover or use the arrow keys to rotate."
        aria-roledescription="carousel"
        onClickCapture={handleClickCapture}
        onKeyDown={handleKeyDown}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        ref={stageRef}
        role="region"
        tabIndex={0}
      >
        <button className="poster-carousel-arrow is-previous" type="button" onClick={() => moveCarousel(-1)} aria-label="Previous tool">
          <ChevronRight size={25} />
        </button>
        <div className="poster-carousel-track">
        {TOOLBOX_WORLDS.map((world) => (
          <WorldPoster
            key={world.id}
            active={world.id === activeWorld.id}
            offset={carouselOffset(TOOLBOX_WORLDS.indexOf(world), activeIndex, count)}
            onActivate={() => activateWorld(TOOLBOX_WORLDS.indexOf(world))}
            onOpen={openWorld}
            world={world}
          />
        ))}
        </div>
        <button className="poster-carousel-arrow is-next" type="button" onClick={() => moveCarousel(1)} aria-label="Next tool">
          <ChevronRight size={25} />
        </button>
        <footer className="poster-carousel-footer">
          <span className="poster-carousel-current"><b>{activeWorld.edition}</b>{activeWorld.worldTitle}</span>
          <div className="poster-carousel-dots" aria-label="Choose a tool">
            {TOOLBOX_WORLDS.map((world, index) => (
              <button
                key={world.id}
                aria-label={`Show ${world.title}`}
                aria-pressed={index === activeIndex}
                onClick={() => setActiveIndex(index)}
                type="button"
              />
            ))}
          </div>
          <span className="poster-carousel-hint">Hover · wheel · drag</span>
        </footer>
      </div>
    </section>
  );
}

function ModuleHeader({ downloadPath, icon: Icon, onBack, onBrowseFolder, subtitle, title }) {
  return (
    <header className="module-header">
      <button className="back-button" type="button" onClick={onBack}>
        <ChevronRight size={21} />
        Toolbox
      </button>
      <span className="module-mark">
        <Icon size={28} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {onBrowseFolder ? (
        <div className="module-folder-control">
          <span className="module-folder-path" title={downloadPath || "No download folder selected"}>
            {downloadPath || "No download folder selected"}
          </span>
          <AppButton tone="secondary" className="folder-action" onClick={onBrowseFolder}>
            <FolderOpen size={20} />
            This tool's folder
          </AppButton>
        </div>
      ) : null}
    </header>
  );
}

export function ToolPageLoadingFallback({ label }) {
  return (
    <div className="tool-page-loading" role="status" aria-live="polite" aria-busy="true" tabIndex={-1}>
      <Loader2 className="spin" size={24} />
      <span>Loading {label}…</span>
    </div>
  );
}

export default function App() {
  const [showOpeningPage, setShowOpeningPage] = useState(shouldShowOpeningPage);
  const [activeView, setActiveView] = useState(readStoredActiveView);
  const [lastToolboxWorldId, setLastToolboxWorldId] = useState(TOOLBOX_WORLDS[0].id);
  const [torrentSidebarWidth, setTorrentSidebarWidth] = useState(() =>
    readStoredPaneSize(TORRENT_SIDEBAR_WIDTH_STORAGE_KEY, 340)
  );
  const [config, setConfig] = useState(null);
  const [torrents, setTorrents] = useState([]);
  const [selectedTorrentId, setSelectedTorrentId] = useState("");
  const [magnet, setMagnet] = useState("");
  const [toolPaths, setToolPaths] = useState(readStoredToolPaths);
  const downloadPath = toolPaths.torrents || "";
  const [selectedFile, setSelectedFile] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [imagePageUrl, setImagePageUrl] = useState("");
  const [imageScan, setImageScan] = useState(emptyImageScan);
  const [imageFilters, setImageFilters] = useState(emptyImageFilters);
  const [selectedImageKeys, setSelectedImageKeys] = useState(() => new Set());
  const [rangeSelectValue, setRangeSelectValue] = useState("");
  const [videoPageUrl, setVideoPageUrl] = useState("");
  const [videoUseBrowserLogin, setVideoUseBrowserLogin] = useState(false);
  const [videoBrowser, setVideoBrowser] = useState("edge");
  const [videoCookiesFile, setVideoCookiesFile] = useState("");
  const [videoScan, setVideoScan] = useState(emptyVideoScan);
  const [videoVerification, setVideoVerification] = useState(null);
  const [isVerifyingVideo, setIsVerifyingVideo] = useState(false);
  const [videoFilters, setVideoFilters] = useState(emptyVideoFilters);
  const [selectedVideoKeys, setSelectedVideoKeys] = useState(() => new Set());
  const [videoRangeSelectValue, setVideoRangeSelectValue] = useState("");
  const [previewUrls, setPreviewUrls] = useState({});
  const [previewErrors, setPreviewErrors] = useState({});
  const [isScanningImages, setIsScanningImages] = useState(false);
  const [isDownloadingImages, setIsDownloadingImages] = useState(false);
  const [isScanningVideos, setIsScanningVideos] = useState(false);
  const [isDownloadingVideos, setIsDownloadingVideos] = useState(false);
  const [downloadResult, setDownloadResult] = useState(null);
  const [imageDownloadJob, setImageDownloadJob] = useState(null);
  const [videoDownloadResult, setVideoDownloadResult] = useState(null);
  const [videoDownloadJob, setVideoDownloadJob] = useState(null);
  const [previewModal, setPreviewModal] = useState(null);
  const [isDownloadSummaryOpen, setIsDownloadSummaryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historySearch, setHistorySearch] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const fileInputRef = useRef(null);
  const previewUrlRef = useRef({});
  const previewQueueRef = useRef([]);
  const previewPendingRef = useRef(new Set());
  const previewActiveRef = useRef(0);
  const pumpPreviewQueueRef = useRef(() => {});
  const scanRequestRef = useRef(0);
  const videoScanRequestRef = useRef(0);
  const videoScanControllerRef = useRef(null);
  const imageSessionLoadedRef = useRef(false);
  const videoSessionLoadedRef = useRef(false);
  const skipNextImageSessionPersistRef = useRef(false);
  const skipNextVideoSessionPersistRef = useRef(false);
  const deferredImageSearch = useDeferredValue(imageFilters.search);
  const deferredVideoSearch = useDeferredValue(videoFilters.search);
  const deferredImageFilters = useMemo(
    () => ({
      search: deferredImageSearch,
      host: imageFilters.host,
      type: imageFilters.type,
      minNumber: imageFilters.minNumber,
      maxNumber: imageFilters.maxNumber
    }),
    [deferredImageSearch, imageFilters.host, imageFilters.maxNumber, imageFilters.minNumber, imageFilters.type]
  );
  const deferredVideoFilters = useMemo(
    () => ({
      search: deferredVideoSearch,
      host: videoFilters.host,
      type: videoFilters.type,
      minNumber: videoFilters.minNumber,
      maxNumber: videoFilters.maxNumber
    }),
    [deferredVideoSearch, videoFilters.host, videoFilters.maxNumber, videoFilters.minNumber, videoFilters.type]
  );

  const activeCount = useMemo(
    () => torrents.filter((torrent) => torrent.status === "downloading").length,
    [torrents]
  );

  const completedCount = useMemo(
    () => torrents.filter((torrent) => torrent.status === "complete").length,
    [torrents]
  );

  const imageEntries = useMemo(
    () => imageScan.images.map((image, index) => imageEntryMeta(image, index)),
    [imageScan.images]
  );

  const visibleImageEntries = useMemo(
    () => imageEntries.filter((entry) => matchesImageFilters(entry, deferredImageFilters)),
    [deferredImageFilters, imageEntries]
  );

  const imageFilterOptions = useMemo(() => ({
    hosts: Array.from(new Set(imageEntries.map((entry) => entry.host))).sort(),
    types: Array.from(new Set(imageEntries.map((entry) => entry.type))).sort()
  }), [imageEntries]);

  const videoEntries = useMemo(
    () => videoScan.videos.map((video, index) => videoEntryMeta(video, index)),
    [videoScan.videos]
  );

  const visibleVideoEntries = useMemo(
    () => videoEntries.filter((entry) => matchesVideoFilters(entry, deferredVideoFilters)),
    [deferredVideoFilters, videoEntries]
  );

  const videoFilterOptions = useMemo(() => ({
    hosts: Array.from(new Set(videoEntries.map((entry) => entry.host))).sort(),
    types: Array.from(new Set(videoEntries.map((entry) => entry.type))).sort()
  }), [videoEntries]);

  function announceVideoScan(title, message, tone = "info") {
    if (tone === "error") {
      setError(message);
    } else {
      setNotice(message);
    }
    notifyDesktop(title, message, tone).catch(() => {});
  }

  const imageStatus = useMemo(() => {
    if (isScanningImages) {
      return { tone: "busy", message: "Scanning page. Large galleries can take a few minutes..." };
    }
    if (isDownloadingImages) {
      return { tone: "busy", message: "Downloading selected images..." };
    }
    if (downloadResult) {
      return {
        tone: downloadResult.failed ? "warn" : "ok",
        message: downloadResult.failed
          ? `Download complete. ${downloadResult.downloaded} saved, ${downloadResult.failed} failed.`
          : `Download complete. ${downloadResult.downloaded} saved${downloadResult.autoRetried ? " after auto retry" : ""}.`
      };
    }
    if (imageScan.images.length) {
      return { tone: "ok", message: "Scan complete." };
    }
    return { tone: "idle", message: "Ready to scan." };
  }, [downloadResult, imageScan.images.length, isDownloadingImages, isScanningImages]);

  const videoStatus = useMemo(() => {
    if (isScanningVideos) {
      return { tone: "busy", message: isVerifyingVideo ? "Waiting for you to complete browser verification..." : "Scanning page for videos..." };
    }
    if (isDownloadingVideos) {
      const percent = videoDownloadJob ? ` ${videoDownloadJobPercent(videoDownloadJob)}%` : "";
      return { tone: "busy", message: `Downloading selected videos...${percent}` };
    }
    if (videoDownloadResult) {
      return {
        tone: videoDownloadResult.failed ? "warn" : "ok",
        message: videoDownloadResult.failed
          ? `Download complete. ${videoDownloadResult.downloaded} saved, ${videoDownloadResult.failed} failed.`
          : `Download complete. ${videoDownloadResult.downloaded} saved.`
      };
    }
    if (videoScan.videos.length) {
      return { tone: "ok", message: "Scan complete." };
    }
    if (videoScan.pageUrl) {
      return { tone: "warn", message: "No playable main video found." };
    }
    return { tone: "idle", message: "Ready to scan." };
  }, [isDownloadingVideos, isScanningVideos, isVerifyingVideo, videoDownloadJob, videoDownloadResult, videoScan.pageUrl, videoScan.videos.length]);

  const statusText = error || notice || (
    torrents.length
      ? `${torrents.length} torrent(s) in queue.`
      : "Downloader engine ready."
  );

  const refreshTorrents = useCallback(async () => {
    const nextTorrents = await api("/api/torrents");
    setTorrents((current) => sameStructuredValue(current, nextTorrents) ? current : nextTorrents);
    setSelectedTorrentId((current) => (
      nextTorrents.some((torrent) => torrent.id === current)
        ? current
        : nextTorrents[0]?.id || ""
    ));
  }, []);

  const refreshHistory = useCallback(async () => {
    setIsHistoryLoading(true);
    try {
      const nextHistory = await api("/api/history");
      const normalizedHistory = Array.isArray(nextHistory) ? nextHistory : [];
      setHistory((current) => sameStructuredValue(current, normalizedHistory) ? current : normalizedHistory);
    } finally {
      setIsHistoryLoading(false);
    }
  }, []);

  const applyVideoDownloadResult = useCallback(async (result) => {
    setVideoDownloadResult(result);
    const updatedVideos = videosWithFailureUpdates(videoScan.videos, result.failures);
    setVideoScan((current) => ({
      ...current,
      videos: videosWithFailureUpdates(current.videos, result.failures)
    }));
    const failedKeys = failedVideoKeySet(updatedVideos, result.failures);
    setSelectedVideoKeys(failedKeys.size ? failedKeys : new Set());
    setNotice(videoDownloadNotice(result));
    await refreshHistory();
  }, [refreshHistory, videoScan.videos]);

  const applyImageDownloadResult = useCallback(async (result, jobItems = []) => {
    setDownloadResult(result);
    const updatedImages = imagesWithDownloadUpdates(imageScan.images, result);
    setImageScan((current) => ({
      ...current,
      images: imagesWithDownloadUpdates(current.images, result)
    }));
    const failedKeys = failedImageKeySet(updatedImages, result.failures);
    const interruptedKeys = imageJobSelection(updatedImages, jobItems);
    interruptedKeys.forEach((key) => failedKeys.add(key));
    setSelectedImageKeys(failedKeys.size ? failedKeys : new Set());
    setIsDownloadSummaryOpen(Boolean(result.failed || result.skipped));
    setNotice(result.cancelled ? "Image download stopped. Completed files were kept." : downloadNotice(result));
    await refreshHistory();
  }, [imageScan.images, refreshHistory]);

  const revokePreviews = useCallback(() => {
    Object.values(previewUrlRef.current).forEach((url) => URL.revokeObjectURL(url));
    previewUrlRef.current = {};
    previewQueueRef.current = [];
    previewPendingRef.current.clear();
    setPreviewUrls({});
    setPreviewErrors({});
  }, []);

  const pumpPreviewQueue = useCallback(() => {
    while (previewActiveRef.current < 6 && previewQueueRef.current.length) {
      const entry = previewQueueRef.current.shift();
      previewActiveRef.current += 1;
      previewBlob(entry.image)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (scanRequestRef.current !== entry.scanId) {
            URL.revokeObjectURL(url);
            return;
          }
          previewUrlRef.current[entry.key] = url;
          setPreviewUrls((current) => ({ ...current, [entry.key]: url }));
        })
        .catch((nextError) => {
          if (scanRequestRef.current === entry.scanId) {
            setPreviewErrors((current) => ({ ...current, [entry.key]: nextError.message }));
          }
        })
        .finally(() => {
          previewPendingRef.current.delete(entry.key);
          previewActiveRef.current = Math.max(0, previewActiveRef.current - 1);
          pumpPreviewQueueRef.current();
        });
    }
  }, []);
  pumpPreviewQueueRef.current = pumpPreviewQueue;

  const requestImagePreview = useCallback((image, index) => {
    const key = imageKey(image, index);
    if (previewUrlRef.current[key] || previewPendingRef.current.has(key)) {
      return;
    }
    previewPendingRef.current.add(key);
    previewQueueRef.current.push({ image, key, scanId: scanRequestRef.current });
    pumpPreviewQueueRef.current();
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function boot() {
      try {
        setIsHistoryLoading(true);
        const [nextConfig, nextTorrents, nextHistory] = await Promise.all([
          api("/api/config"),
          api("/api/torrents"),
          api("/api/history")
        ]);
        if (!isMounted) {
          return;
        }
        const legacyPath = readStoredDownloadPath() || nextConfig.savedDownloadDir || nextConfig.defaultDownloadDir;
        const storedPaths = readStoredToolPaths();
        const migrateImageGalleryRoot = nextConfig.platform === "win32" && shouldMigrateImageGalleryRoot();
        setConfig(nextConfig);
        setToolPaths(resolvedToolPaths({
          storedPaths,
          savedPaths: nextConfig.savedToolPaths || {},
          legacyPath,
          platform: nextConfig.platform,
          imageRootPath: migrateImageGalleryRoot ? DEFAULT_IMAGE_GALLERY_ROOT : ""
        }));
        if (migrateImageGalleryRoot) {
          markImageGalleryRootMigrated();
        }
        setTorrents(Array.isArray(nextTorrents) ? nextTorrents : []);
        setHistory(Array.isArray(nextHistory) ? nextHistory : []);
      } catch (nextError) {
        if (isMounted) {
          setError(nextError.message);
        }
      } finally {
        if (isMounted) {
          setIsHistoryLoading(false);
        }
      }
    }

    boot();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (showOpeningPage || activeView !== "torrents") {
      return undefined;
    }

    let intervalId = 0;
    let inFlight = false;
    const poll = () => {
      if (!document.hidden && !inFlight) {
        inFlight = true;
        refreshTorrents().catch((nextError) => setError(nextError.message)).finally(() => { inFlight = false; });
      }
    };
    const syncPolling = () => {
      window.clearInterval(intervalId);
      intervalId = 0;
      if (!document.hidden) {
        poll();
        intervalId = window.setInterval(poll, 1500);
      }
    };
    syncPolling();
    document.addEventListener("visibilitychange", syncPolling);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", syncPolling);
    };
  }, [activeView, refreshTorrents, showOpeningPage]);

  useEffect(() => () => revokePreviews(), [revokePreviews]);

  useEffect(() => {
    const storedSession = readStoredImageSession();
    imageSessionLoadedRef.current = true;
    if (!storedSession) {
      return;
    }

    skipNextImageSessionPersistRef.current = true;
    scanRequestRef.current += 1;
    setImagePageUrl(storedSession.imagePageUrl || storedSession.imageScan.pageUrl || "");
    setImageScan(storedSession.imageScan);
    setSelectedImageKeys(new Set(storedSession.selectedImageKeys));
    setDownloadResult(storedSession.downloadResult);
  }, []);

  useEffect(() => {
    if (!imageSessionLoadedRef.current) {
      return;
    }

    if (skipNextImageSessionPersistRef.current) {
      skipNextImageSessionPersistRef.current = false;
      return;
    }

    if (!imageScan.images.length) {
      clearStoredImageSession();
      return;
    }

    const id = window.setTimeout(() => {
      storeImageSession({
        imagePageUrl,
        imageScan,
        selectedImageKeys: Array.from(selectedImageKeys),
        downloadResult
      });
    }, 350);
    return () => window.clearTimeout(id);
  }, [downloadResult, imagePageUrl, imageScan, selectedImageKeys]);

  useEffect(() => {
    const storedSession = readStoredVideoSession();
    videoSessionLoadedRef.current = true;
    if (!storedSession) {
      return;
    }

    skipNextVideoSessionPersistRef.current = true;
    const scanId = videoScanRequestRef.current + 1;
    videoScanRequestRef.current = scanId;
    setVideoPageUrl(storedSession.videoPageUrl || storedSession.videoScan.pageUrl || "");
    setVideoScan(storedSession.videoScan);
    setSelectedVideoKeys(new Set(storedSession.selectedVideoKeys));
    setVideoDownloadResult(storedSession.videoDownloadResult);
  }, []);

  useEffect(() => () => {
    videoScanRequestRef.current += 1;
    videoScanControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!videoSessionLoadedRef.current) {
      return;
    }

    if (skipNextVideoSessionPersistRef.current) {
      skipNextVideoSessionPersistRef.current = false;
      return;
    }

    if (!videoScan.videos.length) {
      clearStoredVideoSession();
      return;
    }

    const id = window.setTimeout(() => {
      storeVideoSession({
        videoPageUrl,
        videoScan,
        selectedVideoKeys: Array.from(selectedVideoKeys),
        videoDownloadResult
      });
    }, 350);
    return () => window.clearTimeout(id);
  }, [selectedVideoKeys, videoDownloadResult, videoPageUrl, videoScan]);

  useEffect(() => {
    if (!isDownloadingImages || !imageDownloadJob?.id) {
      return undefined;
    }
    let isCancelled = false;
    let timerId = 0;

    async function pollImageDownloadJob() {
      try {
        const job = await api(`/api/images/download/${encodeURIComponent(imageDownloadJob.id)}`);
        if (isCancelled) return;
        setImageDownloadJob(job);
        if (["complete", "failed", "cancelled"].includes(job.status)) {
          if (job.status === "cancelled" && !job.result) {
            timerId = window.setTimeout(pollImageDownloadJob, 200);
            return;
          }
          setIsDownloadingImages(false);
          if (job.result) {
            await applyImageDownloadResult(job.result, job.items);
          } else {
            const interruptedKeys = imageJobSelection(imageScan.images, job.items);
            setSelectedImageKeys(interruptedKeys);
            setNotice(job.status === "cancelled" ? "Image download stopped." : "");
            if (job.status !== "cancelled") setError(job.error || "Image download failed.");
          }
          return;
        }
        timerId = window.setTimeout(pollImageDownloadJob, 750);
      } catch (nextError) {
        if (!isCancelled) {
          setError(nextError.message);
          if (retryableStatusError(nextError)) timerId = window.setTimeout(pollImageDownloadJob, 1500);
          else setIsDownloadingImages(false);
        }
      }
    }

    pollImageDownloadJob();
    return () => {
      isCancelled = true;
      window.clearTimeout(timerId);
    };
  }, [applyImageDownloadResult, imageDownloadJob?.id, imageScan.images, isDownloadingImages]);

  useEffect(() => {
    if (!isDownloadingVideos || !videoDownloadJob?.id) {
      return undefined;
    }

    let isCancelled = false;
    let timerId = 0;

    async function pollVideoDownloadJob() {
      try {
        const job = await api(`/api/videos/download/${encodeURIComponent(videoDownloadJob.id)}`);
        if (isCancelled) {
          return;
        }

        setVideoDownloadJob(job);
        if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
          setIsDownloadingVideos(false);
          setVideoDownloadJob(null);
          if (job.status === "cancelled") {
            setNotice("Video download stopped.");
            return;
          }
          if (job.result) {
            await applyVideoDownloadResult(job.result);
          } else {
            setError(job.error || "Video download failed.");
          }
          return;
        }

        timerId = window.setTimeout(pollVideoDownloadJob, 1000);
      } catch (nextError) {
        if (!isCancelled) {
          setError(nextError.message);
          if (retryableStatusError(nextError)) timerId = window.setTimeout(pollVideoDownloadJob, 1500);
          else setIsDownloadingVideos(false);
        }
      }
    }

    pollVideoDownloadJob();
    return () => {
      isCancelled = true;
      window.clearTimeout(timerId);
    };
  }, [applyVideoDownloadResult, isDownloadingVideos, videoDownloadJob?.id]);

  useEffect(() => {
    if (!previewModal && !isDownloadSummaryOpen) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setPreviewModal(null);
        setIsDownloadSummaryOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDownloadSummaryOpen, previewModal]);

  useEffect(() => {
    storeToolPaths(toolPaths);
    if (!config || DOWNLOAD_TOOL_IDS.some((toolId) => !toolPaths[toolId])) {
      return undefined;
    }

    const id = window.setTimeout(() => {
      api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolPaths })
      }).catch(() => {});
    }, 450);

    return () => window.clearTimeout(id);
  }, [config, toolPaths]);

  useEffect(() => {
    if (!notice && !error) {
      return undefined;
    }

    const id = window.setTimeout(() => {
      setNotice("");
      setError("");
    }, 5000);

    return () => window.clearTimeout(id);
  }, [error, notice]);

  function dismissToast() {
    setNotice("");
    setError("");
  }

  async function handleMagnetSubmit(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      await api("/api/torrents/magnet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ magnet, downloadPath })
      });
      setMagnet("");
      setNotice("Magnet link added.");
      navigateToTool("torrents");
      await refreshTorrents();
      await refreshHistory();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleFileSubmit(event) {
    event.preventDefault();

    if (!selectedFile) {
      setError("Choose a .torrent file.");
      return;
    }

    setError("");
    setNotice("");
    setIsSubmitting(true);

    const formData = new FormData();
    formData.append("torrent", selectedFile);
    formData.append("downloadPath", downloadPath);

    try {
      await api("/api/torrents/file", {
        method: "POST",
        body: formData
      });
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setNotice(".torrent file added.");
      navigateToTool("torrents");
      await refreshTorrents();
      await refreshHistory();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleBrowseFolder(toolId = "torrents") {
    const currentPath = toolPaths[toolId] || "";
    try {
      const folder = window.magicBox?.chooseDownloadFolder
        ? await window.magicBox.chooseDownloadFolder(currentPath)
        : (await api("/api/system/choose-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPath })
        })).folder;

      if (folder) {
        setToolPaths((current) => ({ ...current, [toolId]: folder }));
      }
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function mutateTorrent(id, action) {
    setError("");
    setNotice("");

    try {
      if (action === "remove") {
        await api(`/api/torrents/${id}`, { method: "DELETE" });
      } else {
        await api(`/api/torrents/${id}/${action}`, { method: "POST" });
      }
      await refreshTorrents();
      await refreshHistory();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function handleApplyTorrentFileSelection(id, selectedFileIndexes) {
    setError("");
    setNotice("");

    try {
      await api(`/api/torrents/${id}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedFileIndexes })
      });
      setNotice("Torrent file selection updated.");
      await refreshTorrents();
      await refreshHistory();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function handleOpenPath(targetPath, options = {}) {
    if (!targetPath) {
      return;
    }

    try {
      await api("/api/system/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath, folder: options.folder === true })
      });
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function handleClearHistory() {
    try {
      await api("/api/history", { method: "DELETE" });
      setHistory([]);
      setNotice("History cleared.");
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function handleRetryHistoryFailures(item) {
    setError("");
    setNotice("");
    try {
      const manifest = await api(`/api/history/${encodeURIComponent(item.id)}/failures`);
      const failures = Array.isArray(manifest?.failures) ? manifest.failures : [];
      if (!failures.length) return;
      const retryImages = failures.map((failure, index) => ({ ...failure, listIndex: failure.listIndex || index + 1 }));
      setImagePageUrl(item.sourceUrl || "");
      setImageScan({
        pageUrl: item.sourceUrl || "",
        galleryName: "",
        count: retryImages.length,
        images: retryImages
      });
      setSelectedImageKeys(new Set(retryImages.map((image, index) => imageKey(image, index))));
      navigateToTool("images");
      await startImageDownload(retryImages, item.sourceUrl || "", item.outputDir, "");
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function handleScanImages(event) {
    event.preventDefault();
    const pendingFailures = Array.isArray(downloadResult?.failures) ? downloadResult.failures : [];
    const scanId = scanRequestRef.current + 1;
    scanRequestRef.current = scanId;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), IMAGE_SCAN_TIMEOUT_MS);
    setError("");
    setNotice("");
    if (!pendingFailures.length) {
      setDownloadResult(null);
    }
    setImageDownloadJob(null);
    setIsDownloadSummaryOpen(false);
    setRangeSelectValue("");
    setImageFilters(emptyImageFilters);
    setImageScan(emptyImageScan);
    setSelectedImageKeys(new Set());
    clearStoredImageSession();
    setIsScanningImages(true);
    revokePreviews();

    try {
      const result = await api("/api/images/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageUrl: imagePageUrl }),
        signal: controller.signal
      });
      if (scanRequestRef.current !== scanId) {
        return;
      }
      setImageScan(result);
      setSelectedImageKeys(new Set(result.images.map((image, index) => imageKey(image, index))));
      if (pendingFailures.length) {
        const matchedFailures = failedImageKeySet(result.images, pendingFailures);
        setNotice(matchedFailures.size
          ? `Gallery refreshed. ${matchedFailures.size} previously failed image(s) matched fresh scan results. Use Retry failed to download them again.`
          : "Gallery refreshed, but the previously failed images could not be matched to the new scan.");
      }
      setIsScanningImages(false);
    } catch (nextError) {
      if (scanRequestRef.current !== scanId) {
        return;
      }
      setImageScan(emptyImageScan);
      setSelectedImageKeys(new Set());
      setError(nextError.name === "AbortError" ? IMAGE_SCAN_TIMEOUT_MESSAGE : nextError.message);
    } finally {
      window.clearTimeout(timeoutId);
      if (scanRequestRef.current === scanId) {
        setIsScanningImages(false);
      }
    }
  }

  function handleToggleImage(key) {
    setSelectedImageKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleSelectAllImages() {
    setSelectedImageKeys(new Set(imageScan.images.map((image, index) => imageKey(image, index))));
  }

  function handleSelectVisibleImages() {
    setSelectedImageKeys((current) => {
      const next = new Set(current);
      visibleImageEntries.forEach((entry) => next.add(entry.key));
      return next;
    });
  }

  function handleClearImages() {
    setSelectedImageKeys(new Set());
  }

  function handleClearVisibleImages() {
    setSelectedImageKeys((current) => {
      const next = new Set(current);
      visibleImageEntries.forEach((entry) => next.delete(entry.key));
      return next;
    });
  }

  function handleImageFilterChange(name, value) {
    setImageFilters((current) => ({
      ...current,
      [name]: value
    }));
  }

  function handleResetImageFilters() {
    setImageFilters(emptyImageFilters);
  }

  function handleRangeSelectSubmit(event) {
    event.preventDefault();

    const failedKeys = failedImageKeySet(imageScan.images, downloadResult?.failures);
    const selectedKeys = rangeExpressionKeySet(rangeSelectValue, imageEntries, visibleImageEntries, failedKeys);
    if (!selectedKeys.size) {
      setError("No images matched that range.");
      return;
    }

    setError("");
    setNotice(`${selectedKeys.size} image(s) selected.`);
    setSelectedImageKeys((current) => {
      const next = new Set(current);
      selectedKeys.forEach((key) => next.add(key));
      return next;
    });
  }

  function handleSelectFailedImages() {
    const failedKeys = failedImageKeySet(imageScan.images, downloadResult?.failures);
    setSelectedImageKeys(failedKeys);
  }

  async function handleOpenImage(image, index) {
    if (!image) {
      return;
    }

    const key = imageKey(image, index);
    const pageLabel = image.pageNumber ? `Page ${image.pageNumber}` : `Item ${index + 1}`;
    let previewUrl = previewUrls[key];
    setPreviewModal({
      key,
      title: image.filename || sourceName(image.url),
      pageLabel,
      sourcePage: image.sourcePage || image.referer || "",
      sourceUrl: image.url,
      previewUrl: previewUrl || "",
      isLoading: !previewUrl,
      error: ""
    });

    if (!previewUrl) {
      try {
        const blob = await previewBlob(image);
        previewUrl = URL.createObjectURL(blob);
        previewUrlRef.current[key] = previewUrl;
        setPreviewUrls((current) => ({ ...current, [key]: previewUrl }));
        setPreviewModal((current) => (
          current?.key === key
            ? { ...current, previewUrl, isLoading: false }
            : current
        ));
      } catch (nextError) {
        setPreviewModal((current) => (
          current?.key === key
            ? {
              ...current,
              previewUrl: image.url,
              isLoading: false,
              error: `Preview proxy failed: ${nextError.message}. Showing the source URL instead.`
            }
            : current
        ));
      }
    }
  }

  async function downloadImagesForKeys(imageKeys) {
    const selectedImages = imageScan.images.reduce((items, image, index) => {
      if (imageKeys.has(imageKey(image, index))) {
        items.push({
          ...image,
          listIndex: image.listIndex || index + 1
        });
      }
      return items;
    }, []);

    if (!selectedImages.length) {
      return;
    }

    await startImageDownload(
      selectedImages,
      imageScan.pageUrl || imagePageUrl,
      imageOutputDir(toolPaths.images, config?.platform),
      imageScan.galleryName
    );
  }

  async function startImageDownload(images, pageUrl, outputDir, galleryName = "") {
    if (!images.length) return;
    setError("");
    setNotice("");
    setDownloadResult(null);
    setIsDownloadSummaryOpen(false);
    setIsDownloadingImages(true);
    try {
      const job = await api("/api/images/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl,
          images,
          outputDir,
          galleryName,
          concurrency: 2,
          background: true
        })
      });
      setImageDownloadJob(job);
    } catch (nextError) {
      setError(nextError.message);
      setIsDownloadingImages(false);
    }
  }

  async function handleCancelImageDownload() {
    if (!imageDownloadJob?.id) return;
    try {
      const job = await api(`/api/images/download/${encodeURIComponent(imageDownloadJob.id)}/cancel`, { method: "POST" });
      setImageDownloadJob(job);
      setNotice("Stopping image download...");
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function handleDownloadImages() {
    await downloadImagesForKeys(selectedImageKeys);
  }

  async function handleRetryFailedImages() {
    const failedKeys = failedImageKeySet(imageScan.images, downloadResult?.failures);
    if (!failedKeys.size) {
      return;
    }

    setSelectedImageKeys(failedKeys);
    await downloadImagesForKeys(failedKeys);
  }

  function handleVideoPageUrlChange(value) {
    videoScanRequestRef.current += 1;
    videoScanControllerRef.current?.abort();
    videoScanControllerRef.current = null;
    setVideoPageUrl(value);
    setVideoVerification(null);
    setIsScanningVideos(false);
    setIsVerifyingVideo(false);
    setError("");
    setNotice("");
  }

  function handleScanVideos(event) {
    event.preventDefault();
    return scanVideos(videoPageUrl);
  }

  function handleVerifyVideos() {
    if (videoVerification?.pageUrl !== videoPageUrl || isScanningVideos) return;
    return scanVideos(videoVerification.pageUrl, { verifyInBrowser: true });
  }

  async function scanVideos(pageUrl, { verifyInBrowser = false } = {}) {
    const scanId = videoScanRequestRef.current + 1;
    videoScanRequestRef.current = scanId;
    videoScanControllerRef.current?.abort();
    const controller = new AbortController();
    videoScanControllerRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), verifyInBrowser ? VIDEO_VERIFICATION_TIMEOUT_MS : VIDEO_SCAN_TIMEOUT_MS);
    setError("");
    setNotice("");
    setVideoDownloadResult(null);
    setVideoDownloadJob(null);
    setVideoRangeSelectValue("");
    setVideoFilters(emptyVideoFilters);
    setVideoScan(emptyVideoScan);
    setSelectedVideoKeys(new Set());
    clearStoredVideoSession();
    if (!verifyInBrowser) setVideoVerification(null);
    setIsVerifyingVideo(verifyInBrowser);
    setIsScanningVideos(true);

    try {
      const result = await api("/api/videos/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl,
          browser: videoUseBrowserLogin && !videoCookiesFile.trim() ? videoBrowser : null,
          ...(videoUseBrowserLogin && videoCookiesFile.trim() ? { cookiesFile: videoCookiesFile.trim() } : {}),
          ...(verifyInBrowser ? { verifyInBrowser: true } : {})
        }),
        signal: controller.signal
      });
      if (videoScanRequestRef.current !== scanId) {
        return;
      }
      setVideoPageUrl(result.pageUrl || pageUrl);
      if (result.authenticated && result.authenticationMethod === "verification-browser") {
        setVideoCookiesFile("");
        setVideoUseBrowserLogin(false);
      }
      setVideoVerification(result.canVerifyInBrowser === true ? {
        pageUrl: result.pageUrl || pageUrl,
        message: result.verificationMessage,
        reason: result.verificationReason,
        canVerifyInBrowser: true
      } : null);
      setVideoScan(result);
      setSelectedVideoKeys(new Set(result.videos.map((video, index) => videoKey(video, index))));
      if (!result.videos.length) {
        announceVideoScan(
          "Video scan finished",
          "No playable main video was found on that page.",
          "warn"
        );
      } else {
        const highestQuality = result.videos[0]?.qualityLabel || "available quality";
        const scanWarning = [result.authenticationWarning, result.qualityWarning].filter(Boolean).join(" ");
        const loginDescription = result.authenticationMethod === "cookies-file"
          ? "the local cookies file"
          : result.authenticationMethod === "verification-browser"
          ? "the saved site session"
          : result.browser ? `${result.browser} login` : "your login";
        announceVideoScan(
          scanWarning ? "Video scan completed with a warning" : "Video scan complete",
          scanWarning
            ? scanWarning
            : result.authenticated
            ? `Found ${result.videos.length} ${pluralize(result.videos.length, "video")} with ${loginDescription}. Highest: ${highestQuality}.`
            : `Found ${result.videos.length} ${pluralize(result.videos.length, "video")}.`,
          scanWarning ? "warn" : "ok"
        );
      }
      setIsScanningVideos(false);
    } catch (nextError) {
      if (videoScanRequestRef.current !== scanId) {
        return;
      }
      setVideoScan(emptyVideoScan);
      setSelectedVideoKeys(new Set());
      const message = nextError.name === "AbortError"
        ? verifyInBrowser ? VIDEO_VERIFICATION_TIMEOUT_MESSAGE : VIDEO_SCAN_TIMEOUT_MESSAGE
        : nextError.message;
      if (nextError.canVerifyInBrowser === true) {
        setVideoVerification((current) => ({
          pageUrl,
          message,
          code: nextError.code,
          reason: verifyInBrowser ? current?.reason : undefined,
          canVerifyInBrowser: true
        }));
      } else if (verifyInBrowser) {
        setVideoVerification((current) => current ? { ...current, message } : null);
      }
      announceVideoScan("Video scan failed", message, "error");
    } finally {
      window.clearTimeout(timeoutId);
      if (videoScanRequestRef.current === scanId) {
        videoScanControllerRef.current = null;
        setIsScanningVideos(false);
        setIsVerifyingVideo(false);
      }
    }
  }

  function handleToggleVideo(key) {
    setSelectedVideoKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleVideoQualityChange(key, variantValue) {
    setVideoScan((current) => ({
      ...current,
      videos: current.videos.map((video, index) => {
        if (videoKey(video, index) !== key) {
          return video;
        }

        const variant = videoVariants(video).find((item, itemIndex) => videoVariantValue(item, itemIndex) === variantValue);
        return variant ? videoWithVariant(video, variant, index) : video;
      })
    }));
  }

  function handleSelectAllVideos() {
    setSelectedVideoKeys(new Set(videoScan.videos.map((video, index) => videoKey(video, index))));
  }

  function handleSelectVisibleVideos() {
    setSelectedVideoKeys((current) => {
      const next = new Set(current);
      visibleVideoEntries.forEach((entry) => next.add(entry.key));
      return next;
    });
  }

  function handleClearVideos() {
    setSelectedVideoKeys(new Set());
  }

  function handleClearVisibleVideos() {
    setSelectedVideoKeys((current) => {
      const next = new Set(current);
      visibleVideoEntries.forEach((entry) => next.delete(entry.key));
      return next;
    });
  }

  function handleVideoFilterChange(name, value) {
    setVideoFilters((current) => ({
      ...current,
      [name]: value
    }));
  }

  function handleResetVideoFilters() {
    setVideoFilters(emptyVideoFilters);
  }

  function handleVideoRangeSelectSubmit(event) {
    event.preventDefault();

    const failedKeys = failedVideoKeySet(videoScan.videos, videoDownloadResult?.failures);
    const selectedKeys = rangeExpressionKeySet(videoRangeSelectValue, videoEntries, visibleVideoEntries, failedKeys);
    if (!selectedKeys.size) {
      setError("No videos matched that range.");
      return;
    }

    setError("");
    setNotice(`${selectedKeys.size} video(s) selected.`);
    setSelectedVideoKeys((current) => {
      const next = new Set(current);
      selectedKeys.forEach((key) => next.add(key));
      return next;
    });
  }

  function handleSelectFailedVideos() {
    const failedKeys = failedVideoKeySet(videoScan.videos, videoDownloadResult?.failures);
    setSelectedVideoKeys(failedKeys);
  }

  function handleOpenVideo(video, index) {
    if (!video) {
      return;
    }

    const key = videoKey(video, index);
    const pageLabel = video.listIndex ? `Item ${video.listIndex}` : `Item ${index + 1}`;
    setPreviewModal({
      key,
      mediaType: "video",
      title: video.filename || sourceName(video.url),
      pageLabel,
      sourcePage: video.sourcePage || video.referer || "",
      sourceUrl: video.url,
      previewUrl: videoPreviewUrl(video),
      poster: video.poster || "",
      bytes: video.bytes || 0,
      displaySize: video.displaySize || "",
      contentType: video.contentType || "",
      qualityLabel: videoQualityLabel(video, ""),
      isLoading: false,
      error: ""
    });
  }

  async function downloadVideosForKeys(videoKeys) {
    const selectedVideos = videoScan.videos.reduce((items, video, index) => {
      if (videoKeys.has(videoKey(video, index))) {
        items.push({
          ...video,
          listIndex: video.listIndex || index + 1
        });
      }
      return items;
    }, []);

    if (!selectedVideos.length) {
      return;
    }

    setError("");
    setNotice("");
    setVideoDownloadResult(null);
    setVideoDownloadJob(null);
    setIsDownloadingVideos(true);

    try {
      const result = await api("/api/videos/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl: videoScan.pageUrl || videoPageUrl,
          videos: selectedVideos,
          outputDir: videoOutputDir(toolPaths.videos, config?.platform),
          background: true
        })
      });

      if (result?.id) {
        setVideoDownloadJob(result);
        setNotice("Video download started.");
        return;
      }

      await applyVideoDownloadResult(result);
      setIsDownloadingVideos(false);
    } catch (nextError) {
      setError(nextError.message);
      setIsDownloadingVideos(false);
    }
  }

  async function handleDownloadVideos() {
    await downloadVideosForKeys(selectedVideoKeys);
  }

  async function handleCancelVideoDownload() {
    const jobId = videoDownloadJob?.id;
    setError("");
    setIsDownloadingVideos(false);
    setVideoDownloadJob(null);
    setNotice("Video download stopped.");

    if (!jobId) {
      return;
    }

    try {
      await api(`/api/videos/download/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST"
      });
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const resizeTorrentSidebar = useCallback((delta) => {
    setTorrentSidebarWidth((current) => {
      const next = clampPaneSize(current + delta, 280, 560);
      storePaneSize(TORRENT_SIDEBAR_WIDTH_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const navigateToTool = useCallback((worldId) => {
    if (TOOLBOX_WORLDS.some((world) => world.id === worldId)) {
      setLastToolboxWorldId(worldId);
    }
    setActiveView(worldId);
  }, []);

  const returnToToolbox = useCallback(() => {
    setActiveView("toolbox");
  }, []);

  const handleEnterFromOpening = useCallback((destination) => {
    const nextView = destination || "toolbox";
    if (TOOLBOX_WORLDS.some((world) => world.id === nextView)) {
      setLastToolboxWorldId(nextView);
    }
    setActiveView(nextView);
    setShowOpeningPage(false);
    try {
      window.localStorage.setItem(OPENING_SEEN_STORAGE_KEY, "true");
      window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, nextView);
    } catch {
    }
  }, []);

  useEffect(() => {
    if (showOpeningPage) {
      return;
    }
    try {
      window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, activeView);
    } catch {
    }
  }, [activeView, showOpeningPage]);

  if (showOpeningPage) {
    return <OpeningPage onEnter={handleEnterFromOpening} />;
  }

  return (
    <main className="app-shell poster-only-shell" data-world={activeView}>
      <section className="main-stage">
        {activeView === "toolbox" ? (
          <ToolboxHome
            initialWorldId={lastToolboxWorldId}
            onNavigate={navigateToTool}
          />
        ) : activeView === "assistant" ? (
          <Suspense fallback={<ToolPageLoadingFallback label="Private Assistant" />}>
            <LazyAssistant onBack={returnToToolbox} />
          </Suspense>
        ) : (
          <section className={classNames("module-page", `module-page-${activeView}`)} aria-label="Selected tool">
            {activeView === "images" ? (
              <>
                <ModuleHeader
                  downloadPath={toolPaths.images}
                  icon={ImageIcon}
                  title="Image Downloader"
                  subtitle="Scan a page, preview discovered images, and download the selected set."
                  onBack={returnToToolbox}
                  onBrowseFolder={() => handleBrowseFolder("images")}
                />
                <Suspense fallback={<ToolPageLoadingFallback label="Image Downloader" />}>
                  <LazyImageDownloaderPage
                  downloadResult={downloadResult}
                  imageDownloadJob={imageDownloadJob}
                  imageEntries={imageEntries}
                  imageFilterOptions={imageFilterOptions}
                  imageFilters={imageFilters}
                  imagePageUrl={imagePageUrl}
                  imageScan={imageScan}
                  imageStatus={imageStatus}
                  isDownloadingImages={isDownloadingImages}
                  isScanningImages={isScanningImages}
                  previewErrors={previewErrors}
                  previewUrls={previewUrls}
                  rangeSelectValue={rangeSelectValue}
                  selectedImageKeys={selectedImageKeys}
                  visibleImageEntries={visibleImageEntries}
                  onClearImages={handleClearImages}
                  onClearVisibleImages={handleClearVisibleImages}
                  onCancelImageDownload={handleCancelImageDownload}
                  onDownloadImages={handleDownloadImages}
                  onImageFilterChange={handleImageFilterChange}
                  onImagePageUrlChange={setImagePageUrl}
                  onOpenDownloadSummary={() => setIsDownloadSummaryOpen(true)}
                  onOpenImage={handleOpenImage}
                  onRequestPreview={requestImagePreview}
                  onRangeSelectSubmit={handleRangeSelectSubmit}
                  onRangeSelectValueChange={setRangeSelectValue}
                  onResetImageFilters={handleResetImageFilters}
                  onScanImages={handleScanImages}
                  onSelectAllImages={handleSelectAllImages}
                  onSelectFailedImages={handleSelectFailedImages}
                  onRetryFailedImages={handleRetryFailedImages}
                  onSelectVisibleImages={handleSelectVisibleImages}
                  onToggleImage={handleToggleImage}
                  />
                </Suspense>
              </>
            ) : activeView === "videos" ? (
              <>
                <ModuleHeader
                  downloadPath={toolPaths.videos}
                  icon={Video}
                  title="Video Downloader"
                  subtitle="Scan a page, preview discovered videos, and download the selected set."
                  onBack={returnToToolbox}
                  onBrowseFolder={() => handleBrowseFolder("videos")}
                />
                <Suspense fallback={<ToolPageLoadingFallback label="Video Downloader" />}>
                  <LazyVideoDownloaderPage
                  videoBrowser={videoBrowser}
                  videoUseBrowserLogin={videoUseBrowserLogin}
                  videoCookiesFile={videoCookiesFile}
                  isDownloadingVideos={isDownloadingVideos}
                  isScanningVideos={isScanningVideos}
                  isVerifyingVideo={isVerifyingVideo}
                  videoVerification={videoVerification?.pageUrl === videoPageUrl ? videoVerification : null}
                  selectedVideoKeys={selectedVideoKeys}
                  videoDownloadJob={videoDownloadJob}
                  videoDownloadResult={videoDownloadResult}
                  videoEntries={videoEntries}
                  videoFilterOptions={videoFilterOptions}
                  videoFilters={videoFilters}
                  videoPageUrl={videoPageUrl}
                  videoRangeSelectValue={videoRangeSelectValue}
                  videoScan={videoScan}
                  videoStatus={videoStatus}
                  visibleVideoEntries={visibleVideoEntries}
                  onClearVideos={handleClearVideos}
                  onClearVisibleVideos={handleClearVisibleVideos}
                  onCancelVideoDownload={handleCancelVideoDownload}
                  onVideoBrowserChange={setVideoBrowser}
                  onVideoUseBrowserLoginChange={setVideoUseBrowserLogin}
                  onVideoCookiesFileChange={setVideoCookiesFile}
                  onDownloadVideos={handleDownloadVideos}
                  onOpenVideo={handleOpenVideo}
                  onRangeSelectSubmit={handleVideoRangeSelectSubmit}
                  onRangeSelectValueChange={setVideoRangeSelectValue}
                  onResetVideoFilters={handleResetVideoFilters}
                  onScanVideos={handleScanVideos}
                  onVerifyVideos={handleVerifyVideos}
                  onSelectAllVideos={handleSelectAllVideos}
                  onSelectFailedVideos={handleSelectFailedVideos}
                  onSelectVisibleVideos={handleSelectVisibleVideos}
                  onToggleVideo={handleToggleVideo}
                  onVideoFilterChange={handleVideoFilterChange}
                  onVideoPageUrlChange={handleVideoPageUrlChange}
                  onVideoQualityChange={handleVideoQualityChange}
                  />
                </Suspense>
              </>
            ) : activeView === "voice-clone" ? (
              <>
                <ModuleHeader
                  downloadPath={toolPaths["voice-clone"]}
                  icon={Mic}
                  title="Voice Clone"
                  subtitle="Create a voice profile, then generate speech from text or transform Source Audio."
                  onBack={returnToToolbox}
                  onBrowseFolder={() => handleBrowseFolder("voice-clone")}
                />
                <Suspense fallback={<ToolPageLoadingFallback label="Voice Clone" />}>
                  <LazyVoiceClonePage
                    config={config}
                    downloadPath={toolPaths["voice-clone"]}
                    onError={setError}
                    onNotice={setNotice}
                    onOpenPath={handleOpenPath}
                  />
                </Suspense>
              </>
            ) : activeView === "file-transfer" ? (
              <>
                <ModuleHeader
                  downloadPath={toolPaths["file-transfer"]}
                  icon={Files}
                  title="File Transfer"
                  subtitle="Move files between Windows, iPhone, iPad, and Mac with a private pairing room."
                  onBack={returnToToolbox}
                  onBrowseFolder={() => handleBrowseFolder("file-transfer")}
                />
                <Suspense fallback={<ToolPageLoadingFallback label="File Transfer" />}>
                  <LazyFileTransferPage
                    downloadPath={toolPaths["file-transfer"]}
                    onError={setError}
                    onNotice={setNotice}
                    onOpenPath={handleOpenPath}
                  />
                </Suspense>
              </>
            ) : activeView === "format-factory" ? (
              <>
                <Suspense fallback={<ToolPageLoadingFallback label="Format Factory" />}>
                  <LazyFormatFactoryPage
                    downloadPath={toolPaths["format-factory"]}
                    onPathChange={pathValue => setToolPaths(current => ({ ...current, 'format-factory':pathValue }))}
                    onBack={returnToToolbox}
                    onBrowseFolder={() => handleBrowseFolder("format-factory")}
                    onError={setError}
                    onNotice={setNotice}
                    onOpenPath={handleOpenPath}
                  />
                </Suspense>
              </>
            ) : activeView === "history" ? (
              <>
                <ModuleHeader
                  icon={History}
                  title="History"
                  subtitle="Review recent image downloads, torrent jobs, failures, and saved folders."
                  onBack={returnToToolbox}
                />
                <Suspense fallback={<ToolPageLoadingFallback label="History" />}>
                  <LazyHistoryPage
                    history={history}
                    historySearch={historySearch}
                    isHistoryLoading={isHistoryLoading}
                    onClearHistory={handleClearHistory}
                    onHistorySearchChange={setHistorySearch}
                    onOpenHistoryFolder={handleOpenPath}
                    onRefreshHistory={refreshHistory}
                    onRetryHistoryFailures={handleRetryHistoryFailures}
                  />
                </Suspense>
              </>
            ) : (
              <>
                <ModuleHeader
                  downloadPath={downloadPath}
                  icon={Download}
                  title="Torrent Downloader"
                  subtitle="Add magnet links or torrent files, then monitor the queue and file selection."
                  onBack={returnToToolbox}
                  onBrowseFolder={() => handleBrowseFolder("torrents")}
                />
                <Suspense fallback={<ToolPageLoadingFallback label="Torrent Downloader" />}>
                  <LazyTorrentDownloaderPage
                    activeCount={activeCount}
                    completedCount={completedCount}
                    config={config}
                    downloadPath={downloadPath}
                    fileInputRef={fileInputRef}
                    isSubmitting={isSubmitting}
                    magnet={magnet}
                    selectedFile={selectedFile}
                    selectedTorrentId={selectedTorrentId}
                    statusText={statusText}
                    torrentSidebarWidth={torrentSidebarWidth}
                    torrents={torrents}
                    onApplyTorrentFileSelection={handleApplyTorrentFileSelection}
                    onBrowseFolder={handleBrowseFolder}
                    onFileSubmit={handleFileSubmit}
                    onMagnetChange={setMagnet}
                    onMagnetSubmit={handleMagnetSubmit}
                    onMutateTorrent={mutateTorrent}
                    onPathChange={(pathValue) => setToolPaths((current) => ({ ...current, torrents: pathValue }))}
                    onRefresh={refreshTorrents}
                    onResetSidebar={() => {
                      setTorrentSidebarWidth(340);
                      storePaneSize(TORRENT_SIDEBAR_WIDTH_STORAGE_KEY, 340);
                    }}
                    onResizeSidebar={resizeTorrentSidebar}
                    onSelectTorrent={setSelectedTorrentId}
                    onSelectedFileChange={setSelectedFile}
                  />
                </Suspense>
              </>
            )}
          </section>
        )}

        {(notice || error) ? (
          <div className={classNames("toast", error && "toast-error")} role={error ? "alert" : "status"}>
            {error ? <X size={18} /> : <Check size={18} />}
            <span className="toast-message">{error || notice}</span>
            <button className="toast-close" type="button" aria-label="Dismiss message" onClick={dismissToast}>
              <X size={16} />
            </button>
          </div>
        ) : null}

        <PreviewModal preview={previewModal} onClose={() => setPreviewModal(null)} />
        <DownloadSummary
          isRetrying={isDownloadingImages}
          result={isDownloadSummaryOpen ? downloadResult : null}
          onClose={() => setIsDownloadSummaryOpen(false)}
          onRetryFailedImages={handleRetryFailedImages}
          onSelectFailedImages={handleSelectFailedImages}
        />
      </section>
    </main>
  );
}
