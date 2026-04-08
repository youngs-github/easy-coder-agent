import fs from "node:fs/promises";
import { GLOBAL_INSTRUCTIONS_PATH } from "../config/index.js";
import { compactMessages } from "../context/compact.js";
import { SYSTEM_PROMPT } from "../context/systemPrompt.js";
import { loadSkills } from "../skills/loader.js";
import { listRecentSessions, loadSession } from "../service/session.js";
import {
  loadUsageSummary,
  formatTokenCount,
  formatCost,
  estimateCost,
  type SessionUsage,
} from "../service/usage.js";
import type { SessionState } from "../types.js";

export type CommandResult =
  | { type: "continue" }
  | { type: "exit" }
  | { type: "resume"; sessionId: string };

export interface SlashCommandOptions {
  askUser: (prompt: string) => Promise<string>;
  sessionUsage: SessionUsage;
  model: string;
  version: string;
}

export async function handleSlashCommand(
  input: string,
  session: SessionState,
  options: SlashCommandOptions,
): Promise<CommandResult> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");

  switch (cmd) {
    case "/help":
      printHelp();
      return { type: "continue" };

    case "/clear":
      session.messages = [];
      session.permissionGrants.clear();
      console.log("[已清除] 对话历史和权限记录已重置");
      return { type: "continue" };

    case "/compact":
      await handleCompact(session);
      return { type: "continue" };

    case "/status":
      handleStatus(session, options);
      return { type: "continue" };

    case "/usage":
      await handleUsage(options);
      return { type: "continue" };

    case "/skills":
      await handleSkills(session);
      return { type: "continue" };

    case "/remember":
      if (!args) {
        console.log("[提示] 用法: /remember <要记住的内容>");
        return { type: "continue" };
      }
      await handleRemember(args);
      return { type: "continue" };

    case "/resume":
      return await handleResume(options.askUser);

    case "/version":
      console.log(`EasyCoder v${options.version}`);
      return { type: "continue" };

    case "/exit":
    case "/quit":
      return { type: "exit" };

    default:
      console.log(`[提示] 未知命令: ${cmd}，输入 /help 查看所有命令`);
      return { type: "continue" };
  }
}

function printHelp(): void {
  console.log(`
可用命令：
  /help            显示此帮助信息
  /clear           清除对话历史和权限记录
  /compact         手动触发上下文压缩
  /status          显示当前状态（消息数、用量等）
  /usage           显示历史累计用量和费用
  /skills          显示已加载的技能列表
  /remember <内容> 将内容追加到 EasyCoder.md 持久化记忆
  /resume          列出历史会话，选择恢复
  /version         显示版本号
  /exit 或 /quit   退出程序

快捷键：
  Ctrl+C           取消当前请求
  Ctrl+C (连按两次) 退出程序

权限提示选项：
  y = 允许一次
  a = 本次会话内在工作目录下自动放行
  r = 保存为永久规则（下次启动仍生效）
  n = 拒绝
`);
}

async function handleCompact(session: SessionState): Promise<void> {
  if (session.messages.length < 4) {
    console.log("[提示] 消息太少，无需压缩");
    return;
  }

  console.log("[上下文压缩] 正在生成摘要...");
  try {
    const result = await compactMessages(session.messages, SYSTEM_PROMPT);
    session.messages = result.newMessages;
    session.lastCompactTokenCount = 0;
    console.log(
      `[上下文压缩] 已将 ${session.messages.length + result.savedTokens} 条消息压缩为摘要 (节省约 ${result.savedTokens} tokens)`,
    );
    console.log("\n--- 摘要内容 ---");
    console.log(result.summary);
    console.log("--- 摘要结束 ---\n");
  } catch (err: any) {
    console.error(`[错误] 压缩失败: ${err.message}`);
  }
}

function handleStatus(
  session: SessionState,
  options: SlashCommandOptions,
): void {
  const msgCount = session.messages.filter((m) => !m._meta?.isContext).length;
  const { sessionUsage, model } = options;
  const cost = estimateCost(
    model,
    sessionUsage.totalInputTokens,
    sessionUsage.totalOutputTokens,
  );

  console.log(`
\x1b[1m当前状态：\x1b[0m
  会话 ID:      ${session.sessionId}
  消息数:       ${msgCount}
  工作目录:     ${session.cwd}
  模型:         ${model}
  永久授权数:   ${session.permissionGrants.size}
  对话轮次:     ${sessionUsage.turns}
  累计 token:   ${formatTokenCount(sessionUsage.totalInputTokens)} 输入 / ${formatTokenCount(sessionUsage.totalOutputTokens)} 输出
  本会话费用:   ${formatCost(cost)}
`);
}

