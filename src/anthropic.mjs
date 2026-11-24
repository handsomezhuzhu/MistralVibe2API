/**
 * Anthropic Messages API <-> OpenAI Chat Completions conversion.
 *
 * The standalone proxy speaks Anthropic on the client side so agents like
 * Claude Code can be pointed at it (ANTHROPIC_BASE_URL), and OpenAI on the
 * upstream side because that is the only protocol Mistral's Vibe endpoint
 * offers.
 */

/* ------------------------------------------------------------------ */
/* Request: Anthropic -> OpenAI                                       */
/* ------------------------------------------------------------------ */

function systemToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => (block?.type === "text" ? (block.text ?? "") : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function toolResultToText(result) {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text") return block.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function userBlocksToContent(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block?.type === "text") {
      parts.push({ type: "text", text: block.text ?? "" });
    } else if (block?.type === "image") {
      const src = block.source;
      if (src?.type === "base64") {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${src.media_type ?? "image/png"};base64,${src.data ?? ""}`,
          },
        });
      } else if (src?.type === "url") {
        parts.push({ type: "image_url", image_url: { url: src.url } });
      }
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

/**
 * Convert an Anthropic /v1/messages request body into an OpenAI
 * /v1/chat/completions request body. Unsupported Anthropic-only knobs
 * (top_k, thinking) are dropped: Mistral's OpenAI surface has no field for
 * them.
 */
export function anthropicRequestToOpenAI(req) {
  const out = {
    model: req.model,
    messages: [],
    stream: !!req.stream,
  };

  const system = systemToText(req.system);
  if (system) out.messages.push({ role: "system", content: system });

  for (const message of req.messages ?? []) {
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content ?? "" }];

    if (message.role === "assistant") {
      const text = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const toolCalls = blocks
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
      const msg = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.messages.push(msg);
      continue;
    }

    // user (tool results become their own tool messages, as OpenAI wants)
    const toolResults = blocks.filter((b) => b?.type === "tool_result");
    for (const result of toolResults) {
      out.messages.push({
        role: "tool",
        tool_call_id: result.tool_call_id,
        content: toolResultToText(result),
      });
    }
    const rest = blocks.filter((b) => b?.type !== "tool_result");
    if (rest.length) {
      out.messages.push({ role: "user", content: userBlocksToContent(rest) });
    }
  }

  if (req.max_tokens != null) out.max_tokens = req.max_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) {
    out.stop = req.stop_sequences;
  }
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  if (req.tool_choice) {
    const choice = req.tool_choice;
    if (choice.type === "auto") out.tool_choice = "auto";
    else if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "tool") {
      out.tool_choice = { type: "function", function: { name: choice.name } };
    } else if (choice.type === "none") out.tool_choice = "none";
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Response: OpenAI -> Anthropic                                      */
/* ------------------------------------------------------------------ */

function mapStopReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
    case "model_length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** Split an OpenAI delta content (string | chunk array) into text + thinking. */
export function splitDeltaContent(content) {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const chunk of content) {
    if (chunk?.type === "text" && typeof chunk.text === "string") {
      text += chunk.text;
    } else if (chunk?.type === "thinking") {
      const items = Array.isArray(chunk.thinking) ? chunk.thinking : [];
      for (const item of items) {
        if (typeof item === "string") thinking += item;
        else if (typeof item?.text === "string") thinking += item.text;
      }
    }
  }
  return { text, thinking };
}

/** Convert a non-streaming OpenAI chat completion into an Anthropic message. */
export function openAIResponseToAnthropic(response, model) {
  const choice = response?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];

  if (message.content) {
    const { text, thinking } = splitDeltaContent(message.content);
    if (thinking) {
      content.push({ type: "thinking", thinking });
    }
    if (text) {
      content.push({ type: "text", text });
    }
  }
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
      name: call.function?.name ?? "",
      input: safeParse(call.function?.arguments),
    });
  }

  return {
    id: response?.id ?? `msg_${Math.random().toString(36).slice(2, 12)}`,
    type: "message",
    role: "assistant",
    content,
    model: model ?? response?.model ?? "unknown",
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response?.usage?.prompt_tokens ?? 0,
      output_tokens: response?.usage?.completion_tokens ?? 0,
    },
  };
}

function safeParse(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Streaming: OpenAI SSE chunks -> Anthropic SSE events               */
/* ------------------------------------------------------------------ */

/**
 * Stateful encoder: feed it parsed OpenAI chunks with push(), flush the tail
 * with end(). Each call returns the Anthropic events that became sendable.
 */
export class AnthropicSSEEncoder {
  constructor(model) {
    this.model = model;
    this.messageId = `msg_${Math.random().toString(36).slice(2, 12)}`;
    this.started = false;
    this.finished = false;
    this.openIndex = -1;
    this.openType = null;
    this.nextIndex = 0;
    this.toolBlocks = new Map(); // openai tool_calls index -> anthropic block
    this.stopReason = null;
    this.usage = { input_tokens: 0, output_tokens: 0 };
  }

  _ensureStarted() {
    if (this.started) return;
    this.started = true;
    return {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.usage.input_tokens, output_tokens: 0 },
      },
    };
  }

  _closeOpen() {
    if (this.openIndex < 0) return null;
    const event = { type: "content_block_stop", index: this.openIndex };
    this.openIndex = -1;
    this.openType = null;
    return event;
  }

  _openBlock(type, contentBlock) {
    const started = this._ensureStarted();
    const closed = this._closeOpen();
    this.openIndex = this.nextIndex++;
    this.openType = type;
    const open = {
      type: "content_block_start",
      index: this.openIndex,
      content_block: contentBlock,
    };
    return [started, closed, open].filter(Boolean);
  }

  _delta(delta) {
    return {
      type: "content_block_delta",
      index: this.openIndex,
      delta,
    };
  }

  push(chunk) {
    const events = [];
    if (!chunk || typeof chunk !== "object") return events;

    if (chunk.usage && typeof chunk.usage === "object") {
      if (chunk.usage.prompt_tokens != null) {
        this.usage.input_tokens = chunk.usage.prompt_tokens;
      }
      if (chunk.usage.completion_tokens != null) {
        this.usage.output_tokens = chunk.usage.completion_tokens;
      }
      if (this.finished) {
        // usage arrived after the finish chunk: let the client see it
        events.push({
          type: "message_delta",
          delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
          usage: { ...this.usage },
        });
      }
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return events;

    const delta = choice.delta ?? {};

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      if (this.openType !== "thinking") {
        events.push(...this._openBlock("thinking", { type: "thinking", thinking: "" }));
      }
      events.push(this._delta({ type: "thinking_delta", thinking: delta.reasoning_content }));
    }

    const { text, thinking } = splitDeltaContent(delta.content);
    if (thinking) {
      if (this.openType !== "thinking") {
        events.push(...this._openBlock("thinking", { type: "thinking", thinking: "" }));
      }
      events.push(this._delta({ type: "thinking_delta", thinking }));
    }
    if (text) {
      if (this.openType !== "text") {
        events.push(...this._openBlock("text", { type: "text", text: "" }));
      }
      events.push(this._delta({ type: "text_delta", text }));
    }

    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0;
      let block = this.toolBlocks.get(key);
      if (!block) {
        const started = this._ensureStarted();
        if (started) events.push(started);
        const closed = this._closeOpen();
        if (closed) events.push(closed);
        block = {
          index: this.nextIndex++,
          id: call.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`,
          name: call.function?.name ?? "",
        };
        this.toolBlocks.set(key, block);
        this.openIndex = block.index;
        this.openType = "tool_use";
        events.push({
          type: "content_block_start",
          index: block.index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        });
      } else if (call.function?.name && !block.name) {
        block.name = call.function.name;
      }
      const args = call.function?.arguments;
      if (args) {
        events.push({
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }

    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      this.stopReason = mapStopReason(choice.finish_reason);
      this.finished = true;
      const closed = this._closeOpen();
      if (closed) events.push(closed);
      events.push({
        type: "message_delta",
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { ...this.usage },
      });
      events.push({ type: "message_stop" });
    }

    return events;
  }

  /** Flush the tail: close any open block and finish the message. */
  end() {
    const events = [];
    if (!this.started) return events;
    if (!this.finished) {
      const closed = this._closeOpen();
      if (closed) events.push(closed);
      events.push({
        type: "message_delta",
        delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
        usage: { ...this.usage },
      });
      events.push({ type: "message_stop" });
      this.finished = true;
    }
    return events;
  }
}

/** Serialize one Anthropic SSE event. */
export function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parse an upstream (OpenAI-style) SSE byte stream, yielding `{ data }` for
 * each event and `{ done: true }` at [DONE].
 */
export async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const dataLines = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (!dataLines.length) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") {
        yield { done: true };
        return;
      }
      try {
        yield { data: JSON.parse(data) };
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
}

/** Keys whose string values are structure, not content. */
const STRUCTURAL_KEYS = new Set([
  "type",
  "role",
  "name",
  "id",
  "model",
  "tool_call_id",
  "tool_use_id",
]);

/** Rough token estimate for /v1/messages/count_tokens. */
export function estimateTokens(body) {
  let text = "";
  const walk = (value) => {
    if (typeof value === "string") text += value;
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (STRUCTURAL_KEYS.has(key)) continue;
        walk(item);
      }
    }
  };
  walk(body);
  return Math.ceil(text.length / 4);
}
