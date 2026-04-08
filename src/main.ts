#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { v4 as uuidv4 } from "uuid";
import { getConfig, ensureConfigDirs } from "./config/index.js";
import { loadDotEnv } from "./config/envFile.js";
import { SYSTEM_PROMPT, injectContext } from "./context/systemPrompt.js";
import {
  loadSkills,
  formatSkillsIndex,
  setSkillRegistry,
} from "./skills/loader.js";
import { queryLoop } from "./service/agentLoop.js";
import { shouldCompact, compactMessages } from "./context/compact.js";
import { saveSession, loadSession } from "./service/session.js";
import {
  SessionUsage,
  TurnUsage,
  recordUsage,
  loadUsageSummary,
  formatUsageStatus,
  formatTokenCount,
  formatCost,
  estimateCost,
} from "./service/usage.js";
import { handleSlashCommand } from "./commands/index.js";
import { getAllTools } from "./tools/index.js";
import { agentTool } from "./tools/agent.js";
import { extractFinalText } from "./service/agentLoop.js";
import type { SessionState, TodoItem, Message } from "./types.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

// --- CLI arg parsing ---
function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let printMode = false;
  let printQuery = "";
  let autoApprove = false;
  let resumeSessionId = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print") {
      printMode = true;
      // Next arg is the query (if not a flag)
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        printQuery = args[++i];
      }
    } else if (arg === "--auto-approve") {
      autoApprove = true;
    } else if (arg === "--resume" && i + 1 < args.length) {
      resumeSessionId = args[++i];
    }
  }

  return { printMode, printQuery, autoApprove, resumeSessionId };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

async function runPrintMode(
  query: string,
  config: Awaited<ReturnType<typeof getConfig>>,
  autoApprove: boolean,
): Promise<void> {
  const skills = await loadSkills(process.cwd());
  setSkillRegistry(skills);
  const skillsIndex = formatSkillsIndex(skills);
  const fullSystemPrompt = skillsIndex
    ? `${SYSTEM_PROMPT}\n\n${skillsIndex}`
    : SYSTEM_PROMPT;

  const tools = getAllTools(agentTool);
  const todos: TodoItem[] = [];
  const messages: Message[] = [{ role: "user", content: query }];

  // In print mode: grant all permissions if autoApprove, otherwise auto-deny writes
  const permissionGrants = new Set<string>();
  if (autoApprove) {
    permissionGrants.add("Write:*");
    permissionGrants.add("Edit:*");
    permissionGrants.add("Bash:*");
  }

  try {
    const result = await queryLoop({
      messages,
      tools,
      systemPrompt: fullSystemPrompt,
      maxTurns: config.maxTurns,
      isSubAgent: false,
      parentPermissionGrants: permissionGrants,
      cwd: process.cwd(),
      abortSignal: undefined,
      askUser: undefined,
      todos,
      onWritePreview: autoApprove ? async () => true : async () => false,
      onText: (text: string) => process.stdout.write(text),
    });

    const finalText = extractFinalText(result.messages);
    if (finalText) {
      process.stdout.write(finalText + "\n");
    }
    process.exit(0);
  } catch (err: any) {
    process.stderr.write(`[错误] ${err.message}\n`, err);
    process.exit(1);
  }
}

