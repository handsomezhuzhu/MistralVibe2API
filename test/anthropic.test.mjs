import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { Readable } from "node:stream";

import {
  AnthropicSSEEncoder,
  anthropicRequestToOpenAI,
  estimateTokens,
  openAIResponseToAnthropic,
  openAIUsageToAnthropic,
  parseSSE,
  sseEvent,
  splitDeltaContent,
} from "../src/anthropic.mjs";

/* ---------------------------- requests ---------------------------- */

test("anthropicRequestToOpenAI converts a simple text conversation", () => {
  const out = anthropicRequestToOpenAI({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: "You are terse.",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.model, "claude-sonnet-4-5");
  assert.equal(out.max_tokens, 1024);
  assert.equal(out.stream, false);
  assert.deepEqual(out.messages, [
    { role: "system", content: "You are terse." },
    { role: "user", content: "hi" },
  ]);
});

test("anthropicRequestToOpenAI converts system blocks, images and stop sequences", () => {
  const out = anthropicRequestToOpenAI({
    model: "m",
    system: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA" },
          },
        ],
      },
    ],
    stop_sequences: ["END"],
    temperature: 0.3,
    top_p: 0.9,
  });
  assert.equal(out.messages[0].content, "one\n\ntwo");
  const userContent = out.messages[1].content;
  assert.equal(userContent[0].type, "text");
  assert.equal(userContent[1].type, "image_url");
  assert.equal(userContent[1].image_url.url, "data:image/png;base64,AAA");
  assert.deepEqual(out.stop, ["END"]);
  assert.equal(out.temperature, 0.3);
  assert.equal(out.top_p, 0.9);
});

test("anthropicRequestToOpenAI converts tool_use and tool_result", () => {
  const out = anthropicRequestToOpenAI({
    model: "m",
    messages: [
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_call_id: "toolu_1", content: "18°C" },
        ],
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
    tool_choice: { type: "tool", name: "get_weather" },
  });

  assert.equal(out.messages[1].role, "assistant");
  assert.equal(out.messages[1].content, "checking");
  assert.equal(out.messages[1].tool_calls[0].id, "toolu_1");
  assert.equal(out.messages[1].tool_calls[0].function.name, "get_weather");
  assert.equal(out.messages[1].tool_calls[0].function.arguments, '{"city":"Paris"}');

  assert.deepEqual(out.messages[2], {
    role: "tool",
    tool_call_id: "toolu_1",
    content: "18°C",
  });

  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "get_weather");
  assert.deepEqual(out.tools[0].function.parameters, {
    type: "object",
    properties: { city: { type: "string" } },
  });
  assert.deepEqual(out.tool_choice, {
    type: "function",
    function: { name: "get_weather" },
  });
});

test("anthropicRequestToOpenAI maps tool_choice variants", () => {
  const base = { model: "m", messages: [] };
  assert.equal(anthropicRequestToOpenAI({ ...base, tool_choice: { type: "auto" } }).tool_choice, "auto");
  assert.equal(anthropicRequestToOpenAI({ ...base, tool_choice: { type: "any" } }).tool_choice, "required");
  assert.equal(anthropicRequestToOpenAI({ ...base, tool_choice: { type: "none" } }).tool_choice, "none");
});

/* ---------------------------- responses --------------------------- */

test("openAIResponseToAnthropic converts text and tool calls", () => {
  const message = openAIResponseToAnthropic(
    {
      id: "cmpl-1",
      model: "mistral-medium-latest",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "let me check",
            tool_calls: [
              { id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    },
    "claude-sonnet-4-5"
  );
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.model, "claude-sonnet-4-5");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content[0], { type: "text", text: "let me check" });
  assert.deepEqual(message.content[1], {
    type: "tool_use",
    id: "call_1",
    name: "get_weather",
    input: { city: "Paris" },
  });
  assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 7 });
});

test("splitDeltaContent handles Mistral's chunked deltas", () => {
  const { text, thinking } = splitDeltaContent([
    { type: "thinking", thinking: [{ type: "text", text: "hmm" }] },
    { type: "text", text: "hello" },
  ]);
  assert.equal(text, "hello");
  assert.equal(thinking, "hmm");
  assert.deepEqual(splitDeltaContent("plain"), { text: "plain", thinking: "" });
});

/* ----------------------------- streaming -------------------------- */

