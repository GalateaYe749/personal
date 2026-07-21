#!/usr/bin/env node
/**
 * Avalon Security Monitor
 * 每 5 分钟运行一次，检查 auth.log  中的攻击行为并自动防御
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = resolve(__dirname, 'auth.log');
const BAN_LOG = '/tmp/avalon-bans.log';

// 防御动作
function ban(ip, reason) {
  const cmd = `iptables -A INPUT -s ${ip} -j DROP 2>/dev/null || ufw deny from ${ip} 2>/dev/null || echo "no firewall"`;
  try {
    execSync(cmd, { timeout: 5000 });
    const msg = `[${new Date().toISOString()}] BANNED ${ip} | ${reason}`;
    appendFileSync(BAN_LOG, msg + '\n');
    console.log('🚫', msg);
  } catch (e) {
    console.log('⚠️  Ban failed (no firewall):', ip);
  }
}

function readLog() {
  try {
    const raw = readFileSync(LOG_FILE, 'utf-8');
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// 分析日志 & 防御
function analyze() {
  const lines = readLog();
  if (lines.length === 0) {
    console.log('✅ No auth log entries');
    return;
  }

  // 统计每个 IP 的失败次数（最近 1 小时内）
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  const ipFails = new Map();

  for (const line of lines) {
    // 格式: [ISO] IP | USER | ACTION | DETAIL
    const match = line.match(/^\[(.+?)\]\s+(\S+)\s+\|\s+(\S+)\s+\|\s+(\S+)/);
    if (!match) continue;

    const ts = new Date(match[1]).getTime();
    if (ts < oneHourAgo) continue; // 只看最近 1 小时

    const ip = match[2];
    const action = match[4];

    if (action === 'LOGIN_FAIL' || action === 'LOGIN_FAIL_GET') {
      ipFails.set(ip, (ipFails.get(ip) || 0) + 1);
    }
  }

  // 封禁策略
  for (const [ip, count] of ipFails) {
    if (count >= 10) {
      ban(ip, `${count} failed logins in 1h`);
    } else if (count >= 5) {
      console.log(`⚠️  Suspicious: ${ip} (${count} fails)`);
    }
  }

  // 清理 7 天前的日志
  const sevenDaysAgo = now - 7 * 86400000;
  const recent = lines.filter(line => {
    const m = line.match(/^\[(.+?)\]/);
    return m && new Date(m[1]).getTime() > sevenDaysAgo;
  });
  if (recent.length < lines.length) {
    try {
      appendFileSync(LOG_FILE, ''); // 截断
      for (const line of recent) appendFileSync(LOG_FILE, line + '\n');
      console.log('🧹 Cleaned old log entries');
    } catch {}
  }

  console.log(`📊 Monitored: ${ipFails.size} active IPs, ${lines.length} total entries`);
}

analyze();
