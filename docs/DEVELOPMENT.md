# 开发、测试与发布

## 工程结构

| 目录 | 内容 |
| --- | --- |
| `src/` | React 界面 |
| `public/` | 图标、手机传输页面、音频工作线程等静态资源 |
| `server/` | Express、本地下载/转换/传输服务及可选 AI 管理 |
| `shared/` | 前后端共享的数据规范与策略 |
| `desktop/` | Windows WebView2 启动器、安装器以及 Mac Swift/WebKit 壳 |
| `scripts/` | 构建、检查、模型按需安装与开发工具 |
| `test/` | Node/Vitest/Python 测试和合成测试数据 |

保留整个源码工程即可继续修改优化。安装后的前端是编译产物，不能替代 `src/` 中的源码。

## 运行与测试

使用 Node.js 22.20.0，先 `npm ci`。`npm run build` 构建生产前端，`npm start` 启动本地服务；默认监听 `127.0.0.1:3099`。

```bash
npm test
npm run test:ui
node --test test/file-transfer-network.test.mjs test/transfer-integrity.test.mjs
```

完整测试包含 Windows 专用测试和可选音频工作流。需要实际模型、GPU 或私人验收音频的测试不属于基础安装包的构建前提。项目的 `AGENTS.md` 要求本地应用改动后重建 Windows 桌面包；开发者自己的完整模型环境与公共基础版使用不同目录。

## Windows 无模型基础版

```powershell
npm ci
npm run desktop:installer:basic
```

流程自动获取校验过的 WebView2 SDK、llama.cpp 执行运行库和独立 yt-dlp，再构建基础版。没有固定版 WebView2 的大体积拷贝；安装器在目标电脑缺少 Evergreen WebView2 时使用 Microsoft 官方引导程序。

输出：

- `release/windows-basic/MagicBox/MagicBox.exe`：基础版运行目录。
- `release/installer/MagicBox-Setup-0.1.0-windows-x64-basic.exe`：公开分发的安装文件。
- `release/chromium/MagicBox/MagicBox.exe`：开发者原有的完整本地构建目录，**不可直接作为无模型公共包上传**。

公共构建跳过本机语音评测权重、基准记录、个人声音、训练结果和 Python 缓存；构建和安装器打包阶段都会扫描。模型文件不会使用 Git LFS 绕过排除规则。

## macOS

在 macOS 14+ 运行 `bash Build-Mac.command`，或使用 GitHub Actions 的 release 工作流。脚本根据运行机器生成 arm64 或 x64 包，构建原生 Swift 壳、Metal 推理运行库，并检查依赖、空资料启动和挂载后的 DMG。以 Mac 上实际通过的构建为准。

`npm run desktop:mac:kit` 可生成可携带的 Mac 构建资料 ZIP。它不是已经编译好的 DMG。更多细节见 [macos.md](macos.md)。

## GitHub Releases

推送 `v*` 标签可以触发公共基础版构建。Windows、Apple Silicon 和 Intel Mac 分别构建，通过检查后把安装文件、SHA-256 和验证报告上传至对应 Release。也可从 Actions 手动运行工作流，仅下载构建附件。

发布前检查：

1. 源码索引中没有模型权重、密钥、Cookie、私人录音、下载数据或巨大二进制。
2. 安装包经 `verify-public-package.mjs` 或 Mac 的模型排除检查。
3. 每个平台的编译和运行检查通过，且 Release 说明准确区分可用与未适配功能。
4. 公开构建尚未设置商业签名或 Apple 公证，不应宣称已签名认证。

未授予本项目开源许可；第三方组件的许可证不会因此改变。
