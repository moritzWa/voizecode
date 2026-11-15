import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || 'https://agentvoice-mcp-probe.moritzw.workers.dev/mcp';
const client = new Client({ name: 'agentvoice-remote-check', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['get_session_status']);
  const a = await client.callTool({ name: 'get_session_status', arguments: {} });
  const b = await client.callTool({ name: 'get_session_status', arguments: {} });
  assert.equal(a.structuredContent.synthetic, true);
  assert.notEqual(a.structuredContent.proof_code, b.structuredContent.proof_code);
  console.log(JSON.stringify({ endpoint: url, tool: tools[0].name, result: a.structuredContent }));
} finally {
  await client.close();
}
