import 'dotenv/config';
import { serve } from '@hono/node-server';
import { StreamableHTTPTransport } from '@hono/mcp';
import { app } from './app.js';
import { mcpServer } from './mcp.js';

const PORT = parseInt(process.env.PORT ?? '3002');

// Mount MCP on /mcp path — single transport, connected once at startup
const mcpTransport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
await mcpServer.connect(mcpTransport);

app.all('/mcp', async (c) => {
  const res = await mcpTransport.handleRequest(c);
  return res ?? c.text('', 405);
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Brain service running on port ${PORT}`);
});
