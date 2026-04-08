import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const MAX_LINES_DEFAULT = 2000;
const TRUNCATE_LINES = 200;

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const filePath = path.resolve(context.cwd, input.file_path as string);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");

    let startLine = (input.start_line as number) ?? 1;
    let endLine = (input.end_line as number) ?? lines.length;

    startLine = Math.max(1, startLine);
    endLine = Math.min(lines.length, endLine);

    if (!input.start_line && !input.end_line && lines.length > MAX_LINES_DEFAULT) {
      const numbered = lines
        .slice(0, TRUNCATE_LINES)
        .map((l, i) => `${i + 1}|${l}`)
        .join("\n");
      return {
        success: true,
        output: `${numbered}\n\n[文件共 ${lines.length} 行，仅显示前 ${TRUNCATE_LINES} 行。使用 start_line/end_line 参数读取指定范围]`,
      };
    }

    const numbered = lines
      .slice(startLine - 1, endLine)
      .map((l, i) => `${startLine + i}|${l}`)
      .join("\n");

    return { success: true, output: numbered };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { success: false, output: "", error: `文件不存在: ${filePath}` };
    }
    return { success: false, output: "", error: err.message };
  }
}

export const readTool: Tool = {
  definition: {
    name: "Read",
    description:
      "读取文件内容，返回带行号的文本。支持通过 start_line/end_line 指定读取范围。大文件（>2000行）默认只返回前200行。",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "文件路径（相对于工作目录或绝对路径）",
        },
        start_line: {
          type: "number",
          description: "起始行号（从1开始），可选",
        },
        end_line: {
          type: "number",
          description: "结束行号，可选",
        },
      },
      required: ["file_path"],
    },
    isReadOnly: true,
  },
  execute,
};
