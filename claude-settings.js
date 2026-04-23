#!/usr/bin/env node
// Claude Settings Manager — local dashboard
// Zero runtime deps. Reads/writes Claude Code settings files with backups.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const url = require('url');

const HOME = os.homedir();
const DEFAULT_PORT = 7823;
const DEFAULT_ROOTS = [path.join(HOME, 'projects')];
const ROOTS = (process.env.CLAUDE_SETTINGS_ROOTS || '').split(':').filter(Boolean);
const SCAN_ROOTS = ROOTS.length ? ROOTS : DEFAULT_ROOTS;
const SCAN_DEPTH = parseInt(process.env.CLAUDE_SETTINGS_DEPTH || '3', 10);

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.slice(7) || process.env.CLAUDE_SETTINGS_PORT || DEFAULT_PORT, 10);
const NO_OPEN = process.argv.includes('--no-open');

// ---------- Settings file discovery ----------

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function readJsonSafe(p) {
  try {
    const text = fs.readFileSync(p, 'utf8');
    return { ok: true, data: JSON.parse(text), raw: text };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function walkForClaudeDirs(root, depth) {
  const hits = [];
  function walk(dir, remaining) {
    if (remaining < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') && ent.name !== '.claude') continue;
      if (ent.name === 'node_modules' || ent.name === 'vendor' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.name === '.claude') {
        hits.push(path.dirname(full));
        continue;
      }
      walk(full, remaining - 1);
    }
  }
  walk(root, depth);
  return hits;
}

function discoverFiles() {
  const files = [];

  // Global user settings
  const globalSettings = path.join(HOME, '.claude', 'settings.json');
  if (safeStat(globalSettings)) files.push({ scope: 'user', kind: 'settings', path: globalSettings });

  // Legacy ~/.claude.json (MCP servers + misc)
  const legacy = path.join(HOME, '.claude.json');
  if (safeStat(legacy)) files.push({ scope: 'user', kind: 'legacy', path: legacy });

  // Project files (scan configured roots)
  const projectDirs = new Set();
  for (const root of SCAN_ROOTS) {
    if (!safeStat(root)) continue;
    for (const proj of walkForClaudeDirs(root, SCAN_DEPTH)) projectDirs.add(proj);
  }

  for (const proj of projectDirs) {
    const shared = path.join(proj, '.claude', 'settings.json');
    const local = path.join(proj, '.claude', 'settings.local.json');
    const mcp = path.join(proj, '.mcp.json');
    if (safeStat(shared)) files.push({ scope: 'project', kind: 'settings', path: shared, project: proj });
    if (safeStat(local)) files.push({ scope: 'local', kind: 'settings', path: local, project: proj });
    if (safeStat(mcp)) files.push({ scope: 'project', kind: 'mcp', path: mcp, project: proj });
  }

  return files;
}

// ---------- Permissions aggregation ----------

const BUCKETS = ['allow', 'deny', 'ask'];

function aggregatePermissions(files) {
  // For each rule, record which files list it in which bucket.
  const rules = new Map(); // rule -> { allow: [files], deny: [files], ask: [files] }
  for (const f of files) {
    if (f.kind !== 'settings') continue;
    const parsed = readJsonSafe(f.path);
    if (!parsed.ok) continue;
    const perms = parsed.data?.permissions || {};
    for (const bucket of BUCKETS) {
      const list = perms[bucket];
      if (!Array.isArray(list)) continue;
      for (const rule of list) {
        if (!rules.has(rule)) rules.set(rule, { allow: [], deny: [], ask: [] });
        rules.get(rule)[bucket].push({ path: f.path, scope: f.scope, project: f.project });
      }
    }
  }
  return [...rules.entries()].map(([rule, scopes]) => ({ rule, ...scopes }));
}

// ---------- MCP server aggregation ----------

const SECRET_KEY_RE = /(authorization|token|secret|api[_-]?key|password|bearer)/i;
function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && SECRET_KEY_RE.test(k)) {
      out[k] = v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)} [redacted]` : '[redacted]';
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

function aggregateMcp(files) {
  const servers = [];
  for (const f of files) {
    if (f.kind === 'legacy' || f.kind === 'mcp') {
      const parsed = readJsonSafe(f.path);
      if (!parsed.ok) continue;
      const map = parsed.data?.mcpServers || {};
      for (const [name, cfg] of Object.entries(map)) {
        servers.push({ name, config: redactSecrets(cfg), source: f.path, scope: f.scope, project: f.project });
      }
    }
    if (f.kind === 'settings') {
      const parsed = readJsonSafe(f.path);
      if (!parsed.ok) continue;
      const enabled = parsed.data?.enabledMcpjsonServers;
      const disabled = parsed.data?.disabledMcpjsonServers;
      if (Array.isArray(enabled)) for (const n of enabled) servers.push({ name: n, mode: 'enabled', source: f.path, scope: f.scope, project: f.project });
      if (Array.isArray(disabled)) for (const n of disabled) servers.push({ name: n, mode: 'disabled', source: f.path, scope: f.scope, project: f.project });
    }
  }
  return servers;
}

// ---------- Safe writes ----------

function backupFile(p) {
  if (!safeStat(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${p}.bak.${ts}`;
  fs.copyFileSync(p, bak);
  return bak;
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isManagedPath(p) {
  // Only allow writes inside ~/.claude or inside discovered project .claude dirs / .mcp.json
  const allowed = [
    path.join(HOME, '.claude') + path.sep,
    path.join(HOME, '.claude.json'),
  ];
  if (p === path.join(HOME, '.claude.json')) return true;
  if (p.startsWith(path.join(HOME, '.claude') + path.sep)) return true;
  // Also allow any path under a configured scan root that ends with .claude/*.json or /.mcp.json
  for (const root of SCAN_ROOTS) {
    const rootAbs = path.resolve(root);
    if (!p.startsWith(rootAbs + path.sep)) continue;
    if (p.includes(path.sep + '.claude' + path.sep) && p.endsWith('.json')) return true;
    if (p.endsWith(path.sep + '.mcp.json')) return true;
  }
  return false;
}

