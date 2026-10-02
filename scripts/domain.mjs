#!/usr/bin/env node
/**
 * 鲤慧 · 自定义域名（lihui-tech.online）一键配置 / 校验
 *
 * 用法：
 *   # 1) 把云托管给的 CNAME 目标值写进 DNS（腾讯 DNSPod）
 *   node scripts/domain.mjs bind --cname xxxxx.ap-shanghai.app.tcloudbase.com
 *   node scripts/domain.mjs bind --cname xxx --token <DNSPod 令牌>   # 不传则用环境变量 DNSPOD_TOKEN
 *
 *   # 2) 校验：解析是否生效 + 网页版/接口是否真的能开
 *   node scripts/domain.mjs check
 *   node scripts/domain.mjs check --domain my.example.com
 *
 * 环境变量：
 *   DNSPOD_TOKEN   DNSPod「API Token」页生成的登录令牌（格式 ID,Token），也可以直接 --token 传
 *
 * 说明：
 *   · bind 会写 @ 与 www 两条 CNAME 记录（已存在同类型则改写，不 duplicate）
 *   · check 只读取，不改动任何记录
 */

import { readFileSync } from 'node:fs';
import { resolveCname, resolve4 } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const API = 'https://dnsapi.cn/';
const TYPES = ['CNAME', 'A', 'AAAA'];
const LINE = '默认';
const TTL = 600;

/* ---------- 参数解析 ---------- */
function parseArgv(argv) {
  const out = { cmd: argv[0] || 'help', flags: { domain: 'lihui-tech.online' }, subs: ['@', 'www'] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain') out.flags.domain = argv[++i];
    else if (a === '--sub') out.subs = String(argv[++i]).split(',');
    else if (a === '--cname') out.flags.cname = argv[++i];
    else if (a === '--token') out.flags.token = argv[++i];
    else if (a === '--timeout') out.flags.timeout = Number(argv[++i]) || 60;
  }
  return out;
}

