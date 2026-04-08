import type { Tool, ToolContext, ToolResult, TodoItem } from "../types.js";

async function execute(
  _input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const todos = context.todos;
  if (todos.length === 0) {
    return { success: true, output: "(无任务)" };
  }
  return { success: true, output: formatTodos(todos) };
}

function formatTodos(todos: TodoItem[]): string {
  return todos
    .map((t, i) => {
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "►" : "○";
      const line = `${icon} [${i + 1}] ${t.subject}`;
      return t.description ? `${line}\n    ${t.description}` : line;
    })
    .join("\n");
}

export const todoReadTool: Tool = {
  definition: {
    name: "TodoRead",
    description: "读取当前任务列表。无参数，返回所有任务及其状态。",
    input_schema: {
      type: "object",
      properties: {},
    },
    isReadOnly: true,
  },
  execute,
};
