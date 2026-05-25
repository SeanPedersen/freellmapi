import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(path.startsWith('/v1/') ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('Proxy tool-calling support', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_proxy_tool_test',
      label: 'proxy-tools',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes tools/tool_choice to provider and returns tool_calls', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-tool',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Karachi"}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      // No `model` → auto-route via fallback chain.
      messages: [{ role: 'user', content: 'What is the weather in Karachi?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      }],
      tool_choice: 'required',
    });

    expect(status).toBe(200);
    expect(providerBody.tools).toHaveLength(1);
    expect(providerBody.tool_choice).toBe('required');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('falls back to another model when the first auto-route returns 400', async () => {
    const origFetch = global.fetch;
    let firstModel: string | null = null;
    const seenModels: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const body = JSON.parse((init as any).body);
      seenModels.push(body.model);

      if (firstModel === null) {
        firstModel = body.model;
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: () => Promise.resolve({ error: { message: 'unsupported field' } }),
          text: () => Promise.resolve(JSON.stringify({ error: { message: 'unsupported field' } })),
        } as any;
      }

      if (body.model === firstModel) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: () => Promise.resolve({ error: { message: 'unsupported field' } }),
          text: () => Promise.resolve(JSON.stringify({ error: { message: 'unsupported field' } })),
        } as any;
      }

      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-fallback',
          object: 'chat.completion',
          created: 123,
          model: body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'fallback ok' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      } as any;
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Say fallback test.' }],
    });

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('fallback ok');
    expect(seenModels.length).toBeGreaterThan(1);
    expect(new Set(seenModels).size).toBeGreaterThan(1);
  });

  it('retries when a provider returns an empty assistant message', async () => {
    const origFetch = global.fetch;
    const seenModels: string[] = [];
    let firstAttempt = true;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const body = JSON.parse((init as any).body);
      seenModels.push(body.model);

      if (firstAttempt) {
        firstAttempt = false;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-empty',
            object: 'chat.completion',
            created: 123,
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: '' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
          }),
        } as any;
      }

      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-retry',
          object: 'chat.completion',
          created: 123,
          model: body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'recovered answer' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      } as any;
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Say something useful.' }],
    });

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('recovered answer');
    expect(seenModels.length).toBeGreaterThan(1);
    expect(new Set(seenModels).size).toBeGreaterThan(1);
  });

  it('retries streaming requests when the provider emits no assistant output', async () => {
    const origFetch = global.fetch;
    const seenModels: string[] = [];
    let firstAttempt = true;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const body = JSON.parse((init as any).body);
      seenModels.push(body.model);

      if (firstAttempt) {
        firstAttempt = false;
        const encoder = new TextEncoder();
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
        } as any;
      }

      const chunks = [
        {
          id: 'chunk-1',
          object: 'chat.completion.chunk',
          created: 123,
          model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'streamed answer' }, finish_reason: 'stop' }],
        },
      ];
      const encoder = new TextEncoder();
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as any;
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Say something useful.' }],
      stream: true,
    });

    expect(status).toBe(200);
    expect(raw).toContain('streamed answer');
    expect(seenModels.length).toBeGreaterThan(1);
    expect(new Set(seenModels).size).toBeGreaterThan(1);
  });

  it('accepts assistant tool_calls + tool messages in follow-up turns', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-final',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'It is 30C in Karachi.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'Weather in Karachi?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_weather_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Karachi"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_weather_1',
          content: '{"temp_c":30}',
        },
      ],
    });

    expect(status).toBe(200);
    expect(providerBody.messages[1].role).toBe('assistant');
    expect(providerBody.messages[1].content).toBeNull();
    expect(providerBody.messages[1].tool_calls).toHaveLength(1);
    expect(providerBody.messages[2].role).toBe('tool');
    expect(providerBody.messages[2].tool_call_id).toBe('call_weather_1');
    expect(body.choices[0].message.content).toContain('30C');
  });

  it('accepts Responses API text input and returns response output_text', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-response',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'pong',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/responses', {
      model: 'freellmapi/auto',
      instructions: 'Answer briefly.',
      input: 'ping',
      max_output_tokens: 12,
    });

    expect(status).toBe(200);
    expect(providerBody.messages).toEqual([
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'ping' },
    ]);
    expect(providerBody.max_tokens).toBe(12);
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.output_text).toBe('pong');
    expect(body.output[0].content[0].text).toBe('pong');
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(2);
  });

  it('carries Responses API context via previous_response_id', async () => {
    const origFetch = global.fetch;
    const providerBodies: any[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBodies.push(JSON.parse((init as any).body));
        const answer = providerBodies.length === 1 ? 'first answer' : 'second answer';
        return {
          ok: true,
          json: () => Promise.resolve({
            id: `chatcmpl-response-${providerBodies.length}`,
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: answer,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const first = await request(app, 'POST', '/v1/responses', {
      model: 'freellmapi/auto',
      input: 'remember alpha',
    });
    expect(first.status).toBe(200);

    const second = await request(app, 'POST', '/v1/responses', {
      model: 'freellmapi/auto',
      previous_response_id: first.body.id,
      input: 'what did I ask you to remember?',
    });

    expect(second.status).toBe(200);
    expect(providerBodies[1].messages).toEqual([
      { role: 'user', content: 'remember alpha' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'what did I ask you to remember?' },
    ]);
    expect(second.body.output_text).toBe('second answer');
  });

  it('drops empty assistant turns from Responses history so follow-ups still route', async () => {
    const origFetch = global.fetch;
    const providerBodies: any[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBodies.push(JSON.parse((init as any).body));
        const content = providerBodies.length === 1 ? '' : 'follow-up ok';
        return {
          ok: true,
          json: () => Promise.resolve({
            id: `chatcmpl-empty-${providerBodies.length}`,
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const first = await request(app, 'POST', '/v1/responses', {
      model: 'freellmapi/auto',
      input: 'remember the blank turn',
    });
    expect(first.status).toBe(200);
    expect(first.body.output_text).toBe('follow-up ok');

    const second = await request(app, 'POST', '/v1/responses', {
      model: 'freellmapi/auto',
      previous_response_id: first.body.id,
      input: 'continue',
    });

    expect(second.status).toBe(200);
    expect(providerBodies[2].messages).toEqual([
      { role: 'user', content: 'remember the blank turn' },
      { role: 'assistant', content: 'follow-up ok' },
      { role: 'user', content: 'continue' },
    ]);
    expect(second.body.output_text).toBe('follow-up ok');
  });

  it('streams Responses API text deltas with flat function tools', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        const chunks = [
          {
            id: 'chunk-1',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }],
          },
          {
            id: 'chunk-2',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
          },
        ];
        const encoder = new TextEncoder();
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              for (const value of chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).concat('data: [DONE]\n\n')) {
                controller.enqueue(encoder.encode(value));
              }
              controller.close();
            },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getUnifiedApiKey()}`,
      },
      body: JSON.stringify({
        model: 'freellmapi/auto',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        stream: true,
        tools: [{
          type: 'function',
          name: 'transcribe',
          description: 'Transcribe a YouTube video using its URL.',
          parameters: {
            type: 'object',
            properties: { youtube_video_url: { type: 'string' } },
            required: ['youtube_video_url'],
          },
        }],
        tool_choice: 'auto',
      }),
    });
    const text = await res.text();
    server.close();

    expect(res.status).toBe(200);
    expect(providerBody.stream).toBe(true);
    expect(providerBody.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'transcribe',
        description: 'Transcribe a YouTube video using its URL.',
        parameters: {
          type: 'object',
          properties: { youtube_video_url: { type: 'string' } },
          required: ['youtube_video_url'],
        },
      },
    });
    expect(text).toContain('event: response.output_text.delta');
    expect(text).toContain('"delta":"hel"');
    expect(text).toContain('"output_text":"hello"');
    expect(text).toContain('event: response.completed');
  });

  it('streams Responses API function calls and accepts function outputs', async () => {
    const origFetch = global.fetch;
    const providerBodies: any[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBodies.push(JSON.parse((init as any).body));

        if (providerBodies.length === 1) {
          const chunks = [
            {
              id: 'chunk-tool-1',
              object: 'chat.completion.chunk',
              created: 123,
              model: 'openai/gpt-oss-120b',
              choices: [{
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{
                    index: 0,
                    id: 'call_transcribe',
                    type: 'function',
                    function: { name: 'transcribe', arguments: '{"youtube_video_url":"' },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: 'chunk-tool-2',
              object: 'chat.completion.chunk',
              created: 123,
              model: 'openai/gpt-oss-120b',
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    type: 'function',
                    function: { arguments: 'https://youtu.be/iVFXmqElh_Q"}' },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            },
          ];
          const encoder = new TextEncoder();
          return {
            ok: true,
            body: new ReadableStream({
              start(controller) {
                for (const value of chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).concat('data: [DONE]\n\n')) {
                  controller.enqueue(encoder.encode(value));
                }
                controller.close();
              },
            }),
          } as any;
        }

        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-after-tool',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'Video summary.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const server = app.listen(0);
    const addr = server.address() as any;
    const first = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getUnifiedApiKey()}`,
      },
      body: JSON.stringify({
        model: 'freellmapi/auto',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'https://youtu.be/iVFXmqElh_Q' }] }],
        stream: true,
        tools: [{
          type: 'function',
          name: 'transcribe',
          parameters: {
            type: 'object',
            properties: { youtube_video_url: { type: 'string' } },
            required: ['youtube_video_url'],
          },
        }],
        tool_choice: 'auto',
      }),
    });
    const firstText = await first.text();
    const responseId = firstText.match(/"id":"(resp_[^"]+)"/)?.[1];
    server.close();

    expect(first.status).toBe(200);
    expect(firstText).toContain('event: response.function_call_arguments.delta');
    expect(firstText).toContain('event: response.function_call_arguments.done');
    expect(firstText).toContain('event: response.output_item.done');
    expect(firstText).toContain('"type":"function_call"');
    expect(firstText).toContain('"output_index":0');
    expect(firstText).toContain('"call_id":"call_transcribe"');
    expect(firstText).toContain('https://youtu.be/iVFXmqElh_Q');
    expect(firstText).not.toContain('"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":""');
    expect(responseId).toBeDefined();

    const second = await request(app, 'POST', '/v1/responses', {
      model: 'freellmapi/auto',
      previous_response_id: responseId,
      input: [{
        type: 'function_call_output',
        call_id: 'call_transcribe',
        output: 'Transcript text.',
      }],
    });

    expect(second.status).toBe(200);
    expect(providerBodies[1].messages.at(-2)).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_transcribe',
        type: 'function',
        function: {
          name: 'transcribe',
          arguments: '{"youtube_video_url":"https://youtu.be/iVFXmqElh_Q"}',
        },
      }],
    });
    expect(providerBodies[1].messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_transcribe',
      content: 'Transcript text.',
    });

    const replayed = await request(app, 'POST', '/v1/responses', {
      model: 'freellmapi/auto',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'https://youtu.be/iVFXmqElh_Q' }] },
        {
          type: 'function_call',
          call_id: 'call_transcribe_replay',
          name: 'transcribe',
          arguments: '{"youtube_video_url":"https://youtu.be/iVFXmqElh_Q"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_transcribe_replay',
          output: 'Transcript text.',
        },
      ],
    });

    expect(replayed.status).toBe(200);
    expect(providerBodies[2].messages.at(-2)).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_transcribe_replay',
        type: 'function',
        function: {
          name: 'transcribe',
          arguments: '{"youtube_video_url":"https://youtu.be/iVFXmqElh_Q"}',
        },
      }],
    });
    expect(providerBodies[2].messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_transcribe_replay',
      content: 'Transcript text.',
    });
  });
});
