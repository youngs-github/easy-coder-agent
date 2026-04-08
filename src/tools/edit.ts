import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const filePath = path.resolve(context.cwd, input.file_path as string);
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  const replaceAll = (input.replace_all as boolean) ?? false;

  try {
    const content = await fs.readFile(filePath, "utf-8");

    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      return {
        success: false,
        output: "",
        error: "old_string 在文件中未找到",
      };
    }

    if (!replaceAll && occurrences > 1) {
      return {
        success: false,
        output: "",
        error: `old_string 出现了 ${occurrences} 次，需要提供更多上下文确保唯一性。如需替换所有匹配项，请设置 replace_all 为 true`,
      };
    }

    const updated = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);
    await fs.writeFile(filePath, updated, "utf-8");

    const oldLines = oldString.split("\n").length;
    const newLines = newString.split("\n").length;
    const summary = replaceAll
      ? `已编辑 ${filePath} (替换了 ${occurrences} 处, 每处 ${oldLines} 行 → ${newLines} 行)`
      : `已编辑 ${filePath} (替换 ${oldLines} 行 → ${newLines} 行)`;
    return { success: true, output: summary };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { success: false, output: "", error: `文件不存在: ${filePath}` };
    }
    return { success: false, output: "", error: err.message };
  }
}

export const editTool: Tool = {
  definition: {
    name: "Edit",
    description:
      "精确编辑文件：在文件中查找匹配的 old_string 并替换为 new_string。默认 old_string 必须唯一存在；设置 replace_all 为 true 可替换所有匹配项。",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "文件路径",
        },
        old_string: {
          type: "string",
          description: "要替换的原始字符串（默认必须在文件中唯一存在）",
        },
        new_string: {
          type: "string",
          description: "替换后的新字符串",
        },
        replace_all: {
          type: "boolean",
          description: "设为 true 时替换所有匹配项（默认 false，要求 old_string 唯一）",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    isReadOnly: false,
  },
  execute,
};