function mutatePermissions(filePath, mutator) {
  if (!isManagedPath(filePath)) throw new Error(`Refusing to write outside managed paths: ${filePath}`);
  const parsed = safeStat(filePath) ? readJsonSafe(filePath) : { ok: true, data: {} };
  if (!parsed.ok) throw new Error(`Cannot parse ${filePath}: ${parsed.error}`);
  const data = parsed.data || {};
  if (!data.permissions) data.permissions = {};
  for (const b of BUCKETS) if (!Array.isArray(data.permissions[b])) data.permissions[b] = data.permissions[b] || undefined;
  mutator(data);
  const bak = backupFile(filePath);
  writeJson(filePath, data);
  return { backup: bak };
}

function addRule(filePath, bucket, rule) {
  if (!BUCKETS.includes(bucket)) throw new Error(`Invalid bucket: ${bucket}`);
  return mutatePermissions(filePath, (data) => {
    if (!Array.isArray(data.permissions[bucket])) data.permissions[bucket] = [];
    if (!data.permissions[bucket].includes(rule)) data.permissions[bucket].push(rule);
  });
}

function removeRule(filePath, bucket, rule) {
  if (!BUCKETS.includes(bucket)) throw new Error(`Invalid bucket: ${bucket}`);
  return mutatePermissions(filePath, (data) => {
    if (Array.isArray(data.permissions[bucket])) {
      data.permissions[bucket] = data.permissions[bucket].filter(r => r !== rule);
    }
  });
}

// ---------- HTTP helpers ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let rel = decodeURIComponent(parsed.pathname || '/');
  if (rel === '/') rel = '/index.html';
  const full = path.join(__dirname, 'public', rel);
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------- Routes ----------

