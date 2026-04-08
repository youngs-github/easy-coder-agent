import { callApi } from "./api.js";
import { checkPermission } from "../utils/permission.js";
import { injectContext } from "../context/systemPrompt.js";
import { getToolByName } from "../tools/index.js";
import type {
  Message,
  MessageContent,
  Tool,
  ToolContext,
  ToolUseBlock,
  ToolResultBlock,
  QueryLoopParams,
  QueryLoopResult,
  StreamEvent,
} from "../types.js";
import {
  buildChangeSummary,
  buildDiffPreview,
  PendingChange,
} from "../utils/diffPreview.js";
import { getConfig } from "../config/index.js";

export async function queryLoop(
  params: QueryLoopParams,
): Promise<QueryLoopResult> {
  const {
    messages,
    tools,
    systemPrompt,
    maxTurns,
    isSubAgent,
    parentPermissionGrants,
    cwd,
    abortSignal,
    askUser,
    onWritePreview,
    onText,
    onToolStart,
    onToolEnd,
    todos,
  } = params;

  const config = await getConfig();
  const permissionGrants = parentPermissionGrants ?? new Set<string>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    // 1. Inject dynamic context
    const messagesWithContext = await injectContext(messages, cwd, todos);

    // 2. Call API with streaming
    const { handler: onEvent, stopSpinner } = buildStreamHandler(
      isSubAgent,
      onText,
      onToolStart,
    );

    let response;
    try {
      response = await callApi({
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        model: config.model,
        systemPrompt,
        messages: messagesWithContext,
        tools,
        abortSignal,
        onEvent,
        apiType: config.apiType,
      });
    } finally {
      stopSpinner();
    }

    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    // 3. Parse response
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    if (response.stopReason === "max_tokens") {
      console.error("\n[错误] 达到模型最大 token 限制");
      messages.push({ role: "assistant", content: response.content });
      break;
    }

    // No tool calls — conversation turn complete.
    // Covers both normal end_turn and API anomalies (empty/unexpected stopReason).
    // Without this guard, malformed API responses cause an infinite loop
    // because stopReason never matches "end_turn" or "max_tokens".
    if (toolUseBlocks.length === 0) {
      messages.push({ role: "assistant", content: response.content });
      if (!isSubAgent) {
        process.stdout.write("\n");
      }
      break;
    }

    // Has tool_use blocks — execute tools
    messages.push({ role: "assistant", content: response.content });

    // Diff preview: collect write operations and show preview before execution
    if (onWritePreview && !isSubAgent) {
      const writeBlocks = toolUseBlocks.filter(
        (b) => b.name === "Write" || b.name === "Edit",
      );
      if (writeBlocks.length > 0) {
        const pendingChanges: PendingChange[] = [];
        for (const block of writeBlocks) {
          const preview = await buildDiffPreview(
            block.name as "Write" | "Edit",
            block.input,
            cwd,
          );
          if (preview) pendingChanges.push(preview);
        }
        if (pendingChanges.length > 0) {
          const summary = buildChangeSummary(pendingChanges);
          for (const change of pendingChanges) {
            process.stderr.write(`\n${change.diff}\n`);
          }
          process.stderr.write(summary + "\n");
          const proceed = await onWritePreview(summary);
          if (!proceed) {
            // User rejected: return tool results as "cancelled"
            const cancelledResults: ToolResultBlock[] = toolUseBlocks.map(
              (b) => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content:
                  b.name === "Write" || b.name === "Edit"
                    ? "用户取消了此写操作"
                    : "", // non-write tools still execute below
                is_error: b.name === "Write" || b.name === "Edit",
              }),
            );
            // Actually execute non-write tools
            const nonWriteBlocks = toolUseBlocks.filter(
              (b) => b.name !== "Write" && b.name !== "Edit",
            );
            if (nonWriteBlocks.length > 0) {
              const toolContext: ToolContext = {
                cwd,
                isSubAgent,
                permissionGrants,
                abortSignal,
                askUser,
                todos,
              };
              const nonWriteResults = await executeTools(
                nonWriteBlocks,
                tools,
                toolContext,
                isSubAgent,
                onToolStart,
                onToolEnd,
              );
              for (const r of nonWriteResults) {
                const idx = toolUseBlocks.findIndex(
                  (b) => b.id === r.tool_use_id,
                );
                if (idx >= 0) cancelledResults[idx] = r;
              }
            }
            messages.push({ role: "user", content: cancelledResults });
            continue;
          }
        }
      }
    }

    const toolContext: ToolContext = {
      cwd,
      isSubAgent,
      permissionGrants,
      abortSignal,
      askUser,
      todos,
    };

    const toolResults = await executeTools(
      toolUseBlocks,
      tools,
      toolContext,
      isSubAgent,
      onToolStart,
      onToolEnd,
    );

    // Append tool results as a user message
    messages.push({ role: "user", content: toolResults });
  }

  if (turns >= maxTurns) {
    messages.push({
      role: "user",
      content: `[系统提示] 已达到最大对话轮次限制 (${maxTurns})。请总结当前工作状态后结束。`,
    });

    const messagesWithContext = await injectContext(messages, cwd, todos);
    const finalResponse = await callApi({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      model: config.model,
      systemPrompt,
      messages: messagesWithContext,
      tools: [],
      abortSignal,
      onEvent: buildStreamHandler(isSubAgent, onText).handler,
      apiType: config.apiType,
    });

    totalInputTokens += finalResponse.usage.inputTokens;
    totalOutputTokens += finalResponse.usage.outputTokens;
    messages.push({ role: "assistant", content: finalResponse.content });
  }

  return { messages, totalInputTokens, totalOutputTokens, turns };
}

