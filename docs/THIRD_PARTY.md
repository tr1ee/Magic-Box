# 第三方组件与许可

Magic Box 使用多个独立项目。第三方软件、运行库及模型各自保留原有许可和版权；本仓库没有授予 Magic Box 自有代码的开源许可证。

主要组件包括 Node.js、React、Express、WebTorrent、Sharp/libvips、FFmpeg/FFprobe、yt-dlp、PDF.js、pdf-lib、mammoth、QRCode、llama.cpp，以及 Windows 的 Microsoft WebView2。精确 npm 依赖版本见 `package-lock.json`；安装包中的 `node_modules` 和独立运行库包含相应许可文件或来源说明。

上游项目：

- [Node.js](https://github.com/nodejs/node)
- [React](https://github.com/facebook/react)
- [Express](https://github.com/expressjs/express)
- [WebTorrent](https://github.com/webtorrent/webtorrent)
- [Sharp](https://github.com/lovell/sharp) / [libvips](https://github.com/libvips/libvips)
- [FFmpeg](https://ffmpeg.org/legal.html)；不同预编译选项会影响许可义务。
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)；独立可执行程序还包含其打包依赖。
- [PDF.js](https://github.com/mozilla/pdf.js) / [pdf-lib](https://github.com/Hopding/pdf-lib)
- [mammoth](https://github.com/mwilliamson/mammoth.js)
- [node-qrcode](https://github.com/soldair/node-qrcode)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [Microsoft WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)

可选的 Qwen、GPT-SoVITS、OpenVoice、Seed-VC、Demucs 等模型与引擎**不包含在公共基础安装包中**。用户选择安装时，应阅读下载页面和软件内显示的相应许可。不要假定所有模型都允许相同的商业用途或再分发。

界面图片随源码提供供本项目使用；没有单独授予其再分发或用于其他产品的许可。若准备再分发或商用，请先核实本项目和全部上游组件的权利要求。
