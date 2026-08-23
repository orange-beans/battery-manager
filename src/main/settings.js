'use strict';
/**
 * 设置管理：读写 Documents/BestAutomation/systemMonitor.json
 * 读取失败（文件不存在 / JSON 损坏 / 字段缺失）时回退到默认设置。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  port: '',               // COM 口，如 "COM3"；空 = 未配置
  baudRate: 115200,       // 协议固定 115200-8N1
  pollIntervalSec: 1,     // 轮询周期，1~15 秒
  slaveAddress: 1,        // Modbus 从站地址，1~247
  autoStart: true,        // 开机自启
  lowBatteryThreshold: 20,// 低电量阈值 %（SOC ≤ 该值判为需充电）
  lowVoltageWarn: 11.5,   // 电压异常提示阈值 V
};

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 清洗/校验设置对象，非法字段回退默认值 */
function sanitize(raw) {
  const d = DEFAULT_SETTINGS;
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    port: typeof s.port === 'string' ? s.port.trim() : d.port,
    baudRate: 115200, // 协议固定，不允许修改
    pollIntervalSec: Math.round(clamp(s.pollIntervalSec, 1, 15, d.pollIntervalSec)),
    slaveAddress: Math.round(clamp(s.slaveAddress, 1, 247, d.slaveAddress)),
    autoStart: typeof s.autoStart === 'boolean' ? s.autoStart : d.autoStart,
    lowBatteryThreshold: Math.round(clamp(s.lowBatteryThreshold, 1, 100, d.lowBatteryThreshold)),
    lowVoltageWarn: clamp(s.lowVoltageWarn, 0, 20, d.lowVoltageWarn),
  };
}

class SettingsStore {
  /** @param {string} documentsDir 通常为 app.getPath('documents') */
  constructor(documentsDir) {
    this.dir = path.join(documentsDir, 'BestAutomation');
    this.file = path.join(this.dir, 'systemMonitor.json');
  }

  /** 读取设置；任何失败都返回默认设置 */
  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf-8');
      return sanitize(JSON.parse(text));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** 保存设置（原子写入：先写临时文件再改名） */
  save(settings) {
    const s = sanitize(settings);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
    return s;
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS, sanitize };
