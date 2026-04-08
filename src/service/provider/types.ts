import type { Message, MessageContent, StreamEvent, Tool } from "../../types.js";

export interface ProviderCallOptions {
  apiKey: string;
  apiUrl: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  maxTokens?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
}

export interface ProviderResponse {
  content: MessageContent[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Provider {
  call(options: ProviderCallOptions): Promise<ProviderResponse>;
}
