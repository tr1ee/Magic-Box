import { Check, Download, FileText, FolderOpen, Info, Link, Pause, Play, RefreshCcw, Trash2, Upload } from "lucide-react";
import { formatBytes } from "../lib/format.js";
import { AppButton, classNames } from "../components/AppButton.jsx";
import IconBox from "../components/IconBox.jsx";
import SplitHandle from "../components/SplitHandle.jsx";

const numberFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1
});

function formatSpeed(value) {
  return `${formatBytes(value)}/s`;
}

function formatEta(value) {
  if (!value || value === Infinity) {
    return "Unknown";
  }

  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function torrentHealthHint(torrent) {
  if (!torrent) {
    return "Select a torrent to inspect health.";
  }

  if (torrent.status === "metadata") {
    return "Fetching metadata. If this lasts a long time, the magnet may have no reachable peers.";
  }

  if (torrent.status === "complete") {
    return "Complete. You can remove it from the queue without deleting saved files.";
  }

  if (!torrent.peers) {
    return "No peers yet. Check tracker/DHT reachability, VPN, firewall, or whether the torrent is seeded.";
  }

  if (torrent.peers && !torrent.connectedPeers) {
    return "Peers were discovered but none are connected yet. This can happen with strict NAT or unavailable peers.";
  }

  if (torrent.status === "downloading" && torrent.connectedPeers && !torrent.downloadSpeed) {
    return "Connected but stalled. The connected peers may not have the pieces you need.";
  }

  return "Connection looks normal for the current peer state.";
}

function TorrentIntakePanel({
  downloadPath,
  isSubmitting,
  magnet,
  onBrowseFolder,
  onFileSubmit,
  onMagnetChange,
  onMagnetSubmit,
  onPathChange,
  onSelectedFileChange,
  selectedFile,
  fileInputRef
}) {
  return (
    <aside className="module-sidebar" aria-label="Torrent setup">
      <section className="rail-panel magnet-panel">
        <div className="panel-title">
          <Link size={20} />
          <h2>Magnet URL</h2>
        </div>
        <form onSubmit={onMagnetSubmit}>
          <textarea
            aria-label="Magnet URL"
            className="field magnet-field"
            value={magnet}
            onChange={(event) => onMagnetChange(event.target.value)}
            placeholder="magnet:?xt=urn:btih:..."
            spellCheck="false"
          />
          <AppButton tone="primary" type="submit" disabled={isSubmitting || !magnet.trim()}>
            <Link size={18} />
            Add magnet
          </AppButton>
        </form>
      </section>

      <section className="rail-panel compact-panel">
        <div className="panel-title">
          <FileText size={20} />
          <h2>.torrent file</h2>
        </div>
        <form onSubmit={onFileSubmit}>
          <div className="file-picker-row">
            <input
              aria-label="Selected torrent file"
              className="field file-name-field"
              readOnly
              value={selectedFile?.name || "No file selected."}
            />
            <label className="app-button app-button-secondary file-trigger" htmlFor="torrent-file">
              Choose file
            </label>
            <input
              id="torrent-file"
              ref={fileInputRef}
              className="native-file-input"
              type="file"
              accept=".torrent,application/x-bittorrent"
              onChange={(event) => onSelectedFileChange(event.target.files?.[0] || null)}
            />
          </div>
          <AppButton tone="outline" type="submit" disabled={isSubmitting || !selectedFile}>
            <Upload size={18} />
            Add selected
          </AppButton>
        </form>
      </section>

      <section className="rail-panel compact-panel">
        <div className="panel-title">
          <FolderOpen size={20} />
          <h2>Save folder</h2>
        </div>
        <div className="folder-row">
          <input
            aria-label="Save folder"
            className="field"
            value={downloadPath}
            onChange={(event) => onPathChange(event.target.value)}
            spellCheck="false"
          />
          <AppButton tone="secondary" onClick={onBrowseFolder}>
            Browse
          </AppButton>
        </div>
      </section>
    </aside>
  );
}

function TorrentsTab({
  activeCount,
  completedCount,
  config,
  onApplyTorrentFileSelection,
  onMutateTorrent,
  onRefresh,
  onSelectTorrent,
  selectedTorrentId,
  statusText,
  torrents
}) {
  const selectedTorrent = torrents.find((torrent) => torrent.id === selectedTorrentId);
  const selectedTorrentFileIndexes = new Set(
    selectedTorrent?.files?.filter((file) => file.selected).map((file) => file.index) || []
  );

  return (
    <section className="tab-surface torrent-surface" role="tabpanel" aria-label="Torrents">
      <div className="torrent-toolbar">
        <div>
          <h2>{torrents.length} torrent(s) in queue.</h2>
          <p>{activeCount} active / {completedCount} complete</p>
        </div>
        <AppButton tone="secondary" onClick={onRefresh}>
          <RefreshCcw size={19} />
          Refresh
        </AppButton>
      </div>

      <div className="data-table torrent-table" aria-label="Torrent queue">
        <div className="table-head torrent-grid">
          <span>Name</span>
          <span>Status</span>
          <span>Progress</span>
          <span>Speed</span>
          <span>Peers</span>
          <span>Connected</span>
          <span>ETA</span>
          <span>Save path</span>
        </div>
        {torrents.length ? (
          torrents.map((torrent) => {
            const progress = Math.round((torrent.progress || 0) * 100);
            const connectedPeers = torrent.connectedPeers ?? torrent.peers ?? 0;
            return (
              <button
                className={classNames("table-row torrent-grid torrent-row", selectedTorrentId === torrent.id && "selected")}
                key={torrent.id}
                type="button"
                onClick={() => onSelectTorrent(torrent.id)}
              >
                <strong>{torrent.name || "Fetching metadata"}</strong>
                <span className={classNames("pill", `pill-${torrent.status || "metadata"}`)}>{torrent.status || "metadata"}</span>
                <span>
                  <span className="mini-progress" aria-label={`${progress}% complete`}>
                    <i style={{ width: `${progress}%` }} />
                  </span>
                  {progress}%
                </span>
                <span>{formatSpeed(torrent.downloadSpeed)}</span>
                <span>{torrent.peers || 0}</span>
                <span>{connectedPeers}</span>
                <span>{formatEta(torrent.timeRemaining)}</span>
                <span className="path-cell">{torrent.downloadPath || ""}</span>
              </button>
            );
          })
        ) : (
          <div className="empty-table-state">
            <Download size={42} />
            <h2>Queue is clear</h2>
            <p>Add a magnet link or .torrent file from the left panel.</p>
          </div>
        )}
      </div>

      <div className="torrent-detail-panel" aria-label="Selected torrent details">
        <section className="torrent-file-picker">
          <header>
            <div>
              <strong>Files</strong>
              <span>
                {selectedTorrent?.files?.length
                  ? `${selectedTorrent.selectedFileCount || 0}/${selectedTorrent.files.length} selected`
                  : "Metadata required"}
              </span>
            </div>
            <div className="mini-action-row">
              <AppButton
                tone="secondary"
                disabled={!selectedTorrent?.files?.length}
                onClick={() => onApplyTorrentFileSelection(selectedTorrent.id, selectedTorrent.files.map((file) => file.index))}
              >
                Select all
              </AppButton>
              <AppButton
                tone="secondary"
                disabled={!selectedTorrent?.files?.length}
                onClick={() => onApplyTorrentFileSelection(selectedTorrent.id, [])}
              >
                Select none
              </AppButton>
            </div>
          </header>
          {selectedTorrent?.files?.length ? (
            <div className="torrent-file-list">
              {selectedTorrent.files.map((file) => {
                const nextIndexes = file.selected
                  ? Array.from(selectedTorrentFileIndexes).filter((index) => index !== file.index)
                  : [...Array.from(selectedTorrentFileIndexes), file.index];
                return (
                  <button
                    className={classNames("torrent-file-row", file.selected && "selected")}
                    key={`${selectedTorrent.id}-${file.index}`}
                    type="button"
                    onClick={() => onApplyTorrentFileSelection(selectedTorrent.id, nextIndexes)}
                  >
                    <IconBox checked={file.selected} />
                    <span>{file.name}</span>
                    <small>{Math.round((file.progress || 0) * 100)}% - {formatBytes(file.length)}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="detail-empty">Select a torrent and wait for metadata to choose files.</p>
          )}
        </section>

        <section className="torrent-health-panel">
          <header>
            <div>
              <strong>Health</strong>
              <span>{selectedTorrent ? selectedTorrent.status : "No torrent selected"}</span>
            </div>
            <Info size={21} />
          </header>
          <p>{torrentHealthHint(selectedTorrent)}</p>
          <div className="health-grid">
            <span>DHT <strong>{(selectedTorrent?.dhtEnabled ?? config?.dhtEnabled) ? "On" : "Off"}</strong></span>
            <span>Tracker <strong>{(selectedTorrent?.trackerEnabled ?? config?.trackerEnabled) ? "On" : "Off"}</strong></span>
            <span>Port <strong>{selectedTorrent?.torrentPort || config?.torrentPort || "Unknown"}</strong></span>
            <span>Max conns <strong>{selectedTorrent?.maxConnections || config?.maxConnections || "Unknown"}</strong></span>
            <span>Peers <strong>{selectedTorrent?.peers || 0}</strong></span>
            <span>Connected <strong>{selectedTorrent?.connectedPeers || 0}</strong></span>
            <span>Down <strong>{formatSpeed(selectedTorrent?.downloadSpeed || 0)}</strong></span>
            <span>Ratio <strong>{numberFormatter.format(selectedTorrent?.ratio || 0)}</strong></span>
          </div>
        </section>
      </div>

      <footer className="status-bar torrent-status">
        <div className="status-cluster">
          <span className="status-orb">
            <Check size={21} />
          </span>
          <strong>{statusText}</strong>
        </div>
        <div className="torrent-control-actions">
          <AppButton tone="secondary" disabled={!selectedTorrent} onClick={() => onMutateTorrent(selectedTorrent.id, "pause")}>
            <Pause size={18} />
            Pause
          </AppButton>
          <AppButton tone="secondary" disabled={!selectedTorrent} onClick={() => onMutateTorrent(selectedTorrent.id, "resume")}>
            <Play size={18} />
            Resume
          </AppButton>
          <AppButton tone="danger" disabled={!selectedTorrent} onClick={() => onMutateTorrent(selectedTorrent.id, "remove")}>
            <Trash2 size={18} />
            Remove
          </AppButton>
        </div>
      </footer>
    </section>
  );
}

export default function TorrentDownloaderPage({
  activeCount,
  completedCount,
  config,
  downloadPath,
  fileInputRef,
  isSubmitting,
  magnet,
  onApplyTorrentFileSelection,
  onBrowseFolder,
  onFileSubmit,
  onMagnetChange,
  onMagnetSubmit,
  onMutateTorrent,
  onPathChange,
  onRefresh,
  onResetSidebar,
  onResizeSidebar,
  onSelectTorrent,
  onSelectedFileChange,
  selectedFile,
  selectedTorrentId,
  statusText,
  torrentSidebarWidth,
  torrents
}) {
  return (
    <div className="torrent-module-grid" style={{ "--torrent-sidebar-width": `${torrentSidebarWidth}px` }}>
      <TorrentIntakePanel
        downloadPath={downloadPath}
        fileInputRef={fileInputRef}
        isSubmitting={isSubmitting}
        magnet={magnet}
        selectedFile={selectedFile}
        onBrowseFolder={onBrowseFolder}
        onFileSubmit={onFileSubmit}
        onMagnetChange={onMagnetChange}
        onMagnetSubmit={onMagnetSubmit}
        onPathChange={onPathChange}
        onSelectedFileChange={onSelectedFileChange}
      />
      <SplitHandle
        className="torrent-split-handle"
        label="Resize torrent setup and queue"
        maximum={560}
        minimum={280}
        onReset={onResetSidebar}
        onResize={onResizeSidebar}
        testId="torrent-split-handle"
        value={torrentSidebarWidth}
      />
      <TorrentsTab
        activeCount={activeCount}
        completedCount={completedCount}
        config={config}
        selectedTorrentId={selectedTorrentId}
        statusText={statusText}
        torrents={torrents}
        onApplyTorrentFileSelection={onApplyTorrentFileSelection}
        onMutateTorrent={onMutateTorrent}
        onRefresh={onRefresh}
        onSelectTorrent={onSelectTorrent}
      />
    </div>
  );
}
