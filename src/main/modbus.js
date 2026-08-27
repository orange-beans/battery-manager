'use strict';
/**
 * 轻量 Modbus-RTU 主站客户端（基于 serialport）
 * 协议要点（见《电池管理系统 Modbus-RTU 通讯协议》）：
 *  - 115200 / 8 / N / 1，无流控
 *  - 帧格式：[从站地址][功能码][数据 N][CRC 低字节][CRC 高字节]
 *  - CRC16/MODBUS：初值 0xFFFF，多项式 0xA001，低字节在前
 *  - 无响应时等待超时后重试（建议 500ms）
 */

const { SerialPort } = require('serialport');

/** CRC-16/MODBUS：初值 0xFFFF，多项式 0xA001（按位处理），返回 16 位整数 */
function crc16(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x0001) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
    }
  }
  return crc & 0xFFFF;
}

class ModbusError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ModbusError';
    this.code = code; // 'TIMEOUT' | 'CRC' | 'EXCEPTION' | 'PORT' ...
  }
}

class ModbusRTUClient {
  /**
   * @param {object} opts
   * @param {string} opts.path      串口名，如 COM3
   * @param {number} [opts.baudRate] 默认 115200
   * @param {number} [opts.timeout]  响应超时 ms，默认 500
   */
  constructor({ path, baudRate = 115200, timeout = 500 }) {
    this.path = path;
    this.baudRate = baudRate;
    this.timeout = timeout;
    this.port = null;
    this._rx = Buffer.alloc(0);
    this._pending = null; // 当前等待响应的请求
    this._lock = Promise.resolve(); // 事务互斥锁：串行化所有读写
  }

  get isOpen() {
    return !!(this.port && this.port.isOpen);
  }

  open() {
    return new Promise((resolve, reject) => {
      if (this.isOpen) return resolve();
      this.port = new SerialPort({
        path: this.path,
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });
      this.port.on('data', (d) => this._onData(d));
      this.port.on('error', (e) => this._failPending(new ModbusError(`串口错误：${e.message}`, 'PORT')));
      this.port.on('close', () => this._failPending(new ModbusError('串口已断开', 'PORT')));
      this.port.open((err) => {
        if (err) return reject(new ModbusError(`无法打开串口 ${this.path}：${err.message}`, 'PORT'));
        resolve();
      });
    });
  }

  async close() {
    this._failPending(new ModbusError('串口已关闭', 'PORT'));
    if (this.port) {
      const p = this.port;
      this.port = null;
      if (p.isOpen) {
        await new Promise((resolve) => p.close(() => resolve()));
      }
    }
  }

