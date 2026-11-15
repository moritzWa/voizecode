import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

// Deliberately public, synthetic data only. Never connect real sessions here.
// A fresh nonce proves a tool ran instead of ChatGPT repeating an earlier result.
export function createServer() {
  const server = new McpServer({ name: 'AgentVoice connectivity probe', version: '0.1.0' });
  server.registerTool('get_session_status', {
    title: 'Check AgentVoice connection',
    description: 'Return a synthetic test session, current server time and a fresh proof code. Does not access any real coding sessions or private data.',
    inputSchema: {},
    outputSchema: {
      session: z.string(), status: z.literal('available'), message: z.string(),
      server_time: z.string(), proof_code: z.string(), synthetic: z.literal(true),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const result = {
      session: 'test-session', status: 'available', message: 'OpenCode bridge connected',
      server_time: new Date().toISOString(), proof_code: crypto.randomUUID(), synthetic: true,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  return server;
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, synthetic: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (path !== '/mcp') return new Response('Not found', { status: 404 });
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } finally {
      await server.close();
    }
  },
};