function createOutputLock() {
  let queue = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const p = queue.then(fn);
      queue = p.then(
        () => {},
        () => {},
      );
      return p;
    },
  };
}

async function executeTools(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext,
  isSubAgent: boolean,
  onToolStart?: (name: string, summary: string) => void,
  onToolEnd?: (name: string, success: boolean, detail?: string) => void,
): Promise<ToolResultBlock[]> {
  const readOnlyBlocks: ToolUseBlock[] = [];
  const writeBlocks: ToolUseBlock[] = [];

  for (const block of toolUseBlocks) {
    const tool = getToolByName(block.name, tools);
    if (!tool) {
      writeBlocks.push(block);
      continue;
    }
    if (tool.definition.isReadOnly) {
      readOnlyBlocks.push(block);
    } else {
      writeBlocks.push(block);
    }
  }

  const results: Map<string, ToolResultBlock> = new Map();
  const outputLock = createOutputLock();

  // Wrap callbacks to serialize output
  const safeToolStart = onToolStart
    ? (name: string, summary: string) => {
        outputLock.run(async () => onToolStart(name, summary));
      }
    : undefined;
  const safeToolEnd = onToolEnd
    ? (name: string, success: boolean, detail?: string) => {
        outputLock.run(async () => onToolEnd(name, success, detail));
      }
    : undefined;

  // Execute read-only tools concurrently (output serialized via lock)
  if (readOnlyBlocks.length > 0) {
    const readResults = await Promise.all(
      readOnlyBlocks.map((block) =>
        executeSingleTool(
          block,
          tools,
          context,
          isSubAgent,
          safeToolStart,
          safeToolEnd,
        ),
      ),
    );
    for (const r of readResults) {
      results.set(r.tool_use_id, r);
    }
  }

  // Execute write tools serially
  for (const block of writeBlocks) {
    const result = await executeSingleTool(
      block,
      tools,
      context,
      isSubAgent,
      safeToolStart,
      safeToolEnd,
    );
    results.set(result.tool_use_id, result);
  }

  return toolUseBlocks.map((b) => results.get(b.id)!);
}

