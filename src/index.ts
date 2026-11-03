import 'dotenv/config';
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { mountMcp } from './mcp.js';

const PORT = parseInt(process.env.PORT ?? '3002');

await mountMcp(app);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Brain service running on port ${PORT}`);
});
