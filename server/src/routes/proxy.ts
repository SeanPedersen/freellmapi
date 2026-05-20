import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, ChatToolCall, ChatToolDefinition } from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { extractBearerToken, timingSafeStringEqual } from '../lib/secrets.js';

export const proxyRouter: Router = Router();

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL
const responseSessionMap = new Map<string, { messages: ChatMessage[]; lastUsed: number }>();
const responseItemMap = new Map<string, ChatMessage>();
const RESPONSE_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_RESPONSE_SESSIONS = 500;
const MAX_MODEL_RESPONSE_LOG_CHARS = 6000;

function getSessionKey(messages: ChatMessage[]): string {
  // Use the first user message as session identifier — clients like Hermes
  // re-send the full conversation each turn, so the first user message is
  // stable across turns. Hash the FULL message (not a 100-char slice) so
  // distinct conversations with identical openings don't collide.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  return crypto.createHash('sha1').update(firstUser.content).digest('hex');
}

function getStickyModel(messages: ChatMessage[]): number | undefined {
  const key = getSessionKey(messages);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(messages);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

const AUTO_MODEL_ID = 'freellmapi/auto';

proxyRouter.use((req, res, next) => {
  const token = extractBearerToken(req.headers.authorization);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  next();
});

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
proxyRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare('SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = 1 ORDER BY intelligence_rank').all() as any[];
  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto (Smart Router)',
        context_window: 128000,
      },
      ...models.map(m => ({
        id: m.model_id,
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
      })),
    ],
  });
});

// OpenAI-compatible GET /models/:id endpoint
proxyRouter.get(/^\/models\/(.+)$/, (req: Request, res: Response) => {
  const id = (req.params as any)[0] as string;
  if (id === AUTO_MODEL_ID) {
    res.json({ id: AUTO_MODEL_ID, object: 'model', created: 0, owned_by: 'freellmapi' });
    return;
  }
  const db = getDb();
  const model = db.prepare('SELECT platform, model_id, display_name, context_window FROM models WHERE model_id = ? AND enabled = 1').get(id) as any;
  if (!model) {
    res.status(404).json({ error: { message: `Model '${id}' not found`, type: 'invalid_request_error' } });
    return;
  }
  res.json({ id: model.model_id, object: 'model', created: 0, owned_by: model.platform, name: model.display_name, context_window: model.context_window });
});

const MAX_RETRIES = 20;

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.string(),
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  const hasContent = typeof msg.content === 'string' && msg.content.length > 0;
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls;
}, {
  message: 'assistant messages must include non-empty content or tool_calls',
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const responseFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

const responseContentPartSchema = z.object({
  type: z.enum(['input_text', 'output_text', 'text']).optional(),
  text: z.string().optional(),
});

const responseInputMessageSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([
    z.string(),
    z.array(responseContentPartSchema),
  ]),
});

const responseItemReferenceSchema = z.object({
  type: z.literal('item_reference'),
  id: z.string().min(1),
});

const responseFunctionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.unknown(),
});

const responseFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

const responseInputSchema = z.union([
  z.string(),
  z.array(z.union([
    responseInputMessageSchema,
    responseItemReferenceSchema,
    responseFunctionCallSchema,
    responseFunctionCallOutputSchema,
    z.string(),
  ])),
]);

const responseCreateSchema = z.object({
  model: z.string().optional(),
  input: responseInputSchema.optional(),
  instructions: z.string().optional(),
  previous_response_id: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.union([toolDefinitionSchema, responseFunctionToolSchema])).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

type ChatResponseFormatter = (result: ChatCompletionResponse) => unknown;
type ResponseTool = z.infer<typeof responseCreateSchema>['tools'] extends Array<infer T> | undefined ? T : never;
type ResponseInputItem = Exclude<z.infer<typeof responseInputSchema>, string>[number];

function stringifyModelResponseForLog(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return '';
    return serialized.length > MAX_MODEL_RESPONSE_LOG_CHARS
      ? `${serialized.slice(0, MAX_MODEL_RESPONSE_LOG_CHARS)}...`
      : serialized;
  } catch {
    return '[unserializable response]';
  }
}

