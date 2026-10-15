#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const assertFile = (relative) => {
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`Missing UI file: public/${relative}`);
  }
};

try {
  const server = read('src/server.ts');
  if (!server.includes("server.get('/', async (request, reply)")) throw new Error('Fastify root route is missing.');
  if (!server.includes("server.get('/*', async (request, reply)")) throw new Error('Fastify static asset route is missing.');
  if (!server.includes("server.post('/api/chat', async (request, reply)")) throw new Error('Agent /api/chat route is missing.');
  for (const file of ['index.html', 'assets/js/orchestrator.js', 'components/chat-composer/chat-submit.js']) assertFile(file);

  const orchestrator = read('public/assets/js/orchestrator.js');
  const fragments = [...orchestrator.matchAll(/\w+: '((?:components|assets)\/[^']+\.html)'/g)].map((m) => m[1]);
  const scripts = [...orchestrator.matchAll(/\['((?:components|assets)\/[^']+\.js)', '(?:classic|module)'\]/g)].map((m) => m[1]);
  [...fragments, ...scripts].forEach(assertFile);

  const submit = read('public/components/chat-composer/chat-submit.js');
  if (!submit.includes("window.WATHIQ_AGENT?.chatEndpoint || '/api/chat'")) throw new Error('UI is not configured to call the same-origin agent API.');
  console.log(`Wathiq UI integration OK: ${fragments.length} fragments, ${scripts.length} scripts, /api/chat linked.`);
} catch (error) {
  console.error(`[Wathiq integration check] ${error.message}`);
  process.exitCode = 1;
}
