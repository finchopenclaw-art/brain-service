import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockAnthropicCreate = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: '{}' }],
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockAnthropicCreate };
    },
  };
});

const { getEmbedding } = await import('../src/embeddings.js');
const { extractMetadata } = await import('../src/metadata.js');

describe('getEmbedding', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('returns a number array from OpenRouter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });
    const result = await getEmbedding('hello world');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });
    await expect(getEmbedding('test')).rejects.toThrow('Embedding API error: 429');
  });
});

describe('extractMetadata', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
  });

  it('parses JSON from Anthropic response', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"type":"observation","topics":["test"],"people":[],"action_items":[],"dates_mentioned":[]}' }],
    });
    const result = await extractMetadata('test thought');
    expect(result.type).toBe('observation');
    expect(result.topics).toEqual(['test']);
  });

  it('returns defaults when JSON parse fails', async () => {
    mockAnthropicCreate.mockReset();
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json' }],
    });
    const result = await extractMetadata('test');
    expect(result.type).toBe('observation');
    expect(result.topics).toEqual(['uncategorized']);
  });
});
