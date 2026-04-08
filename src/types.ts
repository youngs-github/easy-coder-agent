export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type MessageContent =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export type Message = {
  role: "user" | "assistant";
  content: string | MessageContent[];
  _meta?: {
    isContext?: boolean;
    isCompactSummary?: boolean;
  };
};

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  id: string;
  subject: string;
  description: string;
  status: TodoStatus;
};

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  isReadOnly: boolean;
};

export type ToolResult = {
  success: boolean;
  output: string;
  error?: string;
};

export type ToolExecutor = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>;

export type Tool = {
  definition: ToolDefinition;
  execute: ToolExecutor;
};

export type ToolContext = {
  cwd: string;
  isSubAgent: boolean;
  permissionGrants: Set<string>;
  abortSignal?: AbortSignal;
  askUser?: (prompt: string) => Promise<string>;
  todos: TodoItem[];
};

/** 本会话累计 API 用量（跨多轮用户输入累加） */
export type UsageStats = {
  totalInputTokens: number;
  totalOutputTokens: number;
  /** 用户发送普通消息并跑完 queryLoop 的次数 */
  completedQueryLoops: number;
};

export type SessionState = {
  sessionId: string;
  messages: Message[];
  cwd: string;
  model: string;
  permissionGrants: Set<string>;
  lastCompactTokenCount: number;
  usageStats: UsageStats;
};

export type QueryLoopParams = {
  messages: Message[];
  tools: Tool[];
  systemPrompt: string;
  maxTurns: number;
  isSubAgent: boolean;
  parentPermissionGrants?: Set<string>;
  cwd: string;
  abortSignal?: AbortSignal;
  askUser?: (prompt: string) => Promise<string>;
  onText?: (text: string) => void;
  onToolStart?: (name: string, summary: string) => void;
  onToolEnd?: (name: string, success: boolean, detail?: string) => void;
  /** Callback for write previews — return true to proceed */
  onWritePreview?: (preview: string) => Promise<boolean>;
  /** Shared mutable todo list */
  todos: TodoItem[];
};

export type QueryLoopResult = {
  messages: Message[];
  totalInputTokens: number;
  totalOutputTokens: number;
  turns: number;
};

export type StreamEvent =
  | {
      type: "content_block_start";
      index: number;
      content_block: { type: string; id?: string; name?: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta: {
        type: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
      };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_start";
      message: {
        id: string;
        model: string;
        usage: { input_tokens: number; output_tokens: number };
      };
    }
  | {
      type: "message_delta";
      delta: { stop_reason: string };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };
