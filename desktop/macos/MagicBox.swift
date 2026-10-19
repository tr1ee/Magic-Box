import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var readyTimer: Timer?
    var readyFile: URL!
    var localOrigin: URL?
    var terminating = false
    var logHandle: FileHandle?
    let data = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/MagicBox")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        makeMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Magic Box"
        window.minSize = NSSize(width: 900, height: 620)
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        do { try launchServer() } catch { fail(error.localizedDescription) }
    }

    func makeMenu() {
        let menu = NSMenu()
        let appMenu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        menu.addItem(appItem)
        appMenu.addItem(withTitle: "模型与功能说明…", action: #selector(modelInfo), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Magic Box", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenu(title: "Edit")
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        menu.addItem(editItem)
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
    }

    @objc func modelInfo() {
        let alert = NSAlert()
        alert.messageText = "Magic Box · macOS 基础版"
        alert.informativeText = "已包含下载、图片、音视频转换、文档处理和局域网传文件所需的基础组件。\n\n本包不包含大语言模型、语音模型、训练模型或个人数据。需要本地 AI 时，请打开 Private Assistant → Models，查看大小和许可后自行下载；模型存放于用户资料目录。\n\n语音克隆和训练的自动安装器目前仅支持 Windows；Mac 版尚未提供这些引擎的自动安装。DOCX 转 PDF 需要另外安装 LibreOffice。"
        alert.runModal()
    }

    func launchServer() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: data, withIntermediateDirectories: true)
        let runDir = fm.temporaryDirectory.appendingPathComponent("MagicBox-\(UUID().uuidString)")
        try fm.createDirectory(at: runDir, withIntermediateDirectories: true)
        readyFile = runDir.appendingPathComponent("ready.json")
        let root = Bundle.main.resourceURL!.appendingPathComponent("app")
        let log = data.appendingPathComponent("desktop.log")
        // A new launch starts a bounded session log instead of growing it forever.
        fm.createFile(atPath: log.path, contents: nil)
        logHandle = try FileHandle(forWritingTo: log)
        let child = Process()
        child.executableURL = root.appendingPathComponent("node")
        child.arguments = [root.appendingPathComponent("desktop/macos/server-entry.mjs").path]
        child.currentDirectoryURL = data
        var env = ProcessInfo.processInfo.environment
        env["HOST"] = "127.0.0.1"
        env["PORT"] = "0"
        env["NODE_ENV"] = "production"
        env["MAGIC_BOX_READY_FILE"] = readyFile.path
        env["MAGIC_BOX_SETTINGS_FILE"] = data.appendingPathComponent("settings.json").path
        env["MAGIC_BOX_ASSISTANT_DATA_DIR"] = data.appendingPathComponent("assistant").path
        env["MAGIC_BOX_VOICE_DATA_ROOT"] = data.appendingPathComponent("voice_clone").path
        env["MAGIC_BOX_YTDLP_PATH"] = root.appendingPathComponent("vendor/yt-dlp").path
        env["TORRENT_DOWNLOAD_DIR"] = fm.homeDirectoryForCurrentUser.appendingPathComponent("Downloads/MagicBox").path
        child.environment = env
        child.standardOutput = logHandle
        child.standardError = logHandle
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, !self.terminating else { return }
                self.fail("后台服务已退出。请查看 \(log.path)")
            }
        }
        server = child
        try child.run()
        let deadline = Date().addingTimeInterval(90)
        readyTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            if let bytes = try? Data(contentsOf: self.readyFile),
               let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: String],
               let raw = object["url"], let url = URL(string: raw), url.host == "127.0.0.1", url.scheme == "http" {
                timer.invalidate()
                self.localOrigin = url
                self.webView.load(URLRequest(url: url))
            } else if Date() > deadline {
                timer.invalidate()
                self.fail("启动超时。请查看 \(log.path)")
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !UserDefaults.standard.bool(forKey: "baseEditionNoticeV1") {
            UserDefaults.standard.set(true, forKey: "baseEditionNoticeV1")
            modelInfo()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if let origin = localOrigin, url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func fail(_ message: String) {
        readyTimer?.invalidate()
        let alert = NSAlert()
        alert.messageText = "Magic Box 无法启动"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        terminating = true
        readyTimer?.invalidate()
        guard let child = server, child.isRunning else { return .terminateNow }
        child.terminate()
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(10)
            while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            if let directory = self.readyFile?.deletingLastPathComponent() { try? FileManager.default.removeItem(at: directory) }
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
