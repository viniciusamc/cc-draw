import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRESS_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp', 'progress.js');
const PROGRESS_TOOL = 'mcp__cc-draw__report_progress';
const MCP_CONFIG = JSON.stringify({
  mcpServers: { 'cc-draw': { type: 'stdio', command: process.execPath, args: [PROGRESS_SERVER] } },
});

export const SYSTEM_PROMPT = `You are receiving visual design feedback that the user drew on top of a running web page (the "cc-draw" tool).
- The images show the page. In the annotated version, the colored strokes, handwritten text, comment callouts and numbered badges (#1, #2…) come from the user — they are NOT part of the design.
- Each annotation comes with the DOM elements detected under it (CSS selector, HTML snippet, computed styles and sometimes the likely source file). Use this to find the right code (Grep/Glob for the text, classes or ids).
- Annotations without text: interpret them by shape. Striking through / an X usually means remove; an arrow means move something from one place to another or point at a target; a circle/rectangle highlights the target of a note.
- Edit the project's source files in the current directory. Never edit anything inside .cc-draw/. If sources exist, don't edit build artifacts.
- Do only what was asked and keep the rest of the design intact. When the request is vague ("make it nicer"), make tasteful design decisions consistent with the existing style.
- The page reloads on its own in the user's browser after your edits; you don't need to open or serve the page to check.
- Progress (the user watches it live on the page): call the \`report_progress\` tool with state "working" right before you start annotation #N, and with state "done" right after you finish it. Work through the annotations one at a time, in order where possible. If that tool is unavailable, print lines exactly \`[cc-draw] working on #N\` / \`[cc-draw] done #N\` instead.
- When done, reply with a short summary (1 to 4 lines) of what changed, in the user's language.`;

const MARKER = /\[cc-draw\]\s*(working on|done)\s*#(\d+)/gi;

// Pulls progress markers out of Claude's text; returns them in order plus the text without them.
function splitMarkers(text) {
  const progress = [];
  const clean = text
    .replace(MARKER, (_, what, n) => {
      progress.push({ n: Number(n), state: /done/i.test(what) ? 'done' : 'working' });
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { progress, clean };
}

function describeTool(block, cwd) {
  const i = block.input || {};
  const v = i.file_path || i.notebook_path || i.command || i.pattern || i.path || i.url || i.description || '';
  return String(v).split('\n')[0].split(cwd + '/').join('').slice(0, 160);
}

/**
 * Runs Claude Code headless (`claude -p`) with a multimodal message
 * (text + images) over stream-json, emitting simplified events via onEvent.
 */
export function runClaude({ cwd, content, sessionId, model, permissionMode, claudeBin = 'claude', onEvent }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode,
    '--mcp-config', MCP_CONFIG,
    '--allowedTools', PROGRESS_TOOL,
    '--append-system-prompt', SYSTEM_PROMPT,
  ];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);

  const child = spawn(claudeBin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');

  let finished = false;
  let buf = '';
  let stderr = '';

  const handle = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'system' && m.subtype === 'init') {
      onEvent({ kind: 'start', sessionId: m.session_id, model: m.model, resumed: !!sessionId });
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) {
          const { progress, clean } = splitMarkers(b.text);
          for (const p of progress) onEvent({ kind: 'progress', ...p });
          if (clean) onEvent({ kind: 'text', text: clean });
        } else if (b.type === 'tool_use' && b.name === PROGRESS_TOOL) {
          const n = Number(b.input?.n);
          if (n > 0) onEvent({ kind: 'progress', n, state: b.input?.state === 'done' ? 'done' : 'working' });
        } else if (b.type === 'tool_use') onEvent({ kind: 'tool', name: b.name, detail: describeTool(b, cwd) });
      }
    } else if (m.type === 'result') {
      finished = true;
      onEvent({
        kind: 'result',
        ok: m.subtype === 'success' && !m.is_error,
        text: splitMarkers(m.result ?? '').clean,
        sessionId: m.session_id,
        costUsd: m.total_cost_usd,
        durationMs: m.duration_ms,
        denials: (m.permission_denials || []).map((d) => d.tool_name),
      });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      if (!finished) {
        finished = true;
        onEvent({
          kind: 'error',
          text: err.code === 'ENOENT'
            ? `Could not find the "${claudeBin}" command. Is Claude Code installed and on your PATH?`
            : err.message,
        });
      }
      resolve();
    });
    child.on('close', (code, signal) => {
      if (!finished) {
        finished = true;
        onEvent({ kind: 'error', text: signal ? 'Cancelled.' : (stderr.trim().slice(-2000) || `claude exited with code ${code}`) });
      }
      resolve();
    });
  });

  return { child, done };
}
