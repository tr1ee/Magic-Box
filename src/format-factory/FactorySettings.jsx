import { Settings2 } from 'lucide-react';

export default function FactorySettings({ tool, config:c, update, outputs, disabled, officeMissing, capabilities }) {
  const combined = ['merge','mux','mix'].includes(tool.operation);
  const media = ['video','audio'].includes(tool.category);
  const video = tool.category === 'video' && tool.operation !== 'extract';
  const dimensions = tool.category === 'picture' || (video && tool.operation !== 'mux');
  const audio = media && !combined && tool.operation !== 'frames' && c.format !== 'gif';
  const field = (key,label,props = {}) => <label className="ff-field"><span>{label}</span><input type="number" value={c[key]} min="0" step="any" onChange={event => update({ [key]:event.target.value })} {...props}/></label>;
  const select = (key,label,options) => <label className="ff-field"><span>{label}</span><select value={c[key]} onChange={event => update({ [key]:event.target.value })}>{options.map(([value,text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  const toggle = (key,label) => <label className="ff-check"><input type="checkbox" checked={c[key]} onChange={event => update({ [key]:event.target.checked })}/>{label}</label>;
  return <aside className="ff-settings" aria-label="输出设置"><h3><Settings2 size={18}/>输出设置</h3><fieldset disabled={disabled}>
    <div className="ff-selected-tool"><strong>{tool.label}</strong><p>{tool.description}</p></div>
    {select('format','转换为',outputs.map(format => [format,format.toUpperCase()]))}
    {!['pages','split'].includes(tool.operation) || media ? select('quality','质量预设',[['high','通用 · 高质量'],['balanced','均衡 · 质量与体积'],['small','压缩 · 更小文件']]) : null}
    {video && !combined && !['frames','crop','delogo'].includes(tool.operation) && <label className="ff-field"><span>设备 / 尺寸预设</span><select value={['','1920x1080','1280x720','854x480','480x272'].includes(`${c.width}x${c.height}`) ? `${c.width}x${c.height}` : (!c.width && !c.height ? '' : 'custom')} onChange={event => { const [width,height] = event.target.value.split('x'); if (event.target.value !== 'custom') update({ width:width || '',height:height || '' }); }}><option value="">原始尺寸</option><option value="1920x1080">电脑 / 电视 · 1080p</option><option value="1280x720">手机 / 平板 · 720p</option><option value="854x480">小体积 · 480p</option><option value="480x272">PSP · 480 × 272</option><option value="custom">自定义尺寸</option></select></label>}
    {dimensions && <div className="ff-field-pair">{field('width','宽度 px',{placeholder:'原始',min:1,max:16384,step:1})}{field('height','高度 px',{placeholder:'原始',min:1,max:16384,step:1})}</div>}
    {media && !combined && <details className="ff-more" open={tool.operation === 'trim' || undefined}><summary>截取时间范围</summary><div className="ff-field-pair">{field('start','开始时间（秒）',{placeholder:'0'})}{field('end','结束时间（秒）',{placeholder:'到结尾'})}</div></details>}
    {['crop','delogo'].includes(tool.operation) && <section className="ff-option-section"><h4>矩形区域（像素）</h4><div className="ff-field-pair">{field('cropX','左边距 X',{step:1})}{field('cropY','上边距 Y',{step:1})}{field('cropWidth','区域宽度',{min:1,step:1})}{field('cropHeight','区域高度',{min:1,step:1})}</div></section>}
    {tool.operation === 'frames' && field('interval','每隔多少秒导出一帧',{min:0.1,max:3600})}
    {tool.operation === 'split' && media && field('segmentSeconds','每段时长（秒）',{min:1,max:86400})}
    {tool.category === 'document' && (['pages','split'].includes(tool.operation) || tool.id === 'document-images') && <label className="ff-field"><span>页码范围</span><input value={c.pages} onChange={event => update({ pages:event.target.value })} placeholder="全部页面，例如 1-3,5"/><small>页码从 1 开始，按输入顺序输出。</small></label>}
    {(tool.id.includes('rotate') || tool.category === 'picture') && select('rotation','旋转角度',[['0','不旋转'],['90','顺时针 90°'],['180','旋转 180°'],['270','逆时针 90°']])}
    {tool.id === 'picture-watermark' && <><label className="ff-field"><span>水印文字</span><input value={c.watermark} maxLength={200} onChange={event => update({ watermark:event.target.value })} placeholder="输入文字"/></label>{select('watermarkPosition','水印位置',[['southeast','右下角'],['southwest','左下角'],['northeast','右上角'],['northwest','左上角'],['center','居中']])}</>}
    {video && !combined && c.format !== 'gif' && tool.operation !== 'frames' && <>{select('fps','帧率',[['','原始帧率'],['24','24 fps'],['25','25 fps'],['30','30 fps'],['60','60 fps']])}{field('bitrate','视频比特率（kbps）',{placeholder:'自动（推荐）',min:32,max:50000,step:1})}</>}
    {!combined && tool.category !== 'document' && <details className="ff-more" open={tool.id.endsWith('effects') || tool.id.endsWith('speed') || undefined}><summary>更多设置</summary>
      {video && !tool.id.includes('rotate') && select('rotation','旋转角度',[['0','不旋转'],['90','顺时针 90°'],['180','旋转 180°'],['270','逆时针 90°']])}
      {dimensions && select('flip','翻转',[['','不翻转'],['horizontal','水平翻转'],['vertical','垂直翻转']])}
      {audio && <><div className="ff-field-pair">{field('speed','播放速度',{min:0.25,max:4})}{field('volume','音量倍数',{min:0,max:5})}</div><div className="ff-field-pair">{field('fadeIn','淡入（秒）',{max:60})}{field('fadeOut','淡出（秒）',{max:60})}</div>{toggle('denoise','音频降噪')}{video && toggle('mute','移除声音')}
      {!video && <>{field('bitrate','音频比特率（kbps）',{placeholder:'自动',min:32,max:512,step:1})}{select('sampleRate','采样率',[['','自动'],['22050','22050 Hz'],['44100','44100 Hz'],['48000','48000 Hz'],['96000','96000 Hz']])}{select('channels','声道',[['','原始声道'],['1','单声道'],['2','立体声']])}</>}</>}
      {toggle('keepMetadata','保留元数据')}
    </details>}
    {toggle('keepOriginal','另存一份源文件到 Originals')}
    <p className="ff-help">生成新文件，源文件始终保留。重名结果自动编号。</p>
    {officeMissing && <p className="ff-warning" role="status">Office 转 PDF 需要 LibreOffice。安装后重启应用，或为 DOCX 选择 TXT / MD。</p>}
    {tool.category === 'document' && <p className="ff-help">中文文本转 PDF 使用本机字体绘制，输出文字不可选择。</p>}
    <div className="ff-engine-status"><span className={capabilities ? 'ready' : ''}/>{capabilities ? '本地处理引擎已连接' : '正在连接处理引擎…'}</div>
  </fieldset></aside>;
}
