'use strict';
/**
 * 电池监控轮询器
 * 每个周期用 0x03 一次读取 0x0000 起共 8 个寄存器：
 *   0x0000 设备ID / 0x0001 电池A电压mV / 0x0002 电池A状态+电量 /
 *   0x0003 电池B电压mV / 0x0004 电池B状态+电量 / 0x0005 固件版本 /
 *   0x0006 电池A原始ADC / 0x0007 电池B原始ADC
 * 状态字节（0x0002/0x0004 高字节）：bit0=A运行 bit1=B运行 bit4=A低电量 bit5=B低电量
 */

const { EventEmitter } = require('events');
const { ModbusRTUClient } = require('./modbus');

const MAX_FAIL = 3; // 连续失败 3 次判定为断连

function parseStatusByte(st) {
  return {
    runningA: !!(st & 0x01),
    runningB: !!(st & 0x02),
    lowA: !!(st & 0x10),
    lowB: !!(st & 0x20),
  };
}

class BatteryMonitor extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.client = null;
    this._timer = null;
    this._stopped = true;
    this._failCount = 0;
    /** 最近一次完整状态（供托盘/窗口查询） */
    this.state = {
      connected: false,
      error: '未配置串口',
      lastOk: null,
      deviceId: null,
      firmware: null,
      A: null,
      B: null,
    };
  }

  /**
   * 应用新配置并重启轮询
   * @param {{port:string, baudRate:number, pollIntervalSec:number, slaveAddress:number, lowBatteryThreshold:number, lowVoltageWarn:number}} cfg
   */
  async configure(cfg) {
    this.config = { ...cfg };
    await this.stop();
    if (!this.config.port) {
      this.state = { ...this.state, connected: false, error: '未配置串口，请到设置页选择 COM 口', A: null, B: null };
      this.emit('update', this.state);
      return;
    }
    this.client = new ModbusRTUClient({
      path: this.config.port,
      baudRate: this.config.baudRate || 115200,
      timeout: 500,
    });
    this._failCount = 0;
    this._stopped = false;
    this._loop();
  }

  async stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.close().catch(() => {});
    }
  }

  // ---------- 硬件偏移量（校准参数，寄存器 0x0100/0x0101，有符号 int16） ----------

  _isClientReady() {
    return !!(this.client && this.client.isOpen);
  }

  /** 读取 A/B 电池偏移量（mV） */
  async readOffsets() {
    if (!this._isClientReady()) {
      const err = new Error('串口未连接');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    const [a, b] = await this.client.readHoldingRegistersSigned(this.config.slaveAddress, 0x0100, 2);
    return { A: a, B: b };
  }

  /**
   * 写入单个电池偏移量（mV），成功后读回确认
   * @param {'A'|'B'} key
   * @param {number} value -1000 ~ 1000
   * @returns {Promise<{A:number, B:number}>} 写入后读回的 A/B 偏移
   */
  async writeOffset(key, value) {
    if (key !== 'A' && key !== 'B') {
      const err = new Error('电池标识无效');
      err.code = 'BAD_ARG';
      throw err;
    }
    const v = Math.round(Number(value));
    if (!Number.isFinite(v) || v < -1000 || v > 1000) {
      const err = new Error('偏移量需在 -1000 ~ 1000 mV 之间');
      err.code = 'RANGE';
      throw err;
    }
    if (!this._isClientReady()) {
      const err = new Error('串口未连接');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    const addr = key === 'A' ? 0x0100 : 0x0101;
    await this.client.writeSingleRegister(this.config.slaveAddress, addr, v);
    return this.readOffsets(); // 写后读回验证
  }

  async _loop() {
    while (!this._stopped && this.client) {
      const t0 = Date.now();
      try {
        const regs = await this.client.readHoldingRegisters(this.config.slaveAddress, 0x0000, 8);
        this._handleData(regs);
      } catch (e) {
        this._handleError(e);
      }
      if (this._stopped) break;
      const intervalMs = Math.min(15, Math.max(1, this.config.pollIntervalSec || 1)) * 1000;
      const wait = Math.max(150, intervalMs - (Date.now() - t0));
      await new Promise((resolve) => {
        this._timer = setTimeout(resolve, wait);
      });
    }
  }

  _handleData(regs) {
    this._failCount = 0;
    const stA = (regs[2] >> 8) & 0xFF;
    const stB = (regs[4] >> 8) & 0xFF;
    const sA = parseStatusByte(stA);
    const sB = parseStatusByte(stB);
    const th = this.config.lowBatteryThreshold ?? 20;
    const vWarn = this.config.lowVoltageWarn ?? 11.5;

    const mkBattery = (voltMv, socReg, st, running, lowFlag) => {
      const voltage = voltMv / 1000;
      const soc = socReg & 0xFF;
      // 低电量判定：设备状态位 或 SOC≤阈值（阈值可调，取更保守者）
      const low = lowFlag || soc <= th;
      return {
        voltage: Math.round(voltage * 1000) / 1000,
        soc,
        running,
        low,
        voltageWarn: voltage < vWarn, // 协议建议：低于 11.5V 提示异常
      };
    };

    this.state = {
      connected: true,
      error: null,
      lastOk: Date.now(),
      deviceId: regs[0],
      firmware: `V${(regs[5] >> 8) & 0xFF}.${regs[5] & 0xFF}`,
      adcA: regs[6],
      adcB: regs[7],
      A: mkBattery(regs[1], regs[2], stA, sA.runningA, sA.lowA),
      B: mkBattery(regs[3], regs[4], stB, sB.runningB, sB.lowB),
    };
    this.emit('update', this.state);
  }

  _handleError(err) {
    this._failCount++;
    if (this._failCount >= MAX_FAIL) {
      this.state = {
        ...this.state,
        connected: false,
        error: err.message,
        A: null,
        B: null,
      };
      this.emit('update', this.state);
    } else if (this.state.connected) {
      // 偶发失败：保持显示上一次数据，仅在状态中附带提示
      this.state = { ...this.state, transientError: err.message };
      this.emit('update', this.state);
    }
  }
}

module.exports = { BatteryMonitor };