test("AnthropicSSEEncoder emits a full text stream", () => {
  const encoder = new AnthropicSSEEncoder("claude-sonnet-4-5");
  const events = [
    ...encoder.push({
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
    ...encoder.push({
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    }),
    ...encoder.push({
      choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
    }),
    ...encoder.push({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    ...encoder.end(),
  ];

  assert.equal(events[0].type, "message_start");
  assert.equal(events[0].message.role, "assistant");
  assert.equal(events[1].type, "content_block_start");
  assert.equal(events[1].content_block.type, "text");
  const texts = events
    .filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta")
    .map((e) => e.delta.text);
  assert.equal(texts.join(""), "Hello world");
  const stop = events.find((e) => e.type === "content_block_stop");
  assert.ok(stop);
  const messageDelta = events.find((e) => e.type === "message_delta");
  assert.equal(messageDelta.delta.stop_reason, "end_turn");
  assert.deepEqual(messageDelta.usage, { input_tokens: 5, output_tokens: 2 });
  assert.equal(events[events.length - 1].type, "message_stop");
});

test("AnthropicSSEEncoder emits tool_use blocks with json deltas", () => {
  const encoder = new AnthropicSSEEncoder("m");
  const events = [
    ...encoder.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    ...encoder.push({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
          finish_reason: null,
        },
      ],
    }),
    ...encoder.push({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
          finish_reason: null,
        },
      ],
    }),
    ...encoder.push({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
    ...encoder.end(),
  ];

  const start = events.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
  assert.ok(start);
  assert.equal(start.content_block.id, "call_1");
  assert.equal(start.content_block.name, "get_weather");
  const partial = events
    .filter((e) => e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json);
  assert.equal(partial.join(""), '{"city":"Paris"}');
  const messageDelta = events.find((e) => e.type === "message_delta");
  assert.equal(messageDelta.delta.stop_reason, "tool_use");
});

test("AnthropicSSEEncoder keeps thinking blocks separate from text", () => {
  const encoder = new AnthropicSSEEncoder("m");
  const events = [
    ...encoder.push({
      choices: [
        {
          index: 0,
          delta: { content: [{ type: "thinking", thinking: [{ text: "plan" }] }] },
          finish_reason: null,
        },
      ],
    }),
    ...encoder.push({
      choices: [{ index: 0, delta: { content: [{ type: "text", text: "answer" }] }, finish_reason: null }],
    }),
    ...encoder.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ...encoder.end(),
  ];

  const types = events.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type);
  assert.deepEqual(types, ["thinking", "text"]);
  const thinkingDelta = events.find((e) => e.delta?.type === "thinking_delta");
  assert.equal(thinkingDelta.delta.thinking, "plan");
});

test("AnthropicSSEEncoder emits a late usage correction after finish", () => {
  const encoder = new AnthropicSSEEncoder("m");
  const events = [
    ...encoder.push({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
    ...encoder.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ...encoder.push({ usage: { prompt_tokens: 11, completion_tokens: 3 } }),
    ...encoder.end(),
  ];
  const lastUsage = events.filter((e) => e.type === "message_delta").pop();
  assert.deepEqual(lastUsage.usage, { input_tokens: 11, output_tokens: 3 });
});

test("parseSSE yields data objects and stops at [DONE]", async () => {
  const sse =
    "data: {\"a\":1}\n\n" +
    ": keep-alive\n\n" +
    "data: {\"b\":2}\n\n" +
    "data: [DONE]\n\n";
  const seen = [];
  for await (const event of parseSSE(Readable.from([Buffer.from(sse)]))) {
    seen.push(event);
  }
  assert.deepEqual(seen, [{ data: { a: 1 } }, { data: { b: 2 } }, { done: true }]);
});

test("parseSSE handles CRLF line endings split across chunks", async () => {
  const parts = [
    Buffer.from("data: {\"a\":"),
    Buffer.from("1}\r\n\r\ndata: [DONE]\r\n\r\n"),
  ];
  const seen = [];
  for await (const event of parseSSE(Readable.from(parts))) seen.push(event);
  assert.deepEqual(seen, [{ data: { a: 1 } }, { done: true }]);
});

test("sseEvent serializes Anthropic events", () => {
  assert.equal(
    sseEvent({ type: "message_stop" }),
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
  );
});

test("estimateTokens counts roughly", () => {
  const tokens = estimateTokens({
    system: "a".repeat(400),
    messages: [{ role: "user", content: "b".repeat(400) }],
  });
  assert.ok(tokens > 150 && tokens < 250, `got ${tokens}`);
});

test("openAIUsageToAnthropic maps cache hits and cache writes", () => {
  const usage = openAIUsageToAnthropic({
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
    completion_tokens_details: { reasoning_tokens: 5 },
  });
  assert.deepEqual(usage, {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 30,
  });
});

test("openAIResponseToAnthropic carries the cache fields", () => {
  const message = openAIResponseToAnthropic({
    id: "c1",
    model: "m",
    choices: [{ finish_reason: "stop", message: { content: "hi" } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
    },
  });
  assert.equal(message.usage.cache_read_input_tokens, 60);
  assert.equal(message.usage.cache_creation_input_tokens, 30);
});

test("AnthropicSSEEncoder reports cache fields in usage events", () => {
  const encoder = new AnthropicSSEEncoder("m");
  const events = [
    ...encoder.push({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
    ...encoder.push({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
      },
    }),
    ...encoder.end(),
  ];
  const messageDelta = events.find((e) => e.type === "message_delta");
  assert.equal(messageDelta.usage.cache_read_input_tokens, 60);
  assert.equal(messageDelta.usage.cache_creation_input_tokens, 30);
});
