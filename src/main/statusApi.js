'use strict';
/**
 * 本机只读状态接口：仅监听 127.0.0.1。
 * 直接返回 monitor.state 的内存快照，不触发额外串口读取。
 * 提供 GET /status 与 GET /health，其余方法/路径分别返回 405/404。
 */

const http = require('http');

const APP_ID = 'battery-monitor';

/** 按现有低电量提醒规则计算 alert（单电池看 low，双电池看“运行中且低电量”） */
function buildAlert(state, settings) {
  const single = settings.batteryMode === 'single';
  const list = single ? [['A', state.A]] : [['A', state.A], ['B', state.B]];
  const hits = list.filter(([, b]) => b && b.low && (single || b.running));
  if (!hits.length) return { active: false, keys: [], minSoc: null, message: '' };
  const keys = hits.map(([k]) => k);
  const minSoc = Math.min(...hits.map(([, b]) => b.soc));
  const labels = keys.map((k) => (single ? '电池' : `电池${k}（运行中）`));
  return { active: true, keys, minSoc, message: `${labels.join('、')}电量 ${minSoc}%，请及时充电` };
}

/** 仅暴露契约中定义的电池字段 */
function pickBattery(b) {
  if (!b) return null;
  return {
    voltage: b.voltage,
    soc: b.soc,
    running: b.running,
    low: b.low,
    voltageWarn: b.voltageWarn,
  };
}

function buildStatus(state, settings, version) {
  const s = state || {};
  const single = settings.batteryMode === 'single';
  return {
    ok: true,
    app: APP_ID,
    version,
    ts: Date.now(),
    connected: !!s.connected,
    error: s.error || null,
    lastOk: s.lastOk ?? null,
    deviceId: s.deviceId ?? null,
    firmware: s.firmware ?? null,
    settings: {
      batteryMode: settings.batteryMode,
      lowBatteryThreshold: settings.lowBatteryThreshold,
      lowVoltageWarn: settings.lowVoltageWarn,
    },
    A: pickBattery(s.A),
    B: single ? null : pickBattery(s.B),
    alert: buildAlert(s, settings),
  };
}

class StatusApiServer {
  /**
   * @param {{getState:()=>object, getSettings:()=>object, version:string}} opts
   */
  constructor({ getState, getSettings, version }) {
    this.getState = getState;
    this.getSettings = getSettings;
    this.version = version;
    this.server = null;
    this.port = null;
    this.error = null; // 启动失败原因（如端口占用），null 表示正常或未启用
  }

  /** 按设置启动（若已在运行会先关闭旧实例）；失败只记录，不抛异常 */
  async start(settings) {
    await this.stop();
    this.error = null;
    if (!settings.apiEnabled) return;
    const server = http.createServer((req, res) => this._handle(req, res));
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(settings.apiPort, '127.0.0.1');
      });
      this.server = server;
      this.port = settings.apiPort;
      // 控制台使用英文，避免 Windows 终端编码（GBK）下中文乱码；界面提示仍为中文
      console.log(`[StatusAPI] listening on http://127.0.0.1:${this.port}`);
    } catch (err) {
      this.error =
        err.code === 'EADDRINUSE' ? `端口 ${settings.apiPort} 已被占用` : err.message || '启动失败';
      console.error(`[StatusAPI] failed to start on port ${settings.apiPort}: ${err.code || err.message}`);
      try {
        server.close();
      } catch {
        // 忽略：server 未进入监听状态
      }
    }
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      // 断开 keep-alive 连接，确保端口立即释放
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  _handle(req, res) {
    const send = (code, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    try {
      if (req.method !== 'GET') {
        return send(405, { ok: false, error: 'method-not-allowed' });
      }
      const pathname = (req.url || '/').split('?')[0];
      if (pathname === '/status') {
        return send(200, buildStatus(this.getState(), this.getSettings(), this.version));
      }
      if (pathname === '/health') {
        return send(200, { ok: true, app: APP_ID, version: this.version });
      }
      return send(404, { ok: false, error: 'not-found' });
    } catch (e) {
      console.error('[StatusAPI] request handling failed:', e);
      try {
        send(500, { ok: false, error: 'internal-error' });
      } catch {
        // 响应可能已发送
      }
    }
  }
}

module.exports = { StatusApiServer, buildStatus, buildAlert };
