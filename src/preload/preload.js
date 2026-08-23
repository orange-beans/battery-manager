'use strict';
/**
 * 预加载脚本：通过 contextBridge 向渲染层暴露受控 API
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 获取当前设置 + 最新电池状态 + 配置文件路径 */
  getState: () => ipcRenderer.invoke('state:get'),
  /** 枚举本机串口 */
  listPorts: () => ipcRenderer.invoke('ports:list'),
  /** 保存设置（主进程会校验、写盘并重启轮询） */
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  /** 在资源管理器中定位配置文件 */
  openConfigFolder: () => ipcRenderer.invoke('config:openFolder'),
  /** 隐藏窗口到托盘 */
  hideWindow: () => ipcRenderer.send('window:hide'),
  /** 订阅电池状态推送 */
  onBatteryUpdate: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('battery:update', listener);
    return () => ipcRenderer.removeListener('battery:update', listener);
  },
  /** 订阅视图跳转（托盘菜单点“设置”时切到设置页） */
  onNavShow: (cb) => {
    const listener = (_e, view) => cb(view);
    ipcRenderer.on('nav:show', listener);
    return () => ipcRenderer.removeListener('nav:show', listener);
  },
});
