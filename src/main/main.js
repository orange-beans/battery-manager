'use strict';
/**
 * 主进程入口：窗口管理、系统托盘、开机自启、设置持久化、IPC
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');
const { SettingsStore } = require('./settings');
const { BatteryMonitor } = require('./monitor');
const { trayForState } = require('./trayIcons');

let mainWindow = null;
let tray = null;
let store = null;
let settings = null;
let monitor = null;
let isQuitting = false;

// ---------- 单实例：重复启动时聚焦已有窗口 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// ---------- 窗口 ----------
function createWindow(showOnCreate) {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 780,
    minHeight: 560,
    show: false,
    frame: false,               // 自定义标题栏
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0d1220',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (showOnCreate) mainWindow.show();
  });

  // 最小化 / 关闭都退回托盘，不真正退出（退出走托盘菜单）
  mainWindow.on('minimize', () => mainWindow.hide());
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow(view) {
  if (!mainWindow) return;
  if (view) mainWindow.webContents.send('nav:show', view);
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// ---------- 托盘 ----------
function createTray() {
  const { trayForState: forState } = require('./trayIcons');
  const { image, tooltip } = forState(monitor.state, settings);
  tray = new Tray(image);
  tray.setToolTip(tooltip);
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => showWindow());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { label: '设置', click: () => showWindow('settings') },
    { type: 'separator' },
    { label: '打开配置文件', click: () => shell.showItemInFolder(store.file) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function updateTray(state) {
  if (!tray) return;
  const { image, tooltip } = trayForState(state, settings);
  tray.setImage(image);
  tray.setToolTip(tooltip);
}

// ---------- 开机自启 ----------
function applyAutoStart() {
  if (!app.isPackaged) return; // 开发模式下不写入启动项（指向 electron.exe 无意义）
  // 便携版运行时 process.execPath 指向临时解压目录，自启必须指向便携 exe 本体，
  // 否则注册表里记录的是临时路径，重启后自启失效
  const execPath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.autoStart,
      openAsHidden: true, // 开机自启时静默驻留托盘
      path: execPath,
    });
  } catch (e) {
    console.error('设置开机自启失败：', e);
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('state:get', () => ({
    settings,
    configPath: store.file,
    state: monitor.state,
    version: app.getVersion(),
  }));

  ipcMain.handle('ports:list', async () => {
    try {
      const ports = await SerialPort.list();
      return ports.map((p) => ({
        path: p.path,
        description: p.friendlyName || p.manufacturer || '',
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('settings:save', async (_e, newSettings) => {
    try {
      settings = store.save(newSettings);
      applyAutoStart();
      await monitor.configure(settings); // 立即按新配置重启轮询
      return { ok: true, settings };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('config:openFolder', () => {
    // 确保文件存在，方便用户直接查看/编辑
    if (!require('fs').existsSync(store.file)) store.save(settings);
    shell.showItemInFolder(store.file);
  });

  ipcMain.on('window:hide', () => mainWindow && mainWindow.hide());
}

// ---------- 启动 ----------
app.whenReady().then(async () => {
  store = new SettingsStore(app.getPath('documents'));
  settings = store.load();

  // 判断是否为开机自启（静默驻留托盘，不弹窗）
  const launchedAtLogin =
    app.isPackaged && app.getLoginItemSettings().wasOpenedAsHidden;

  monitor = new BatteryMonitor();
  monitor.on('update', (state) => {
    updateTray(state);
    if (mainWindow) mainWindow.webContents.send('battery:update', state);
  });

  registerIpc();
  createWindow(!launchedAtLogin);
  createTray();
  applyAutoStart();
  await monitor.configure(settings);

  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => {
  // 托盘常驻应用：窗口全关也不退出
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (monitor) await monitor.stop();
});