  _failPending(err) {
    if (this._pending) {
      const p = this._pending;
      this._pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  _onData(chunk) {
    if (!this._pending) return; // 无等待请求，丢弃（含串口杂波）
    this._rx = Buffer.concat([this._rx, chunk]);
    const p = this._pending;

    // 异常响应帧：[地址][功能码|0x80][异常码][CRC]，长度固定 5
    if (this._rx.length >= 2 && this._rx[0] === p.slave && this._rx[1] === (p.fc | 0x80)) {
      if (this._rx.length >= 5) {
        const frame = Buffer.from(this._rx.slice(0, 5));
        this._finish(frame, 5);
        if (this._checkCrc(frame)) {
          const exCode = frame[2];
          p.reject(new ModbusError(`Modbus 异常响应，异常码 0x${exCode.toString(16).padStart(2, '0')}`, 'EXCEPTION'));
        } else {
          p.reject(new ModbusError('异常帧 CRC 校验失败', 'CRC'));
        }
      }
      return;
    }

    if (this._rx.length >= p.expected) {
      const frame = Buffer.from(this._rx.slice(0, p.expected));
      this._finish(frame, p.expected);
      if (frame[0] !== p.slave || frame[1] !== p.fc) {
        return p.reject(new ModbusError('响应帧地址/功能码不匹配', 'CRC'));
      }
      if (!this._checkCrc(frame)) {
        return p.reject(new ModbusError('CRC 校验失败', 'CRC'));
      }
      p.resolve(frame);
    }
  }

  _finish(frame, consumed) {
    const p = this._pending;
    this._pending = null;
    clearTimeout(p.timer);
    this._rx = Buffer.from(this._rx.slice(consumed)); // 保留多余字节（理论上不应有）
  }

  _checkCrc(frame) {
    if (frame.length < 4) return false;
    const body = frame.slice(0, frame.length - 2);
    const crc = crc16(body);
    return frame[frame.length - 2] === (crc & 0xFF) && frame[frame.length - 1] === (crc >> 8);
  }

  /**
   * 互斥锁：所有事务排队串行执行，避免写入与轮询读“打架”
   * （Modbus-RTU 单主站半双工，同一时刻只能有一个在途请求）
   */
  _withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 发送一次请求并等待响应（经互斥锁串行化）
   * @param {number} slave       从站地址
   * @param {number} fc          功能码
   * @param {Buffer} reqData     功能码之后的数据区
   * @param {number} respDataLen 正常响应中「字节计数」之后的预期数据字节数
   * @returns {Promise<Buffer>}  完整响应帧（含 CRC）
   */
  _transact(slave, fc, reqData, respDataLen) {
    return this._withLock(() => this._transactUnlocked(slave, fc, reqData, respDataLen));
  }

  _transactUnlocked(slave, fc, reqData, respDataLen) {
    return new Promise((resolve, reject) => {
      if (this._pending) return reject(new ModbusError('上一请求尚未完成', 'BUSY'));
      this.open().then(() => {
        const body = Buffer.concat([Buffer.from([slave, fc]), reqData]);
        const crc = crc16(body);
        const frame = Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
        this._rx = Buffer.alloc(0);
        const timer = setTimeout(() => {
          this._pending = null;
          reject(new ModbusError('响应超时（设备无应答）', 'TIMEOUT'));
        }, this.timeout);
        this._pending = {
          slave, fc,
          expected: 3 + respDataLen + 2, // 地址+功能码+字节计数 + 数据 + CRC
          timer, resolve, reject,
        };
        this.port.write(frame);
      }).catch(reject);
    });
  }

  /**
   * 功能码 0x03：读保持寄存器
   * @returns {Promise<number[]>} 寄存器值数组（uint16）
   */
  async readHoldingRegisters(slave, address, quantity) {
    const reqData = Buffer.alloc(4);
    reqData.writeUInt16BE(address, 0);
    reqData.writeUInt16BE(quantity, 2);
    const frame = await this._transact(slave, 0x03, reqData, quantity * 2);
    const byteCount = frame[2];
    if (byteCount !== quantity * 2) {
      throw new ModbusError(`字节计数异常：期望 ${quantity * 2}，实际 ${byteCount}`, 'CRC');
    }
    const regs = [];
    for (let i = 0; i < quantity; i++) {
      regs.push(frame.readUInt16BE(3 + i * 2));
    }
    return regs;
  }

  /** 功能码 0x04：读输入寄存器（本设备与 0x03 等效） */
  async readInputRegisters(slave, address, quantity) {
    const reqData = Buffer.alloc(4);
    reqData.writeUInt16BE(address, 0);
    reqData.writeUInt16BE(quantity, 2);
    const frame = await this._transact(slave, 0x04, reqData, quantity * 2);
    const regs = [];
    for (let i = 0; i < quantity; i++) regs.push(frame.readUInt16BE(3 + i * 2));
    return regs;
  }

  /**
   * 功能码 0x03：读保持寄存器，按 int16 有符号解析（用于偏移量等带符号参数）
   * @returns {Promise<number[]>} 有符号寄存器值数组
   */
  async readHoldingRegistersSigned(slave, address, quantity) {
    const reqData = Buffer.alloc(4);
    reqData.writeUInt16BE(address, 0);
    reqData.writeUInt16BE(quantity, 2);
    const frame = await this._transact(slave, 0x03, reqData, quantity * 2);
    const byteCount = frame[2];
    if (byteCount !== quantity * 2) {
      throw new ModbusError(`字节计数异常：期望 ${quantity * 2}，实际 ${byteCount}`, 'CRC');
    }
    const regs = [];
    for (let i = 0; i < quantity; i++) {
      regs.push(frame.readInt16BE(3 + i * 2));
    }
    return regs;
  }

  /**
   * 功能码 0x06：写单个保持寄存器
   * 正常响应为请求回显（无字节计数，帧长固定 8 字节）；
   * 越界等非法数据时设备返回异常 0x03。
   * @returns {Promise<number>} 写入的寄存器值
   */
  async writeSingleRegister(slave, address, value) {
    const v = value & 0xFFFF;
    const reqData = Buffer.alloc(4);
    reqData.writeUInt16BE(address, 0);
    reqData.writeUInt16BE(v, 2);
    // respDataLen=3 使期望帧长 = 3 + 3 + 2 = 8（地址+功能码+地址2+值2+CRC2）
    const frame = await this._transact(slave, 0x06, reqData, 3);
    if (frame.length !== 8 || frame.readUInt16BE(2) !== address || frame.readUInt16BE(4) !== v) {
      throw new ModbusError('写寄存器回显校验失败', 'CRC');
    }
    return v;
  }
}

module.exports = { ModbusRTUClient, ModbusError, crc16 };
