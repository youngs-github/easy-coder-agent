import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const MAX_RESULTS = 100;

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const pattern = input.pattern as string;
  const searchPath = path.resolve(context.cwd, (input.path as string) ?? ".");
  const globFilter = input.glob as string | undefined;

  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
    `--max-count=${MAX_RESULTS}`,
  ];
  if (globFilter) {
    args.push("--glob", globFilter);
  }
  args.push(pattern, searchPath);

  return new Promise((resolve) => {
    let output = "";
    // Try ripgrep first, fall back to grep
    const child = spawn("rg", args, {
      cwd: context.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", (code) => {
      const lines = output.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        resolve({ success: true, output: "未找到匹配项" });
        return;
      }
      const truncated = lines.slice(0, MAX_RESULTS);
      const result = truncated.join("\n");
      const suffix = lines.length > MAX_RESULTS
        ? `\n\n[共找到超过 ${MAX_RESULTS} 条匹配，仅显示前 ${MAX_RESULTS} 条]`
        : `\n\n[共 ${truncated.length} 条匹配]`;
      resolve({ success: true, output: result + suffix });
    });

    child.on("error", () => {
      // ripgrep not found, fallback to grep
      const grepArgs = ["-rn", "--color=never"];
      if (globFilter) {
        grepArgs.push(`--include=${globFilter}`);
      }
      grepArgs.push(pattern, searchPath);

      let grepOutput = "";
      const grepChild = spawn("grep", grepArgs, {
        cwd: context.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      grepChild.stdout.on("data", (data) => {
        grepOutput += data.toString();
      });
      grepChild.stderr.on("data", (data) => {
        grepOutput += data.toString();
      });

      grepChild.on("close", () => {
        const lines = grepOutput.trim().split("\n").filter(Boolean);
        if (lines.length === 0) {
          resolve({ success: true, output: "未找到匹配项" });
          return;
        }
        const truncated = lines.slice(0, MAX_RESULTS);
        resolve({
          success: true,
          output: truncated.join("\n") + `\n\n[共 ${truncated.length} 条匹配]`,
        });
      });

      grepChild.on("error", (err) => {
        resolve({ success: false, output: "", error: `搜索命令执行失败: ${err.message}` });
      });
    });
  });
}

export const grepTool: Tool = {
  definition: {
    name: "Grep",
    description:
      "在文件中搜索匹配正则表达式的内容，返回匹配行（文件名:行号:内容格式）。优先使用 ripgrep，不可用时回退到 grep。",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "搜索的正则表达式",
        },
        path: {
          type: "string",
          description: "搜索路径（默认当前工作目录）",
        },
        glob: {
          type: "string",
          description: "文件过滤（如 *.ts），可选",
        },
      },
      required: ["pattern", "path"],
    },
    isReadOnly: true,
  },
  execute,
};
