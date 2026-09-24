import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runClaude } from './claude.js';
import { buildPrompt } from './prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OVERLAY_FILE = path.join(here, 'overlay', 'overlay.js');
const SCREENSHOT_LIB = path.join(path.dirname(require.resolve('modern-screenshot')), 'index.js');
const CANVAS_DIR = path.join(here, '..', 'dist', 'canvas'); // compiled Excalidraw app (npm run build)
const INJECT = '<script src="/__over/overlay.js" defer></script>';
const IGNORED = /(^|[\\/])(\.cc-draw|node_modules|\.git)([\\/]|$)/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};

function inject(html) {
  const i = html.lastIndexOf('</body>');
  return i === -1 ? html + INJECT : html.slice(0, i) + INJECT + html.slice(i);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function startServer({ root, port = 4545, proxy, model, permissionMode = 'acceptEdits', dryRun = false }) {
  root = path.resolve(root);
  const stateDir = path.join(root, '.cc-draw');
  const sessionFile = path.join(stateDir, 'session.json');
  const target = proxy ? new URL(proxy) : null;

  const clients = new Set();
  let run = null;
  let pendingReload = false;
  let lastSessionId = null;
  try { lastSessionId = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessionId || null; } catch {}

  const broadcast = (msg) => {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) c.write(data);
  };
  const publicRun = (r) => r && {
    id: r.id, feedbackId: r.feedbackId, status: r.status, events: r.events, startedAt: r.startedAt, endedAt: r.endedAt,
  };

  // ---------- live reload (static mode; in proxy mode the dev server's HMR handles it) ----------
  let reloadTimer = null;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 150);
  };
  if (!target) {
    try {
      fs.watch(root, { recursive: true }, (_ev, name) => {
        if (!name || IGNORED.test(String(name))) return;
        if (run?.status === 'running') { pendingReload = true; return; }
        scheduleReload();
      });
    } catch (err) {
      console.warn('[cc-draw] live reload disabled:', err.message);
    }
  }

  // ---------- on-disk state ----------
  async function ensureStateDir() {
    await fsp.mkdir(path.join(stateDir, 'feedback'), { recursive: true });
    await fsp.writeFile(path.join(stateDir, '.gitignore'), '*\n');
  }

  // ---------- Claude run ----------
  function startRun({ content, continueSession, feedbackDir, feedbackId, annotationCount, promptText }) {
    const r = { id: crypto.randomUUID().slice(0, 8), feedbackId, status: 'running', events: [], startedAt: Date.now() };
    run = r;
    pendingReload = false;
    const push = (ev) => {
      r.events.push({ ...ev, t: Date.now() });
      if (r.events.length > 400) r.events.splice(1, r.events.length - 400);
      broadcast({ type: 'run', run: publicRun(r) });
    };
    const finish = () => {
      r.endedAt = Date.now();
      if (r.status === 'running') r.status = r.cancelled ? 'cancelled' : 'error';
      broadcast({ type: 'run', run: publicRun(r) });
      if (pendingReload) setTimeout(() => broadcast({ type: 'reload' }), 400);
    };

    push({ kind: 'info', text: `Feedback saved to ${path.relative(root, feedbackDir)}/` });

    if (dryRun) {
      // simulates Claude's progress markers so the page animations can be tested without a real run
      let n = 0;
      const step = () => {
        if (n < annotationCount) {
          n++;
          push({ kind: 'progress', n, state: 'working' });
          setTimeout(() => { push({ kind: 'progress', n, state: 'done' }); step(); }, 900);
          return;
        }
        push({ kind: 'result', ok: true, text: `[dry-run] Generated prompt:\n\n${promptText}` });
        r.status = 'done';
        finish();
      };
      setTimeout(step, 300);
      return;
    }

    const { child, done } = runClaude({
      cwd: root,
      content,
      sessionId: continueSession ? lastSessionId : null,
      model,
      permissionMode,
      onEvent: (ev) => {
        if (ev.sessionId && ev.sessionId !== lastSessionId) {
          lastSessionId = ev.sessionId;
          fsp.writeFile(sessionFile, JSON.stringify({ sessionId: lastSessionId })).catch(() => {});
        }
        if (ev.kind === 'result') r.status = ev.ok ? 'done' : 'error';
        if (ev.kind === 'error') r.status = r.cancelled ? 'cancelled' : 'error';
        push(ev);
      },
    });
    r.child = child;
    done.then(finish);
  }

  async function handleFeedback(req, res) {
    if (run?.status === 'running') return sendJson(res, 409, { error: 'Claude is still working on the previous request.' });
    let fb;
    try { fb = JSON.parse((await readBody(req)).toString('utf8')); } catch (err) {
      return sendJson(res, 400, { error: 'Invalid JSON: ' + err.message });
    }

    await ensureStateDir();
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const feedbackDir = path.join(stateDir, 'feedback', id);
    await fsp.mkdir(feedbackDir, { recursive: true });

    const captions = {
      clean: 'Image 1 — the page as it is now (no annotations):',
      annotated: 'Image 2 — the same area with my annotations drawn on top:',
    };
    const imageBlocks = [];
    const imageFiles = [];
    for (const img of fb.images || []) {
      const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(img.dataUrl || '');
      if (!m) continue;
      const file = path.join(feedbackDir, `${img.label}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`);
      await fsp.writeFile(file, Buffer.from(m[3], 'base64'));
      imageFiles.push(path.relative(root, file));
      imageBlocks.push({ type: 'text', text: captions[img.label] || img.label });
      imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } });
    }

    const promptText = buildPrompt(fb, { imageFiles });
    const { images, ...rest } = fb;
    await fsp.writeFile(path.join(feedbackDir, 'feedback.json'), JSON.stringify(rest, null, 2));
    await fsp.writeFile(path.join(feedbackDir, 'prompt.md'), promptText);
    await fsp.writeFile(path.join(stateDir, 'latest.md'), promptText);

    startRun({
      content: [...imageBlocks, { type: 'text', text: promptText }],
      continueSession: fb.continueSession !== false && !!lastSessionId,
      feedbackDir,
      feedbackId: id,
      annotationCount: (fb.annotations || []).length,
      promptText,
    });
    sendJson(res, 200, { ok: true, id });
  }

  // ---------- Excalidraw canvas (iframe), served from dist/canvas/ ----------
  async function serveCanvas(req, res, rel) {
    if (!fs.existsSync(path.join(CANVAS_DIR, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('cc-draw: the Excalidraw canvas is not built — run `npm run build` in the cc-draw folder.');
    }
    let file;
    try { file = path.join(CANVAS_DIR, decodeURIComponent(rel || 'index.html')); } catch {
      res.writeHead(400); return res.end('bad request');
    }
    if (!file.startsWith(CANVAS_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // ---------- internal routes /__over/* ----------
  async function handleInternal(req, res, pathname) {
    if (pathname.startsWith('/__over/canvas/')) return serveCanvas(req, res, pathname.slice('/__over/canvas/'.length));
    if (pathname === '/__over/overlay.js' || pathname === '/__over/modern-screenshot.js') {
      const file = pathname.endsWith('overlay.js') ? OVERLAY_FILE : SCREENSHOT_LIB;
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    if (pathname === '/__over/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', run: publicRun(run), hasSession: !!lastSessionId, liveReload: !target })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (pathname === '/__over/feedback' && req.method === 'POST') return handleFeedback(req, res);
    if (pathname === '/__over/cancel' && req.method === 'POST') {
      if (run?.status === 'running' && run.child) {
        run.cancelled = true;
        run.child.kill('SIGTERM');
      }
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/__over/new-session' && req.method === 'POST') {
      lastSessionId = null;
      await fsp.rm(sessionFile, { force: true });
      broadcast({ type: 'session', hasSession: false });
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'not found' });
  }

  // ---------- static files ----------
  async function serveStatic(req, res, pathname) {
    let file = path.join(root, pathname);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    let st = await fsp.stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fsp.stat(file).catch(() => null);
    }
    if (!st && !path.extname(file)) {
      file += '.html';
      st = await fsp.stat(file).catch(() => null);
    }
    if (!st?.isFile()) {
      res.writeHead(404, { 'content-type': MIME['.html'] });
      return res.end(inject(`<!doctype html><title>404</title><p style="font-family:system-ui;padding:2rem">404 — ${pathname}</p>`));
    }
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      const html = inject(await fsp.readFile(file, 'utf8'));
      res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  // ---------- proxy to a dev server ----------
  function proxyRequest(req, res) {
    const headers = { ...req.headers, host: target.host };
    delete headers['accept-encoding']; // we need uncompressed HTML to inject the script
    const lib = target.protocol === 'https:' ? https : http;
    const preq = lib.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      method: req.method, path: req.url, headers,
    }, (pres) => {
      const type = pres.headers['content-type'] || '';
      if (!type.includes('text/html')) {
        res.writeHead(pres.statusCode, pres.headers);
        return pres.pipe(res);
      }
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        const body = inject(Buffer.concat(chunks).toString('utf8'));
        const h = { ...pres.headers };
        delete h['content-length'];
        delete h['content-encoding'];
        delete h['transfer-encoding'];
        delete h['content-security-policy'];
        h['content-length'] = Buffer.byteLength(body);
        res.writeHead(pres.statusCode, h);
        res.end(body);
      });
    });
    preq.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`cc-draw: could not connect to ${target.href} (${err.message}). Is the dev server running?`);
    });
    req.pipe(preq);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/__over/')) return await handleInternal(req, res, pathname);
      if (target) return proxyRequest(req, res);
      return await serveStatic(req, res, decodeURIComponent(pathname));
    } catch (err) {
      console.error('[cc-draw]', err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
  });

  // websockets (Vite/Next HMR) go straight through to the dev server
  server.on('upgrade', (req, socket, head) => {
    if (!target) return socket.destroy();
    const upstream = net.connect(Number(target.port) || 80, target.hostname, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        raw += `${k}: ${k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(raw + '\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();

  const shutdown = () => { run?.child?.kill('SIGTERM'); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return new Promise((resolve, reject) => {
    let p = port;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && p < port + 20) server.listen(++p);
      else reject(err);
    });
    server.on('listening', () => resolve({ server, url: `http://localhost:${p}` }));
    server.listen(p);
  });
}