async function handleUsage(options: SlashCommandOptions): Promise<void> {
  try {
    const summary = await loadUsageSummary();
    if (summary.sessionsCount === 0) {
      console.log("[提示] 暂无历史用量数据");
      return;
    }

    console.log(`\n\x1b[1m历史累计用量：\x1b[0m`);
    console.log(`  总调用次数: ${summary.sessionsCount}`);
    console.log(
      `  总输入:     ${formatTokenCount(summary.totalInputTokens)} tokens`,
    );
    console.log(
      `  总输出:     ${formatTokenCount(summary.totalOutputTokens)} tokens`,
    );
    console.log(
      `  总计:       ${formatTokenCount(summary.totalTokens)} tokens`,
    );

    console.log(`\n\x1b[1m按模型统计：\x1b[0m`);
    for (const [model, data] of Object.entries(summary.byModel)) {
      const modelCost = estimateCost(
        model,
        data.inputTokens,
        data.outputTokens,
      );
      console.log(
        `  ${model}: ${data.calls} 次调用, ${formatTokenCount(data.inputTokens + data.outputTokens)} tokens, ${formatCost(modelCost)}`,
      );
    }

    // Also show current session
    const { sessionUsage, model } = options;
    if (sessionUsage.turns > 0) {
      const sessionCost = estimateCost(
        model,
        sessionUsage.totalInputTokens,
        sessionUsage.totalOutputTokens,
      );
      console.log(
        `\n\x1b[1m本次会话：\x1b[0m ${sessionUsage.turns} 轮, ${formatTokenCount(sessionUsage.totalTokens)} tokens, ${formatCost(sessionCost)}`,
      );
    }
    console.log();
  } catch (err: any) {
    console.error(`[错误] 读取用量数据失败: ${err.message}`);
  }
}

async function handleSkills(session: SessionState): Promise<void> {
  const skills = await loadSkills(session.cwd);
  if (skills.length === 0) {
    console.log("[提示] 未加载任何技能");
    console.log("  全局技能目录: ~/.easy-coder/skills/");
    console.log("  项目技能目录: ./skills/");
    console.log("  支持 .md / .txt 文件或包含 SKILL.md 的目录");
    return;
  }

  console.log(`\n\x1b[1m已加载 ${skills.length} 个技能：\x1b[0m`);
  for (const skill of skills) {
    const tag =
      skill.source === "application"
        ? "内置"
        : skill.source === "global"
          ? "全局"
          : "项目";
    console.log(
      `  \x1b[36m[${tag}]\x1b[0m ${skill.name}: ${skill.description}`,
    );
  }
  console.log();
}

async function handleRemember(content: string): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const line = `- [${date}] ${content}\n`;

    let existing = "";
    try {
      existing = await fs.readFile(GLOBAL_INSTRUCTIONS_PATH, "utf-8");
    } catch {
      /* file doesn't exist yet */
    }

    await fs.writeFile(GLOBAL_INSTRUCTIONS_PATH, existing + line, "utf-8");
    console.log(`[已记忆] 内容已追加到 ${GLOBAL_INSTRUCTIONS_PATH}`);
  } catch (err: any) {
    console.error(`[错误] 写入失败: ${err.message}`);
  }
}

async function handleResume(
  askUser: (prompt: string) => Promise<string>,
): Promise<CommandResult> {
  const sessions = await listRecentSessions(5);
  if (sessions.length === 0) {
    console.log("[提示] 没有找到历史会话");
    return { type: "continue" };
  }

  console.log("\n最近的会话：");
  sessions.forEach((s, i) => {
    const date = new Date(s.updatedAt).toLocaleString("zh-CN");
    console.log(
      `  ${i + 1}. [${date}] ${s.firstUserMessage} (${s.sessionId.slice(0, 12)}...)`,
    );
  });

  const answer = (await askUser("选择会话编号（回车新建）: ")).trim();
  const num = parseInt(answer, 10);
  if (num >= 1 && num <= sessions.length) {
    return { type: "resume", sessionId: sessions[num - 1].sessionId };
  }
  return { type: "continue" };
}
