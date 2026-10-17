const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// Verify source-of-truth evaluation evidence is retained for the agent and UI.
const agent = read('agent/agent.ts');
assert.ok(agent.includes('scoreBreakdown: result.assistantEvidence?.scoreBreakdown'));
assert.ok(agent.includes('personalMatch: result.assistantEvidence?.personalMatch'));
assert.ok(agent.includes('scoreBreakdown: asArray(e.scoreBreakdown)'));
assert.ok(agent.includes('personalMatch: e.personalMatch'));

const evaluateTool = read('agent/tools/evaluateProduct.ts');
assert.ok(evaluateTool.includes('scoreBreakdown: objectArray(evaluation.scoreBreakdown)'));
assert.ok(evaluateTool.includes('personalMatch'));

const fastLane = read('agent/fastLane.ts');
assert.ok(fastLane.includes('asksScoreDetails'));
assert.ok(fastLane.includes('asksPersonalMatch'));
assert.ok(fastLane.includes("String(item.type || '').toLowerCase() !== 'calculation'"));
assert.ok(!fastLane.includes('One factor behind this result:'));

const prompt = read('agent/prompt.ts');
assert.ok(prompt.includes('Do not proactively list every note or score factor'));
assert.ok(prompt.includes('Only when the user asks why the score'));
assert.ok(!prompt.includes('All entries are shown in the card.'));
assert.ok(!prompt.includes('`scoreBreakdown`'));

const server = read('server.ts');
assert.ok(server.includes("const WATHIQ_AGENT_VERSION = '6.5.1'"));
console.log('PASS backend evidence propagation and on-demand score narration contract');
