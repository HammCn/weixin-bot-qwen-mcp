import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import * as z from 'zod';
import 'dotenv/config';
import crypto from 'node:crypto';

// ==================== 配置管理 ====================
const CONFIG = {
  // 微信协议配置
  weixin: {
    baseUrl: process.env.WEIXIN_BASE_URL?.trim() || 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: process.env.WEIXIN_CDN_BASE_URL?.trim() || 'https://novac2c.cdn.weixin.qq.com/c2c',
    botType: process.env.WEIXIN_BOT_TYPE?.trim() || '3',
    stateFile: process.env.WEIXIN_STATE_FILE?.trim() || path.resolve('weixin-bot-state.json'),
    routeTag: process.env.WEIXIN_ROUTE_TAG?.trim(),
  },
  // QwenCode 配置
  qwen: {
    path: process.env.QWEN_PATH?.trim() || '/Users/hamm/qwen',
    workspace: process.env.WORKSPACE?.trim() || '/Users/hamm/Desktop',
  },
  // MCP Server 配置
  mcp: {
    port: parseInt(process.env.MCP_PORT || '12580', 10),
  },
};

// 微信协议常量
const CHANNEL_VERSION = '1.0.2';
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const SESSION_EXPIRED_ERRCODE = -14;

const MessageType = { USER: 1, BOT: 2 } as const;
const MessageState = { FINISH: 2 } as const;
const MessageItemType = { TEXT: 1, IMAGE: 2 } as const;
const UploadMediaType = { IMAGE: 1 } as const;
const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

// ==================== 日志工具封装 ====================
const LOG_EMOJIS = {
  info: 'ℹ️',
  success: '✅',
  error: '❌',
  warning: '⚠️',
  debug: '🐛',
  connect: '🔌',
  disconnect: '🔌',
  message: '💬',
  file: '📁',
  server: '🚀',
  session: '🔄',
  auth: '🔐',
  clean: '🧹',
  weixin: '💚',
};

function formatMessage(emoji, prefix, ...args) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return `[${timestamp}] ${emoji} [${prefix}] ${args.join(' ')}`;
}

const logger = {
  info: (...args) => console.log(formatMessage(LOG_EMOJIS.info, '信息', ...args)),
  success: (...args) => console.log(formatMessage(LOG_EMOJIS.success, '成功', ...args)),
  error: (...args) => console.error(formatMessage(LOG_EMOJIS.error, '错误', ...args)),
  warn: (...args) => console.warn(formatMessage(LOG_EMOJIS.warning, '警告', ...args)),
  debug: (...args) => console.log(formatMessage(LOG_EMOJIS.debug, '调试', ...args)),
  connect: (...args) => console.log(formatMessage(LOG_EMOJIS.connect, '连接', ...args)),
  disconnect: (...args) => console.log(formatMessage(LOG_EMOJIS.disconnect, '断开', ...args)),
  message: (...args) => console.log(formatMessage(LOG_EMOJIS.message, '消息', ...args)),
  file: (...args) => console.log(formatMessage(LOG_EMOJIS.file, '文件', ...args)),
  server: (...args) => console.log(formatMessage(LOG_EMOJIS.server, '服务', ...args)),
  session: (...args) => console.log(formatMessage(LOG_EMOJIS.session, '会话', ...args)),
  auth: (...args) => console.log(formatMessage(LOG_EMOJIS.auth, '认证', ...args)),
  clean: (...args) => console.log(formatMessage(LOG_EMOJIS.clean, '清理', ...args)),
  weixin: (...args) => console.log(formatMessage(LOG_EMOJIS.weixin, '微信', ...args)),
};

// ==================== 微信协议客户端 ====================
type WeixinState = {
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  token?: string;
  getUpdatesBuf?: string;
  contextTokens?: Record<string, string>;
};

class WeixinProtocolClient {
  state: WeixinState = { contextTokens: {} };
  baseUrl = CONFIG.weixin.baseUrl;
  cdnBaseUrl = CONFIG.weixin.cdnBaseUrl;
  token = '';
  routeTag = CONFIG.weixin.routeTag;
  stateFile = CONFIG.weixin.stateFile;

  async init(): Promise<void> {
    await this.loadState();
    if (this.state.baseUrl) this.baseUrl = this.state.baseUrl;
    if (this.state.token) this.token = this.state.token;
    this.state.contextTokens ??= {};
    logger.weixin('客户端已初始化', this.token ? '已登录' : '未登录');
  }

