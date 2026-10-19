# Magic Box · 本地多功能工具箱

Magic Box 把种子下载、网页图片和视频下载、格式转换、局域网传文件以及可选的本地 AI 助手放在一个桌面应用中。基础工具在本机处理文件；下载和模型安装需要访问相应网站。

**安装包不包含大语言模型、语音模型、训练模型或开发者的个人数据。需要 AI 功能时，由用户在软件内查看许可和大小后自行下载。**

[下载安装包](https://github.com/tr1ee/Magic-Box/releases/latest) · [操作手册](docs/USER_GUIDE.md) · [开发与打包](docs/DEVELOPMENT.md) · [Mac 构建说明](docs/macos.md) · [第三方组件](docs/THIRD_PARTY.md)

## 下载与安装

在 [Releases](https://github.com/tr1ee/Magic-Box/releases) 选择对应文件：

| 文件 | 用途 |
| --- | --- |
| `MagicBox-Setup-0.1.0-windows-x64-basic.exe` | Windows 10/11 64 位基础版安装程序 |
| `MagicBox-0.1.0-macOS-arm64-basic.dmg` | Apple Silicon Mac，需 macOS 14+；以实际发布附件为准 |
| `MagicBox-0.1.0-macOS-x64-basic.dmg` | Intel Mac，需 macOS 14+；以实际发布附件为准 |
| `MagicBox-Mac-Build.zip` | Mac 构建工程，供自行编译；不是安装包 |
| `*.sha256` | 对应安装文件的 SHA-256 校验值 |

Windows 安装到当前用户目录，提供开始菜单、可选桌面快捷方式和卸载入口；缺少 Microsoft WebView2 时会联网安装其运行时。程序随包携带 Node.js、媒体工具和小型推理运行库，基础功能无需额外安装 Python。

macOS 将 `.app` 拖到 Applications 后打开。Mac 版本仍处于初始适配阶段，尚未完成全部原生交互的实机验证。当前发布包未使用商业代码签名证书或 Apple 公证，操作系统可能显示来源提示。

## 功能与平台状态

| 功能 | Windows | macOS |
| --- | --- | --- |
| Torrent / Magnet 下载与文件选择 | 支持 | 使用同一后端，需实机验证 |
| 静态网页图片扫描、筛选和批量下载 | 支持 | 支持基础扫描 |
| 视频下载、音视频转换、图片转换 | 支持 | 提供基础组件 |
| PDF 合并、图片转 PDF、PDF/DOCX 提取文本 | 支持 | 提供基础组件 |
| DOCX 转 PDF | 另需 LibreOffice | 另需 LibreOffice |
| 局域网双向文件传输 | 支持 | 提供同一服务，需实机验证 |
| Private Assistant 本地 AI | 软件内另行下载模型 | 软件内另行下载模型 |
| 语音克隆、训练、流式语音 | 另行安装可选引擎和模型 | 自动安装器尚未适配 |
| Edge 验证窗口、部分动态网页提取 | 依赖可用浏览器和站点支持 | Windows 专用流程尚未适配 |
| 跨互联网远程传文件 | 尚未实现 | 尚未实现 |

下载器只处理用户有权访问和下载的内容，不保证所有网站、登录流程、验证码或 DRM 内容可用。语音功能需要相应授权和硬件；不会把旧的个人训练结果作为公共模型分发。

## 从源码运行

需要 Node.js **22.20.0 或更新的兼容版本**；打包流程固定使用 22.20.0。

```bash
git clone https://github.com/tr1ee/Magic-Box.git
cd Magic-Box
npm ci
npm run build
npm start
```

浏览器打开终端显示的本地地址，默认是 `http://127.0.0.1:3099`。源码运行时若需视频下载，可将 `yt-dlp` 安装到 PATH；AI 运行库和桌面依赖的获取方式见开发说明。

Windows 基础版安装包：

```powershell
npm ci
npm run desktop:installer:basic
```

Mac：

```bash
bash Build-Mac.command
```

此命令会下载构建工具和运行库源码，**不会下载 AI 模型**。完整流程及输出位置见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 模型、数据和隐私

- 仓库只收录源码、界面资源、测试与说明；模型、运行时二进制、缓存、下载记录、训练数据和发布附件不进入 Git。
- 基础安装包不含任何模型权重。小型 llama.cpp 运行库属于执行程序，模型文件仍由用户另行下载。
- 本地 AI 模型安装会展示大小和许可，并按清单校验下载。没有安装模型时，AI 生成功能不可用。
- Windows 数据通常存放于 `%LOCALAPPDATA%\MagicBox`；Mac 存放于 `~/Library/Application Support/MagicBox`。下载文件以各工具选择的保存目录为准。
- 局域网传输只在设备能互相访问时有效；不通过云端转发文件。

## 问题反馈与许可

通过 [Issues](https://github.com/tr1ee/Magic-Box/issues) 提供系统版本、操作步骤和报错。提交日志前请删除个人路径、访问令牌、Cookie 和私人文件信息。

本仓库目前**未授予开源许可证**；公开可见不代表授予复制、修改或再分发许可。第三方组件和模型遵循各自许可证，详见 [第三方说明](docs/THIRD_PARTY.md)。

## English overview

Magic Box is a local desktop toolbox for torrent/media downloads, image and document processing, format conversion, LAN file transfer, and an optional local AI assistant. Public source and basic installers exclude model weights, trained checkpoints, and personal data. Users install optional models from the app after reviewing their size and license.

Windows x64 is the primary supported desktop platform. macOS 14+ builds use a native WebKit shell; voice engine installers and Windows browser-verification flows are not yet ported. Download available installers from [Releases](https://github.com/tr1ee/Magic-Box/releases), and see the linked guides for installation and building. No open-source license has been granted for this repository.
