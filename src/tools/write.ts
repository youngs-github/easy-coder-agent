import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const filePath = path.resolve(context.cwd, input.file_path as string);
  const content = input.content as string;

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let diffSummary: string;
    try {
      const existing = await fs.readFile(filePath, "utf-8");
      const oldLines = existing.split("\n").length;
      const newLines = content.split("\n").length;
      const added = Math.max(0, newLines - oldLines);
      const removed = Math.max(0, oldLines - newLines);
      diffSummary = `覆盖写入: ${filePath} (${oldLines}→${newLines} 行, +${added} -${removed})`;
    } catch {
      const newLines = content.split("\n").length;
      diffSummary = `新建文件: ${filePath} (${newLines} 行)`;
    }

    await fs.writeFile(filePath, content, "utf-8");
    return { success: true, output: diffSummary };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

export const writeTool: Tool = {
  definition: {
    name: "Write",
    description:
      "覆盖写入文件内容，自动创建父目录。写入前会显示 diff 摘要。",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "文件路径（相对于工作目录或绝对路径）",
        },
        content: {
          type: "string",
          description: "要写入的完整文件内容",
        },
      },
      required: ["file_path", "content"],
    },
    isReadOnly: false,
  },
  execute,
};