const routes = {
  'GET /api/context': (req, res) => {
    sendJson(res, 200, {
      home: HOME,
      scanRoots: SCAN_ROOTS,
      scanDepth: SCAN_DEPTH,
      port: PORT,
      nodeVersion: process.version,
    });
  },

  'GET /api/files': (req, res) => {
    const files = discoverFiles();
    const enriched = files.map(f => {
      const st = safeStat(f.path);
      const parsed = readJsonSafe(f.path);
      let counts = null;
      if (parsed.ok && f.kind === 'settings') {
        const p = parsed.data?.permissions || {};
        counts = {
          allow: Array.isArray(p.allow) ? p.allow.length : 0,
          deny: Array.isArray(p.deny) ? p.deny.length : 0,
          ask: Array.isArray(p.ask) ? p.ask.length : 0,
        };
      }
      return {
        ...f,
        size: st?.size || 0,
        mtime: st?.mtime?.toISOString(),
        parseOk: parsed.ok,
        parseError: parsed.error,
        counts,
      };
    });
    sendJson(res, 200, { files: enriched });
  },

  'GET /api/file': (req, res) => {
    const q = url.parse(req.url, true).query;
    const p = q.path;
    if (!p || typeof p !== 'string') return sendJson(res, 400, { error: 'path required' });
    const parsed = readJsonSafe(p);
    const raw = q.raw === 'true' || q.raw === '1';
    let data = parsed.data;
    if (parsed.ok && !raw) data = redactSecrets(parsed.data);
    sendJson(res, 200, {
      path: p,
      ok: parsed.ok,
      data,
      text: parsed.ok && raw ? JSON.stringify(data, null, 2) : undefined,
      error: parsed.error,
      redacted: parsed.ok && !raw,
    });
  },

  'POST /api/file/save': async (req, res) => {
    try {
      const body = await readBody(req);
      const { filePath, content } = body;
      if (!filePath || typeof content !== 'string') return sendJson(res, 400, { error: 'filePath and content required' });
      if (!isManagedPath(filePath)) return sendJson(res, 403, { error: `Refusing to write outside managed paths: ${filePath}` });
      let parsed;
      try { parsed = JSON.parse(content); }
      catch (e) { return sendJson(res, 400, { error: `Invalid JSON: ${e.message}` }); }
      const bak = backupFile(filePath);
      writeJson(filePath, parsed);
      sendJson(res, 200, { ok: true, backup: bak });
    } catch (e) { sendJson(res, 500, { error: String(e.message || e) }); }
  },

  'GET /api/permissions': (req, res) => {
    const files = discoverFiles();
    const rules = aggregatePermissions(files);
    sendJson(res, 200, { rules });
  },

  'GET /api/mcp': (req, res) => {
    const files = discoverFiles();
    sendJson(res, 200, { servers: aggregateMcp(files) });
  },

  'POST /api/rule/add': async (req, res) => {
    try {
      const body = await readBody(req);
      const { filePath, bucket, rule } = body;
      if (!filePath || !bucket || !rule) return sendJson(res, 400, { error: 'filePath, bucket, rule required' });
      const result = addRule(filePath, bucket, rule);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) { sendJson(res, 500, { error: String(e.message || e) }); }
  },

  'POST /api/rule/remove': async (req, res) => {
    try {
      const body = await readBody(req);
      const { filePath, bucket, rule } = body;
      if (!filePath || !bucket || !rule) return sendJson(res, 400, { error: 'filePath, bucket, rule required' });
      const result = removeRule(filePath, bucket, rule);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) { sendJson(res, 500, { error: String(e.message || e) }); }
  },

  // Move a rule: remove from `from` files (list), add to `to` file.
  'POST /api/rule/promote': async (req, res) => {
    try {
      const body = await readBody(req);
      const { from, to, bucket, rule } = body;
      if (!Array.isArray(from) || !to || !bucket || !rule) {
        return sendJson(res, 400, { error: 'from (array), to, bucket, rule required' });
      }
      const backups = [];
      const added = addRule(to, bucket, rule);
      backups.push({ file: to, backup: added.backup });
      for (const fp of from) {
        if (fp === to) continue;
        const removed = removeRule(fp, bucket, rule);
        backups.push({ file: fp, backup: removed.backup });
      }
      sendJson(res, 200, { ok: true, backups });
    } catch (e) { sendJson(res, 500, { error: String(e.message || e) }); }
  },
};

// ---------- Server ----------

function openBrowser(targetUrl) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', targetUrl] : [targetUrl];
  try { execFile(cmd, args, () => {}); } catch {}
}

function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const { pathname } = url.parse(req.url);
    const key = `${req.method} ${pathname}`;
    if (routes[key]) return routes[key](req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 404, { error: 'not found' });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[claude-settings] Port ${port} is in use. Try --port=<other>.`);
      process.exit(1);
    }
    console.error('[claude-settings] server error:', err);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const target = `http://127.0.0.1:${port}/`;
    console.log(`[claude-settings] listening on ${target}`);
    console.log(`[claude-settings] scanning: ${SCAN_ROOTS.join(', ')} (depth ${SCAN_DEPTH})`);
    if (!NO_OPEN) openBrowser(target);
  });
}

startServer(PORT);
