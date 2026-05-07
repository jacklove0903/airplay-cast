# AirPlay Cast

将 iOS 设备的 AirPlay 屏幕镜像实时投屏到 Windows 浏览器中观看。

## 工作原理

```
iPhone (AirPlay) → RTSP/RTP → Server (解密+解码) → WebRTC → 浏览器
```

1. 服务器通过 mDNS 广播 AirPlay 服务，iOS 设备发现后建立 RTSP 连接
2. 接收 RTP 视频流（H.264），使用 AES-128-CTR 解密
3. 提取 NAL 单元，通过 WebRTC 实时推送到浏览器播放

## 环境要求

- Node.js >= 18
- Windows 系统
- iOS 设备（iPhone/iPad）与 Windows 在同一局域网

## 安装

```bash
git clone <repo-url>
cd airplay-cast
npm install
```

## 运行

### 开发模式

分别启动后端和前端：

```bash
# 终端 1：启动后端（RTSP + WebSocket + WebRTC）
npm run dev:server

# 终端 2：启动前端开发服务器
npm run dev:client
```

### 生产模式

```bash
npm run build
npm start
```

服务器默认运行在 `http://localhost:3000`。

## 使用方法

1. 启动服务器后，在 Windows 浏览器打开 `http://localhost:3000`
2. 确保 iOS 设备与 Windows 在同一 WiFi 网络
3. 在 iPhone 上打开控制中心 → 屏幕镜像 → 选择 "AirPlay Cast"
4. 浏览器中即可看到投屏画面，双击视频可切换全屏

## 项目结构

```
server/
  index.ts      # 入口，Express + WebSocket 信令
  rtsp.ts       # RTSP 协议实现，RTP 解析，H.264 NAL 提取
  mdns.ts       # mDNS 服务广播（模拟 AppleTV）
  webrtc.ts     # WebRTC 桥接，NAL → RTP 转发

client/
  src/
    App.tsx      # 主组件，WebSocket 状态管理
    Player.tsx   # 视频播放器，WebRTC 接收端
    main.tsx     # React 入口
    index.css    # 样式
```

## 端口说明

| 端口 | 用途 |
|------|------|
| 3000 | HTTP 服务（浏览器访问） |
| 7100 | RTSP 控制连接（AirPlay） |
| 7101 | 视频 RTP 数据 |
| 7102 | 音频 RTP 数据 |

## 技术栈

- **后端**: Node.js, TypeScript, Express, WebSocket (ws), werift (WebRTC)
- **前端**: React 19, TypeScript, Vite
- **协议**: RTSP, RTP, WebRTC, mDNS/DNS-SD

## 注意事项

- 防火墙需允许 3000、7100-7102 端口的入站连接
- 目前为 MVP 阶段，仅支持视频投屏，音频暂未完整实现
- 仅支持 AirPlay 1 协议
