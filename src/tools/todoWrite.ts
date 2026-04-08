import type { Tool, ToolContext, ToolResult, TodoItem } from "../types.js";

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const action = input.action as string;
  const todos = context.todos;

  switch (action) {
    case "create": {
      const subject = input.subject as string;
      if (!subject) {
        return { success: false, output: "", error: "subject 为必填项" };
      }
      const id = `todo_${Date.now()}`;
      const item: TodoItem = {
        id,
        subject,
        description: (input.description as string) ?? "",
        status: "pending",
      };
      todos.push(item);
      return { success: true, output: formatTodos(todos) };
    }

    case "update": {
      const id = input.id as string;
      const item = todos.find((t) => t.id === id);
      if (!item) {
        return { success: false, output: "", error: `未找到任务: ${id}` };
      }
      if (input.subject !== undefined) item.subject = input.subject as string;
      if (input.description !== undefined)
        item.description = input.description as string;
      if (input.status !== undefined) item.status = input.status as TodoItem["status"];
      return { success: true, output: formatTodos(todos) };
    }

    case "delete": {
      const id = input.id as string;
      const idx = todos.findIndex((t) => t.id === id);
      if (idx === -1) {
        return { success: false, output: "", error: `未找到任务: ${id}` };
      }
      todos.splice(idx, 1);
      return { success: true, output: formatTodos(todos) };
    }

    default:
      return { success: false, output: "", error: `未知操作: ${action}，支持 create/update/delete` };
  }
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "(无任务)";
  return todos
    .map((t, i) => {
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "►" : "○";
      const line = `${icon} [${i + 1}] ${t.subject}`;
      return t.description ? `${line}\n    ${t.description}` : line;
    })
    .join("\n");
}

export const todoWriteTool: Tool = {
  definition: {
    name: "TodoWrite",
    description:
      "管理任务列表。create 创建新任务，update 更新任务状态/内容，delete 删除任务。复杂多步任务应先用此工具创建任务列表追踪进度。",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete"],
          description: "操作类型",
        },
        id: {
          type: "string",
          description: "任务 ID（update/delete 时必填）",
        },
        subject: {
          type: "string",
          description: "任务标题（create 时必填，update 时可选）",
        },
        description: {
          type: "string",
          description: "任务详细描述（可选）",
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "任务状态（可选）",
        },
      },
      required: ["action"],
    },
    isReadOnly: false,
  },
  execute,
};
