import express from 'express';
import session from 'express-session';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
const PASSWORDS = {
  'Avalon': sha256('Avalon'),
  'EasonQian': sha256('EasonQian'),
};

const app = express();
const PORT = 3456;

// ── 服务端防暴力破解 ──
const _rateMap = new Map();
const _rateLimit = (max, windowMs) => (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (!_rateMap.has(ip)) _rateMap.set(ip, []);
  const attempts = _rateMap.get(ip).filter(t => now - t < windowMs);
  if (attempts.length >= max) {
    return res.status(429).json({ error: 'rate limited', retryAfter: Math.ceil(windowMs / 1000) });
  }
  attempts.push(now);
  _rateMap.set(ip, attempts);
  next();
};
// 定期清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of _rateMap) {
    const valid = attempts.filter(t => now - t < 3600000);
    if (valid.length === 0) _rateMap.delete(ip); else _rateMap.set(ip, valid);
  }
}, 60000);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'galatea-neon-city-' + randomUUID(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

// ── GET 登录（从 GitHub Pages 等外部页面跳转过来，带速率限制） ──
app.get('/login', _rateLimit(5, 60000), (req, res) => {
  const { key, from } = req.query;
  if (!key) return res.redirect('/?err=1');
  const hash = sha256(key);
  let zone = null;
  if (hash === PASSWORDS['Avalon']) zone = 'galatea';
  else if (hash === PASSWORDS['EasonQian']) zone = 'eason';
  if (zone) {
    req.session.auth = zone;
    const fromParam = from ? '?from=' + from : '';
    return res.redirect('/private/' + zone + '/' + fromParam);
  }
  res.redirect('/?err=1');
});

// ── API：登录（带速率限制：10次/分钟，20次/小时） ──
app.post('/api/login', _rateLimit(10, 60000), _rateLimit(20, 3600000), (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'missing password' });
  const hash = sha256(password);
  let zone = null;
  if (hash === PASSWORDS['Avalon']) zone = 'galatea';
  else if (hash === PASSWORDS['EasonQian']) zone = 'eason';
  if (zone) {
    req.session.auth = zone;
    return res.json({ ok: true, zone });
  }
  res.status(403).json({ error: 'invalid key' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth', (req, res) => {
  if (req.session?.auth) return res.json({ authed: true, zone: req.session.auth });
  res.json({ authed: false });
});

// ── 受保护的私密内容 ──
app.get('/private/:zone/:file(*)', (req, res) => {
  if (!req.session?.auth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.session.auth !== req.params.zone) {
    return res.status(403).json({ error: 'wrong zone' });
  }
  const file = req.params.file || 'index.html';
  const absPath = resolve(ROOT, 'private', req.params.zone, file);
  if (!absPath.startsWith(resolve(ROOT, 'private'))) {
    return res.status(403).json({ error: 'invalid path' });
  }
  res.sendFile(absPath, (err) => {
    if (err) res.status(404).json({ error: 'not found' });
  });
});

// ── 公开静态文件 ──
app.use((req, res, next) => {
  if (req.path.startsWith('/private/')) return next('route');
  next();
});
app.use(express.static(ROOT, { index: 'index.html' }));

app.use((req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`✦ Server running on http://120.55.242.84:${PORT}`);
});