async function main() {
  loadDotEnv(process.cwd());

  const { printMode, printQuery, autoApprove, resumeSessionId } = parseArgs(
    process.argv,
  );
  const config = await getConfig();
  await ensureConfigDirs();

  // --- Print mode: non-interactive one-shot ---
  if (printMode) {
    const query = printQuery || (await readStdin());
    if (!query) {
      process.stderr.write(
        "用法: easy-coder -p <query> 或 echo <query> | easy-coder -p\n",
      );
      process.exit(1);
    }
    await runPrintMode(query, config, autoApprove);
    return;
  }

  // --- Interactive mode ---
  let session: SessionState;

  if (resumeSessionId) {
    const loaded = await loadSession(resumeSessionId);
    if (loaded) {
      loaded.model = config.model;
      session = loaded;
      console.log(`[已恢复] 会话 ${resumeSessionId.slice(0, 12)}...`);
    } else {
      console.error(`[错误] 未找到会话: ${resumeSessionId}`);
      session = createNewSession(config.model);
    }
  } else {
    session = createNewSession(config.model);
  }

  // Load skills and build lightweight index for context
  const skills = await loadSkills(session.cwd);
  setSkillRegistry(skills);
  const skillsIndex = formatSkillsIndex(skills);
  const fullSystemPrompt = skillsIndex
    ? `${SYSTEM_PROMPT}\n\n${skillsIndex}`
    : SYSTEM_PROMPT;

  console.log(`\x1b[1m\x1b[36mEasyCoder\x1b[0m v${VERSION}\n`);
  console.log(
    `\x1b[90m模型: ${config.model}  |  工作目录: ${session.cwd}\x1b[0m`,
  );
  if (skills.length > 0) {
    console.log(
      `\x1b[90m已加载 ${skills.length} 个技能: ${skills.map((s) => s.name).join(", ")}\x1b[0m`,
    );
  }
  console.log("\x1b[90m输入 /help 查看命令，Ctrl+C 取消当前操作\x1b[0m\n");

  const tools = getAllTools(agentTool);
  const todos: TodoItem[] = [];
  let abortController: AbortController | null = null;
  let ctrlCCount = 0;
  let ctrlCTimer: NodeJS.Timeout | null = null;
  const sessionUsage = new SessionUsage();

  const rl = createInterface({ input, output });
  const askUser = (prompt: string) => rl.question(prompt);

  rl.on("SIGINT", () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
      console.log("\n[已取消] 当前请求已中断");
      return;
    }

    ctrlCCount++;
    if (ctrlCCount >= 2) {
      console.log("\n再见！");
      void cleanup(session, sessionUsage, config.model);
      rl.close();
      process.exit(0);
    }

    console.log("\n再按一次 Ctrl+C 退出程序");
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    ctrlCTimer = setTimeout(() => {
      ctrlCCount = 0;
    }, 2000);
  });

  // Build dynamic prompt with session token usage
  const buildPrompt = () => {
    const total = sessionUsage.totalTokens;
    if (total === 0) return "> ";
    const cost = estimateCost(
      config.model,
      sessionUsage.totalInputTokens,
      sessionUsage.totalOutputTokens,
    );
    return `\x1b[90m[${formatTokenCount(total)} tok · ${formatCost(cost)}]\x1b[0m > `;
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await rl.question(buildPrompt());
    const trimmed = line.trim();
    if (!trimmed) continue;

    ctrlCCount = 0;

    if (trimmed.startsWith("/")) {
      const result = await handleSlashCommand(trimmed, session, {
        askUser,
        sessionUsage,
        model: config.model,
        version: VERSION,
      });
      if (result.type === "exit") {
        await cleanup(session, sessionUsage, config.model);
        console.log("再见！");
        rl.close();
        process.exit(0);
      }
      if (result.type === "resume") {
        const loaded = await loadSession(result.sessionId);
        if (loaded) {
          loaded.model = config.model;
          Object.assign(session, loaded);
          console.log(`[已恢复] 会话已切换`);
        }
      }
      continue;
    }

    // Regular user message
    session.messages.push({ role: "user", content: trimmed });

    abortController = new AbortController();

    try {
      const turnUsage = new TurnUsage();
      const result = await queryLoop({
        messages: session.messages,
        tools,
        systemPrompt: fullSystemPrompt,
        maxTurns: config.maxTurns,
        isSubAgent: false,
        parentPermissionGrants: session.permissionGrants,
        cwd: session.cwd,
        abortSignal: abortController.signal,
        askUser,
        todos,
        onWritePreview: async (_summary: string) => {
          const answer = (
            await askUser("\n\x1b[33m确认执行以上写操作？[y/n] \x1b[0m")
          ).toLowerCase();
          return answer === "y" || answer === "yes";
        },
        onToolStart: (name, summary) => {
          process.stderr.write(
            `\n  \x1b[36m⚡ ${name}\x1b[0m: ${summary} ... `,
          );
        },
        onToolEnd: (_name, success, detail) => {
          process.stderr.write(
            success
              ? `\x1b[32m✓\x1b[0m (${detail})\n`
              : `\x1b[31m✗\x1b[0m (${detail})\n`,
          );
        },
      });

      turnUsage.add(result.totalInputTokens, result.totalOutputTokens);
      sessionUsage.addTurn(turnUsage);

      // Record usage
      await recordUsage(
        config.model,
        result.totalInputTokens,
        result.totalOutputTokens,
      );

      session.messages = result.messages;

      // Show per-turn usage
      const turnCost = estimateCost(
        config.model,
        turnUsage.inputTokens,
        turnUsage.outputTokens,
      );
      process.stderr.write(
        `\n\x1b[90m[本轮] ${formatTokenCount(turnUsage.inputTokens)}in / ${formatTokenCount(turnUsage.outputTokens)}out — ${formatCost(turnCost)}\x1b[0m\n`,
      );

      // Check if compact is needed
      const totalTokens = sessionUsage.totalTokens;
      if (
        shouldCompact(
          totalTokens,
          config.compactThreshold,
          session.lastCompactTokenCount,
        )
      ) {
        console.error("\n[上下文压缩] 正在自动压缩...");
        try {
          const compactResult = await compactMessages(
            session.messages,
            fullSystemPrompt,
          );
          const oldCount = session.messages.length;
          session.messages = compactResult.newMessages;
          session.lastCompactTokenCount = totalTokens;
          console.error(
            `[上下文压缩] 已将 ${oldCount} 条消息压缩为摘要 (节省约 ${compactResult.savedTokens} tokens)`,
          );
        } catch (err: any) {
          console.error(`[上下文压缩] 压缩失败: ${err.message}`);
        }
      }

      await saveSession(session);
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("\n[已取消]");
      } else {
        console.error(`\n[错误] ${err.message}`);
      }
    }

    abortController = null;
    process.stdout.write("\n");
  }
}

function createNewSession(model: string): SessionState {
  return {
    sessionId: uuidv4(),
    messages: [],
    cwd: process.cwd(),
    model,
    permissionGrants: new Set(),
    lastCompactTokenCount: 0,
    usageStats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      completedQueryLoops: 0,
    },
  };
}

async function cleanup(
  session: SessionState,
  sessionUsage: SessionUsage,
  model: string,
): Promise<void> {
  if (session.messages.length > 0) {
    try {
      await saveSession(session);
    } catch {
      /* ignore */
    }
  }
  // Show final usage summary
  if (sessionUsage.turns > 0) {
    console.log(formatUsageStatus(sessionUsage, model));
  }
}

main().catch((err) => {
  console.error(`[致命错误] ${err.message}`);
  process.exit(1);
});
