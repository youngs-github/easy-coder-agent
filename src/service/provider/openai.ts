import { ApiError } from "../../utils/errors.js";
import type {
  Message,
  MessageContent,
  StreamEvent,
  Tool,
} from "../../types.js";
import type { Provider, ProviderCallOptions, ProviderResponse } from "./types.js";

const API_TIMEOUT_MS = 60000;

// --- Message format conversion ---

function formatMessagesForOpenAI(
  messages: Message[],
  systemPrompt: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  // Deduplicate tool call IDs across turns: keep originals, only suffix duplicates
  const usedIds = new Set<string>();
  const idMap = new Map<string, string>(); // original → latest remapped id
  let dupCounter = 0;

  // tool_use: keep original id, only remap if it collides with a previously used id
  const assignId = (original: string): string => {
    if (usedIds.has(original)) {
      const uid = `${original}_d${dupCounter++}`;
      idMap.set(original, uid);
      usedIds.add(uid);
      return uid;
    }
    usedIds.add(original);
    // Track the original so tool_result can find it if it was remapped in a previous turn
    idMap.set(original, original);
    return original;
  };

  // tool_result: resolve to the id used in the preceding assistant message
  const resolveId = (original: string): string => {
    return idMap.get(original) ?? original;
  };

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const m of messages) {
    if (typeof m.content === "string") {
      result.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const blocks = m.content as MessageContent[];
      const textParts = blocks.filter((b) => b.type === "text");
      const toolUseParts = blocks.filter((b) => b.type === "tool_use");

      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content =
        textParts
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("") || null;

      if (toolUseParts.length > 0) {
        msg.tool_calls = toolUseParts.map((b) => {
          const tu = b as {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          };
          return {
            id: assignId(tu.id),
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input),
            },
          };
        });
      }

      result.push(msg);
      continue;
    }

    // User message — may contain tool_result blocks
    if (m.role === "user") {
      const blocks = m.content as MessageContent[];
      const toolResults = blocks.filter((b) => b.type === "tool_result");

      if (toolResults.length > 0) {
        const nonToolParts = blocks.filter((b) => b.type !== "tool_result");
        if (nonToolParts.length > 0) {
          const text = nonToolParts
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join("\n");
          if (text) result.push({ role: "user", content: text });
        }
        for (const tr of toolResults) {
          const t = tr as {
            type: "tool_result";
            tool_use_id: string;
            content: string;
          };
          result.push({
            role: "tool",
            tool_call_id: resolveId(t.tool_use_id),
            content: t.content,
          });
        }
      } else {
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("\n");
        result.push({ role: "user", content: text });
      }
    }
  }

  return result;
}

function buildToolSchemasOpenAI(
  tools: Tool[],
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.definition.name,
      description: t.definition.description,
      parameters: t.definition.input_schema,
    },
  }));
}

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return reason ?? "";
  }
}

// --- OpenAI Provider ---

