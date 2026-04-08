import { ApiError, getRetryConfig } from "../utils/errors.js";
import type { ApiType } from "../config/index.js";
import { getProvider } from "./provider/index.js";
import type { Message, MessageContent, StreamEvent, Tool } from "../types.js";

export interface ApiCallOptions {
  apiKey: string;
  apiUrl: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  maxTokens?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  apiType: ApiType;
}

export interface ApiResponse {
  content: MessageContent[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function callApi(options: ApiCallOptions): Promise<ApiResponse> {
  const provider = getProvider(options.apiType);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await provider.call({
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        model: options.model,
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        tools: options.tools,
        maxTokens: options.maxTokens,
        abortSignal: options.abortSignal,
        onEvent: options.onEvent,
      });
    } catch (err: any) {
      lastError = err;

      if (err instanceof ApiError) {
        if (err.isAuth) {
          console.error(
            "[错误] API 认证失败，请检查 OPENAI_KEY 环境变量",
            err,
          );
          process.exit(1);
        }

        const retryConfig = getRetryConfig(err);
        if (!retryConfig || attempt >= retryConfig.maxRetries) {
          throw err;
        }

        let delay = retryConfig.baseDelay;
        if (err.isRateLimit) {
          delay = 5000;
        }

        console.error(
          `[重试] API 错误 ${err.statusCode}，${Math.round(delay / 1000)}秒后重试 (${attempt + 1}/${retryConfig.maxRetries})...`,
        );
        await sleep(delay);
        continue;
      }

      // Non-API errors (stream incomplete, network etc) - don't retry
      throw err;
    }
  }

  throw lastError ?? new Error("未知错误");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
