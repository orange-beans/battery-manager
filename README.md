# 电池状态监控（Battery Monitor）

BestAutomation 电池管理系统 PC 端监控软件。基于 **Electron + serialport**，通过串口以
Modbus-RTU 协议轮询电池监控硬件，在 Windows 系统托盘实时显示运行中电池的电量，
并提供电池 A/B 详细数据仪表盘与设置界面。

## 功能一览

- **托盘电量图标**：仿笔记本电池样式，图标填充量随电量变化（>50% 绿 / 21~50% 橙 /
  ≤20% 红），低电量时图标变为红色警示样式；鼠标悬停显示电压、电量等详情。
  显示的是当前处于"运行中"的电池（两块同时运行时显示电量较低者）。
- **主窗口**：双击托盘图标打开。展示电池 A/B 的电压、电量、运行/待机/需充电状态、
  设备 ID、固件版本、原始 ADC（调试用）、最后更新时间。最小化或关闭窗口均退回托盘。
- **托盘右键菜单**：显示主窗口 / 设置 / 打开配置文件 / 退出（退出后软件彻底关闭，
  可通过 exe 或桌面快捷方式再次启动）。
- **低电量提醒**：托盘图标变红；主窗口对应电池卡片红色脉冲边框 +"⚠ 电量低，请充电"
  徽标；电压低于 11.5V 另显示"电压异常偏低"提示（阈值可在配置文件中调整）。
- **开机自启**：设置页可开关；自启时静默驻留托盘，不弹窗。
- **设置持久化**：保存到 `Documents\BestAutomation\systemMonitor.json`，启动时自动加载；
  JSON 损坏或缺失时回退默认设置；可直接编辑该文件修改设置。
- **异常处理**：500ms 响应超时、连续 3 次失败判定断连并自动重试、串口拔出自动提示。

## 可设置的参数（设置页）

| 参数 | 范围 | 默认 |
|---|---|---|
| 串口（COM 口） | 自动枚举，可刷新 | — |
| 监控频率（轮询周期） | 1 ~ 15 秒 | 1 秒 |
| 开机自动启动 | 开 / 关 | 开 |
| Modbus 从站地址 | 1 ~ 247 | 1 |
| 低电量阈值 | 1 ~ 100 % | 20 % |

> 波特率固定为 115200-8-N-1（协议规定），不开放修改。

## 环境要求与运行

- 开发/打包机器：Node.js ≥ 18（建议 20 LTS）、Windows 10
- 运行目标机器：Windows 10 x64

```bash
npm install      # 安装依赖（serialport 为 N-API 预编译，无需编译环境）
npm start        # 开发模式运行
```

## 打包为 Windows 安装包

在 **Windows** 机器上执行：

```bash
npm run dist            # 生成 NSIS 安装包 release\电池状态监控 Setup x.x.x.exe
npm run dist:portable   # 或生成免安装便携版 exe
```

安装包会创建桌面与开始菜单快捷方式。

> 说明：开发模式（npm start）下不会真正写入开机启动项；打包安装后"开机自启"生效。

## 硬件接线注意

协议文档第 2 节写明设备接口为**串口 TTL（3.3V 电平，需 USB-TTL 转接），并非 RS485**。
请确认实际使用的是 USB-TTL 转接器（与设备 PA9/PA10 交叉连接、共地）。
若现场确实是 RS485 硬件，则使用 USB-RS485 转换器即可——对软件而言都是 COM 口，
通讯参数（115200-8N1、Modbus-RTU）完全一致，无需改动软件。

## 配置文件示例

`Documents\BestAutomation\systemMonitor.json`：

```json
{
  "port": "COM3",
  "baudRate": 115200,
  "pollIntervalSec": 1,
  "slaveAddress": 1,
  "autoStart": true,
  "lowBatteryThreshold": 20,
  "lowVoltageWarn": 11.5
}
```

## 协议实现说明

- 每周期发送 `0x03 读保持寄存器`，起始地址 `0x0000`，数量 8，一帧取回全部数据
  （设备 ID、A/B 电压、A/B 状态+电量、固件版本、A/B 原始 ADC）。
- CRC 采用标准 CRC-16/MODBUS（初值 0xFFFF、多项式 0xA001、低字节在前），已通过
  标准测试向量（"123456789" → 0x4B37）验证。
- ⚠ **协议文档第 8 节示例中给出的 CRC 字节（如 19 D7、D8 44）与标准 CRC-16/MODBUS
  计算结果不一致**，疑为文档笔误。本软件按文档第 3 节的算法描述实现标准 CRC，
  与"使用现成 Modbus 库"的建议一致。若实机通讯无应答，请优先核对设备端 CRC 实现。

## 目录结构

```
battery-monitor/
├── package.json            # 依赖与 electron-builder 打包配置
├── src/
│   ├── main/
│   │   ├── main.js         # 主进程：窗口/托盘/自启/IPC
│   │   ├── modbus.js       # Modbus-RTU 客户端（CRC16、组帧、超时）
│   │   ├── monitor.js      # 轮询器：寄存器解析、断连判定
│   │   ├── settings.js     # 设置读写与校验（systemMonitor.json）
│   │   └── trayIcons.js    # 托盘图标选择逻辑
│   ├── preload/preload.js  # contextBridge 受控 API
│   └── renderer/           # 仪表盘 + 设置页（HTML/CSS/JS）
├── assets/
│   ├── icon.ico            # 应用图标
│   └── tray/{16,24,32}/    # 托盘图标组（多尺寸多状态）
└── tools/gen_icons.py      # 图标生成脚本（需 Pillow）
```
