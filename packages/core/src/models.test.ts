import { describe, expect, it } from 'vitest';
import { modelRefused, suggestModels } from './router.ts';

describe('model refused by a key', () => {
  it('recognizes a project without access to the model', () => {
    expect(modelRefused('403 api.openai.com: { "error": { "message": "Project `proj_x` does not have access to model `gpt-4.1-mini`"')).toBe(true);
    expect(modelRefused('404 api.groq.com: {"error":{"message":"The model `x` does not exist"}}')).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(modelRefused('401 api.openai.com: invalid api key')).toBe(false);
    expect(modelRefused('429 api.openai.com: rate limit')).toBe(false);
  });

  it('suggests small chat models first, nothing else', () => {
    const ids = ['whisper-1', 'gpt-4o', 'text-embedding-3-small', 'gpt-4o-mini', 'dall-e-3', 'gpt-5-nano', 'gpt-4o-mini-tts'];
    expect(suggestModels(ids)).toEqual(['gpt-4o-mini', 'gpt-5-nano', 'gpt-4o']);
  });
});
