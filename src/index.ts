import 'dotenv/config';
import { serve } from '@hono/node-server';
import { StreamableHTTPTransport } from '@hono/mcp';
import { app } from './app.js';
import { mcpServer } from './mcp.js';

const PORT = parseInt(process.env.PORT ?? '3002');

// Mount MCP as catch-all after REST routes
app.all('*', async (c) => {
  const transport = new StreamableHTTPTransport();
  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Brain service running on port ${PORT}`);
});
