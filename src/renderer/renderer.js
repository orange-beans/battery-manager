'use strict';
/* 渲染层逻辑：仪表盘 + 设置页 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let currentSettings = null;
let configPath = '';

// ---------- 视图切换 ----------
function showView(name) {
  $('#view-dashboard').classList.toggle('hidden', name !== 'dashboard');
  $('#view-settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'settings') loadSettingsIntoForm();
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

// ---------- 仪表盘渲染 ----------
function socClass(soc, low) {
  if (low || soc <= 20) return 'red';
  if (soc <= 50) return 'amber';
  return '';
}

function renderBattery(key, bat) {
  const card = $(`#card-${key}`);
  if (!bat) {
    $('[data-role="fill"]', card).style.width = '0%';
    $('[data-role="soc"]', card).textContent = '--%';
    $('[data-role="voltage"]', card).textContent = '--';
    $('[data-role="soc2"]', card).textContent = '--';
    const st = $('[data-role="status"]', card);
    st.textContent = '--';
    st.className = 'stat-value';
    ['running', 'low', 'voltwarn'].forEach((r) => $(`[data-role="${r}"]`, card).classList.add('hidden'));
    card.classList.remove('low');
    return;
  }

  const fill = $('[data-role="fill"]', card);
  fill.style.width = `${Math.max(0, Math.min(100, bat.soc))}%`;
  fill.className = `battery-fill ${socClass(bat.soc, bat.low)}`.trim();

  $('[data-role="soc"]', card).textContent = `${bat.soc}%`;

  const voltEl = $('[data-role="voltage"]', card);
  voltEl.textContent = `${bat.voltage.toFixed(2)} V`;
  voltEl.className = `stat-value ${bat.voltageWarn ? 'text-amber' : ''}`.trim();

  const soc2 = $('[data-role="soc2"]', card);
  soc2.textContent = `${bat.soc}%`; // 与电池壳内电量格式一致
  soc2.className = `stat-value ${bat.low ? 'text-red' : bat.soc <= 50 ? 'text-amber' : 'text-green'}`;

  const st = $('[data-role="status"]', card);
  if (bat.low) {
    st.textContent = '需充电';
    st.className = 'stat-value text-red';
  } else if (bat.running) {
    st.textContent = '运行中';
    st.className = 'stat-value text-blue';
  } else {
    st.textContent = '待机';
    st.className = 'stat-value';
  }

  $('[data-role="running"]', card).classList.toggle('hidden', !bat.running);
  $('[data-role="low"]', card).classList.toggle('hidden', !bat.low);
  $('[data-role="voltwarn"]', card).classList.toggle('hidden', !bat.voltageWarn || bat.voltage === 0);
  card.classList.toggle('low', bat.low);
}

function renderState(state) {
  const pill = $('#conn-pill');
  const connText = $('#conn-text');
  const banner = $('#error-banner');

  if (state.connected) {
    pill.className = 'conn-pill connected';
    connText.textContent = '已连接';
    banner.classList.add('hidden');
  } else {
    pill.className = 'conn-pill disconnected';
    connText.textContent = '未连接';
    banner.textContent = state.error ? `连接异常：${state.error}` : '连接异常';
    banner.classList.remove('hidden');
  }

  renderBattery('A', state.A);
  renderBattery('B', state.B);

  $('#meta-device').textContent = state.connected
    ? `设备ID ${state.deviceId} · 固件 ${state.firmware}`
    : '';
  $('#meta-update').textContent = state.lastOk
    ? `最后更新 ${new Date(state.lastOk).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '';
  $('#foot-adc').textContent = state.connected
    ? `原始ADC  A: ${state.adcA}   B: ${state.adcB}（调试用）`
    : '';
  $('#foot-config').textContent = configPath;
}

// ---------- 设置页 ----------
async function refreshPorts(prefer) {
  const sel = $('#set-port');
  const ports = await window.api.listPorts();
  sel.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = ports.length ? '— 请选择 —' : '（未检测到串口）';
  sel.appendChild(empty);
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = p.description ? `${p.path}（${p.description}）` : p.path;
    sel.appendChild(opt);
  }
  // 如果保存的端口当前不存在，也保留显示，便于用户感知
  if (prefer && !ports.some((p) => p.path === prefer)) {
    const opt = document.createElement('option');
    opt.value = prefer;
    opt.textContent = `${prefer}（当前未连接）`;
    sel.appendChild(opt);
  }
  sel.value = prefer || '';
}

async function loadSettingsIntoForm() {
  const { settings, configPath: cp } = await window.api.getState();
  currentSettings = settings;
  configPath = cp;
  $('#config-path').textContent = cp;
  $('#set-interval').value = settings.pollIntervalSec;
  $('#interval-val').textContent = `每 ${settings.pollIntervalSec} 秒 1 次`;
  $('#set-autostart').checked = settings.autoStart;
  $('#set-slave').value = settings.slaveAddress;
  $('#set-lowth').value = settings.lowBatteryThreshold;
  await refreshPorts(settings.port);
}

async function saveSettings() {
  const newSettings = {
    ...currentSettings,
    port: $('#set-port').value,
    pollIntervalSec: Number($('#set-interval').value),
    autoStart: $('#set-autostart').checked,
    slaveAddress: Number($('#set-slave').value),
    lowBatteryThreshold: Number($('#set-lowth').value),
  };
  const res = await window.api.saveSettings(newSettings);
  if (res.ok) {
    currentSettings = res.settings;
    toast('设置已保存并生效');
  } else {
    toast(`保存失败：${res.error}`, true);
  }
}

// ---------- 初始化 ----------
window.addEventListener('DOMContentLoaded', async () => {
  // 标题栏按钮：最小化/关闭均退回托盘
  $('#btn-min').addEventListener('click', () => window.api.hideWindow());
  $('#btn-close').addEventListener('click', () => window.api.hideWindow());

  // 视图切换
  $('#btn-goto-settings').addEventListener('click', () => showView('settings'));
  $('#btn-back').addEventListener('click', () => showView('dashboard'));

  // 设置页交互
  $('#set-interval').addEventListener('input', (e) => {
    $('#interval-val').textContent = `每 ${e.target.value} 秒 1 次`;
  });
  $('#btn-refresh-ports').addEventListener('click', () => refreshPorts($('#set-port').value));
  $('#btn-save').addEventListener('click', saveSettings);
  $('#btn-reset').addEventListener('click', async () => {
    await window.api.saveSettings({}); // 空对象 → 主进程清洗为默认值
    await loadSettingsIntoForm();
    toast('已恢复默认设置');
  });
  $('#btn-open-config').addEventListener('click', () => window.api.openConfigFolder());

  // 托盘菜单跳转（如点“设置”）
  window.api.onNavShow((view) => showView(view === 'settings' ? 'settings' : 'dashboard'));

  // 电池状态推送
  window.api.onBatteryUpdate(renderState);

  // 首次加载
  const { settings, configPath: cp, state } = await window.api.getState();
  currentSettings = settings;
  configPath = cp;
  renderState(state);
});
