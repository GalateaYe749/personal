import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import fs from 'node:fs';
import { createHash, randomUUID, pbkdf2Sync, randomBytes } from 'node:crypto';

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const app = express();
const PORT = 3456;

// ═══════════════════════════════════════════
//  config
// ═══════════════════════════════════════════

const CONFIG = {
  
  PBKDF2_ITERATIONS: 600000,
  PBKDF2_KEYLEN: 64,
  PBKDF2_DIGEST: 'sha512',
  // 速率限制
  RATE_WINDOW_MS: 60000,
  RATE_MAX_PER_WINDOW: 5,
  RATE_BAN_THRESHOLD: 15,
  RATE_BAN_DURATION_MS: 3600000,
  // Session
  SESSION_MAX_AGE_MS: 8 * 60 * 60 * 1000,
};

// ═══════════════════════════════════════════
//
// ═══════════════════════════════════════════

function hashPassword(password) {
  const salt = randomBytes(32).toString('hex');
  const hash = pbkdf2Sync(password, salt, CONFIG.PBKDF2_ITERATIONS, CONFIG.PBKDF2_KEYLEN, CONFIG.PBKDF2_DIGEST).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = stored.split(':');
  const hash = pbkdf2Sync(password, salt, CONFIG.PBKDF2_ITERATIONS, CONFIG.PBKDF2_KEYLEN, CONFIG.PBKDF2_DIGEST).toString('hex');

  if (hash.length !== originalHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ originalHash.charCodeAt(i);
  return diff === 0;
}

const PASSWORDS = {
  'Avalon': hashPassword('Avalon'),
  'EasonQian': hashPassword('EasonQian'),
};

//

// ═══════════════════════════════════════════
//
// ═══════════════════════════════════════════

const LOG_FILE = resolve(__dirname, 'auth.log');

function logAuth(ip, user, action, detail = '') {
  const line = `[${new Date().toISOString()}] ${ip} | ${user} | ${action} | ${detail}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
}

const _rateStore = new Map();
const _banStore = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  if (_banStore.has(ip)) {
    const banUntil = _banStore.get(ip);
    if (Date.now() < banUntil) {
      logAuth(ip, '-', 'BLOCKED', `banned until ${new Date(banUntil).toISOString()}`);
      return res.status(429).json({
        error: 'temporarily blocked',
        retryAfter: Math.ceil((banUntil - Date.now()) / 1000)
      });
    }
    _banStore.delete(ip);
  }

  // 统计窗口内的尝试
  const now = Date.now();
  if (!_rateStore.has(ip)) _rateStore.set(ip, []);
  const attempts = _rateStore.get(ip).filter(t => now - t < CONFIG.RATE_WINDOW_MS);
  attempts.push(now);
  _rateStore.set(ip, attempts);

  if (attempts.length > CONFIG.RATE_BAN_THRESHOLD) {
    // 超过阈值 → 封 IP
    _banStore.set(ip, now + CONFIG.RATE_BAN_DURATION_MS);
    _rateStore.delete(ip);
    logAuth(ip, '-', 'BANNED', `${attempts.length} attempts`);
    return res.status(429).json({
      error: 'ip banned for 1 hour',
      retryAfter: CONFIG.RATE_BAN_DURATION_MS / 1000
    });
  }

  if (attempts.length > CONFIG.RATE_MAX_PER_WINDOW) {
    logAuth(ip, '-', 'RATE_LIMITED', `${attempts.length} in window`);
    return res.status(429).json({
      error: 'too many requests',
      retryAfter: Math.ceil(CONFIG.RATE_WINDOW_MS / 1000)
    });
  }

  next();
}

// 周期性清理
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of _rateStore) {
    const valid = attempts.filter(t => now - t < CONFIG.RATE_WINDOW_MS * 2);
    if (valid.length === 0) _rateStore.delete(ip); else _rateStore.set(ip, valid);
  }
  for (const [ip, until] of _banStore) {
    if (now >= until) _banStore.delete(ip);
  }
}, 300000); // 每 5 分钟

// ═══════════════════════════════════════════
//
// ═══════════════════════════════════════════

const CSRF_TOKENS = new Map();

function generateCsrf(req) {
  const token = randomUUID();
  CSRF_TOKENS.set(token, Date.now());
  req.session.csrf = token;
  return token;
}

function verifyCsrf(req, res, next) {
  // 只对 POST/PUT/DELETE 检查
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  if (!token || !CSRF_TOKENS.has(token)) {
    return res.status(403).json({ error: 'invalid csrf' });
  }
  // 一次性 token
  CSRF_TOKENS.delete(token);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, ts] of CSRF_TOKENS) {
    if (now - ts > 3600000) CSRF_TOKENS.delete(token);
  }
}, 600000);

// ═══════════════════════════════════════════
//  中间件
// ═══════════════════════════════════════════

//
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// limit
app.use(express.json({ limit: '1kb' }));
app.use(express.urlencoded({ extended: true, limit: '1kb' }));

// session
app.use(session({
  secret: 'avalon-garden-' + randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  name: 'avalon_sid',       // 非默认 session ID
  cookie: {
    httpOnly: true,          // JS 不可读
    secure: false,           // 如用 HTTPS 改为 true
    sameSite: 'lax',
    maxAge: CONFIG.SESSION_MAX_AGE_MS,
  }
}));

// CSRF 中间件
app.use(verifyCsrf);

// ═══════════════════════════════════════════
//  API 路由
// ═══════════════════════════════════════════

//
app.get('/api/csrf', (req, res) => {
  res.json({ csrf: generateCsrf(req) });
});


app.post('/api/login', rateLimit, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length > 100) {
    return res.status(400).json({ error: 'invalid request' });
  }

  let zone = null;
  let matchedUser = null;

  //
  for (const [user, stored] of Object.entries(PASSWORDS)) {
    if (verifyPassword(password, stored)) {
      zone = user === 'Avalon' ? 'galatea' : 'eason';
      matchedUser = user;
      break;
    }
  }

  if (zone) {
    req.session.auth = zone;
    logAuth(req.ip, matchedUser, 'LOGIN_OK');
    return res.json({ ok: true, zone, csrf: generateCsrf(req) });
  }

  logAuth(req.ip, '-', 'LOGIN_FAIL');
  // 随机延迟，防止时序攻击
  const delay = 100 + Math.random() * 200;
  setTimeout(() => {
    res.status(403).json({ error: 'invalid key' });
  }, delay);
});


app.get('/login', rateLimit, (req, res) => {
  const { key } = req.query;
  if (!key || key.length > 100) return res.redirect('/?err=1');

  let zone = null;
  for (const [user, stored] of Object.entries(PASSWORDS)) {
    if (verifyPassword(key, stored)) {
      zone = user === 'Avalon' ? 'galatea' : 'eason';
      logAuth(req.ip, user, 'LOGIN_OK_GET');
      break;
    }
  }

  if (zone) {
    req.session.auth = zone;
    return res.redirect('/private/' + zone + '/?from=gh');
  }
  logAuth(req.ip, '-', 'LOGIN_FAIL_GET');
  res.redirect('/?err=1');
});

//
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

//
app.get('/api/auth', (req, res) => {
  if (req.session?.auth) return res.json({ authed: true, zone: req.session.auth });
  res.json({ authed: false });
});

// ═══════════════════════════════════════════
//  Notes 存储
// ═══════════════════════════════════════════


const NOTES_DIR = resolve(__dirname, 'notes');
if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });

app.post('/api/notes', (req, res) => {
  if (!req.session?.auth) return res.status(401).json({ error: 'unauthorized' });
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'invalid' });
  if (content.length > 100000) return res.status(400).json({ error: 'too large' });
  const file = resolve(NOTES_DIR, req.session.auth + '.txt');
  if (!file.startsWith(NOTES_DIR)) return res.status(403).json({ error: 'invalid' });
  try {
    fs.writeFileSync(file, content, 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'write failed' });
  }
});

app.get('/api/notes', (req, res) => {
  if (!req.session?.auth) return res.status(401).json({ error: 'unauthorized' });
  const file = resolve(NOTES_DIR, req.session.auth + '.txt');
  if (!file.startsWith(NOTES_DIR)) return res.status(403).json({ error: 'invalid' });
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf-8');
      return res.json({ content });
    }
    res.json({ content: '' });
  } catch (e) {
    res.status(500).json({ error: 'read failed' });
  }
});

// ═══════════════════════════════════════════
//  受保护私密内容
// ═══════════════════════════════════════════

app.get('/private/:zone/:file(*)', (req, res) => {
  if (!req.session?.auth) {
    return res.redirect('/?err=2');
  }
  if (req.session.auth !== req.params.zone) {
    return res.status(403).json({ error: 'wrong zone' });
  }

  //
  const file = (req.params.file || 'index.html').replace(/\.\./g, '');
  const absPath = resolve(ROOT, 'private', req.params.zone, file);
  const allowedBase = resolve(ROOT, 'private');
  if (!absPath.startsWith(allowedBase)) {
    return res.status(403).json({ error: 'invalid path' });
  }

  //
  const ext = file.split('.').pop().toLowerCase();
  if (!['html', 'css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'json', 'txt', 'md', 'woff', 'woff2', 'ttf'].includes(ext)) {
    return res.status(403).json({ error: 'invalid file type' });
  }

  res.sendFile(absPath, (err) => {
    if (err) {
      logAuth(req.ip, req.session.auth, 'FILE_NOT_FOUND', absPath);
      res.status(404).json({ error: 'not found' });
    }
  });
});

// ═══════════════════════════════════════════
//  静态文件
// ═══════════════════════════════════════════

app.use((req, res, next) => {
  if (req.path.startsWith('/private/')) return next('route');
  next();
});

//
app.use(express.static(ROOT, {
  index: 'index.html',
  dotfiles: 'deny',
  maxAge: '1h',
}));

app.use((req, res) => {
  res.status(404).send('Not found');
});

// ═══════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`✦ Avalon Server running on port ${PORT}`);
  console.log(`✦ Rate limit: ${CONFIG.RATE_MAX_PER_WINDOW}/min, ban after ${CONFIG.RATE_BAN_THRESHOLD} fails`);
  console.log(`✦ PBKDF2: ${CONFIG.PBKDF2_ITERATIONS} iterations, ${CONFIG.PBKDF2_DIGEST}`);
});