  async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      this.state = JSON.parse(raw) as WeixinState;
      this.state.contextTokens ??= {};
    } catch {
      this.state = { contextTokens: {} };
    }
  }

  async saveState(): Promise<void> {
    this.state.baseUrl ||= this.baseUrl;
    this.state.token ||= this.token;
    this.state.contextTokens ??= {};
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  baseInfo() {
    return { channel_version: CHANNEL_VERSION };
  }

  async startQRCodeLogin(botType = CONFIG.weixin.botType): Promise<{ qrcode: string; qrcode_img_content: string }> {
    const url = new URL('/ilink/bot/get_bot_qrcode', this.ensureSlash(this.baseUrl));
    url.searchParams.set('bot_type', botType);
    return this.fetchJson(url, {
      method: 'GET',
      headers: this.routeTag ? { SKRouteTag: this.routeTag } : {},
    });
  }

  async getQRCodeStatus(qrcode: string): Promise<{ status: string; bot_token?: string; ilink_bot_id?: string; baseurl?: string; ilink_user_id?: string }> {
    const url = new URL('/ilink/bot/get_qrcode_status', this.ensureSlash(this.baseUrl));
    url.searchParams.set('qrcode', qrcode);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS);
    try {
      return await this.fetchJson(url, {
        method: 'GET',
        headers: { 'iLink-App-ClientVersion': '1', ...(this.routeTag ? { SKRouteTag: this.routeTag } : {}) },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { status: 'wait' };
      throw error;
    } finally {
      clearTimeout(t);
    }
  }

  async waitQRCodeLogin(qrcode: string, timeoutMs = 8 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getQRCodeStatus(qrcode);
      if (status.status === 'wait') {
        logger.weixin('等待扫码...', qrcode.substring(0, 20));
        await this.sleep(1000);
        continue;
      }
      if (status.status === 'scaned') {
        logger.weixin('二维码已扫码，等待用户确认');
        await this.sleep(1000);
        continue;
      }
      if (status.status === 'expired') {
        logger.weixin('二维码已过期，重新拉取中...');
        const refreshed = await this.startQRCodeLogin();
        logger.weixin(`新二维码：${refreshed.qrcode_img_content}`);
        qrcode = refreshed.qrcode;
        continue;
      }
      if (status.status === 'confirmed') {
        if (!status.bot_token) throw new Error('confirmed but bot_token missing');
        this.token = status.bot_token;
        this.state.token = status.bot_token;
        this.state.accountId = status.ilink_bot_id;
        this.state.userId = status.ilink_user_id;
        if (status.baseurl) {
          this.baseUrl = status.baseurl;
          this.state.baseUrl = status.baseurl;
        }
        await this.saveState();
        logger.weixin('登录成功！', `userId=${status.ilink_user_id}`);
        return;
      }
      throw new Error(`unexpected qr status: ${status.status}`);
    }
    throw new Error('wait qrcode login timeout');
  }

  async pollMessages(callback: (msg: any) => Promise<void>): Promise<void> {
    if (!this.token) throw new Error('WEIXIN_BOT_TOKEN or saved token required');
    let timeoutMs = LONG_POLL_TIMEOUT_MS;
    for (;;) {
      const resp = await this.getUpdates(timeoutMs);
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeoutMs = resp.longpolling_timeout_ms;
      }
      if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
        throw new Error(`session expired (${SESSION_EXPIRED_ERRCODE})`);
      }
      if ((resp.ret ?? 0) !== 0 || (resp.errcode ?? 0) !== 0) {
        throw new Error(`getupdates failed ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
      }
      if (resp.get_updates_buf && resp.get_updates_buf !== this.state.getUpdatesBuf) {
        this.state.getUpdatesBuf = resp.get_updates_buf;
        await this.saveState();
      }
      for (const msg of resp.msgs ?? []) {
        if (msg.from_user_id && msg.context_token) {
          this.state.contextTokens![msg.from_user_id] = msg.context_token;
          await this.saveState();
        }
        await callback(msg);
      }
    }
  }

  async getUpdates(timeoutMs = LONG_POLL_TIMEOUT_MS): Promise<any> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.postJson('/ilink/bot/getupdates', {
        get_updates_buf: this.state.getUpdatesBuf || '',
        base_info: this.baseInfo(),
      }, timeoutMs, controller.signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: this.state.getUpdatesBuf || '' };
      }
      throw error;
    } finally {
      clearTimeout(t);
    }
  }

  async sendText(toUserId: string, text: string): Promise<void> {
    const contextToken = this.requireContextToken(toUserId);
    await this.postJson('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: this.generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      },
      base_info: this.baseInfo(),
    });
  }

  async sendImage(toUserId: string, filePath: string, caption = ''): Promise<void> {
    const contextToken = this.requireContextToken(toUserId);
    const uploaded = await this.uploadImage(toUserId, filePath);
    if (caption) await this.sendText(toUserId, caption);
    await this.postJson('/ilink/bot/sendmessage', {
      msg: {
        to_user_id: toUserId,
        client_id: this.generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: uploaded.aesKey.toString('base64'),
              encrypt_type: 1,
            },
            mid_size: uploaded.cipherSize,
          },
        }],
      },
      base_info: this.baseInfo(),
    });
  }

  async uploadImage(toUserId: string, filePath: string): Promise<any> {
    const plaintext = await fs.readFile(filePath);
    const aesKey = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString('hex');
    const cipherText = this.encryptAesEcb(plaintext, aesKey);
    const { upload_param } = await this.postJson('/ilink/bot/getuploadurl', {
      filekey,
      media_type: UploadMediaType.IMAGE,
      to_user_id: toUserId,
      rawsize: plaintext.length,
      rawfilemd5: crypto.createHash('md5').update(plaintext).digest('hex'),
      filesize: cipherText.length,
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
      base_info: this.baseInfo(),
    });
    if (!upload_param) throw new Error('getuploadurl returned empty upload_param');
    const downloadEncryptedQueryParam = await this.uploadCipherToCDN(upload_param, filekey, cipherText);
    return {
      filekey,
      aesKey,
      plainSize: plaintext.length,
      cipherSize: cipherText.length,
      downloadEncryptedQueryParam,
    };
  }

  async downloadAndDecryptMedia(encryptQueryParam: string, aesKeyBase64OrHex: string): Promise<Buffer> {
    const url = `${this.cdnBaseUrl.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cdn download ${res.status}: ${await res.text()}`);
    const ciphertext = Buffer.from(await res.arrayBuffer());
    const key = this.decodeMediaAESKey(aesKeyBase64OrHex);
    return this.decryptAesEcb(ciphertext, key);
  }

  requireContextToken(toUserId: string): string {
    const token = this.state.contextTokens?.[toUserId];
    if (!token) throw new Error(`missing context_token for ${toUserId}; poll first or edit state file`);
    return token;
  }

  async uploadCipherToCDN(uploadParam: string, filekey: string, cipherText: Buffer): Promise<string> {
    const url = `${this.cdnBaseUrl.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    let lastError: unknown;
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(cipherText),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`cdn upload client error ${res.status}: ${await res.text()}`);
      }
      if (res.status !== 200) {
        lastError = new Error(`cdn upload server error ${res.status}: ${await res.text()}`);
        continue;
      }
      const downloadParam = res.headers.get('x-encrypted-param');
      if (!downloadParam) throw new Error('cdn upload missing x-encrypted-param');
      return downloadParam;
    }
    throw lastError instanceof Error ? lastError : new Error('cdn upload failed after 3 attempts');
  }

  async postJson(endpoint: string, payload: unknown, timeoutMs = API_TIMEOUT_MS, signal?: AbortSignal): Promise<any> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'X-WECHAT-UIN': this.buildRandomWechatUIN(),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.routeTag) headers.SKRouteTag = this.routeTag;

    const controller = signal ? undefined : new AbortController();
    const actualSignal = signal ?? controller!.signal;
    const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${endpoint}`, {
        method: 'POST',
        headers,
        body,
        signal: actualSignal,
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${raw}`);
      return raw ? JSON.parse(raw) : {};
    } finally {
      if (t) clearTimeout(t);
    }
  }

  async fetchJson(url: URL, init: RequestInit): Promise<any> {
    const res = await fetch(url, init);
    const raw = await res.text();
    if (!res.ok) throw new Error(`${url.pathname} ${res.status}: ${raw}`);
    return JSON.parse(raw);
  }

  ensureSlash(v: string): string {
    return v.endsWith('/') ? v : `${v}/`;
  }

  buildRandomWechatUIN(): string {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(n), 'utf8').toString('base64');
  }

  generateClientId(): string {
    return `weixin-bot-${Date.now()}-${crypto.randomUUID()}`;
  }

  encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
  }

  decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  decodeMediaAESKey(value: string): Buffer {
    if (/^[0-9a-fA-F]{32}$/.test(value)) return Buffer.from(value, 'hex');
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`unsupported aes_key encoding; decoded length=${decoded.length}`);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ==================== 全局变量 ====================
const weixinClient = new WeixinProtocolClient();
const transports: Record<string, { transport: StreamableHTTPServerTransport; server: McpServer }> = {};