export class OpenAIProvider implements Provider {
  async call(options: ProviderCallOptions): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 16384,
      messages: formatMessagesForOpenAI(
        options.messages,
        options.systemPrompt,
      ),
      stream: true,
    };

    if (options.tools.length > 0) {
      body.tools = buildToolSchemasOpenAI(options.tools);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    const onParentAbort = () => controller.abort();
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }

    let response: Response;
    try {
      response = await fetch(`${options.apiUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        throw new Error("请求超时（60秒）");
      }
      throw new Error(`网络错误: ${err.message}`, err);
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ApiError(response.status, response.statusText, errorBody);
    }

    const contentType = response.headers.get("content-type") ?? "";

    // Non-streaming JSON response
    if (contentType.includes("application/json")) {
      return this.parseJsonResponse(await response.text(), options);
    }

    // SSE streaming response — collect content AND emit normalized events
    const content: MessageContent[] = [];
    let stopReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;

    let textAccum = "";
    let textStarted = false;
    let blockIdx = 0;
    let textBlockIdx = -1;

    const toolCallMap: Map<
      number,
      { id: string; name: string; arguments: string; blockIdx: number }
    > = new Map();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const closeTextBlock = () => {
      if (!textStarted) return;
      if (options.onEvent) {
        options.onEvent({ type: "content_block_stop", index: textBlockIdx });
      }
      content.push({ type: "text", text: textAccum });
      textStarted = false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        // Non-standard error in SSE stream
        if (chunk.error && !chunk.choices) {
          throw new ApiError(429, "Rate Limit", JSON.stringify(chunk.error));
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text content
        if (delta?.content) {
          if (!textStarted) {
            textBlockIdx = blockIdx++;
            textStarted = true;
            if (options.onEvent) {
              options.onEvent({
                type: "content_block_start",
                index: textBlockIdx,
                content_block: { type: "text" },
              });
            }
          }
          textAccum += delta.content;
          if (options.onEvent) {
            options.onEvent({
              type: "content_block_delta",
              index: textBlockIdx,
              delta: { type: "text_delta", text: delta.content },
            });
          }
        }

        // Tool calls
        if (delta?.tool_calls) {
          closeTextBlock();

          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;

            if (tc.id) {
              // New tool call
              const bIdx = blockIdx++;
              toolCallMap.set(idx, {
                id: tc.id,
                name: tc.function?.name ?? "",
                arguments: "",
                blockIdx: bIdx,
              });
              if (options.onEvent) {
                options.onEvent({
                  type: "content_block_start",
                  index: bIdx,
                  content_block: {
                    type: "tool_use",
                    id: tc.id,
                    name: tc.function?.name ?? "",
                  },
                });
              }
            }

            if (tc.function?.arguments) {
              const builder = toolCallMap.get(idx);
              if (builder) {
                builder.arguments += tc.function.arguments;
                if (options.onEvent) {
                  options.onEvent({
                    type: "content_block_delta",
                    index: builder.blockIdx,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments,
                    },
                  });
                }
              }
            }
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          closeTextBlock();

          // Close all tool call blocks and build content
          for (const [, builder] of toolCallMap) {
            if (options.onEvent) {
              options.onEvent({
                type: "content_block_stop",
                index: builder.blockIdx,
              });
            }

            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(builder.arguments || "{}");
            } catch {
              /* empty */
            }
            content.push({
              type: "tool_use",
              id: builder.id,
              name: builder.name,
              input,
            });
          }

          stopReason = mapFinishReason(choice.finish_reason);
        }
      }
    }

    // Safety: close text block if stream ended without finish_reason
    closeTextBlock();

    // Build tool_use content blocks (only if not already built in finish_reason)
    if (toolCallMap.size > 0 && !content.some((b) => b.type === "tool_use")) {
      for (const [, builder] of toolCallMap) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(builder.arguments || "{}");
        } catch {
          /* empty */
        }
        content.push({
          type: "tool_use",
          id: builder.id,
          name: builder.name,
          input,
        });
      }
    }

    return { content, stopReason, usage: { inputTokens, outputTokens } };
  }

  private parseJsonResponse(
    body: string,
    options: ProviderCallOptions,
  ): ProviderResponse {
    const data = JSON.parse(body);
    const choice = data.choices?.[0];

    const content: MessageContent[] = [];

    if (choice?.message?.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          /* empty */
        }
        content.push({
          type: "tool_use",
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          input,
        });
      }
    }

    const stopReason = mapFinishReason(choice?.finish_reason ?? null);
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;

    // Emit events for stream handler compatibility
    if (options.onEvent && content.length > 0) {
      let idx = 0;
      for (const block of content) {
        options.onEvent({
          type: "content_block_start",
          index: idx,
          content_block: { type: block.type, id: (block as any).id, name: (block as any).name },
        });
        if (block.type === "text") {
          options.onEvent({
            type: "content_block_delta",
            index: idx,
            delta: { type: "text_delta", text: (block as { text: string }).text },
          });
        }
        options.onEvent({ type: "content_block_stop", index: idx });
        idx++;
      }
    }

    return { content, stopReason, usage: { inputTokens, outputTokens } };
  }
}
