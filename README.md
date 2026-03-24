# 微信机器人 + QwenCode + MCP Server

使用 `Qwen-Code` 和微信对接的智能助手服务。

## 🎉 企业微信

如需企业微信的版本，看这里 https://github.com/HammCn/WecomBot-QwenCode

## 📋 功能特性

- 💚 微信消息接收（文本、图片）
- 🤖 QwenCode 命令执行
- 🔌 MCP Server 支持
- 📁 文件发送工具
- 🔄 会话管理
- 📝 状态持久化

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并修改配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 微信协议配置（一般无需修改）
WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
WEIXIN_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
WEIXIN_BOT_TYPE=3
WEIXIN_STATE_FILE=./weixin-bot-state.json

# QwenCode 配置（根据实际路径修改）
QWEN_PATH=/Users/hamm/qwen
WORKSPACE=/Users/hamm/Desktop

# MCP Server 配置
MCP_PORT=12580
```

### 3. 启动服务

```bash
npm start
```

### 4. 微信登录

服务启动后会自动显示二维码：

1. 终端会输出二维码 URL
2. 使用微信扫描二维码
3. 确认登录
4. 登录成功后状态会保存到 `weixin-bot-state.json`

### 5. 使用方式

在微信中发送消息给机器人：

- **文本消息**：直接发送文本，机器人会调用 QwenCode 执行
- **图片消息**：发送图片，机器人会保存并调用 QwenCode 处理
- **命令**：发送 `/clear` 清理会话缓存

## 🔧 MCP 工具

### sendFileToWeixinBot

发送文件到微信用户。

**参数**：
- `path`: 文件路径（绝对路径或相对路径）
- `userId`: 接收文件的微信 ID

**示例**：
```javascript
// 在 MCP 客户端中调用
{
  "name": "sendFileToWeixinBot",
  "arguments": {
    "path": "/path/to/file.pdf",
    "userId": "wx_user_id"
  }
}
```

## 📊 架构说明

```
微信消息 → 微信协议客户端 → 消息类型判断 → 对应处理器
                                       │
                                       ├── 文本 → executeQwenCommand
                                       └── 图片 → 保存 → executeQwenCommand

MCP 请求 → HTTP Server → 会话管理 → MCP Server → 工具调用
                                          │
                                          └── sendFileToWeixinBot → 发送文件到微信
```

## 🔐 状态管理

登录状态保存在 `weixin-bot-state.json`：

```json
{
  "accountId": "机器人 ID",
  "userId": "用户 ID",
  "baseUrl": "API 基础 URL",
  "token": "认证 Token",
  "getUpdatesBuf": "轮询缓冲",
  "contextTokens": {
    "微信 ID": "上下文 Token"
  }
}
```

## ⚙️ 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `WEIXIN_BASE_URL` | 微信 API 基础 URL | `https://ilinkai.weixin.qq.com` |
| `WEIXIN_CDN_BASE_URL` | 微信 CDN 基础 URL | `https://novac2c.cdn.weixin.qq.com/c2c` |
| `WEIXIN_BOT_TYPE` | 机器人类型 | `3` |
| `WEIXIN_STATE_FILE` | 状态文件路径 | `./weixin-bot-state.json` |
| `WEIXIN_ROUTE_TAG` | 路由标签（可选） | - |
| `QWEN_PATH` | QwenCode 安装路径 | `/Users/hamm/qwen` |
| `WORKSPACE` | 工作目录 | `/Users/hamm/Desktop` |
| `MCP_PORT` | MCP 服务端口 | `12580` |

## 📝 与原项目对比

| 功能 | 原项目（企业微信） | 新项目（微信） |
|------|------------------|---------------|
| 消息协议 | 企业微信 SDK | 微信 iLink 协议 |
| 登录方式 | Bot ID + Secret | 二维码扫码 |
| 消息类型 | 文本、图片、文件、视频、语音 | 文本、图片 |
| 文件发送 | WebSocket 上传 | CDN 上传 |
| 加密方式 | - | AES-128-ECB |
| 状态存储 | 内存 | JSON 文件 |

## 🐛 故障排查

### 二维码不显示

检查网络是否正常，确认能访问 `ilinkai.weixin.qq.com`

### 登录状态丢失

检查 `weixin-bot-state.json` 是否存在且可写

### 消息不响应

1. 检查 token 是否有效
2. 检查 context_token 是否已获取
3. 查看日志输出

### MCP 连接失败

1. 确认端口 12580 未被占用
2. 检查防火墙设置
3. 查看 HTTP 服务器日志

## 📄 License

MIT