// ==================== 文件处理业务 ====================
async function validateFile(filePath: string) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  try {
    await fs.access(absolutePath);
    return { success: true, path: absolutePath };
  } catch (error: any) {
    logger.error('文件不存在:', error.message);
    return { success: false, error: error.message, path: absolutePath };
  }
}

function checkFileSize(fileSize: number, maxSize = 50 * 1024 * 1024) {
  if (fileSize > maxSize) {
    return { success: false, error: '文件大小超过限制', fileSize, maxSize };
  }
  return { success: true };
}

async function handleSendFile(filePath: string, userId: string) {
  logger.file('处理文件发送:', filePath);
  const validation = await validateFile(filePath);
  if (!validation.success) {
    return { success: false, message: '文件不存在或无法访问', filePath: validation.path, error: validation.error };
  }
  const stats = await fs.stat(validation.path);
  const fileName = path.basename(validation.path);
  const ext = path.extname(validation.path).toLowerCase();
  const sizeCheck = checkFileSize(stats.size);
  if (!sizeCheck.success) {
    return { success: false, message: sizeCheck.error, fileSize: stats.size, maxFileSize: sizeCheck.maxSize };
  }
  const fileBuffer = await fs.readFile(validation.path);
  try {
    const uploaded = await weixinClient.uploadImage(userId, validation.path);
    await weixinClient.sendImage(userId, validation.path);
    logger.success('文件已发送:', fileName);
    return { success: true, message: '文件上传并发送成功', data: { fileName, filePath: validation.path, fileSize: stats.size, fileType: ext } };
  } catch (error: any) {
    logger.error('文件发送失败:', error.message);
    return { success: false, message: '文件发送失败', error: error.message };
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// ==================== MCP Server 管理 ====================
function createMcpServer() {
  const server = new McpServer(
    { name: 'weixin-bot-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    'sendFileToWeixinBot',
    {
      description: '发送文件到微信，支持各种文件类型。当用户说把文件发给他的时候，会自动调用此工具。',
      inputSchema: {
        path: z.string().describe('要发送的文件路径（绝对路径或相对路径）'),
        userId: z.string().describe('接受文件的微信 ID'),
      },
    },
    async ({ path: filePath, userId }) => {
      try {
        const result = await handleSendFile(filePath, userId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } catch (error: any) {
        logger.error('工具调用失败:', error);
        throw error;
      }
    },
  );
  return server;
}

function createSessionTransport() {
  const mcpServer = createMcpServer();
  const sessionId = randomUUID();
  const transportInstance = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      logger.session('新建:', sid);
      transports[sid] = { transport: transportInstance, server: mcpServer };
    },
  });
  transportInstance.onclose = () => {
    const sid = transportInstance.sessionId;
    if (sid && transports[sid]) {
      closeSession(sid);
    }
  };
  mcpServer.connect(transportInstance);
  logger.connect('MCP 连接已建立');
  return { transport: transportInstance, server: mcpServer, sessionId };
}

function closeSession(sessionId: string) {
  if (!transports[sessionId]) return;
  logger.session('关闭:', sessionId);
  const { server, transport } = transports[sessionId];
  delete transports[sessionId];
  transport.onclose = null;
  server.close().catch((err) => {
    logger.error('关闭 server 失败:', sessionId, err);
  });
}

async function closeAllSessions() {
  const sessionIds = Object.keys(transports);
  if (sessionIds.length === 0) return;
  logger.server('发现', sessionIds.length, '个活跃会话');
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        closeSession(sessionId);
      } catch (error: any) {
        logger.error('关闭会话失败:', sessionId, error);
      }
    }),
  );
  logger.server('所有会话已关闭');
}

