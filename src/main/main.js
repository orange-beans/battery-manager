'use strict';
/**
 * 主进程入口：窗口管理、系统托盘、开机自启、设置持久化、IPC
 */

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell } = require('electron');
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

// 低电量提醒状态
let alerting = false;      // 当前是否处于低电量提醒中
let lastAlertAt = 0;       // 上次弹通知的时间戳
let notifiedOnce = false;  // “仅提醒一次”模式是否已提醒过
let flashTimer = null;     // 托盘图标闪烁定时器

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
    { label: '任务栏图标设置', click: () => shell.openExternal('ms-settings:taskbar') },
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
  if (!flashTimer) tray.setImage(image); // 闪烁期间不覆盖闪烁图标，仅更新提示文本
  tray.setToolTip(tooltip);
}

// ---------- 低电量提醒（系统通知 + 托盘图标闪烁） ----------
function showLowAlert(state) {
  // 多块低电量时优先提醒电量更低者（与托盘图标策略一致）
  const bat = [state.A, state.B]
    .filter((b) => b && b.running && b.low)
    .sort((x, y) => x.soc - y.soc)[0];
  if (!bat) return;
  const key = bat === state.A ? 'A' : 'B';
  // 注意：曾尝试自定义 toastXml（scenario="reminder"）以延长弹窗显示时间，
  // 但 Electron 在 Windows 上有已知 bug（issue #39367），自定义 XML 通知会静默不显示，
  // 故回退为标准通知。弹窗停留时长由系统控制（约数秒），通知会保留在通知中心，
  // 托盘图标闪烁会持续到低电量结束，不影响提醒效果。
  const n = new Notification({
    title: '电池低电量提醒',
    body: `电池${key}（运行中）电量 ${bat.soc}%，请及时充电`,
    icon: trayForState(state, settings).image, // 复用低电量托盘图标
    silent: false,
  });
  n.on('click', () => showWindow());
  n.show();
}

function startFlash(state) {
  if (flashTimer) return;
  // 正常态（忽略 low 标志）用于与低电量图标交替闪烁
  const normalState = {
    ...state,
    A: state.A ? { ...state.A, low: false } : null,
    B: state.B ? { ...state.B, low: false } : null,
  };
  const lowImg = trayForState(state, settings).image;
  const normalImg = trayForState(normalState, settings).image;
  let showLow = true;
  flashTimer = setInterval(() => {
    showLow = !showLow;
    tray.setImage(showLow ? lowImg : normalImg);
  }, 800);
}

function stopFlash() {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  if (tray) updateTray(monitor.state); // 恢复真实图标
}

/** 每次收到监控更新时评估是否需要提醒/停止提醒 */
function evaluateAlert(state) {
  if (!settings.lowAlertEnabled) {
    stopAlert();
    return;
  }
  const lowRunning =
    !!state && state.connected && [state.A, state.B].some((b) => b && b.running && b.low);
  if (!lowRunning) {
    stopAlert();
    return;
  }
  const now = Date.now();
  if (!alerting) {
    alerting = true;
    lastAlertAt = 0;
    notifiedOnce = false;
    startFlash(state);
  }
  if (settings.lowAlertIntervalMin === 0) {
    // 仅提醒一次：同一段低电量期间只弹一次
    if (!notifiedOnce) {
      notifiedOnce = true;
      showLowAlert(state);
    }
  } else if (now - lastAlertAt >= settings.lowAlertIntervalMin * 60 * 1000) {
    lastAlertAt = now;
    showLowAlert(state);
  }
}

function stopAlert() {
  if (!alerting) return;
  alerting = false;
  notifiedOnce = false;
  stopFlash();
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

/** 把偏移量操作的异常转成用户可读的提示 */
function offsetErrMsg(e) {
  if (e && e.code === 'EXCEPTION') {
    const m = /异常码 0x([0-9a-f]{2})/.exec(e.message);
    const code = m ? parseInt(m[1], 16) : null;
    if (code === 0x03) return '设备拒绝：数值越界或非法（异常 0x03），请输入 -1000 ~ 1000 mV';
    if (code === 0x02) return '设备拒绝：寄存器不存在（异常 0x02）';
    return code !== null ? `设备返回异常 0x${code.toString(16).padStart(2, '0')}` : e.message;
  }
  if (e && e.code === 'TIMEOUT') {
    return '操作超时，请检查串口连接；如不确定是否生效，可点击“读取当前偏移值”确认';
  }
  return (e && e.message) || '操作失败';
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

  // ---------- 硬件偏移量读写 ----------
  ipcMain.handle('offset:read', async () => {
    try {
      const offsets = await monitor.readOffsets();
      return { ok: true, ...offsets };
    } catch (e) {
      return { ok: false, error: offsetErrMsg(e) };
    }
  });

  ipcMain.handle('offset:write', async (_e, { battery, value }) => {
    try {
      const offsets = await monitor.writeOffset(battery, value);
      return { ok: true, ...offsets };
    } catch (e) {
      return { ok: false, error: offsetErrMsg(e) };
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
  // Windows 10+ 系统通知（Toast）必须设置 AppUserModelID，否则不显示
  app.setAppUserModelId('com.bestautomation.batterymonitor');

  store = new SettingsStore(app.getPath('documents'));
  settings = store.load();

  // 判断是否为开机自启（静默驻留托盘，不弹窗）
  const launchedAtLogin =
    app.isPackaged && app.getLoginItemSettings().wasOpenedAsHidden;

  monitor = new BatteryMonitor();
  monitor.on('update', (state) => {
    updateTray(state);
    evaluateAlert(state);
    if (mainWindow) mainWindow.webContents.send('battery:update', state);
  });

  registerIpc();
  createWindow(!launchedAtLogin);
  createTray();
  applyAutoStart();

  // 首次运行：引导用户把托盘图标从溢出区拖到通知区常驻（仅一次）
  if (!settings.trayHintShown) {
    settings = store.save({ ...settings, trayHintShown: true });
    try {
      const hint = new Notification({
        title: '电池状态监控',
        body: '电池图标默认在任务栏 ⌄ 溢出区中，可将其拖出到通知区即可常驻显示。',
        silent: true,
      });
      hint.show();
    } catch (e) {
      console.error('首次运行提示失败：', e);
    }
  }

  await monitor.configure(settings);

  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => {
  // 托盘常驻应用：窗口全关也不退出
});

app.on('before-quit', async () => {
  isQuitting = true;
  stopFlash();
  if (monitor) await monitor.stop();
});
