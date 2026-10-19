import { useDeferredValue, useMemo } from "react";
import { FolderOpen, History, Loader2, RefreshCcw, RotateCcw, Search, Trash2 } from "lucide-react";
import { formatBytes, formatDateTime } from "../lib/format.js";
import { AppButton, classNames } from "../components/AppButton.jsx";

function HistoryTab({
  history,
  historySearch,
  isHistoryLoading,
  onClearHistory,
  onHistorySearchChange,
  onOpenHistoryFolder,
  onRefreshHistory,
  onRetryHistoryFailures
}) {
  const deferredHistorySearch = useDeferredValue(historySearch);
  const filteredHistory = useMemo(() => {
    const search = deferredHistorySearch.trim().toLowerCase();
    if (!search) {
      return history;
    }

    return history.filter((item) => [
      item.type,
      item.sourceUrl,
      item.outputDir,
      item.name,
      item.infoHash,
      item.status
    ].filter(Boolean).join(" ").toLowerCase().includes(search));
  }, [deferredHistorySearch, history]);

  return (
    <section className="tab-surface history-surface" role="tabpanel" aria-label="History">
      <div className="history-toolbar">
        <div>
          <h2>{history.length} history item(s)</h2>
          <p>Local activity from image, video, and torrent jobs.</p>
        </div>
        <div className="history-actions">
          <div className="filter-input-with-icon history-search">
            <Search size={17} />
            <input
              value={historySearch}
              onChange={(event) => onHistorySearchChange(event.target.value)}
              placeholder="Search history"
              spellCheck="false"
            />
          </div>
          <AppButton tone="secondary" onClick={onRefreshHistory} disabled={isHistoryLoading}>
            {isHistoryLoading ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
            Refresh
          </AppButton>
          <AppButton tone="danger" onClick={onClearHistory} disabled={!history.length}>
            <Trash2 size={18} />
            Clear
          </AppButton>
        </div>
      </div>

      <div className="history-list" aria-label="Download history">
        {filteredHistory.length ? (
          filteredHistory.map((item) => {
            const isImage = item.type === "image";
            const isVideo = item.type === "video";
            const isMedia = isImage || isVideo;
            const title = isMedia
              ? item.sourceUrl || (isVideo ? "Video download" : "Image download")
              : item.name || item.infoHash || "Torrent";
            const failures = Array.isArray(item.failures) ? item.failures : [];
            const skipped = Number(item.skipped || 0);
            return (
              <article className="history-item" key={item.id || `${item.type}-${item.timestamp}`}>
                <header>
                  <div>
                    <strong>{title}</strong>
                    <span>{formatDateTime(item.timestamp || item.updatedAt)}</span>
                  </div>
                  <span className={classNames("pill", isMedia ? "pill-complete" : `pill-${item.status || "metadata"}`)}>
                    {isMedia ? item.type : item.status || "torrent"}
                  </span>
                </header>
                <div className="history-meta">
                  {isMedia ? (
                    <>
                      <span>{item.downloaded || 0} saved</span>
                      {isImage ? <span>{skipped} skipped</span> : null}
                      <span>{item.failed || 0} failed</span>
                    </>
                  ) : (
                    <>
                      <span>{item.selectedFileCount || 0}/{item.fileCount || 0} files</span>
                      <span>{Math.round((item.progress || 0) * 100)}%</span>
                      <span>{formatBytes(item.downloaded || 0)} / {formatBytes(item.length || 0)}</span>
                    </>
                  )}
                </div>
                {item.outputDir ? <code>{item.outputDir}</code> : null}
                <footer>
                  <AppButton tone="secondary" onClick={() => onOpenHistoryFolder(item.outputDir)} disabled={!item.outputDir}>
                    <FolderOpen size={18} />
                    Open folder
                  </AppButton>
                  {isImage && failures.length ? (
                    <AppButton tone="accent" onClick={() => onRetryHistoryFailures(item)}>
                      <RotateCcw size={18} />
                      Retry failed
                    </AppButton>
                  ) : null}
                </footer>
              </article>
            );
          })
        ) : (
          <div className="empty-table-state">
            <History size={42} />
            <h2>No history yet</h2>
            <p>Image, video, and torrent jobs will appear here after they run.</p>
          </div>
        )}
      </div>
    </section>
  );
}

export default HistoryTab;
