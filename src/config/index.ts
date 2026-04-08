import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CONFIG_DIR = path.join(os.homedir(), ".easy-coder");
export const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");
export const SKILLS_DIR = path.join(CONFIG_DIR, "skills");
export const GLOBAL_INSTRUCTIONS_PATH = path.join(CONFIG_DIR, "EasyCoder.md");
export const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

// Application-level skills: bundled with the agent itself
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_SKILLS_DIR = path.join(__dirname, "..", "skills");

export type ApiType = "openai" | "anthropic";

export interface Config {
  apiKey: string;
  apiUrl: string;
  model: string;
  compactModel: string;
  compactThreshold: number;
  maxTurns: number;
  apiType: ApiType;
}

interface Settings {
  OPENAI_KEY?: string;
  OPENAI_URL?: string;
  OPENAI_MODEL?: string;
  OPENAI_COMPACT_MODEL?: string;
  OPENAI_COMPACT_THRESHOLD?: number;
  OPENAI_MAX_TURNS?: number;
  OPENAI_API_TYPE?: string;
}

async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

let config: Config | undefined;
export async function getConfig(): Promise<Config> {
  if (config) {
    return Promise.resolve(config);
  }
  const settings = await loadSettings();

  const apiKey = process.env.OPENAI_KEY ?? settings.OPENAI_KEY ?? "";
  const apiUrl = process.env.OPENAI_URL ?? settings.OPENAI_URL ?? "";
  const model = process.env.OPENAI_MODEL ?? settings.OPENAI_MODEL ?? "";
  const compactModel =
    process.env.OPENAI_COMPACT_MODEL ?? settings.OPENAI_COMPACT_MODEL ?? "";
  const compactThreshold = process.env.OPENAI_COMPACT_THRESHOLD
    ? parseInt(process.env.OPENAI_COMPACT_THRESHOLD, 10)
    : (settings.OPENAI_COMPACT_THRESHOLD ?? 160000);
  const maxTurns = process.env.OPENAI_MAX_TURNS
    ? parseInt(process.env.OPENAI_MAX_TURNS, 10)
    : (settings.OPENAI_MAX_TURNS ?? 50);
  const rawApiType =
    process.env.OPENAI_API_TYPE ?? settings.OPENAI_API_TYPE ?? "openai";
  const apiType: ApiType =
    rawApiType === "anthropic" ? "anthropic" : "openai";

  if (!apiKey) {
    console.error(
      "[错误] 未设置 OPENAI_KEY 环境变量，也未在 ~/.easy-coder/settings.json 中配置 apiKey",
    );
    process.exit(1);
  }

  config = { apiKey, apiUrl, model, compactModel, compactThreshold, maxTurns, apiType };
  return config;
}

const SKILLS_README = path.join(SKILLS_DIR, "README.md");

export async function ensureConfigDirs(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  // 占位文件：此前只有执行 /remember 才会创建，用户容易误以为未生效
  try {
    await fs.access(GLOBAL_INSTRUCTIONS_PATH);
  } catch {
    await fs.writeFile(
      GLOBAL_INSTRUCTIONS_PATH,
      "<!-- EasyCoder 全局说明：可在此手写项目偏好；也可用 /remember 追加带日期的条目 -->\n\n",
      "utf-8",
    );
  }
  try {
    await fs.access(SKILLS_README);
  } catch {
    await fs.writeFile(
      SKILLS_README,
      `# Skills 目录

在此目录下为每个 skill 建子文件夹，并放入 \`SKILL.md\`（或任意 \`.md\`），启动时会合并进模型上下文。

示例：

\`\`\`
~/.easy-coder/skills/
  react-patterns/SKILL.md
  internal-api/SKILL.md
\`\`\`

项目内可使用 \`<项目>/.easy-coder/skills/**\/*.md\` 或 git 根目录下同名路径。
`,
      "utf-8",
    );
  }
}

export async function loadEasyCoderInstructions(cwd: string): Promise<string> {
  const parts: string[] = [];

  // 1. Global user config
  try {
    const global = await fs.readFile(GLOBAL_INSTRUCTIONS_PATH, "utf-8");
    if (global.trim()) parts.push(global.trim());
  } catch {
    /* not found */
  }

  // 2. Git root config
  try {
    const { execSync } = await import("node:child_process");
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (gitRoot && gitRoot !== cwd) {
      const gitInstructions = await fs.readFile(
        path.join(gitRoot, "EasyCoder.md"),
        "utf-8",
      );
      if (gitInstructions.trim()) parts.push(gitInstructions.trim());
    }
  } catch {
    /* not a git repo or file not found */
  }

  // 3. CWD config
  try {
    const cwdInstructions = await fs.readFile(
      path.join(cwd, "EasyCoder.md"),
      "utf-8",
    );
    if (cwdInstructions.trim()) parts.push(cwdInstructions.trim());
  } catch {
    /* not found */
  }

  return parts.join("\n\n---\n\n");
}
