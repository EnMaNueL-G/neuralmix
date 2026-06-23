// NeuralMix Pro - bridge seguro.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('nm', {
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  libList: () => ipcRenderer.invoke('lib:list'),
  libAdd: (paths, source) => ipcRenderer.invoke('lib:add', paths, source),
  dirScan: (dir) => ipcRenderer.invoke('dir:scan', dir),
  libRemove: (p) => ipcRenderer.invoke('lib:remove', p),
  suggest: (p) => ipcRenderer.invoke('lib:suggest', p),
  readAudio: (p) => ipcRenderer.invoke('audio:read', p),
  stemsSeparate: (jobId, opts) => ipcRenderer.invoke('stems:separate', jobId, opts),
  stemsFind: (p) => ipcRenderer.invoke('stems:find', p),
  stemsCancel: (jobId) => ipcRenderer.invoke('stems:cancel', jobId),
  onStems: (cb) => {
    const fn = (_e, jobId, ev) => cb(jobId, ev);
    ipcRenderer.on('stems:event', fn);
    return () => ipcRenderer.removeListener('stems:event', fn);
  },
  pickFiles: () => ipcRenderer.invoke('pick:files'),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  setSafe: (on) => ipcRenderer.invoke('app:safe', on),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch (_) { return ''; } },
  onLib: (cb) => {
    const fns = {};
    ['lib:progress', 'lib:done', 'lib:error', 'lib:idle'].forEach((ch) => {
      fns[ch] = (_e, data) => cb(ch, data);
      ipcRenderer.on(ch, fns[ch]);
    });
    return () => Object.entries(fns).forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn));
  },
});
