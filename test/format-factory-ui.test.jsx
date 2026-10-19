import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FormatFactory from '../src/FormatFactory.jsx';
let calls, created, pending;
const props = { downloadPath:'G:\\results',onError:vi.fn(),onNotice:vi.fn(),onOpenPath:vi.fn(),onBrowseFolder:vi.fn() };
beforeEach(() => {
  calls=[]; created=[]; pending=null;
  vi.stubGlobal('fetch',vi.fn(async (url,options) => {
    if(url.endsWith('/capabilities')) return {ok:true,json:async()=>({maxFiles:100,libreOffice:{available:false}})};
    if(url.endsWith('/jobs') && options?.method==='POST') {
      calls.push(options.body);
      if(pending) await pending;
      const job={id:`job-${calls.length}`,category:options.body.get('category'),status:'running',items:[{id:'item1',name:'sample.mp4',targetFormat:options.body.get('outputFormat'),size:100,status:'converting',progress:10}],outputs:[]};
      created=[job]; return {ok:true,json:async()=>job};
    }
    return {ok:true,json:async()=>({jobs:created})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
const add = (name='sample.mp4') => fireEvent.change(screen.getByLabelText('添加待处理文件'),{target:{files:[new File(['test'],name,{type:'video/mp4'})]}});
it('chooses format directly, restores tool drafts, and submits extraction options',async()=>{
  const user=userEvent.setup(); render(<FormatFactory {...props}/>);
  await screen.findByText('本地处理引擎已连接');
  await user.click(screen.getByRole('button',{name:'MKV',exact:true}));
  expect(screen.getByLabelText('转换为').value).toBe('mkv');
  add();
  await user.click(screen.getByRole('button',{name:'提取音频',exact:true}));
  expect(screen.queryByText('sample.mp4')).toBeNull();
  add();
  await user.click(screen.getByRole('button',{name:'开始处理',exact:true}));
  await waitFor(()=>expect(calls).toHaveLength(1));
  expect(calls[0].get('operation')).toBe('extract'); expect(calls[0].get('outputFormat')).toBe('mp3');
  await user.click(screen.getByRole('button',{name:'MKV',exact:true}));
  expect(screen.getAllByText('sample.mp4')).toHaveLength(2);
});
it('blocks duplicate submission and file drops while upload is pending',async()=>{
  const user=userEvent.setup(); render(<FormatFactory {...props}/>);
  await screen.findByText('本地处理引擎已连接'); add();
  let release; pending=new Promise(resolve=>{release=resolve;});
  await user.dblClick(screen.getByRole('button',{name:'开始处理',exact:true}));
  expect(calls).toHaveLength(1); expect(screen.getByRole('button',{name:'正在上传…'}).disabled).toBe(true);
  add('second.mp4'); expect(screen.queryByText('second.mp4')).toBeNull();
  release(); await waitFor(()=>expect(screen.queryByText('正在上传…')).toBeNull());
});
it('orders merge inputs and keeps live jobs when changing category',async()=>{
  const user=userEvent.setup(); render(<FormatFactory {...props}/>);
  await screen.findByText('本地处理引擎已连接');
  await user.click(screen.getByRole('button',{name:'视频合并',exact:true})); add('first.mp4');
  expect(screen.getByRole('button',{name:'开始处理'}).disabled).toBe(true); add('second.mp4');
  await user.click(screen.getByRole('button',{name:'上移 second.mp4'}));
  await user.click(screen.getByRole('button',{name:'开始处理'}));
  await waitFor(()=>expect(calls).toHaveLength(1));
  expect(calls[0].getAll('files').map(file=>file.name)).toEqual(['second.mp4','first.mp4']);
  await user.click(screen.getByRole('button',{name:'图片',exact:true}));
  await user.click(screen.getByRole('button',{name:'PNG',exact:true}));
  expect(screen.getByText('sample.mp4')).toBeTruthy();
});
it('reports unsupported files, keeps source files when clearing, and exposes folder selection',async()=>{
  const user=userEvent.setup();render(<FormatFactory {...props}/>); await screen.findByText('本地处理引擎已连接');
  add('wrong.exe'); expect(screen.getByRole('alert').textContent).toContain('不适用');
  add(); await user.click(screen.getByRole('button',{name:'清空',exact:true}));
  expect(screen.queryByText('sample.mp4')).toBeNull();
  await user.click(screen.getByRole('button',{name:'浏览',exact:true})); expect(props.onBrowseFolder).toHaveBeenCalledOnce();
});
it('search finds non-default formats and PDF page tools',async()=>{
  const user=userEvent.setup(); render(<FormatFactory {...props}/>); await screen.findByText('本地处理引擎已连接');
  await user.type(screen.getByLabelText('搜索工具或格式'),'ico');
  await user.click(screen.getByRole('button',{name:'ICO',exact:true})); expect(screen.getByLabelText('转换为').value).toBe('ico');
  await user.clear(screen.getByLabelText('搜索工具或格式')); await user.type(screen.getByLabelText('搜索工具或格式'),'PDF');
  await user.click(screen.getByRole('button',{name:'PDF 提取页面',exact:true}));
  expect(screen.getByLabelText(/页码范围/)).toBeTruthy();
});
