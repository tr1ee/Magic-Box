Magic Box 首个公开基础版：种子与媒体下载、格式转换、基础文档处理和局域网双向文件传输。

所有基础安装包均排除大语言模型、语音模型、个人训练模型与私人数据。需要本地 AI 时，在 Private Assistant → Models 查看大小和许可后自行下载。

- Windows 10/11 x64：下载 `windows-x64-basic.exe`。首次安装可能需要联网安装 Microsoft WebView2。
- macOS 14+：Apple Silicon 使用 `arm64`，Intel 使用 `x64`，以本页实际附件为准。Mac 语音模型自动安装器、Windows 专用浏览器验证尚未适配，原生交互尚需进一步实机验证。
- `MagicBox-Mac-Build.zip` 为可修改的构建工程，不是 DMG 安装程序。
- 附件提供 SHA-256 校验。Windows 程序未商业签名，Mac 使用临时签名且未经过 Apple 公证。

使用方法见仓库的 `docs/USER_GUIDE.md`，开发与构建见 `docs/DEVELOPMENT.md`。

本仓库目前未授予开源许可证。第三方运行库和后续下载的模型遵循各自的许可。
