#!/usr/bin/env node
// Minimal stdio MCP server exposing `report_progress`. The cc-draw server reads these tool calls
// straight from Claude's stream-json output, so this server only has to acknowledge them.
import readline from 'node:readline';

const TOOL = {
  name: 'report_progress',
  description:
    'Report progress on the cc-draw annotations to the user, who watches it live on the page. ' +
    'Call it with state "working" right before you start annotation #n, and with state "done" right after you finish it.',
  inputSchema: {
    type: 'object',
    properties: {
      n: { type: 'integer', description: 'Annotation number (#n)' },
      state: { type: 'string', enum: ['working', 'done'] },
    },
    required: ['n', 'state'],
  },
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications need no reply
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cc-draw', version: '0.1.0' },
      });
    case 'tools/list':
      return reply({ tools: [TOOL] });
    case 'tools/call': {
      const a = m.params?.arguments || {};
      return reply({ content: [{ type: 'text', text: `ok — #${a.n} ${a.state}` }] });
    }
    case 'ping':
      return reply({});
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
