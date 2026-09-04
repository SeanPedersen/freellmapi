import { describe, expect, it } from 'vitest';
import { getSessionKey } from '../../routes/proxy.js';

const messages = [{ role: 'user' as const, content: 'Repeat this prompt.' }];

describe('proxy sticky sessions', () => {
  it('uses a supplied client session ID instead of the first prompt', () => {
    expect(getSessionKey(messages, 'smart', 'playground-chat-a'))
      .not.toBe(getSessionKey(messages, 'smart', 'playground-chat-b'));
  });

  it('preserves first-prompt session keys for clients without an ID', () => {
    expect(getSessionKey(messages, 'smart')).toBe(getSessionKey(messages, 'smart'));
  });
});
