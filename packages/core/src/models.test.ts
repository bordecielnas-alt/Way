import { describe, expect, it } from 'vitest';
import { wikipedia } from '@way/providers';
import { aiLabel, modelRefused, suggestModels } from './router.ts';

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

describe('the AI named for the visitor', () => {
  it('says the model, and the service when the model does not', () => {
    expect(aiLabel('gemini-flash', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(aiLabel('groq', 'openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b via groq');
    expect(aiLabel('ollama', null)).toBe('ollama');
  });

  it('captions a picture with its Commons description, as text, a sentence or two', () => {
    expect(wikipedia.describePicture({ ImageDescription: { value: '<p>Le <i>Titanic</i> quittant&nbsp;Southampton</p>' } })).toBe('Le Titanic quittant Southampton');
    expect(wikipedia.describePicture({ ObjectName: { value: 'Carpathia' } })).toBe('Carpathia');
    expect(wikipedia.describePicture({})).toBeNull();
    const long = `${'Une longue description du navire au port. '.repeat(8)}`;
    expect(wikipedia.describePicture({ ImageDescription: { value: long } })!.length).toBeLessThanOrEqual(180);
  });
});
