import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export interface ThoughtMetadata {
  type: 'observation' | 'task' | 'idea' | 'reference' | 'person_note';
  topics: string[];
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
}

export async function extractMetadata(content: string): Promise<ThoughtMetadata> {
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Extract metadata from this thought. Return JSON only with these exact fields:
- "type": one of "observation", "task", "idea", "reference", "person_note"
- "topics": array of 1-3 short topic tags (always include at least one)
- "people": array of people mentioned (empty array if none)
- "action_items": array of implied to-dos (empty array if none)
- "dates_mentioned": array of dates in YYYY-MM-DD format (empty array if none)

Thought: ${content}`,
    }],
  });
  const text = message.content[0].type === 'text' ? message.content[0].text : '';
  try {
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) {
      return { type: 'observation', topics: ['uncategorized'], people: [], action_items: [], dates_mentioned: [] };
    }
    const parsed = JSON.parse(json) as ThoughtMetadata;
    if (!parsed.type || !parsed.topics) {
      return { type: 'observation', topics: ['uncategorized'], people: [], action_items: [], dates_mentioned: [] };
    }
    return parsed;
  } catch {
    return { type: 'observation', topics: ['uncategorized'], people: [], action_items: [], dates_mentioned: [] };
  }
}
