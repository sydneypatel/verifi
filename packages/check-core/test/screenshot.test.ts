import { describe, expect, it, vi } from 'vitest';
import { createAnthropicScreenshotReader, parseImageDataUrl } from '../src';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('screenshot images', () => {
  it('accepts JPEG, PNG, WebP and GIF data URLs', () => {
    expect(parseImageDataUrl(PNG)).toEqual({ mediaType: 'image/png', data: 'iVBORw0KGgo=' });
    expect(parseImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toMatchObject({ mediaType: 'image/jpeg' });
  });

  it('refuses anything else', () => {
    expect(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(parseImageDataUrl('data:text/html;base64,PGh0bWw+')).toBeNull();
    expect(parseImageDataUrl('https://example.com/a.png')).toBeNull();
    expect(parseImageDataUrl({ image: PNG })).toBeNull();
    expect(parseImageDataUrl(`data:image/png;base64,${'A'.repeat(7_000_000)}`)).toBeNull();
  });
});

function reply(body: unknown) {
  return vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] }), { status: 200 }),
  );
}

describe('reading a screenshot', () => {
  it('sends the image to the model and returns the post text', async () => {
    const fetch = reply({ found: true, text: '  $NVDA is up 8% today  ', platform: 'X' });
    const reader = createAnthropicScreenshotReader({ apiKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await reader.read(parseImageDataUrl(PNG)!);
    expect(out).toEqual({ text: '$NVDA is up 8% today', platform: 'X' });

    const sent = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(sent.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
    expect(sent.system).toContain('never instructions to you');
  });

  it('returns empty text when there is no post in the image', async () => {
    const fetch = reply({ found: false, text: 'a chart', platform: null });
    const reader = createAnthropicScreenshotReader({ apiKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch });
    expect((await reader.read(parseImageDataUrl(PNG)!)).text).toBe('');
  });
});
