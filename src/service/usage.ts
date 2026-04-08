import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "../config/index.js";

const USAGE_FILE = path.join(CONFIG_DIR, "usage.json");

export interface UsageRecord {
  date: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  sessionsCount: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; calls: number }>;
}

interface UsageFile {
  records: UsageRecord[];
}

export const PRICING: Record<string, { input: number; output: number }> = {
  "MiniMax-M2.7": { input: 0.0015, output: 0.006 },
  "MiniMax-M2.5-highspeed": { input: 0.0005, output: 0.002 },
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-3.5-haiku-20241022": { input: 0.0008, output: 0.004 },
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
};

const DEFAULT_PRICE = { input: 0.002, output: 0.008 };

function getModelPricing(model: string) {
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.includes(key) || key.includes(model)) return price;
  }
  return DEFAULT_PRICE;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = getModelPricing(model);
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Per-turn usage for display in main loop */
export class TurnUsage {
  inputTokens = 0;
  outputTokens = 0;

  add(input: number, output: number) {
    this.inputTokens += input;
    this.outputTokens += output;
  }

  get total() {
    return this.inputTokens + this.outputTokens;
  }
}

/** Session-level accumulator */
export class SessionUsage {
  totalInputTokens = 0;
  totalOutputTokens = 0;
  turns = 0;

  addTurn(turn: TurnUsage) {
    this.totalInputTokens += turn.inputTokens;
    this.totalOutputTokens += turn.outputTokens;
    this.turns++;
  }

  get totalTokens() {
    return this.totalInputTokens + this.totalOutputTokens;
  }
}

/** Persist usage record to disk */
export async function recordUsage(
  model: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  let data: UsageFile = { records: [] };
  try {
    const raw = await fs.readFile(USAGE_FILE, "utf-8");
    data = JSON.parse(raw);
  } catch { /* first time */ }

  const record: UsageRecord = {
    date: new Date().toISOString().slice(0, 10),
    inputTokens,
    outputTokens,
    model,
  };

  data.records.push(record);

  // Keep last 1000 records
  if (data.records.length > 1000) {
    data.records = data.records.slice(-1000);
  }

  await fs.writeFile(USAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** Load and summarize all historical usage */
export async function loadUsageSummary(): Promise<UsageSummary> {
  let data: UsageFile = { records: [] };
  try {
    const raw = await fs.readFile(USAGE_FILE, "utf-8");
    data = JSON.parse(raw);
  } catch { /* no file */ }

  const summary: UsageSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUSD: 0,
    sessionsCount: data.records.length,
    byModel: {},
  };

  for (const r of data.records) {
    summary.totalInputTokens += r.inputTokens;
    summary.totalOutputTokens += r.outputTokens;

    if (!summary.byModel[r.model]) {
      summary.byModel[r.model] = { inputTokens: 0, outputTokens: 0, calls: 0 };
    }
    summary.byModel[r.model].inputTokens += r.inputTokens;
    summary.byModel[r.model].outputTokens += r.outputTokens;
    summary.byModel[r.model].calls++;
  }

  summary.totalTokens = summary.totalInputTokens + summary.totalOutputTokens;
  summary.estimatedCostUSD = estimateCost(
    Object.keys(summary.byModel)[0] ?? "unknown",
    summary.totalInputTokens,
    summary.totalOutputTokens
  );

  return summary;
}

/** Format a human-readable usage status string */
export function formatUsageStatus(
  sessionUsage: SessionUsage,
  model: string
): string {
  const cost = estimateCost(model, sessionUsage.totalInputTokens, sessionUsage.totalOutputTokens);
  return [
    `\x1b[1m本轮用量：\x1b[0m`,
    `  输入: ${formatTokenCount(sessionUsage.totalInputTokens)} tokens  输出: ${formatTokenCount(sessionUsage.totalOutputTokens)} tokens`,
    `  对话轮次: ${sessionUsage.turns}  预估费用: ${formatCost(cost)}`,
  ].join("\n");
}
