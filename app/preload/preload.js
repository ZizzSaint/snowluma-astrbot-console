'use strict';
/** 预加载脚本：仅暴露必要的 IPC 接口，渲染层不接触 Node。 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const listeners = new Map();
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  listeners.set(handler, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    listeners.delete(handler);
  };
}

contextBridge.exposeInMainWorld('launcher', {
  state: (options) => invoke('state:all', options),
  settings: {
    patch: (patch) => invoke('settings:patch', patch),
  },
  env: {
    qq: () => invoke('env:qq'),
    node: () => invoke('env:node'),
    pythons: () => invoke('env:pythons'),
  },
  snowluma: {
    releases: (options) => invoke('snowluma:releases', options),
    plan: (options) => invoke('snowluma:plan', options),
    install: (options) => invoke('snowluma:install', options),
    update: () => invoke('snowluma:update'),
    start: () => invoke('snowluma:start'),
    stop: () => invoke('snowluma:stop'),
    restart: () => invoke('snowluma:restart'),
    bridge: (options) => invoke('snowluma:bridge', options),
    logs: (options) => invoke('snowluma:logs', options),
    clearLogs: () => invoke('snowluma:clearLogs'),
    onebot: (options) => invoke('snowluma:onebot', options),
  },
  astrbot: {
    releases: (options) => invoke('astrbot:releases', options),
    plan: (options) => invoke('astrbot:plan', options),
    install: (options) => invoke('astrbot:install', options),
    update: () => invoke('astrbot:update'),
    repairDeps: () => invoke('astrbot:repairDeps'),
    dashboard: () => invoke('astrbot:dashboard'),
    start: () => invoke('astrbot:start'),
    stop: () => invoke('astrbot:stop'),
    restart: () => invoke('astrbot:restart'),
    bridge: (options) => invoke('astrbot:bridge', options),
    resetPassword: () => invoke('astrbot:resetPassword'),
    login: (options) => invoke('astrbot:login', options),
    logs: (options) => invoke('astrbot:logs', options),
    clearLogs: () => invoke('astrbot:clearLogs'),
  },
  migrate: {
    defaultTarget: () => invoke('migrate:defaultTarget'),
    plan: (targetRoot) => invoke('migrate:plan', { targetRoot }),
    run: (targetRoot) => invoke('migrate:run', { targetRoot }),
  },
  system: {
    openPath: (target) => invoke('shell:openPath', { target }),
    openExternal: (url) => invoke('shell:openExternal', { url }),
    exportLogs: (service) => invoke('logs:export', { service }),
    pickDir: (title) => invoke('dialog:pickDir', { title }),
    quit: () => invoke('app:quit'),
    freezeQqUpdate: () => invoke('qq:freeze'),
    unfreezeQqUpdate: () => invoke('qq:unfreeze'),
    qqFreezeStatus: () => invoke('qq:freezeStatus'),
    openHosts: () => invoke('qq:openHosts'),
  },
  on,
});
