import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_DIR } from "../config/index.js";
import type { Message, SessionState, UsageStats } from "../types.js";

const MAX_SESSIONS = 20;

interface SessionFile {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages: Message[];
  permissionGrants?: string[];
  lastCompactTokenCount?: number;
  usageStats?: UsageStats;
}

export async function saveSession(state: SessionState): Promise<void> {
  const filePath = path.join(SESSIONS_DIR, `${state.sessionId}.json`);

  const existing = await loadSessionFile(state.sessionId);
  const data: SessionFile = {
    sessionId: state.sessionId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: state.cwd,
    messages: state.messages,
    permissionGrants: [...state.permissionGrants],
    lastCompactTokenCount: state.lastCompactTokenCount,
    usageStats: state.usageStats,
  };

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  await pruneOldSessions();
}

async function loadSessionFile(
  sessionId: string
): Promise<SessionFile | null> {
  try {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function loadSession(
  sessionId: string
): Promise<SessionState | null> {
  const data = await loadSessionFile(sessionId);
  if (!data) return null;

  return {
    sessionId: data.sessionId,
    messages: data.messages,
    cwd: data.cwd,
    model: "",
    permissionGrants: new Set(data.permissionGrants ?? []),
    lastCompactTokenCount: data.lastCompactTokenCount ?? 0,
    usageStats: data.usageStats ?? {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      completedQueryLoops: 0,
    },
  };
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: string;
  cwd: string;
  firstUserMessage: string;
}

export async function listRecentSessions(
  limit = 5
): Promise<SessionSummary[]> {
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const summaries: SessionSummary[] = [];
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(SESSIONS_DIR, file);
        const content = await fs.readFile(filePath, "utf-8");
        const data: SessionFile = JSON.parse(content);

        const firstUserMsg = data.messages.find(
          (m) => m.role === "user" && !m._meta?.isContext && !m._meta?.isCompactSummary
        );
        const preview =
          typeof firstUserMsg?.content === "string"
            ? firstUserMsg.content.slice(0, 40)
            : "（工具调用）";

        summaries.push({
          sessionId: data.sessionId,
          updatedAt: data.updatedAt,
          cwd: data.cwd,
          firstUserMessage: preview,
        });
      } catch { /* skip corrupt files */ }
    }

    summaries.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return summaries.slice(0, limit);
  } catch {
    return [];
  }
}

async function pruneOldSessions(): Promise<void> {
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    if (jsonFiles.length <= MAX_SESSIONS) return;

    const withStats = await Promise.all(
      jsonFiles.map(async (f) => {
        const filePath = path.join(SESSIONS_DIR, f);
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const data: SessionFile = JSON.parse(content);
          return { file: f, updatedAt: new Date(data.updatedAt).getTime() };
        } catch {
          return { file: f, updatedAt: 0 };
        }
      })
    );

    withStats.sort((a, b) => a.updatedAt - b.updatedAt);
    const toDelete = withStats.slice(0, withStats.length - MAX_SESSIONS);

    for (const item of toDelete) {
      await fs.unlink(path.join(SESSIONS_DIR, item.file));
    }
  } catch { /* ignore pruning errors */ }
}
