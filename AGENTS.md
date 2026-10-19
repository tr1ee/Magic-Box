# Project instructions

## Platform branches and shared changes

- `main` is the existing published baseline. Do not push platform fixes to it or change its default branch without a separate request.
- Windows development tracks `codex/windows`; macOS development tracks `codex/macos`. Do not merge either entire platform branch into the other.
- Share a feature through a focused commit based on a common ancestor (for example `codex/shared-startup`), then cherry-pick it into the target platform and validate there. A shared candidate is not validated on both platforms merely because it builds on one.
- Before committing, check the current branch and changed paths. Fetch the other platform's branch to inspect improvements; fetching alone does not apply them.
- Preserve Windows launchers, installer scripts, model installers and runtime contracts when importing Mac sources. Missing files in a Mac build kit are not deletion requests.
- Model weights, downloaded runtimes, user data, cookies and secrets stay outside Git. Preserve per-user models and settings on both platforms. A model-free Mac build does not remove Windows model support.
- On macOS, run relevant tests and the production frontend build; native release acceptance additionally requires the Mac build, packaged resources/signature checks and actual launch verification. Report these acceptance states separately. Windows packaging is performed on Windows.

## Windows local packaging

The following packaging requirements apply to Windows implementation updates, including shared features being accepted into `codex/windows`:

- Treat an implementation update as incomplete until the local WebView2 desktop package has been rebuilt successfully.
- After changing application, UI, server, shared, desktop, or packaging code, run the relevant tests and production build, then run:

  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-webview2.ps1`

- Verify that the changed code/assets are present under `release/chromium/MagicBox`, including packaged server or frontend files when applicable.
- In the final handoff, report the local executable at `release/chromium/MagicBox/MagicBox.exe` and state whether packaging succeeded.
- If packaging or packaged-artifact verification fails, do not describe the update as complete; report the failure and continue fixing it when possible.

# Magic Box macOS 更新约定

- 用户要求只保留一个系统应用入口：`/Applications/MagicBox.app`。后续更新替换此路径，交付链接也指向此路径。
- 不要将 `before-*`、`render-fix-*`、功能预览等旧版本以松散 `.app` 留在工作区、下载目录或桌面。临时打包使用 `.cache/macos-build.noindex`，成功和失败退出时都清理临时应用；发布文件保留 DMG/ZIP。
- 替换前先验证新版签名和必需资源。替换后验证安装路径中的版本与签名，再删除旧副本，并针对旧路径使用 `lsregister -u`，最后对正式安装路径使用 `lsregister -f`。
- 保留 `~/Library/Application Support/MagicBox` 中的用户设置、资料和模型，以及 `~/Downloads/MagicBox` 中的下载文件。
