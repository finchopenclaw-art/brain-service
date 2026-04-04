import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getEmbedding } from './embeddings.js';
import { extractMetadata } from './metadata.js';
import { insertThought, searchThoughts, listThoughts, getStats } from './thoughts.js';

export const mcpServer = new McpServer({ name: 'open-brain', version: '2.0.0' });

mcpServer.registerTool('capture_thought', {
  title: 'Capture Thought',
  description: 'Save a new thought to the brain. Generates an embedding and extracts metadata automatically. Use when the user wants to save notes, insights, decisions, or project state.',
  inputSchema: {
    content: z.string().describe('The thought to capture — a clear, standalone statement that will make sense when retrieved later'),
  },
}, async ({ content }) => {
  try {
    const [embedding, metadata] = await Promise.all([
      getEmbedding(content),
      extractMetadata(content),
    ]);
    await insertThought(content, embedding, { ...metadata, source: 'mcp' }, 'mcp');
    let confirmation = `Captured as ${metadata.type}`;
    if (metadata.topics.length) confirmation += ` — ${metadata.topics.join(', ')}`;
    if (metadata.people.length) confirmation += ` | People: ${metadata.people.join(', ')}`;
    if (metadata.action_items.length) confirmation += ` | Actions: ${metadata.action_items.join('; ')}`;
    return { content: [{ type: 'text' as const, text: confirmation }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
  }
});

mcpServer.registerTool('search_thoughts', {
  title: 'Search Thoughts',
  description: 'Search captured thoughts by meaning. Use when the user asks about a topic, person, or idea they have previously captured.',
  inputSchema: {
    query: z.string().describe('What to search for'),
    limit: z.number().optional().default(10),
    threshold: z.number().optional().default(0.5),
  },
}, async ({ query, limit, threshold }) => {
  try {
    const embedding = await getEmbedding(query);
    const results = await searchThoughts(embedding, limit, threshold);
    if (!results.length) return { content: [{ type: 'text' as const, text: `No thoughts found matching "${query}".` }] };
    const formatted = results.map((t, i) => {
      const m = t.metadata;
      const parts = [
        `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
        `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
        `Type: ${(m.type as string) || 'unknown'}`,
      ];
      if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${(m.topics as string[]).join(', ')}`);
      if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${(m.people as string[]).join(', ')}`);
      if (Array.isArray(m.action_items) && m.action_items.length) parts.push(`Actions: ${(m.action_items as string[]).join('; ')}`);
      parts.push(`\n${t.content}`);
      return parts.join('\n');
    });
    return { content: [{ type: 'text' as const, text: `Found ${results.length} thought(s):\n\n${formatted.join('\n\n')}` }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
  }
});

mcpServer.registerTool('list_thoughts', {
  title: 'List Recent Thoughts',
  description: 'List recently captured thoughts with optional filters by type, topic, person, or time range.',
  inputSchema: {
    limit: z.number().optional().default(10),
    type: z.string().optional().describe('Filter by type: observation, task, idea, reference, person_note'),
    topic: z.string().optional().describe('Filter by topic tag'),
    person: z.string().optional().describe('Filter by person mentioned'),
    days: z.number().optional().describe('Only thoughts from the last N days'),
  },
}, async ({ limit, type, topic, person, days }) => {
  try {
    const thoughts = await listThoughts({ limit, type, topic, person, days });
    if (!thoughts.length) return { content: [{ type: 'text' as const, text: 'No thoughts found.' }] };
    const formatted = thoughts.map((t, i) => {
      const m = t.metadata;
      const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(', ') : '';
      return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${(m.type as string) || '??'}${tags ? ' - ' + tags : ''})\n   ${t.content}`;
    });
    return { content: [{ type: 'text' as const, text: `${thoughts.length} recent thought(s):\n\n${formatted.join('\n\n')}` }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
  }
});

mcpServer.registerTool('thought_stats', {
  title: 'Thought Statistics',
  description: 'Get a summary of all captured thoughts: totals, types, top topics, and people.',
  inputSchema: {},
}, async () => {
  try {
    const stats = await getStats();
    const sort = (o: Record<string, number>): [string, number][] =>
      Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const lines = [
      `Total thoughts: ${stats.total}`,
      `Date range: ${stats.oldest ? new Date(stats.oldest).toLocaleDateString() : 'N/A'} → ${stats.newest ? new Date(stats.newest).toLocaleDateString() : 'N/A'}`,
      '', 'Types:', ...sort(stats.types).map(([k, v]) => `  ${k}: ${v}`),
    ];
    if (Object.keys(stats.topics).length) { lines.push('', 'Top topics:'); for (const [k, v] of sort(stats.topics)) lines.push(`  ${k}: ${v}`); }
    if (Object.keys(stats.people).length) { lines.push('', 'People mentioned:'); for (const [k, v] of sort(stats.people)) lines.push(`  ${k}: ${v}`); }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
  }
});
