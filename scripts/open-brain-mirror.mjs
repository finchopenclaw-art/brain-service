#!/usr/bin/env node
// Copy department saves into Open Brain (card #271). Runs ON THE DEV BOX, the only machine holding Open Brain's key
// (~/.claude.json, the open-brain MCP url). It asks the VPS what is pending, saves each note, and marks what landed, so
// a failed night retries the rest the next night.
//
//   node scripts/open-brain-mirror.mjs --to coop [--check]     --check only proves the connection
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dept = flag('to');
if (!dept || !/^[a-z][a-z0-9]{1,30}$/.test(dept)) { console.error('--to <dept> is required'); process.exit(1); }

const url = JSON.parse(readFileSync(`${homedir()}/.claude.json`, 'utf8')).mcpServers?.['open-brain']?.url;
if (!url) { console.error('No open-brain MCP url in ~/.claude.json'); process.exit(1); }

const vps = (args) => execFileSync('ssh', ['-i', `${homedir()}/.ssh/ciesc_vps`, '-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', 'root@145.223.74.121',
  `cd /root/brain-service && node scripts/share-nightly.mjs ${args}`], { encoding: 'utf8' });

let id = 0;
async function tool(name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const body = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text);
  if (!res.ok || body.error || body.result?.isError) throw new Error(`${name} failed (${res.status}): ${JSON.stringify(body.error ?? body.result).slice(0, 200)}`);
  return body.result?.content?.[0]?.text ?? '';
}

if (process.argv.includes('--check')) {
  console.log((await tool('thought_stats', {})).split('\n')[0]);
  process.exit(0);
}

const pending = JSON.parse(vps(`pending-open-brain --to ${dept}`));
const done = [];
let failed = 0;
for (const note of pending) {
  try {
    await tool('capture_thought', { content: note.content });
    done.push(note.id);
  } catch (e) {
    failed++;
    console.error(e.message);
  }
}
if (done.length) vps(`mark-open-brain --to ${dept} --ids ${done.join(',')}`);
console.log(`[${new Date().toISOString()}] ${pending.length} pending, ${done.length} saved to Open Brain, ${failed} failed.`);
if (failed) process.exit(1);
