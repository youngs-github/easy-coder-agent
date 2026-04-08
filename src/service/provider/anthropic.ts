import { ApiError } from "../../utils/errors.js";
import type {
  Message,
  MessageContent,
  StreamEvent,
  Tool,
} from "../../types.js";
import type {
  Provider,
  ProviderCallOptions,
  ProviderResponse,
} from "./types.js";

const API_TIMEOUT_MS = 60000;

function formatMessagesForApi(messages: Message[]): Array<{
  role: string;
  content: string | Array<Record<string, unknown>>;
}> {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }
    const blocks = m.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "thinking":
          return { type: "thinking", thinking: block.thinking };
        case "tool_use":
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
            ...(block.is_error ? { is_error: true } : {}),
          };
        default:
          return block;
      }
    });
    return { role: m.role, content: blocks };
  });
}

function buildToolSchemas(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.definition.name,
    description: t.definition.description,
    input_schema: t.definition.input_schema,
  }));
}

export class AnthropicProvider implements Provider {
  async call(options: ProviderCallOptions): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 16384,
      system: options.systemPrompt,
      messages: formatMessagesForApi(options.messages),
      stream: true,
    };

    if (options.tools.length > 0) {
      body.tools = buildToolSchemas(options.tools);
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
      response = await fetch(`${options.apiUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
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

    // Non-streaming JSON response (some APIs ignore stream:true)
    if (contentType.includes("application/json")) {
      return this.parseJsonResponse(await response.text());
    }

    // SSE streaming response
    const content: MessageContent[] = [];
    let stopReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;

    const blockBuilders: Map<
      number,
      {
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        partialJson?: string;
      }
    > = new Map();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        // Non-standard error format: {"error": {"code": "...", "message": "..."}}
        if (event.error && !event.type) {
          throw new ApiError(429, "Rate Limit", JSON.stringify(event.error));
        }

        if (options.onEvent) {
          options.onEvent(event);
        }

        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage.input_tokens;
            outputTokens = event.message.usage.output_tokens;
            break;

          case "content_block_start":
            blockBuilders.set(event.index, {
              type: event.content_block.type,
              text: "",
              thinking: "",
              id: event.content_block.id,
              name: event.content_block.name,
              partialJson: "",
            });
            break;

          case "content_block_delta": {
            const builder = blockBuilders.get(event.index);
            if (!builder) break;
            if (event.delta.type === "text_delta" && event.delta.text) {
              builder.text = (builder.text ?? "") + event.delta.text;
            } else if (
              event.delta.type === "thinking_delta" &&
              event.delta.thinking
            ) {
              builder.thinking =
                (builder.thinking ?? "") + event.delta.thinking;
            } else if (
              event.delta.type === "input_json_delta" &&
              event.delta.partial_json
            ) {
              builder.partialJson =
                (builder.partialJson ?? "") + event.delta.partial_json;
            }
            break;
          }

          case "content_block_stop": {
            const builder = blockBuilders.get(event.index);
            if (!builder) break;

            if (builder.type === "text") {
              content.push({ type: "text", text: builder.text ?? "" });
            } else if (builder.type === "thinking") {
              content.push({
                type: "thinking",
                thinking: builder.thinking ?? "",
              });
            } else if (builder.type === "tool_use") {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(builder.partialJson ?? "{}");
              } catch {
                /* empty input */
              }
              content.push({
                type: "tool_use",
                id: builder.id ?? "",
                name: builder.name ?? "",
                input,
              });
            }
            blockBuilders.delete(event.index);
            break;
          }

          case "message_delta":
            stopReason = event.delta.stop_reason;
            outputTokens += event.usage.output_tokens;
            break;

          case "error":
            throw new Error(
              `模型接口错误: ${(event as any).error?.type ?? "unknown"} — ${(event as any).error?.message ?? "无详细信息"}`,
            );
        }
      }
    }

    return { content, stopReason, usage: { inputTokens, outputTokens } };
  }

  private parseJsonResponse(body: string): ProviderResponse {
    const data = JSON.parse(body);

    const content: MessageContent[] = (data.content ?? []).map((block: any) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "thinking")
        return { type: "thinking", thinking: block.thinking };
      if (block.type === "tool_use")
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      return block;
    });

    const stopReason = data.stop_reason ?? "end_turn";
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;

    return { content, stopReason, usage: { inputTokens, outputTokens } };
  }
}
