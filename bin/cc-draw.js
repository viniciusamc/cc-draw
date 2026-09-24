#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startServer } from '../src/server.js';

const HELP = `
cc-draw — draw on top of your frontend and have Claude Code apply it

Usage:
  cc-draw [dir]                       serve the folder's static files (default: .)
  cc-draw [dir] --proxy <url>         sit in front of a dev server (Vite, Next…)

Options:
  -p, --port <n>             port (default 4545)
      --proxy <url>          dev server URL, e.g. http://localhost:5173
  -m, --model <model>        Claude model (e.g. opus, sonnet)
      --permission-mode <m>  Claude permission mode (default: acceptEdits)
      --no-open              don't open the browser
      --dry-run              only generate the prompt, don't call Claude
  -h, --help

In the browser: Alt+Shift+D (or the "Annotate" button) toggles drawing mode.
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      port: { type: 'string', short: 'p', default: '4545' },
      proxy: { type: 'string' },
      model: { type: 'string', short: 'm' },
      'permission-mode': { type: 'string', default: 'acceptEdits' },
      open: { type: 'boolean', default: true },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(err.message + '\n' + HELP);
  process.exit(1);
}

const { values, positionals } = parsed;
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const dir = path.resolve(positionals[0] || '.');

const { url } = await startServer({
  root: dir,
  port: Number(values.port),
  proxy: values.proxy,
  model: values.model,
  permissionMode: values['permission-mode'],
  dryRun: values['dry-run'],
});

console.log(`
  \x1b[1mcc-draw\x1b[0m  →  \x1b[36m${url}\x1b[0m
  ${values.proxy ? `proxying:   ${values.proxy}` : `serving:    ${dir}`}
  Claude runs in: ${dir}${values['dry-run'] ? '  (dry-run)' : ''}

  In the browser: Alt+Shift+D or the "Annotate" button.
`);

if (values.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
