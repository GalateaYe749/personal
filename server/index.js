import express from 'express';
import session from 'express-session';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
const PASSWORDS = {
  'GalateaYe': sha256('GalateaYe'),
  'EasonQian': sha256('EasonQian'),
};

const app = express();
const PORT = 3456;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'galatea-neon-city-' + randomUUID(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

// ── API 路由（放在静态之前，优先处理） ──

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'missing password' });
  const hash = sha256(password);
  let zone = null;
  if (hash === PASSWORDS['GalateaYe']) zone = 'galatea';
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

// ── 受保护的私密文件路由 ──
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

// ── 公开静态文件（只公开非 private 路径） ──
app.use((req, res, next) => {
  if (req.path.startsWith('/private/')) {
    return next('route'); // 跳过 static，让上面 catch-all 处理或被 404 捕获
  }
  next();
});

app.use(express.static(ROOT, { index: 'index.html' }));

// ── 404 ──
app.use((req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`✦ Server running on http://120.55.242.84:${PORT}`);
});