function logFinalModelResponse(route: RouteResult, response: unknown, ttfbMs: number | null): void {
  const ttfbStr = ttfbMs !== null ? ` | ttfb=${ttfbMs}ms` : '';
  if (process.env.LOG_SENSITIVE_DATA !== 'true') {
    console.log(`[Model Response] ${route.platform}/${route.modelId}${ttfbStr}`);
    return;
  }
  console.log(`[Model Response] ${route.platform}/${route.modelId}${ttfbStr}: ${stringifyModelResponseForLog(response)}`);
}

interface ResponsesStreamContext {
  responseId: string;
  messageId: string;
  createdAt: number;
  messages: ChatMessage[];
  outputText: string;
  textStarted: boolean;
  messageOutputIndex: number | null;
  toolCalls: Map<number, ResponseStreamToolCall>;
  nextOutputIndex: number;
}

interface ResponseStreamToolCall {
  id: string;
  itemId: string;
  outputIndex: number;
  name: string;
  arguments: string;
}

function isChatToolDefinition(tool: ResponseTool): tool is ChatToolDefinition {
  return 'function' in tool;
}

function isResponseFunctionCallOutput(item: ResponseInputItem): item is z.infer<typeof responseFunctionCallOutputSchema> {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call_output';
}

function isResponseFunctionCall(item: ResponseInputItem): item is z.infer<typeof responseFunctionCallSchema> {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call';
}

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 404 from a provider means the model no longer exists/is accessible — fall back
    || msg.includes('404') || msg.includes('no longer available') || msg.includes('model not found');
}

function extractResponseText(content: z.infer<typeof responseInputMessageSchema>['content']): string {
  if (typeof content === 'string') return content;
  return content.map(part => part.text ?? '').join('');
}

function normalizeResponseTools(tools: z.infer<typeof responseCreateSchema>['tools']): ChatToolDefinition[] | undefined {
  if (!tools) return undefined;

  return tools.map((tool): ChatToolDefinition => {
    if (isChatToolDefinition(tool)) return tool;

    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      },
    };
  });
}

function getPreviousResponseMessages(previousResponseId: string | undefined): ChatMessage[] {
  if (!previousResponseId) {
    console.log('[Session] no previous_response_id → fresh conversation');
    return [];
  }
  const session = responseSessionMap.get(previousResponseId);
  if (!session) {
    console.log(`[Session] previous_response_id="${previousResponseId}" not found in map (size=${responseSessionMap.size}) → session miss`);
    return [];
  }
  const ageMs = Date.now() - session.lastUsed;
  if (ageMs > RESPONSE_SESSION_TTL_MS) {
    console.log(`[Session] previous_response_id="${previousResponseId}" expired (age=${Math.round(ageMs / 1000)}s) → evicted`);
    responseSessionMap.delete(previousResponseId);
    return [];
  }
  console.log(`[Session] hit previous_response_id="${previousResponseId}" → restored ${session.messages.length} msg(s) (age=${Math.round(ageMs / 1000)}s)`);
  session.lastUsed = Date.now();
  return session.messages.map(message => ({ ...message }));
}

function saveResponseSession(responseId: string, itemId: string, messages: ChatMessage[], outputText: string, toolCalls?: ChatToolCall[]): void {
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: outputText || null,
    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  const stored = [...messages.map(message => ({ ...message })), assistantMessage];
  responseSessionMap.set(responseId, {
    messages: stored,
    lastUsed: Date.now(),
  });
  console.log(`[Session] saved response_id="${responseId}" with ${stored.length} msg(s) (map size=${responseSessionMap.size})`);
  responseItemMap.set(itemId, assistantMessage);

  if (responseSessionMap.size <= MAX_RESPONSE_SESSIONS) return;

  const now = Date.now();
  for (const [id, session] of responseSessionMap) {
    if (now - session.lastUsed > RESPONSE_SESSION_TTL_MS) {
      responseSessionMap.delete(id);
    }
  }
}