// ==================== HTTP 请求处理 ====================
const serverRequestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
    }
    if (body) {
      try {
        req.body = JSON.parse(body);
      } catch {
        req.body = {};
      }
    } else {
      req.body = {};
    }
    const sessionId = req.headers['mcp-session-id']?.toString();
    let session;
    if (sessionId && transports[sessionId]) {
      session = transports[sessionId];
    } else {
      session = createSessionTransport();
      res.setHeader('mcp-session-id', session.sessionId);
    }
    await session.transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    logger.error('请求失败:', error.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: error.message || 'Internal server error' },
          id: null,
        }),
      );
    }
  }
};

// ==================== 消息处理业务 ====================
async function handleCommandMessage(content: string, fromUserId: string) {
  if (content === '/clear') {
    const clearPath = CONFIG.qwen.path + '/projects/' + CONFIG.qwen.workspace.replaceAll('/.', '--').replaceAll('/', '-');
    try {
      await fs.rmdir(clearPath, { recursive: true });
      logger.clean('已完成:', clearPath);
    } catch (error: any) {
      logger.error('清理失败:', error);
    } finally {
      await weixinClient.sendText(fromUserId, '会话已重置');
    }
    return true;
  }
  return false;
}

function executeQwenCommand(content: string, fromUserId: string) {
  let responseText = '';
  content = `[全局参数：微信 ID=${fromUserId}] ${content}`;
  logger.message('执行 Qwen 命令:', content);

  const child = spawn('sh', ['-c', `cd ${CONFIG.qwen.workspace} && qwen --continue -y -p "$1"`, '_', content], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    responseText += text;
    weixinClient.sendText(fromUserId, text).catch((err) => logger.error('发送消息失败:', err));
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    weixinClient.sendText(fromUserId, `执行错误：${text}`).catch((err) => logger.error('发送错误消息失败:', err));
  });

  child.on('close', () => {
    logger.success('命令执行完成');
  });
}