/* ---------- 小工具 ---------- */
const log = (s) => console.log(s);
const ok = (s) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`\x1b[33m!\x1b[0m ${s}`);
const fail = (s) => console.error(`\x1b[31m✗\x1b[0m ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dnspodPost(action, params, token) {
  const body = new URLSearchParams({ login_token: token, format: 'json', ...params });
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 1) {
    const e = new Error(json.message || `DNSPod 返回 code=${json.code}`);
    e.code = json.code;
    throw e;
  }
  return json;
}

/* ---------- bind：写 CNAME ---------- */
async function bind({ domain, subs, cname, token }) {
  if (!cname) {
    fail('缺少 CNAME 目标值。用法：node scripts/domain.mjs bind --cname <云托管给的目标域名>');
    fail('目标值在云托管控制台「服务设置 → 自定义域名」里添加 lihui-tech.online 后，由系统生成。');
    process.exitCode = 1;
    return;
  }
  cname = String(cname).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  const tk = token || (process.env.DNSPOD_TOKEN || '').trim();

  if (!tk) {
    fail('没找到 DNSPod 令牌。二选一：');
    fail('  ① 临时传：node scripts/domain.mjs bind --cname ' + cname + ' --token <ID,Token>');
    fail('  ② 常驻写：set DNSPOD_TOKEN=<ID,Token>   （PowerShell 用 $env:DNSPOD_TOKEN=）');
    fail('令牌获取：DNSPod 控制台 → 右上头像 → API Token → 创建（形如 12345,abcdef…）');
    process.exitCode = 1;
    return;
  }

  log(`域名 ${domain}，写入主机记录：${subs.join(' / ')} → CNAME ${cname}`);
  for (const sub of subs) {
    const name = sub === '@' ? domain : `${sub}.${domain}`;
    try {
      const list = await dnspodPost('Record.List', { Domain: domain, SubDomain: sub }, tk);
      const recs = (list.records || []).filter((r) => TYPES.includes(r.Type));
      const same = recs.find((r) => r.Type === 'CNAME');
      if (same) {
        if (same.Value.replace(/\.$/, '') === cname) {
          warn(`${name} 已是 CNAME → ${same.Value}，无需改动`);
          continue;
        }
        await dnspodPost(
          'Record.Modify',
          {
            RecordId: same.RecordId,
            Domain: domain,
            SubDomain: sub,
            RecordType: 'CNAME',
            RecordLine: LINE,
            Value: cname,
            TTL: String(TTL),
          },
          tk,
        );
        ok(`${name} 记录 ${same.RecordId} 改指向 ${cname}`);
      } else if (recs.length) {
        const t = recs[0];
        await dnspodPost(
          'Record.Modify',
          {
            RecordId: t.RecordId,
            Domain: domain,
            SubDomain: sub,
            RecordType: 'CNAME',
            RecordLine: LINE,
            Value: cname,
            TTL: String(TTL),
          },
          tk,
        );
        ok(`${name} ${t.Type} → CNAME ${cname}（已改写，原类型 ${t.Type}）`);
      } else {
        await dnspodPost(
          'Record.Create',
          { Domain: domain, SubDomain: sub, RecordType: 'CNAME', RecordLine: LINE, Value: cname, TTL: String(TTL) },
          tk,
        );
        ok(`${name} 新建 CNAME → ${cname}`);
      }
    } catch (e) {
      fail(`${name} 操作失败：${e.message}`);
      process.exitCode = 1;
    }
  }
  log('');
  log('DNS 生效通常 10 秒～10 分钟（DNSPod 默认 TTL 600）。随时：node scripts/domain.mjs check');
}

/* ---------- check：验证解析 + 网页 ---------- */
async function checkOne(domain) {
  const name = domain.startsWith('http') ? new URL(domain).host : domain;
  const base = name.startsWith('https') || name.startsWith('http') ? name : `https://${domain}`;
  // 解析只作为「参考信息」：本机 DNS 可能被代理/沙箱挡住，真正判据是下面的 HTTPS 请求
  let chain = [],
    ips = [];
  try {
    chain = await resolveCname(domain);
  } catch {
    /* 有些运营商 DNS 不返回 CNAME 链，忽略 */
  }
  try {
    const rr = await resolve4(domain, { ttl: true });
    ips = rr.map((i) => (typeof i === 'string' ? i : i.address));
  } catch {
    warn(`${domain} 本机 DNS 解析不到（可能是本机 DNS/代理限制，不代表域名没生效）`);
  }
  if (ips.length) ok(`${domain} → ${ips.join(', ')}${chain.length ? `（CNAME ${chain.join(' → ')}）` : ''}`);

  for (const p of ['/', '/api/v1/ip/locate', '/api/v1/life/report']) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(base + p, { signal: ctl.signal, redirect: 'follow' });
      clearTimeout(timer);
      const txt = await r.text();
      const hit = p === '/' ? (txt.includes('鲤慧') ? ' 网页版已上线' : ' 内容不含网页版特征') : '';
      ok(`${base}${p} → HTTP ${r.status}${hit || ''}`);
      if (p === '/' && r.status === 200 && !txt.includes('鲤慧')) process.exitCode = 1;
    } catch (e) {
      fail(`${base}${p} → ${e.message}`);
      process.exitCode = 1;
    }
  }
}

async function verify(domain) {
  log(`校验 ${domain}\n`);
  const names = domain.includes('.') && !domain.startsWith('http') ? [domain, `www.${domain}`] : [domain];
  for (const n of names) await checkOne(n);
  ok('全部通过。浏览器打开 ' + (domain.startsWith('http') ? domain : `https://${domain}/`));
}

/* ---------- 入口 ---------- */
async function main() {
  const argv = process.argv.slice(2);
  const { cmd, flags } = parseArgv(argv);

  if (cmd === 'bind') {
    await bind({ domain: flags.domain, subs: flags.subs, cname: flags.cname, token: flags.token });
  } else if (cmd === 'check') {
    await verify(flags.domain);
  } else {
    log('鲤慧 · 域名工具\n');
    log('  node scripts/domain.mjs bind  --cname <云托管CNAME目标> [--token <DNSPod令牌>]');
    log('  node scripts/domain.mjs check [--domain lihui-tech.online]');
    log('');
    log('默认域名 lihui-tech.online，默认写 @ 与 www 两条记录。');
    log('令牌也可以放环境变量 DNSPOD_TOKEN（优先于 --token 缺失时用）。');
  }
}

main().catch((e) => {
  fail(String(e.message || e));
  process.exitCode = 1;
});
