import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const MAX_OUTPUT_LENGTH = 10000;
const DEFAULT_TIMEOUT = 30000;

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const command = input.command as string;
  const timeout = (input.timeout_ms as number) ?? DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    let output = "";
    let killed = false;

    const child = spawn("bash", ["-c", command], {
      cwd: context.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, timeout);

    const onAbort = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    if (context.abortSignal) {
      context.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (output.length > MAX_OUTPUT_LENGTH) {
        output =
          output.slice(0, MAX_OUTPUT_LENGTH / 2) +
          "\n\n[...输出已截断...]\n\n" +
          output.slice(-MAX_OUTPUT_LENGTH / 2);
      }

      if (killed) {
        resolve({
          success: false,
          output: output + "\n\n[命令超时，已终止]",
          error: "命令执行超时",
        });
        return;
      }

      resolve({
        success: code === 0,
        output: output || "(无输出)",
        error: code !== 0 ? `退出码: ${code}` : undefined,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        output: "",
        error: `执行失败: ${err.message}`,
      });
    });
  });
}

export const bashTool: Tool = {
  definition: {
    name: "Bash",
    description:
      "在当前工作目录执行 shell 命令，返回 stdout + stderr。支持超时设置。",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 bash 命令",
        },
        timeout_ms: {
          type: "number",
          description: "超时毫秒数（默认 30000）",
        },
      },
      required: ["command"],
    },
    isReadOnly: false,
  },
  execute,
};
