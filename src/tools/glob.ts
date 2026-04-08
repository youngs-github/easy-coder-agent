import { glob as globFn } from "glob";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const MAX_RESULTS = 200;

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const pattern = input.pattern as string;
  const searchPath = path.resolve(context.cwd, (input.path as string) ?? ".");

  try {
    const matches = await globFn(pattern, {
      cwd: searchPath,
      nodir: true,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    if (matches.length === 0) {
      return { success: true, output: "未找到匹配的文件" };
    }

    // Sort by modification time (most recent first)
    const withStats = await Promise.all(
      matches.map(async (f) => {
        try {
          const stat = await fs.stat(f);
          return { path: f, mtime: stat.mtimeMs };
        } catch {
          return { path: f, mtime: 0 };
        }
      })
    );
    withStats.sort((a, b) => b.mtime - a.mtime);

    const truncated = withStats.slice(0, MAX_RESULTS);
    const result = truncated.map((f) => f.path).join("\n");
    const suffix =
      matches.length > MAX_RESULTS
        ? `\n\n[共 ${matches.length} 个文件，仅显示前 ${MAX_RESULTS} 个]`
        : `\n\n[共 ${truncated.length} 个文件]`;

    return { success: true, output: result + suffix };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

export const globTool: Tool = {
  definition: {
    name: "Glob",
    description:
      "按 glob 模式搜索文件，返回匹配的文件路径列表（按修改时间降序排列）。自动忽略 node_modules 和 .git 目录。",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "glob 模式（如 **/*.ts）",
        },
        path: {
          type: "string",
          description: "搜索根目录（默认当前工作目录）",
        },
      },
      required: ["pattern"],
    },
    isReadOnly: true,
  },
  execute,
};