async function handleTextMessage(msg: any) {
  const fromUserId = msg.from_user_id;
  const text = msg.item_list?.find((item: any) => item.type === MessageItemType.TEXT)?.text_item?.text || '';
  logger.message('收到文本消息:', fromUserId, text.substring(0, 50));

  const isCommand = await handleCommandMessage(text, fromUserId);
  if (!isCommand) {
    executeQwenCommand(text, fromUserId);
  }
}

async function handleImageMessage(msg: any) {
  const fromUserId = msg.from_user_id;
  const imageItem = msg.item_list?.find((item: any) => item.type === MessageItemType.IMAGE);
  if (!imageItem) return;

  const media = imageItem.image_item?.media;
  if (!media) return;

  logger.message('收到图片消息:', fromUserId);
  try {
    const buffer = await weixinClient.downloadAndDecryptMedia(media.encrypt_query_param!, media.aes_key!);
    const filename = `image_${Date.now()}.jpg`;
    const savePath = path.join(CONFIG.qwen.workspace, filename);
    await fs.writeFile(savePath, buffer);
    executeQwenCommand(`@${savePath} 我保存了这张图片，稍后可能会让你协助处理它`, fromUserId);
  } catch (error: any) {
    logger.error('下载图片失败:', error.message);
  }
}

async function handleEnterChat(fromUserId: string) {
  await weixinClient.sendText(fromUserId, '你好，我是 Mac 智能助手，有什么可以帮你的吗？');
}

// ==================== 服务关闭管理 ====================
async function gracefulShutdown() {
  logger.info('正在关闭...');
  try {
    await closeAllSessions();
    await closeAllSessions();
    httpServer.close(() => {
      logger.server('已关闭');
      process.exit(0);
    });
    setTimeout(() => {
      logger.server('强制退出');
      process.exit(0);
    }, 5000);
  } catch (error: any) {
    logger.error('关闭失败:', error);
    process.exit(1);
  }
}

// ==================== 服务启动 ====================
const httpServer = http.createServer(serverRequestHandler);
const PORT = CONFIG.mcp.port;

async function startWeixinPolling() {
  try {
    await weixinClient.init();
    if (!weixinClient.token) {
      logger.weixin('未登录，开始二维码登录流程...');
      const qr = await weixinClient.startQRCodeLogin();
      logger.weixin(`请扫描二维码：${qr.qrcode_img_content}`);
      await weixinClient.waitQRCodeLogin(qr.qrcode);
    }
    logger.weixin('开始轮询消息...');
    await weixinClient.pollMessages(async (msg) => {
      const fromUserId = msg.from_user_id;
      const text = msg.item_list?.find((item: any) => item.type === MessageItemType.TEXT)?.text_item?.text || '';
      const hasImage = msg.item_list?.some((item: any) => item.type === MessageItemType.IMAGE);

      if (text) {
        await handleTextMessage(msg);
      }
      if (hasImage) {
        await handleImageMessage(msg);
      }
    });
  } catch (error: any) {
    logger.error('微信轮询错误:', error.message);
    setTimeout(startWeixinPolling, 5000);
  }
}

httpServer.listen(PORT, async () => {
  logger.server('已启动', `端口：${PORT}`);
  startWeixinPolling().catch((err) => logger.error('启动失败:', err));
});

process.on('SIGINT', gracefulShutdown);
