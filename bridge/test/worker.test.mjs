import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';

const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
async function rpc(method, params = {}, id = 1) {
  const response = await worker.fetch(new Request('https://probe.example/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return response.json();
}

test('health is explicitly synthetic; other paths are absent', async () => {
  const response = await worker.fetch(new Request('https://probe.example/health'));
  assert.deepEqual(await response.json(), { ok: true, synthetic: true });
  assert.equal((await worker.fetch(new Request('https://probe.example/sessions'))).status, 404);
});

test('MCP handshake', async () => {
  const result = await rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(result.result.serverInfo.name, 'AgentVoice connectivity probe');
});

test('one honestly read-only tool, no real session access', async () => {
  const { result } = await rpc('tools/list');
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, 'get_session_status');
  assert.equal(result.tools[0].annotations.readOnlyHint, true);
});

test('tool returns fresh proof, time, and synthetic data', async () => {
  const a = (await rpc('tools/call', { name: 'get_session_status', arguments: {} })).result;
  const b = (await rpc('tools/call', { name: 'get_session_status', arguments: {} })).result;
  assert.equal(a.isError, undefined);
  assert.equal(a.structuredContent.synthetic, true);
  assert.equal(a.structuredContent.message, 'OpenCode bridge connected');
  assert.ok(Number.isFinite(Date.parse(a.structuredContent.server_time)));
  assert.notEqual(a.structuredContent.proof_code, b.structuredContent.proof_code);
  assert.deepEqual(JSON.parse(a.content[0].text), a.structuredContent);
});

test('unadvertised tools fail', async () => {
  const { result } = await rpc('tools/call', { name: 'send_session_message', arguments: {} });
  assert.equal(result.isError, true);
});