function toChatMessages(
  input: z.infer<typeof responseInputSchema> | undefined,
  instructions?: string,
  previousResponseId?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  messages.push(...getPreviousResponseMessages(previousResponseId));

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input ?? []) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }

    if ('type' in item && item.type === 'item_reference' && typeof item.id === 'string') {
      const referencedMessage = responseItemMap.get(item.id);
      if (referencedMessage) messages.push({ ...referencedMessage });
      continue;
    }

    if (isResponseFunctionCall(item)) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        }],
      });
      continue;
    }

    if (isResponseFunctionCallOutput(item)) {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : (JSON.stringify(item.output) ?? ''),
      });
      continue;
    }

    if (!('role' in item)) continue;

    const role = item.role === 'developer' ? 'system' : item.role;
    messages.push({ role, content: extractResponseText(item.content) });
  }

  return messages;
}

function formatResponseApiResult(result: ChatCompletionResponse, messages: ChatMessage[]): unknown {
  const outputText = result.choices[0]?.message.content ?? '';
  const toolCalls = result.choices[0]?.message.tool_calls ?? [];
  const createdAt = result.created ?? Math.floor(Date.now() / 1000);
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;

  saveResponseSession(responseId, messageId, messages, outputText, toolCalls);
  const output = [
    {
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: outputText,
        annotations: [],
      }],
    },
    ...toolCalls.map(toolCall => ({
      id: `fc_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })),
  ];

  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: result.model,
    output,
    output_text: outputText,
    usage: {
      input_tokens: result.usage?.prompt_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
    },
  };
}

function createResponsesStreamContext(messages: ChatMessage[]): ResponsesStreamContext {
  return {
    responseId: `resp_${crypto.randomUUID().replaceAll('-', '')}`,
    messageId: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: Math.floor(Date.now() / 1000),
    messages,
    outputText: '',
    textStarted: false,
    messageOutputIndex: null,
    toolCalls: new Map(),
    nextOutputIndex: 0,
  };
}

function writeResponseStreamEvent(res: Response, event: Record<string, unknown> & { type: string }): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeResponseStreamStart(res: Response, context: ResponsesStreamContext, model: string): void {
  writeResponseStreamEvent(res, {
    type: 'response.created',
    response: {
      id: context.responseId,
      object: 'response',
      created_at: context.createdAt,
      status: 'in_progress',
      model,
      output: [],
      output_text: '',
    },
  });
}

function ensureResponseTextItem(res: Response, context: ResponsesStreamContext): void {
  if (context.textStarted) return;

  context.textStarted = true;
  context.messageOutputIndex = context.nextOutputIndex++;
  writeResponseStreamEvent(res, {
    type: 'response.output_item.added',
    response_id: context.responseId,
    output_index: context.messageOutputIndex,
    item: {
      id: context.messageId,
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  });
  writeResponseStreamEvent(res, {
    type: 'response.content_part.added',
    response_id: context.responseId,
    item_id: context.messageId,
    output_index: context.messageOutputIndex,
    content_index: 0,
    part: {
      type: 'output_text',
      text: '',
      annotations: [],
    },
  });
}

function writeResponseStreamChunk(res: Response, context: ResponsesStreamContext, chunk: ChatCompletionChunk): number {
  const text = chunk.choices[0]?.delta?.content ?? '';
  const toolCalls = chunk.choices[0]?.delta?.tool_calls ?? [];

  let outputTokens = 0;
  if (text) {
    ensureResponseTextItem(res, context);
    context.outputText += text;
    outputTokens += Math.ceil(text.length / 4);
    writeResponseStreamEvent(res, {
      type: 'response.output_text.delta',
      response_id: context.responseId,
      item_id: context.messageId,
      output_index: context.messageOutputIndex ?? 0,
      content_index: 0,
      delta: text,
    });
  }

  for (const rawToolCall of toolCalls) {
    const toolCall = rawToolCall as ChatToolCall & { index?: number };
    const index = toolCall.index ?? 0;
    let existing = context.toolCalls.get(index);

    if (!existing) {
      existing = {
        id: toolCall.id || `call_${crypto.randomUUID().replaceAll('-', '')}`,
        itemId: `fc_${crypto.randomUUID().replaceAll('-', '')}`,
        outputIndex: context.nextOutputIndex++,
        name: toolCall.function?.name ?? '',
        arguments: '',
      };
      context.toolCalls.set(index, existing);
      writeResponseStreamEvent(res, {
        type: 'response.output_item.added',
        response_id: context.responseId,
        output_index: existing.outputIndex,
        item: {
          id: existing.itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: existing.id,
          name: existing.name,
          arguments: '',
        },
      });
    }

    if (toolCall.id) existing.id = toolCall.id;
    if (toolCall.function?.name) existing.name = toolCall.function.name;

    const argumentDelta = toolCall.function?.arguments ?? '';
    if (!argumentDelta) continue;

    existing.arguments += argumentDelta;
    writeResponseStreamEvent(res, {
      type: 'response.function_call_arguments.delta',
      response_id: context.responseId,
      item_id: existing.itemId,
      output_index: existing.outputIndex,
      call_id: existing.id,
      delta: argumentDelta,
    });
  }

  return outputTokens;
}

function writeResponseStreamEnd(res: Response, context: ResponsesStreamContext, model: string, inputTokens: number, outputTokens: number): void {
  const finalToolCalls = Array.from(context.toolCalls.values());
  const chatToolCalls: ChatToolCall[] = finalToolCalls.map(toolCall => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  }));

  saveResponseSession(context.responseId, context.messageId, context.messages, context.outputText, chatToolCalls);
  const messageOutput = context.textStarted
    ? [{
      id: context.messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: context.outputText,
        annotations: [],
      }],
    }]
    : [];
  const output = [
    ...messageOutput,
    ...finalToolCalls.map(toolCall => ({
      id: toolCall.itemId,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    })),
  ];
  const finalResponse = {
    id: context.responseId,
    object: 'response',
    created_at: context.createdAt,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    model,
    output,
    output_text: context.outputText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  if (context.textStarted) {
    writeResponseStreamEvent(res, {
      type: 'response.output_text.done',
      response_id: context.responseId,
      item_id: context.messageId,
      output_index: context.messageOutputIndex ?? 0,
      content_index: 0,
      text: context.outputText,
    });
    writeResponseStreamEvent(res, {
      type: 'response.output_item.done',
      response_id: context.responseId,
      output_index: context.messageOutputIndex ?? 0,
      item: messageOutput[0],
    });
  }
  for (const toolCall of finalToolCalls) {
    writeResponseStreamEvent(res, {
      type: 'response.function_call_arguments.done',
      response_id: context.responseId,
      item_id: toolCall.itemId,
      output_index: toolCall.outputIndex,
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
    writeResponseStreamEvent(res, {
      type: 'response.output_item.done',
      response_id: context.responseId,
      output_index: toolCall.outputIndex,
      item: {
        id: toolCall.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });
  }
  writeResponseStreamEvent(res, {
    type: 'response.completed',
    response: finalResponse,
  });
}

proxyRouter.post('/responses', async (req: Request, res: Response) => {
  const parsed = responseCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const messages = toChatMessages(parsed.data.input, parsed.data.instructions, parsed.data.previous_response_id);
  if (messages.length === 0) {
    res.status(400).json({
      error: {
        message: 'Invalid request: input or instructions is required',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const responseStreamContext = parsed.data.stream ? createResponsesStreamContext(messages) : undefined;

  await handleChatCompletion(req, res, result => formatResponseApiResult(result, messages), {
    model: parsed.data.model,
    messages,
    temperature: parsed.data.temperature,
    max_tokens: parsed.data.max_output_tokens,
    top_p: parsed.data.top_p,
    stream: parsed.data.stream,
    tools: normalizeResponseTools(parsed.data.tools),
    tool_choice: parsed.data.tool_choice,
    parallel_tool_calls: parsed.data.parallel_tool_calls,
  }, responseStreamContext);
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  await handleChatCompletion(req, res);
});

async function handleChatCompletion(
  req: Request,
  res: Response,
  formatResponse?: ChatResponseFormatter,
  body: unknown = req.body,
  responseStreamContext?: ResponsesStreamContext,
): Promise<void> {
  const start = Date.now();

  // Validate request
  const parsed = chatCompletionSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: rawModel, temperature, max_tokens, top_p, stream, tools, tool_choice, parallel_tool_calls } = parsed.data;
  const requestedModel = rawModel === AUTO_MODEL_ID ? undefined : rawModel;
  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
          thought_signature: tc.thought_signature,
        })) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }

    return {
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce((sum, m) => {
    if (typeof m.content !== 'string') return sum;
    return sum + Math.ceil(m.content.length / 4);
  }, 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const preview = process.env.LOG_SENSITIVE_DATA === 'true' && typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content.slice(0, 120).replace(/\n/g, ' ')
    : '';
  console.log(`[Request] ${rawModel ?? 'auto'} | ${messages.length} msg(s) | stream=${!!stream}${preview ? ` | "${preview}"` : ''}`);

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  if (requestedModel) {
    const db = getDb();
    const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
    if (enabled) {
      preferredModel = enabled.id;
    } else {
      const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
      const reason = disabled ? 'is disabled' : 'is not in the catalog';
      res.status(400).json({
        error: {
          message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }
  } else {
    preferredModel = getStickyModel(messages);
  }

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel);
    } catch (err: any) {
      // No more models available
      if (lastError) {
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${lastError.message}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: { message: err.message, type: 'routing_error' },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        let ttfbMs: number | null = null;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
          );

          for await (const chunk of gen) {
            if (!streamStarted) {
              ttfbMs = Date.now() - start;
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              if (responseStreamContext) {
                writeResponseStreamStart(res, responseStreamContext, route.modelId);
              }
              streamStarted = true;
            }
            if (responseStreamContext) {
              totalOutputTokens += writeResponseStreamChunk(res, responseStreamContext, chunk);
            } else {
              const text = chunk.choices[0]?.delta?.content ?? '';
              totalOutputTokens += Math.ceil(text.length / 4);
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }

          if (!streamStarted) {
            // Upstream returned no chunks — emit minimal successful stream.
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (responseStreamContext) {
              writeResponseStreamStart(res, responseStreamContext, route.modelId);
            }
          }
          if (responseStreamContext) {
            writeResponseStreamEnd(res, responseStreamContext, route.modelId, estimatedInputTokens, totalOutputTokens);
            logFinalModelResponse(route, {
              id: responseStreamContext.responseId,
              object: 'response',
              status: 'completed',
              model: route.modelId,
              output_text: responseStreamContext.outputText,
              tool_calls: Array.from(responseStreamContext.toolCalls.values()).map(toolCall => ({
                call_id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
              })),
              usage: {
                input_tokens: estimatedInputTokens,
                output_tokens: totalOutputTokens,
                total_tokens: estimatedInputTokens + totalOutputTokens,
              },
            }, ttfbMs);
          } else {
            res.write('data: [DONE]\n\n');
            logFinalModelResponse(route, {
              object: 'chat.completion.stream',
              model: route.modelId,
              output_tokens: totalOutputTokens,
            }, ttfbMs);
          }
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId);
          logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, ttfbMs, null);
          return;
        } catch (streamErr: any) {
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try {
              if (responseStreamContext) {
                writeResponseStreamEvent(res, {
                  type: 'response.failed',
                  response: {
                    id: responseStreamContext.responseId,
                    status: 'failed',
                    error: payload.error,
                  },
                });
              } else {
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
                res.write('data: [DONE]\n\n');
              }
              res.end();
            } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, ttfbMs, streamErr.message);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
        );
        const ttfbMs = Date.now() - start;

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        const responseBody = formatResponse ? formatResponse(result) : result;
        res.json(responseBody);
        logFinalModelResponse(route, responseBody, ttfbMs);

        logRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, ttfbMs, null,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, null, err.message);

      if (isRetryableError(err)) {
        // Put this model+key on cooldown and try the next one
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(route.platform, route.modelId, route.keyId, 120_000);
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
}

function logRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  ttfbMs: number | null,
  error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, ttfbMs, error);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
