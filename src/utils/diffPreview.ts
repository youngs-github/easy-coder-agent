import fs from "node:fs/promises";
import path from "node:path";
import type { ToolUseBlock } from "../types.js";

export interface PendingChange {
  tool: "Write" | "Edit";
  filePath: string;
  diff: string;
  block: ToolUseBlock;
}

export async function buildDiffPreview(
  toolName: "Write" | "Edit",
  toolInput: Record<string, unknown>,
  cwd: string
): Promise<PendingChange | null> {
  const filePath = path.resolve(cwd, toolInput.file_path as string);

  if (toolName === "Write") {
    return buildWriteDiff(filePath, toolInput.content as string);
  }
  if (toolName === "Edit") {
    return buildEditDiff(
      filePath,
      toolInput.old_string as string,
      toolInput.new_string as string
    );
  }
  return null;
}

async function buildWriteDiff(
  filePath: string,
  newContent: string
): Promise<PendingChange> {
  let oldContent: string | null = null;
  try {
    oldContent = await fs.readFile(filePath, "utf-8");
  } catch {
    /* new file */
  }

  if (oldContent === null) {
    const lines = newContent.split("\n");
    const preview = lines
      .slice(0, 10)
      .map((l, i) => `\x1b[32m+${String(i + 1).padStart(4)}| ${l}\x1b[0m`)
      .join("\n");
    const suffix =
      lines.length > 10 ? `\n  ... (共 ${lines.length} 行)` : "";
    return {
      tool: "Write",
      filePath,
      diff: `\x1b[33m[新建文件]\x1b[0m ${filePath} (${lines.length} 行)\n${preview}${suffix}`,
      block: undefined as any,
    };
  }

  const diff = computeLineDiff(oldContent, newContent, filePath);
  return { tool: "Write", filePath, diff, block: undefined as any };
}

async function buildEditDiff(
  filePath: string,
  oldString: string,
  newString: string
): Promise<PendingChange> {
  let fileContent: string;
  try {
    fileContent = await fs.readFile(filePath, "utf-8");
  } catch {
    return {
      tool: "Edit",
      filePath,
      diff: `\x1b[31m[文件不存在]\x1b[0m ${filePath}`,
      block: undefined as any,
    };
  }

  const idx = fileContent.indexOf(oldString);
  if (idx === -1) {
    return {
      tool: "Edit",
      filePath,
      diff: `\x1b[31m[未找到匹配]\x1b[0m ${filePath}\n  搜索文本: "${oldString.slice(0, 60)}..."`,
      block: undefined as any,
    };
  }

  const lineNum = fileContent.slice(0, idx).split("\n").length;
  const contextLines = 3;
  const allLines = fileContent.split("\n");
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const startLine = Math.max(1, lineNum - contextLines);
  const endLine = Math.min(
    allLines.length,
    lineNum + oldLines.length - 1 + contextLines
  );

  let diff = `\x1b[33m[编辑]\x1b[0m ${filePath} (第 ${lineNum} 行附近)\n`;
  for (let i = startLine; i <= endLine; i++) {
    const line = allLines[i - 1];
    const inOld = i >= lineNum && i < lineNum + oldLines.length;
    if (inOld) {
      diff += `\x1b[31m-${String(i).padStart(4)}| ${line}\x1b[0m\n`;
    } else {
      diff += ` ${String(i).padStart(4)}| ${line}\n`;
    }
  }

  diff += `\n  替换为:\n`;
  for (let i = 0; i < newLines.length; i++) {
    diff += `\x1b[32m+${String(lineNum + i).padStart(4)}| ${newLines[i]}\x1b[0m\n`;
  }

  return { tool: "Edit", filePath, diff, block: undefined as any };
}

function computeLineDiff(
  oldContent: string,
  newContent: string,
  filePath: string
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxOld = oldLines.length;
  const maxNew = newLines.length;

  let diff = `\x1b[33m[覆盖写入]\x1b[0m ${filePath} (${maxOld} → ${maxNew} 行)\n`;

  const changes: Array<{
    line: number;
    type: "add" | "remove";
    text: string;
  }> = [];

  for (let i = 0; i < Math.max(maxOld, maxNew); i++) {
    const oldLine = i < maxOld ? oldLines[i] : null;
    const newLine = i < maxNew ? newLines[i] : null;

    if (oldLine !== newLine) {
      if (oldLine !== null)
        changes.push({ line: i + 1, type: "remove", text: oldLine });
      if (newLine !== null)
        changes.push({ line: i + 1, type: "add", text: newLine });
    }
  }

  if (changes.length === 0) {
    return `${diff}\n  (内容无变化)`;
  }

  const showChanges = changes.slice(0, 30);

  for (const c of showChanges) {
    if (c.type === "remove") {
      diff += `\x1b[31m-${String(c.line).padStart(4)}| ${c.text}\x1b[0m\n`;
    } else {
      diff += `\x1b[32m+${String(c.line).padStart(4)}| ${c.text}\x1b[0m\n`;
    }
  }

  if (changes.length > 30) {
    diff += `\n  ... (共 ${changes.length} 处变更，仅显示前 30 处)`;
  }

  return diff;
}

export function buildChangeSummary(pendingChanges: PendingChange[]): string {
  if (pendingChanges.length === 0) return "";
  const files = [...new Set(pendingChanges.map((c) => c.filePath))];
  const lines = [
    `\n\x1b[1m即将执行 ${pendingChanges.length} 个写操作，涉及 ${files.length} 个文件：\x1b[0m`,
    ...files.map((f) => `  • ${f}`),
  ];
  return lines.join("\n");
}
