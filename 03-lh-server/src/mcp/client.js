/**
 * 鲤慧 LiHui · MCP Client（Agent 侧）
 * 实现 Model Context Protocol 的客户端最小可用集：
 *   initialize → notifications/initialized → tools/list → tools/call
 * 传输：stdio（换行分隔 JSON-RPC 2.0）
 */
const { spawn } = require('child_process');
const logger = require('../utils/logger');

class McpClient {
  /**
   * @param {object} opt { id, name, command, args, env, cwd }
   */
  constructor(opt) {
    this.id = opt.id;
    this.name = opt.name || opt.id;
    this.command = opt.command;
    this.args = opt.args || [];
    this.env = opt.env || {};
    this.cwd = opt.cwd;

    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.seq = 0;
    this.tools = [];
    this.serverInfo = null;
    this.status = 'stopped'; // stopped | starting | running | error
    this.error = '';
    this.restarts = 0;
    this.maxRestart = 3;
  }

  async start() {
    if (this.proc) return this;
    this.status = 'starting';
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.proc = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env, MCP_TRANSPORT: 'stdio' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: process.platform === 'win32',
        });
      } catch (e) {
        this.status = 'error';
        this.error = e.message;
        return reject(e);
      }

      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onData(chunk));
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (d) => logger.debug('mcp:' + this.id, String(d).trim()));

      this.proc.on('error', (e) => {
        this.status = 'error';
        this.error = e.message;
        logger.error('mcp:' + this.id, `spawn error ${e.message}`);
        if (!settled) {
          settled = true;
          reject(e);
        }
      });

      this.proc.on('exit', (code, signal) => {
        this.status = 'stopped';
        this.proc = null;
        for (const [, p] of this.pending) p.reject(new Error('mcp server exited'));
        this.pending.clear();
        logger.warn('mcp:' + this.id, `exited code=${code} signal=${signal}`);
        if (this._autostart && this.restarts < this.maxRestart) {
          this.restarts += 1;
          setTimeout(() => this.start().catch(() => {}), 800);
        }
      });

      // 握手
      this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: { name: 'lihui-agent', version: '1.0.0' },
      })
        .then(async (res) => {
          this.serverInfo = (res && res.serverInfo) || {};
          this._notify('notifications/initialized', {});
          const list = await this._request('tools/list', {});
          this.tools = (list && list.tools) || [];
          this.status = 'running';
          this.error = '';
          logger.info('mcp:' + this.id, `ready, ${this.tools.length} tools`);
          settled = true;
          resolve(this);
        })
        .catch((e) => {
          this.status = 'error';
          this.error = e.message;
          logger.error('mcp:' + this.id, `handshake failed: ${e.message}`);
          settled = true;
          reject(e);
        });
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue; // 非 JSON 行直接忽略（部分 SDK 会打印日志）
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'mcp error'));
        else p.resolve(msg.result);
      }
    }
  }

  _send(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('mcp server not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _request(method, params, timeout = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp timeout: ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _notify(method, params) {
    try {
      this._send({ jsonrpc: '2.0', method, params });
    } catch (_) {}
  }

  /** 调用工具 */
  async call(tool, args = {}, timeout = 60000) {
    if (this.status !== 'running') await this.start();
    const res = await this._request('tools/call', { name: tool, arguments: args }, timeout);
    const content = (res && res.content) || [];
    const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
    let data = null;
    const joined = textParts.join('\n');
    try {
      data = joined ? JSON.parse(joined) : null;
    } catch (_) {
      data = { text: joined };
    }
    return { isError: !!(res && res.isError), content, data, raw: res };
  }

  async stop() {
    this._autostart = false;
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch (_) {}
    this.proc = null;
    this.status = 'stopped';
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      transport: 'stdio',
      command: this.command,
      args: this.args,
      status: this.status,
      error: this.error,
      serverInfo: this.serverInfo,
      tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    };
  }
}

module.exports = { McpClient };
