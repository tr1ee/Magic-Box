// Shared catalog: every visible tool maps to a validated local operation.
export const FACTORY_FORMATS = {
  video: { inputs: ['3gp','avi','flv','m4v','mkv','mov','mp4','mpeg','mpg','ogv','ts','webm','wmv','vob','mts','m2ts','asf','rm','rmvb'], outputs: ['mp4','mkv','mov','webm','avi','gif','wmv','flv','mpg','ts','3gp','m3u8'] },
  audio: { inputs: ['aac','flac','m4a','mp3','ogg','opus','wav','wma','aiff','aif','ac3','ape','amr','wv','mka','dts'], outputs: ['mp3','wav','m4a','flac','ogg','opus','wma','aac','aiff','ac3'] },
  picture: { inputs: ['avif','bmp','gif','jpeg','jpg','png','svg','tif','tiff','webp','ico','tga'], outputs: ['png','jpg','webp','avif','tiff','gif','bmp','ico','tga'] },
  document: { inputs: ['docx','doc','xlsx','xls','pptx','ppt','odt','ods','odp','rtf','jpeg','jpg','md','pdf','png','tif','tiff','txt','webp'], outputs: ['pdf','txt','md','png','jpg'] }
};
export const FACTORY_GROUPS = [
  { id: 'video', label: '视频', defaultFormat: 'mp4' },
  { id: 'audio', label: '音频', defaultFormat: 'mp3' },
  { id: 'picture', label: '图片', defaultFormat: 'png' },
  { id: 'document', label: '文档', defaultFormat: 'pdf' }
];
const tool = (id, category, label, operation, description, extra = {}) => ({ id, category, label, operation, description, ...extra });
export const FACTORY_TOOLS = [
  tool('video-convert','video','视频转换','convert','批量转换视频格式，适配手机、电脑和播放器。'),
  tool('video-compress','video','视频压缩','convert','使用更小体积预设，减少视频占用空间。', { quality: 'small' }),
  tool('video-trim','video','视频剪辑','trim','按起止时间截取片段，精确到小数秒。'),
  tool('video-merge','video','视频合并','merge','按列表顺序合并视频，自动统一画面和音频参数。', { minFiles: 2 }),
  tool('video-extract','video','提取音频','extract','从视频中提取声音，保存为 MP3、WAV 等格式。', { outputs: FACTORY_FORMATS.audio.outputs, format: 'mp3' }),
  tool('video-crop','video','画面裁剪','crop','输入裁剪区域的位置和尺寸，保留需要的画面。'),
  tool('video-delogo','video','去除水印','delogo','通过周围像素填补矩形区域；效果取决于画面内容。'),
  tool('video-frames','video','导出帧','frames','按设定间隔导出图片，每次最多 500 帧。', { outputs: ['png','jpg'], format: 'png' }),
  tool('video-split','video','视频分割','split','按固定时长分段，分割点取决于输出关键帧。'),
  tool('video-rotate','video','旋转与翻转','convert','旋转画面，或进行水平、垂直翻转。'),
  tool('video-speed','video','变速与降噪','convert','调整播放速度、音量，或对声音进行降噪。'),
  tool('video-mux','video','音视频混流','mux','选择一个视频和一个音频，用音频替换视频声音。', { minFiles: 2, maxFiles: 2, outputs: ['mp4','mkv','mov'] }),
  tool('video-repair','video','尝试修复视频','repair','忽略可恢复的解码错误并重新编码；无法保证修复严重损坏的文件。'),
  tool('audio-convert','audio','音频转换','convert','批量转换音频，支持无损 FLAC、WAV 和常用有损格式。'),
  tool('audio-trim','audio','音频剪辑','trim','按时间截取录音、音乐和音频片段。'),
  tool('audio-merge','audio','音频合并','merge','按照列表顺序合并音频。', { minFiles: 2 }),
  tool('audio-mix','audio','音频混音','mix','叠加多个音轨，自动归一混合音量。', { minFiles: 2 }),
  tool('audio-split','audio','音频分割','split','将长录音分成固定时长的片段。'),
  tool('audio-effects','audio','音量 / 变速 / 降噪','convert','调整音量、播放速度、淡入淡出和降噪。'),
  tool('picture-convert','picture','图片转换','convert','批量转换图片格式，支持 ICO 图标、BMP 和 TGA。'),
  tool('picture-resize','picture','缩放与旋转','convert','调整图片大小和方向，留空尺寸即保持原尺寸。'),
  tool('picture-compress','picture','图片压缩','convert','减小 JPG、WebP、AVIF 等图片的文件大小。', { quality: 'small' }),
  tool('picture-watermark','picture','文字水印','convert','在图片上添加文字水印，可设置位置。'),
  tool('document-convert','document','文档转换','convert','图片、文本转 PDF；PDF / DOCX 提取文本；Office 转 PDF 需要 LibreOffice。'),
  tool('document-merge','document','PDF 合并','merge','按列表顺序合并 PDF 和图片。', { minFiles: 2, outputs: ['pdf'], format: 'pdf', inputs: ['pdf','png','jpg','jpeg','webp','tif','tiff'] }),
  tool('document-split','document','PDF 分割','split','将所选 PDF 页逐页保存为独立文件。', { inputs: ['pdf'], outputs: ['pdf'], format: 'pdf' }),
  tool('document-pages','document','PDF 提取页面','pages','按页码范围提取和重排页面，例如 1-3,5。', { inputs: ['pdf'], outputs: ['pdf'], format: 'pdf' }),
  tool('document-images','document','PDF 转图片','convert','将每一页导出为 PNG 或 JPG。', { inputs: ['pdf'], outputs: ['png','jpg'], format: 'png' }),
  tool('document-text','document','PDF / DOCX 转文本','convert','提取可选中的文字；扫描件不包含可提取文本。', { inputs: ['pdf','docx'], outputs: ['txt','md'], format: 'txt' }),
  tool('document-rotate','document','PDF 旋转','pages','旋转所选页面后保存为新 PDF。', { inputs: ['pdf'], outputs: ['pdf'], format: 'pdf' })
];
export const FACTORY_DEFAULTS = { quality: 'high', width: '', height: '', start: '', end: '', rotation: '0', flip: '', speed: '1', volume: '1', fps: '', bitrate: '', sampleRate: '', channels: '', fadeIn: '', fadeOut: '', denoise: false, mute: false, cropX: '0', cropY: '0', cropWidth: '', cropHeight: '', interval: '10', segmentSeconds: '60', pages: '', watermark: '', watermarkPosition: 'southeast', keepMetadata: true, keepOriginal: false };
export const OFFICE_INPUTS = ['doc','docx','xlsx','xls','pptx','ppt','odt','ods','odp','rtf'];
export function toolInputs(tool) {
  if (tool.operation === 'mux') return [...FACTORY_FORMATS.video.inputs, ...FACTORY_FORMATS.audio.inputs];
  return tool.inputs || FACTORY_FORMATS[tool.category].inputs;
}
export function toolOutputs(tool) { return tool.outputs || FACTORY_FORMATS[tool.category].outputs; }
