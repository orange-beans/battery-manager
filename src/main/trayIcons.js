'use strict';
/**
 * 托盘图标管理：根据电池状态选择对应图标。
 * 图标由 tools/gen_icons.py 预生成，位于 assets/tray/{16,24,32}/ 下：
 *   bat_000 ~ bat_100   正常（填充色随电量：绿/橙/红）
 *   low_000 ~ low_100   低电量（红色边框+红色填充）
 *   disc                串口未连接（灰色 ×）
 *   idle                已连接但无电池处于运行状态（灰色）
 */

const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

const cache = new Map();

function loadIcon(name) {
  if (cache.has(name)) return cache.get(name);
  const img = nativeImage.createEmpty();
  for (const size of [16, 24, 32]) {
    const p = path.join(__dirname, '..', '..', 'assets', 'tray', String(size), `${name}.png`);
    if (fs.existsSync(p)) {
      img.addRepresentation({ scaleFactor: size / 16, buffer: fs.readFileSync(p) });
    }
  }
  cache.set(name, img);
  return img;
}

function levelOf(soc) {
  const n = Math.round((soc ?? 0) / 10) * 10;
  return String(Math.min(100, Math.max(0, n))).padStart(3, '0');
}

/**
 * 选出托盘应当展示的电池：优先“运行中”的；两块都在运行时取电量更低者（更保守）。
 * @returns {{key:'A'|'B', battery:object}|null}
 */
function pickActiveBattery(state) {
  const cands = [];
  if (state.A && state.A.running) cands.push({ key: 'A', battery: state.A });
  if (state.B && state.B.running) cands.push({ key: 'B', battery: state.B });
  if (!cands.length) return null;
  cands.sort((x, y) => x.battery.soc - y.battery.soc);
  return cands[0];
}

/**
 * 根据监控状态返回 { image, tooltip }
 */
function trayForState(state, settings) {
  if (!state || !state.connected) {
    return {
      image: loadIcon('disc'),
      tooltip: `电池状态监控 - 未连接\n${(state && state.error) || '串口未连接'}`,
    };
  }
  const active = pickActiveBattery(state);
  if (!active) {
    return {
      image: loadIcon('idle'),
      tooltip: '电池状态监控 - 已连接\n当前无电池处于运行状态',
    };
  }
  const { key, battery } = active;
  const lv = levelOf(battery.soc);
  const image = loadIcon(battery.low ? `low_${lv}` : `bat_${lv}`);
  // 两块电池统一格式：电池X（运行中）：SOC%  xx.xx V（单位与主窗口一致，带空格）
  const fmt = (k, b) => `电池${k}${b.running ? '（运行中）' : ''}：${b.soc}%  ${b.voltage.toFixed(2)} V`;
  const lines = [fmt(key, battery)];
  const other = key === 'A' ? state.B : state.A;
  if (other) lines.push(fmt(key === 'A' ? 'B' : 'A', other));
  if (battery.low) lines.push('⚠ 电量低，请充电');
  lines.push('双击查看详情');
  return { image, tooltip: lines.join('\n') };
}

module.exports = { loadIcon, trayForState, pickActiveBattery };