async function executeSingleTool(
  block: ToolUseBlock,
  tools: Tool[],
  context: ToolContext,
  isSubAgent: boolean,
  onToolStart?: (name: string, summary: string) => void,
  onToolEnd?: (name: string, success: boolean, detail?: string) => void,
): Promise<ToolResultBlock> {
  const tool = getToolByName(block.name, tools);
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `未知工具: ${block.name}`,
      is_error: true,
    };
  }

  const summary = getToolSummary(block.name, block.input);
  if (onToolStart) onToolStart(block.name, summary);

  // Permission check
  const permission = await checkPermission(
    tool.definition,
    block.input,
    context,
  );
  if (!permission.allowed) {
    if (onToolEnd) onToolEnd(block.name, false, permission.reason);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `权限被拒绝: ${permission.reason}`,
      is_error: true,
    };
  }

  const startTime = Date.now();
  try {
    const result = await tool.execute(block.input, context);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const detail = result.error ?? `${elapsed}s`;
    if (onToolEnd) onToolEnd(block.name, result.success, detail);

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: result.error
        ? `错误: ${result.error}\n${result.output}`
        : result.output,
      is_error: !result.success,
    };
  } catch (err: any) {
    if (onToolEnd) onToolEnd(block.name, false, err.message);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `工具执行异常: ${err.message}`,
      is_error: true,
    };
  }
}

function getToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return String(input.file_path ?? "");
    case "Write":
      return String(input.file_path ?? "");
    case "Edit":
      return String(input.file_path ?? "");
    case "Bash":
      return String(input.command ?? "").slice(0, 60);
    case "Grep":
      return `${input.pattern} in ${input.path ?? "."}`;
    case "Glob":
      return String(input.pattern ?? "");
    case "Agent":
      return String(input.task ?? "").slice(0, 60);
    case "WebSearch":
      return String(input.query ?? "").slice(0, 60);
    case "WebFetch":
      return String(input.url ?? "").slice(0, 80);
    default:
      return "";
  }
}

function buildStreamHandler(
  isSubAgent: boolean,
  onText?: (text: string) => void,
  _onToolStart?: (name: string, summary: string) => void,
): { handler: (event: StreamEvent) => void; stopSpinner: () => void } {
  let hasOutput = false;
  let spinnerInterval: NodeJS.Timeout | null = null;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIdx = 0;
  let spinnerStarted = false;

  if (!isSubAgent) {
    spinnerInterval = setInterval(() => {
      if (!hasOutput) {
        if (!spinnerStarted) {
          process.stderr.write("\n");
          spinnerStarted = true;
        }
        process.stderr.write(
          `\r\x1b[K\x1b[90m${spinnerFrames[spinnerIdx % spinnerFrames.length]} 思考中...\x1b[0m`,
        );
        spinnerIdx++;
      }
    }, 80);
  }

  const clearSpinner = () => {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    if (spinnerStarted && !hasOutput) {
      process.stderr.write("\r\x1b[K");
    }
    spinnerStarted = false;
  };

  const handler = (event: StreamEvent) => {
    switch (event.type) {
      case "content_block_start":
        if (event.content_block.type === "text") {
          clearSpinner();
          if (!hasOutput) {
            hasOutput = true;
            process.stdout.write("\n");
          }
        } else if (event.content_block.type === "tool_use") {
          clearSpinner();
          hasOutput = true;
        }
        break;

      case "content_block_delta":
        if (event.delta.type === "text_delta" && event.delta.text) {
          clearSpinner();
          if (!hasOutput) {
            hasOutput = true;
            process.stdout.write("\n");
          }
          process.stdout.write(event.delta.text);
          if (onText) onText(event.delta.text);
        }
        break;

      case "content_block_stop":
        break;
    }
  };

  return { handler, stopSpinner: clearSpinner };
}

export function extractFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    if (typeof msg.content === "string") return msg.content;

    const textBlocks = (msg.content as MessageContent[])
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    if (textBlocks.length > 0) return textBlocks.join("\n");
  }
  return "(子代理未产生输出)";
}
