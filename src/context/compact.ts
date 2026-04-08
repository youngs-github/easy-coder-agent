import { callApi } from "../service/api.js";
import { getConfig } from "../config/index.js";
import type { Message, MessageContent, ToolUseBlock, ToolResultBlock } from "../types.js";

const COMPACT_PROMPT = `请对以上对话生成一份详细摘要，用于让新的 AI 助手无缝接续当前工作。

摘要必须包含以下章节：

## 任务概述
用户要求做什么，核心目标是什么

## 当前状态
正在进行中的工作，尚未完成的任务，下一步应该做什么

## 已完成的工作
列出所有已完成的修改，包括修改了哪些文件、做了什么改动

## 关键决策
过程中做出的重要技术决策及其原因

## 重要文件
涉及的核心文件路径及其作用简介

## 错误与修复
遇到的问题、失败的方案、最终的解决方法（不要重复已解决的路径）

## 用户偏好
用户在此次对话中表达的偏好和要求（如代码风格、不想用某些方案等）

摘要应当足够详细，让助手读完后能立即继续工作，不需要询问已经讨论过的信息。`;

const MIN_KEEP = 4;
const MAX_KEEP = 10;

export async function compactMessages(
  messages: Message[],
  systemPrompt: string
): Promise<{
  newMessages: Message[];
  summary: string;
  savedTokens: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const config = await getConfig();

  // Step 1: Generate summary
  const summaryMessages: Message[] = [
    ...messages.filter((m) => !m._meta?.isContext),
    { role: "user", content: COMPACT_PROMPT },
  ];

  const response = await callApi({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    model: config.compactModel,
    systemPrompt,
    messages: summaryMessages,
    tools: [],
    apiType: config.apiType,
  });

  const summary = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Step 2: Find safe truncation point
  const realMessages = messages.filter(
    (m) => !m._meta?.isContext && !m._meta?.isCompactSummary
  );
  const keepIndex = findSafeTruncationIndex(realMessages);
  const keptMessages = realMessages.slice(keepIndex);

  // Step 3: Rebuild messages
  const newMessages: Message[] = [
    {
      role: "user",
      content: `<compact-summary>\n${summary}\n</compact-summary>`,
      _meta: { isCompactSummary: true },
    },
    {
      role: "assistant",
      content: "我已了解之前的工作进度，继续我们的任务。",
    },
    ...keptMessages,
  ];

  const savedTokens = estimateTokensSaved(realMessages.length, keptMessages.length);

  return {
    newMessages,
    summary,
    savedTokens,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  };
}

function findSafeTruncationIndex(messages: Message[]): number {
  const totalLen = messages.length;
  if (totalLen <= MIN_KEEP) return 0;

  // Search from end backward to find safe cut point
  for (let keep = MIN_KEEP; keep <= Math.min(MAX_KEEP, totalLen); keep++) {
    const idx = totalLen - keep;
    const msg = messages[idx];

    // Safe point: user message that isn't a tool_result
    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        return idx;
      }
      // Check if it contains only tool_results
      const hasNonToolResult = (content as MessageContent[]).some(
        (b) => b.type !== "tool_result"
      );
      if (hasNonToolResult) {
        return idx;
      }
    }
  }

  // Fallback: keep MAX_KEEP from end
  return Math.max(0, totalLen - MAX_KEEP);
}

function estimateTokensSaved(
  oldCount: number,
  keptCount: number
): number {
  // Rough estimate: ~100 tokens per message on average
  return Math.max(0, (oldCount - keptCount) * 100);
}

export function shouldCompact(
  totalTokens: number,
  threshold: number,
  lastCompactTokenCount: number
): boolean {
  if (totalTokens < threshold) return false;
  // Ensure at least 20000 token growth since last compact
  if (lastCompactTokenCount > 0 && totalTokens - lastCompactTokenCount < 20000) {
    return false;
  }
  return true;
}
