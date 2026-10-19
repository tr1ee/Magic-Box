# Magic Box macOS 基础版

## 在 Mac 上生成 DMG

1. 将 `MagicBox-Mac-Build.zip` 复制到运行 macOS 14 或更新系统的 Mac，在 Finder 中解压。
2. 首次构建需要 Apple Command Line Tools。终端执行 `xcode-select --install`，完成安装后继续。
3. 在终端输入 `bash `（末尾留空格），把解压目录里的 `Build-Mac.command` 拖到终端，然后回车。

脚本自动下载校验过的 Node.js、CMake 和 llama.cpp 源码，安装锁定版本的依赖，构建前端、原生 Metal 推理运行库和 Swift 原生 WebKit 窗口，进行依赖与后台服务检查，生成并挂载检查 DMG。首次构建需要联网，原生编译可能耗时数分钟。安装后的基础功能无需安装 Node、Python 或 Homebrew。

Apple Silicon Mac 输出 `release/macos/MagicBox-0.1.1-macOS-arm64-basic.dmg`；Intel Mac 输出 `release/macos/MagicBox-0.1.1-macOS-x64-basic.dmg`。请使用对应架构的 Mac 构建；本包不是 Universal 包。

构建成功后，打开 DMG，将 MagicBox.app 拖到 Applications。更新时替换已有的 `/Applications/MagicBox.app`，只保留这一个系统入口。临时构建位于 `.cache/macos-build.noindex`，打包退出时自动清理，`release/macos` 只保留 DMG 等发布文件。包使用本地临时签名，未使用 Developer ID 签名和 Apple 公证；向其他 Mac 分发时可能需要在系统设置 → 隐私与安全性中选择“仍要打开”。

## 包含的基础功能

- 种子下载、静态网页图片扫描与下载、视频下载。
- 图片、音视频与基础文档转换；DOCX 转 PDF 需自行安装 LibreOffice。
- 同一局域网内传文件；Windows Mobile Hotspot 设置入口不适用于 Mac。
- 原生文件上传、保存目录选择、Finder 打开文件、下载记录。
- Private Assistant 的本地资料管理及模型目录。

视频扫描与浏览器验证会自动识别 `/Applications` 或 `~/Applications` 中安装的 Chrome、Edge 或 Chromium。点击验证按钮后，在独立浏览器窗口完成站点验证或登录，扫描会自动继续；专用会话与日常浏览器资料分开保存。站点是否提供视频仍取决于访问权限和站点响应。图片的动态网页扫描仍需单独适配 Mac。

## 模型按需下载

安装包不含大语言模型、语音模型、任何之前训练的模型、训练样本、缓存、历史记录或个人设置。只包含运行基础工具的程序和小型 llama.cpp 推理运行库。每次构建会扫描包内容；发现模型权重、私人语音数据或异常大文件即中止。

首次打开软件会显示基础版说明；之后可通过菜单“模型与功能说明”查看。需要本地 AI 时进入 **Private Assistant → Models**，查看模型大小和许可后手动安装。下载按现有模型清单校验 SHA-256，未安装模型时不会自动下载。

**语音克隆、语音训练和流式语音的自动安装器目前仅支持 Windows。Mac 版点击安装会提示平台限制，不会运行 Windows 安装脚本。** 这些功能需要后续单独适配 macOS，不能仅靠下载模型启用。

设置与后续下载的模型位于 `~/Library/Application Support/MagicBox`；默认下载位置是 `~/Downloads/MagicBox`。升级 `.app` 不会覆盖用户资料。启动日志位于 `~/Library/Application Support/MagicBox/desktop.log`。

## 启动动画

每次新启动窗口时播放约 9 秒的开屏：青蓝手绘笔画同时起笔、同时收笔，各条线从不同端点沿路径连续画出；头发、脸部和闭眼睫毛保留细节，身体的肩、袖、手臂、衣领和衣身轮廓保持可见，只省略部分内部褶皱。线稿完成后短暂停留，再用约 180 毫秒让彩图从线稿下连续显现，不做亮度或模糊突跳。睁眼由十二张关键姿态经过肤色校准、单次眼部合成和运动插帧生成 60 fps 连续动画，以一张完整画面播放，避免眼周羽化叠层变暗；人物和背景通过原图轮廓遮罩分成独立图层，保持人物尺寸不变地左右平移，背景反向小幅移动形成视差；背景光晕、粒子和放大的粉色蝴蝶继续移动，随后显示 Magic Box 欢迎语并自动进入上次使用的页面。点击右下角按钮或按 Esc 可随时跳过；切回同一窗口不会重播。系统开启“减少动态效果”时使用约 1 秒的静态版本。动画在本地渲染，无需网络；素材加载失败或超时会自动进入应用。

## 验证边界

Windows 只能生成这个不含模型的构建资料包；DMG、Swift 编译、原生界面和 Apple 签名检查必须在 Mac 上运行。构建脚本检查媒体组件、图片/PDF 依赖、打包后后台服务、前端文件、签名以及挂载后的 DMG 内容。原生界面交互仍需在 Mac 上实际打开应用验证。
