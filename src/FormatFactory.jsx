import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, AudioLines, Check, ChevronDown, CircleStop, FileText, FileVideo, FolderOpen, Image as ImageIcon, Loader2, Plus, Search, Settings2, Trash2, Upload, X, Play, RotateCcw, Scissors, Combine, Crop, Eraser, Images, FileOutput, Minimize2 } from 'lucide-react';
import { FACTORY_DEFAULTS, FACTORY_FORMATS, FACTORY_GROUPS, FACTORY_TOOLS, OFFICE_INPUTS, toolInputs, toolOutputs } from '../shared/formatFactory.mjs';
import FactorySettings from './format-factory/FactorySettings.jsx';
import './format-factory/factory.css';

const ICONS = { video: FileVideo, audio: AudioLines, picture: ImageIcon, document: FileText };
const OP_ICONS = { trim: Scissors, merge: Combine, mix: Combine, mux: Combine, crop: Crop, delogo: Eraser, frames: Images, extract: FileOutput };
const TERMINAL = new Set(['completed','cancelled','failed']);
const EMPTY = [];
const extension = name => String(name).split('.').pop().toLowerCase();
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`;
export async function factoryApi(url, options) {
  const response = await fetch(`/api/format-factory${url}`,options);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `本地处理服务暂时不可用（${response.status}），请重试。`);
  if (payload === null) throw new Error('本地处理服务返回了无效数据，请重试。');
  return payload;
}
function Button({ children, primary, ...props }) { return <button type="button" className={`ff-button${primary ? ' ff-primary' : ''}`} {...props}>{children}</button>; }
function Status({ item }) {
  const labels = { queued:'等待处理', converting:'处理中', completed:'已完成', failed:'失败', cancelled:'已停止', ready:'待开始' };
  return <span className={`ff-status ff-status-${item.status}`} title={item.error || ''}>{item.status === 'converting' ? <Loader2 size={14} className="spin"/> : item.status === 'completed' ? <Check size={14}/> : null}{labels[item.status] || item.status}{item.status === 'converting' ? ` ${item.progress || 0}%` : ''}</span>;
}
export default function FormatFactoryPage({ downloadPath, onError, onNotice, onOpenPath, onBrowseFolder, onBack, onPathChange }) {
  const [toolId,setToolId] = useState('video-convert');
  const [expanded,setExpanded] = useState('video');
  const [search,setSearch] = useState('');
  const [drafts,setDrafts] = useState({});
  const [configs,setConfigs] = useState({});
  const [capabilities,setCapabilities] = useState(null);
  const [jobs,setJobs] = useState([]);
  const [hidden,setHidden] = useState([]);
  const [filter,setFilter] = useState('all');
  const [uploading,setUploading] = useState(false);
  const [dragging,setDragging] = useState(false);
  const [error,setError] = useState('');
  const [preview,setPreview] = useState(null);
  const filesRef = useRef(null), folderRef = useRef(null), submitRef = useRef(false), retryFiles = useRef(new Map());
  const tool = FACTORY_TOOLS.find(entry => entry.id === toolId);
  const entries = drafts[toolId] || EMPTY;
  const config = configs[toolId] || { ...FACTORY_DEFAULTS, quality:tool.quality || 'high', format:tool.format || FACTORY_GROUPS.find(group => group.id === tool.category).defaultFormat };
  const updateConfig = patch => setConfigs(current => ({ ...current, [toolId]:{ ...config,...patch } }));
  const report = useCallback(message => { setError(message); onError?.(message); },[onError]);
  const accept = toolInputs(tool).map(format => `.${format}`).join(',');
  const busyJobs = jobs.filter(job => !TERMINAL.has(job.status));
  const officeMissing = tool.category === 'document' && config.format === 'pdf' && !capabilities?.libreOffice?.available && entries.some(entry => OFFICE_INPUTS.includes(extension(entry.file.name)));
  const minFiles = tool.minFiles || 1;
  const outputs = toolOutputs(tool).filter(format => !(tool.category === 'video' && ['merge','split'].includes(tool.operation) && ['gif','3gp','m3u8'].includes(format)));

  useEffect(() => {
    let active = true;
    factoryApi('/capabilities').then(value => { if (active) setCapabilities(value); }).catch(e => { if (active) report(e.message); });
    return () => { active = false; };
  },[report]);
  useEffect(() => {
    let active = true, timer;
    const poll = async () => {
      try { const result = await factoryApi('/jobs'); if (active) setJobs(result.jobs || []); }
      catch (e) { if (active) setError(`任务状态暂时无法更新：${e.message}`); }
      if (active) timer = setTimeout(poll,1200);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  },[]);
  useEffect(() => {
    if (!preview) return undefined;
    const dismiss = event => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown',dismiss);
    return () => { URL.revokeObjectURL(preview.url); window.removeEventListener('keydown',dismiss); };
  },[preview]);

  const selectTool = (next, format) => {
    if (uploading) return;
    setToolId(next.id); setExpanded(next.category); setError(''); setFilter('all');
    if (format) setConfigs(current => ({ ...current,[next.id]:{ ...FACTORY_DEFAULTS,...current[next.id],format } }));
  };
  const addFiles = list => {
    if (submitRef.current) return;
    const incoming = Array.from(list || []);
    const accepted = new Set(toolInputs(tool));
    const good = incoming.filter(file => accepted.has(extension(file.name)));
    const rejected = incoming.length - good.length;
    const limit = tool.maxFiles || capabilities?.maxFiles || 100;
    let skipped = 0;
    const next = [...entries];
    for (const file of good) {
      const key = `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
      if (next.some(entry => entry.key === key)) continue;
      if (next.length >= limit) { skipped++; continue; }
      next.push({ key,file });
    }
    setDrafts(current => ({ ...current,[toolId]:next })); setFilter('all');
    report(rejected || skipped ? `${rejected ? `${rejected} 个文件不适用于「${tool.label}」。` : ''}${skipped ? `本工具最多添加 ${limit} 个文件，已跳过 ${skipped} 个。` : ''}` : '');
  };
  const remove = key => setDrafts(current => ({ ...current,[toolId]:entries.filter(entry => entry.key !== key) }));
  const move = (index,delta) => {
    const next = [...entries]; [next[index],next[index+delta]] = [next[index+delta],next[index]];
    setDrafts(current => ({ ...current,[toolId]:next }));
  };
  async function start() {
    if (submitRef.current || entries.length < minFiles || officeMissing) return;
    submitRef.current = true; setUploading(true); report('');
    try {
      const form = new FormData();
      form.append('category',tool.category); form.append('operation',tool.operation); form.append('outputFormat',config.format); form.append('outputDir',downloadPath || '');
      Object.entries(config).filter(([key]) => key !== 'format').forEach(([key,value]) => form.append(key,String(value)));
      entries.forEach(entry => form.append('files',entry.file));
      const job = await factoryApi('/jobs',{ method:'POST',body:form });
      retryFiles.current.set(job.id,{ entries,toolId,config });
      setJobs(current => [job,...current.filter(entry => entry.id !== job.id)]);
      setDrafts(current => ({ ...current,[toolId]:[] }));
      onNotice?.(`已加入任务：${tool.label} · ${entries.length} 个文件`);
    } catch (e) { report(e.message); }
    finally { submitRef.current = false; setUploading(false); }
  }
  async function cancel(job) {
    try { await factoryApi(`/jobs/${job.id}/cancel`,{ method:'POST' }); onNotice?.('正在停止任务…'); }
    catch (e) { report(e.message); }
  }
  async function clearQueue() {
    setDrafts(current => ({ ...current,[toolId]:[] }));
    const finished = jobs.filter(job => TERMINAL.has(job.status));
    for (const job of finished) {
      try {
        await factoryApi(`/jobs/${job.id}`,{method:'DELETE'});
        setHidden(current => [...current,job.id]);
        setJobs(current => current.filter(entry => entry.id !== job.id));
        retryFiles.current.delete(job.id);
      } catch(e) { report(e.message); }
    }
  }
  function retry(job) {
    const saved = retryFiles.current.get(job.id);
    if (!saved) { report('重新打开页面后需要重新添加源文件；已生成的结果仍保存在输出目录。'); return; }
    const failed = saved.entries.filter((_,index) => ['failed','cancelled'].includes(job.items[index]?.status));
    setToolId(saved.toolId); setExpanded(job.category); setFilter('all');
    setConfigs(current => ({ ...current,[saved.toolId]:saved.config }));
    setDrafts(current => {
      const existing = current[saved.toolId] || [];
      return { ...current,[saved.toolId]:[...existing,...failed.filter(entry => !existing.some(old => old.key === entry.key))] };
    });
  }
  const rows = useMemo(() => jobs.filter(job => !hidden.includes(job.id)).flatMap(job => job.items.map(item => ({ job,item }))),[jobs,hidden]);
  const shownRows = rows.filter(({ item }) => filter === 'all' || (filter === 'active' ? ['queued','converting'].includes(item.status) : filter === 'completed' ? item.status === 'completed' : ['failed','cancelled'].includes(item.status)));
  const total = rows.length;
  const progress = total ? Math.round(rows.reduce((sum,{item}) => sum + (TERMINAL.has(item.status) ? 100 : item.progress || 0),0)/total) : 0;
  const Icon = ICONS[tool.category];
  return <section className="ff-app" aria-label="格式工厂">
    <header className="ff-toolbar"><div className="ff-brand">{onBack && <button type="button" className="ff-back" onClick={onBack} title="返回工具箱" aria-label="返回工具箱">‹</button>}<div><h2>格式工厂</h2><p>选择工具，添加文件，开始处理</p></div></div><div className="ff-toolbar-actions">
      <Button onClick={() => filesRef.current?.click()} disabled={uploading}><Plus size={17}/>添加文件</Button>
      <Button onClick={() => folderRef.current?.click()} disabled={uploading}><FolderOpen size={17}/>添加文件夹</Button>
      <Button onClick={clearQueue} disabled={uploading || (!entries.length && !rows.some(({job}) => TERMINAL.has(job.status)))} title="移除当前待办和已结束的任务记录，保留输出文件"><Trash2 size={17}/>清空</Button>
      <Button primary onClick={start} disabled={uploading || entries.length < minFiles || officeMissing || !capabilities}><span>{uploading ? <Loader2 className="spin" size={17}/> : <Play size={17}/>}</span>{uploading ? '正在上传…' : '开始处理'}</Button>
    </div></header>
    <nav className="ff-catalog" aria-label="转换工具"><label className="ff-search"><Search size={15}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索工具或格式" aria-label="搜索工具或格式"/></label>
      {FACTORY_GROUPS.map(group => {
        const GroupIcon = ICONS[group.id];
        const matches = FACTORY_TOOLS.filter(entry => entry.category === group.id && (!search || `${entry.label} ${entry.description}`.toLowerCase().includes(search.toLowerCase())));
        const formats = FACTORY_FORMATS[group.id].outputs.filter(format => !search || format.includes(search.toLowerCase()));
        if (search && !matches.length && !formats.length) return null;
        const open = !!search || expanded === group.id;
        return <section className={`ff-tool-group${open ? ' ff-group-open' : ''}`} key={group.id}><button type="button" className="ff-group-heading" aria-expanded={open} onClick={() => setExpanded(open ? '' : group.id)}><GroupIcon size={19}/>{group.label}<ChevronDown size={16} className={open ? 'ff-up' : ''}/></button>
          {open && <div className="ff-group-body"><div className="ff-format-grid">{formats.slice(0,search ? 20 : 6).map(format => <button type="button" key={format} disabled={uploading} className={tool.id === `${group.id}-convert` && config.format === format ? 'is-selected' : ''} onClick={() => selectTool(FACTORY_TOOLS.find(entry => entry.id === `${group.id}-convert`),format)}>{format.toUpperCase()}</button>)}</div>
          {matches.filter(entry => !entry.id.endsWith('-convert')).map(entry => { const ToolIcon = OP_ICONS[entry.operation] || (entry.id.includes('compress') ? Minimize2 : Settings2); return <button type="button" key={entry.id} className={`ff-tool${toolId === entry.id ? ' is-selected' : ''}`} onClick={() => selectTool(entry)} disabled={uploading} aria-pressed={toolId === entry.id}><ToolIcon size={16}/>{entry.label}</button>; })}</div>}
        </section>;
      })}
      {search && !FACTORY_TOOLS.some(entry => `${entry.label} ${entry.description}`.toLowerCase().includes(search.toLowerCase())) && !Object.values(FACTORY_FORMATS).some(group => group.outputs.some(format => format.includes(search.toLowerCase()))) && <p className="ff-help">没有找到匹配的工具。</p>}
    </nav>
    <main className={`ff-workspace${dragging ? ' ff-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!uploading) setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
      <input ref={filesRef} type="file" multiple accept={accept} hidden aria-label="添加待处理文件" onChange={event => { addFiles(event.target.files); event.target.value = ''; }}/>
      <input ref={folderRef} type="file" multiple webkitdirectory="" hidden aria-label="添加文件夹中的文件" onChange={event => { addFiles(event.target.files); event.target.value = ''; }}/>
      <div className="ff-queue-title"><h3>任务队列 <small>{entries.length + rows.length ? entries.length + rows.length : ''}</small></h3>{busyJobs.length > 0 && <Button onClick={() => Promise.all(busyJobs.map(cancel))}><CircleStop size={15}/>全部停止</Button>}</div>
      <div className="ff-tabs" role="tablist" aria-label="任务筛选">{[['all','全部'],['active','处理中'],['completed','已完成'],['failed','失败 / 停止']].map(([id,label]) => <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
      {error && <div className="ff-error" role="alert"><span>{error}</span><button type="button" onClick={() => report('')} aria-label="关闭提示"><X size={16}/></button></div>}
      <div className="ff-queue-scroll"><table className="ff-table"><thead><tr><th>文件名称</th><th>输出</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {filter === 'all' && entries.map((entry,index) => <tr key={entry.key}><td><div className="ff-file"><Icon size={20}/><span><strong title={entry.file.name}>{entry.file.name}</strong><small>{extension(entry.file.name).toUpperCase()} · {bytes(entry.file.size)} · {tool.label}</small></span></div></td><td><span className="ff-format-label">{config.format.toUpperCase()}</span></td><td><Status item={{ status:'ready' }}/></td><td><div className="ff-row-actions">
          {['merge','mix','mux'].includes(tool.operation) && <><button type="button" aria-label={`上移 ${entry.file.name}`} disabled={index === 0 || uploading} onClick={() => move(index,-1)}><ArrowUp size={15}/></button><button type="button" aria-label={`下移 ${entry.file.name}`} disabled={index === entries.length-1 || uploading} onClick={() => move(index,1)}><ArrowDown size={15}/></button></>}
          {['video','audio','picture'].includes(tool.category) && <button type="button" aria-label={`预览 ${entry.file.name}`} onClick={() => setPreview({ name:entry.file.name,url:URL.createObjectURL(entry.file),type:tool.category })}><Play size={15}/></button>}
          <button type="button" disabled={uploading} aria-label={`移除 ${entry.file.name}`} onClick={() => remove(entry.key)}><X size={15}/></button></div></td></tr>)}
        {shownRows.map(({job,item}) => <tr key={item.id}><td><div className="ff-file">{(() => { const FileIcon = ICONS[job.category]; return <FileIcon size={20}/>; })()}<span><strong title={item.name}>{item.name}</strong><small>{bytes(item.size)} · {FACTORY_GROUPS.find(group => group.id === job.category)?.label}</small>{item.error && <small className="ff-item-error" title={item.error}>{item.error}</small>}</span></div></td><td><span className="ff-format-label">{item.targetFormat.toUpperCase()}</span></td><td><Status item={item}/></td><td><div className="ff-row-actions">
          {item.outputs?.length > 0 && <button type="button" aria-label={`打开 ${item.name} 输出目录`} onClick={() => onOpenPath(job.outputDir)}><FolderOpen size={16}/></button>}
          {!TERMINAL.has(job.status) && <button type="button" aria-label={`停止 ${item.name} 所在任务`} onClick={() => cancel(job)}><CircleStop size={16}/></button>}
          {['failed','cancelled'].includes(item.status) && <button type="button" aria-label={`重试 ${item.name} 所在任务`} onClick={() => retry(job)}><RotateCcw size={16}/></button>}
        </div></td></tr>)}
      </tbody></table>
      {!shownRows.length && !(filter === 'all' && entries.length) && <div className="ff-empty"><Upload size={54} strokeWidth={1.1}/><h3>{filter === 'all' ? '拖入文件，开始转换' : '没有此状态的任务'}</h3><p>{filter === 'all' ? '也可以点击上方「添加文件」' : '切换到「全部」查看待办和处理记录'}</p>{filter === 'all' && <small>当前工具：{tool.label} · 最多 {tool.maxFiles || capabilities?.maxFiles || 100} 个文件</small>}</div>}
      </div>
      <div className="ff-output"><FolderOpen size={17}/><span>输出文件夹</span><input readOnly={!onPathChange} value={downloadPath || ''} placeholder="默认输出文件夹" onChange={event => onPathChange?.(event.target.value)} aria-label="输出文件夹" title={downloadPath}/>{onBrowseFolder && <Button onClick={onBrowseFolder}>浏览</Button>}<button type="button" className="ff-icon-button" disabled={!downloadPath} aria-label="打开输出文件夹" onClick={() => onOpenPath(downloadPath)}><FolderOpen size={18}/></button></div>
    </main>
    <FactorySettings tool={tool} config={config} update={updateConfig} outputs={outputs} disabled={uploading} officeMissing={officeMissing} capabilities={capabilities}/>
    <footer className="ff-footer"><span>{uploading ? '正在添加文件…' : busyJobs.length ? `${busyJobs.length} 个任务处理中` : '就绪'}</span><div><span>进度</span><progress max="100" value={progress} aria-label="总处理进度"/><span>{progress}%</span></div><span>处理模式：<b>本地处理</b></span></footer>
    {preview && <div className="ff-modal-backdrop" onClick={() => setPreview(null)}><section className="ff-preview" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`} onClick={event => event.stopPropagation()}><header><strong>{preview.name}</strong><button type="button" autoFocus onClick={() => setPreview(null)} aria-label="关闭预览"><X size={20}/></button></header>{preview.type === 'picture' ? <img src={preview.url} alt={preview.name}/> : preview.type === 'audio' ? <audio src={preview.url} controls/> : <video src={preview.url} controls/>}<p>预览使用浏览器支持的格式；无法播放的文件仍可尝试转换。</p></section></div>}
  </section>;
}
