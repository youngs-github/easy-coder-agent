import { queryLoop, extractFinalText } from "../service/agentLoop.js";
import { SYSTEM_PROMPT } from "../context/systemPrompt.js";
import { BASE_TOOLS } from "./index.js";
import type { Tool, ToolContext, ToolResult, Message } from "../types.js";

// Per-agent-type configuration
const AGENT_TYPE_CONFIG: Record<
  string,
  {
    label: string;
    tools: string[] | null; // null = all BASE_TOOLS except Agent
    maxTurns: number;
    useCompactModel: boolean;
  }
> = {
  explore: {
    label: "探索代理",
    tools: ["Read", "Grep", "Glob"],
    maxTurns: 10,
    useCompactModel: true,
  },
  plan: {
    label: "规划代理",
    tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    maxTurns: 10,
    useCompactModel: false,
  },
  general: {
    label: "子代理",
    tools: null, // all except Agent
    maxTurns: 15,
    useCompactModel: false,
  },
};

async function execute(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const task = input.task as string;
  const agentType = (input.agent_type as string) || "general";
  const allowedToolsOverride = input.allowed_tools as string[] | undefined;

  const typeConfig = AGENT_TYPE_CONFIG[agentType] ?? AGENT_TYPE_CONFIG.general;
  const { label, maxTurns, useCompactModel } = typeConfig;

  // Determine tool set
  let tools: Tool[];
  if (allowedToolsOverride) {
    tools = BASE_TOOLS.filter((t) =>
      allowedToolsOverride.includes(t.definition.name),
    );
  } else if (typeConfig.tools) {
    tools = BASE_TOOLS.filter((t) =>
      typeConfig.tools!.includes(t.definition.name),
    );
  } else {
    tools = BASE_TOOLS.filter((t) => t.definition.name !== "Agent");
  }

  console.error(
    `\n\x1b[33m[${label}启动]\x1b[0m 类型: ${agentType}  任务: ${task.slice(0, 80)}`,
  );
  const startTime = Date.now();

  const messages: Message[] = [{ role: "user", content: task }];

  try {
    const result = await queryLoop({
      messages,
      tools,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns,
      isSubAgent: true,
      parentPermissionGrants: context.permissionGrants,
      cwd: context.cwd,
      abortSignal: context.abortSignal,
      todos: [], // sub-agents get fresh empty todo list
      onToolStart: (name, summary) => {
        process.stderr.write(
          `\n    \x1b[36m⚡ ${name}\x1b[0m: ${summary} ... `,
        );
      },
      askUser: context.askUser,
      onToolEnd: (_name, success, detail) => {
        process.stderr.write(
          success
            ? `\x1b[32m✓\x1b[0m (${detail})\n`
            : `\x1b[31m✗\x1b[0m (${detail})\n`,
        );
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(
      `\n\x1b[33m[${label}完成]\x1b[0m 耗时 ${elapsed}s，使用 ${result.turns} 轮对话`,
    );

    const finalText = extractFinalText(result.messages);
    return { success: true, output: finalText };
  } catch (err: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(
      `\n\x1b[31m[${label}失败]\x1b[0m 耗时 ${elapsed}s，错误: ${err.message}`,
    );
    return {
      success: false,
      output: `${label}执行失败: ${err.message}`,
      error: err.message,
    };
  }
}

export const agentTool: Tool = {
  definition: {
    name: "Agent",
    description:
      "启动一个子代理来完成独立的子任务。子代理拥有独立的对话上下文，可以使用工具来完成任务，完成后返回结果文本。支持三种代理类型：explore（快速代码探索，只读工具）、plan（规划分析，只读+网络搜索）、general（通用，全部工具）。",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "要委派给子代理的任务描述",
        },
        agent_type: {
          type: "string",
          enum: ["explore", "plan", "general"],
          description:
            "代理类型: explore=快速探索（只读工具，便宜模型）, plan=规划分析（只读+网络搜索）, general=通用代理（全部工具，默认）",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description:
            "允许子代理使用的工具名称列表（可选，覆盖 agent_type 的默认工具集）",
        },
      },
      required: ["task"],
    },
    isReadOnly: false,
  },
  execute,
};
