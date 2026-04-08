import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { CONFIG_DIR } from "../config/index.js";
import type { ToolDefinition, ToolContext } from "../types.js";

const PERMISSIONS_FILE_PATH = `${CONFIG_DIR}/permissions.json`;

export interface PermissionRule {
  id: string;
  tool: string;
  effect: "allow" | "deny";
  /** What this rule matches:
   *  - "dir:/path/to/project" — directory prefix match
   *  - "glob:**\/*.test.ts" — glob match on file path
   *  - "cmd:npm run *" — command prefix/pattern match (for Bash)
   *  - "cmd-regex:..." — regex match on command (for Bash)
   *  - "network:*.github.com" — hostname glob match (for WebSearch/WebFetch)
   *  - "*" — match everything
   */
  match: string;
  note?: string;
}

interface PermissionsFile {
  rules: PermissionRule[];
}

const DANGEROUS_PATHS = [
  `${os.homedir()}/.ssh/`,
  `${os.homedir()}/.aws/`,
  "/etc/",
  "/usr/",
  "/bin/",
  "/sbin/",
];

const BASH_READONLY_PREFIXES = [
  "ls",
  "cat",
  "grep",
  "find",
  "wc",
  "head",
  "tail",
  "git log",
  "git diff",
  "git status",
  "git branch",
  "echo",
  "pwd",
  "which",
  "node -v",
  "npm -v",
];

const DANGEROUS_COMMANDS = ["rm -rf", "sudo", "chmod 777", "> /dev/", "dd if="];

function isDangerousPath(filePath: string): boolean {
  const resolved = filePath.startsWith("~")
    ? filePath.replace("~", os.homedir())
    : filePath;
  return DANGEROUS_PATHS.some((p) => resolved.startsWith(p));
}

function isBashReadOnly(command: string): boolean {
  const trimmed = command.trim();
  return BASH_READONLY_PREFIXES.some((p) => trimmed.startsWith(p));
}

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some((d) => command.includes(d));
}

// --- Rule loading & matching ---

let cachedRules: PermissionRule[] | null = null;

async function loadRules(): Promise<PermissionRule[]> {
  if (cachedRules) return cachedRules;
  try {
    const raw = await fs.readFile(PERMISSIONS_FILE_PATH, "utf-8");
    const data: PermissionsFile = JSON.parse(raw);
    cachedRules = data.rules ?? [];
  } catch {
    cachedRules = [];
  }
  return cachedRules!;
}

async function saveRules(rules: PermissionRule[]): Promise<void> {
  const data: PermissionsFile = { rules };
  await fs.writeFile(
    PERMISSIONS_FILE_PATH,
    JSON.stringify(data, null, 2),
    "utf-8",
  );
  cachedRules = rules;
}

function matchRule(
  rule: PermissionRule,
  toolName: string,
  targetPath: string,
  cwd: string,
): boolean {
  // Check tool match
  if (rule.tool !== "*" && rule.tool !== toolName) return false;

  const match = rule.match;

  // Wildcard
  if (match === "*") return true;

  // Directory match: "dir:/path"
  if (match.startsWith("dir:")) {
    const dir = match.slice(4);
    const normalized = targetPath.endsWith("/") ? targetPath : targetPath + "/";
    const grantDir = dir.endsWith("/") ? dir : dir + "/";
    return normalized === grantDir || normalized.startsWith(grantDir);
  }

  // Glob match: "glob:**/*.test.ts"
  if (match.startsWith("glob:")) {
    const pattern = match.slice(5);
    return matchGlob(targetPath, pattern);
  }

  // Command prefix match: "cmd:npm run *"
  if (match.startsWith("cmd:")) {
    const prefix = match.slice(4).replace(/\*$/, "").trim();
    return targetPath.startsWith(prefix);
  }

  // Command regex match: "cmd-regex:..."
  if (match.startsWith("cmd-regex:")) {
    const regexStr = match.slice(10);
    try {
      const regex = new RegExp(regexStr);
      return regex.test(targetPath);
    } catch {
      return false;
    }
  }

  // Network hostname match: "network:*.github.com"
  if (match.startsWith("network:")) {
    const pattern = match.slice(8);
    return matchGlob(targetPath, pattern);
  }

  return false;
}

/** Simple glob matcher supporting *, **, and ? */
function matchGlob(str: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return false;
  }
}

// --- Extract target info from tool input ---

function getTargetInfo(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): { path: string; command: string; url: string } {
  let filePath = "";
  let command = "";
  let url = "";

  switch (toolName) {
    case "Write":
    case "Edit":
    case "Read":
      filePath = (toolInput.file_path as string) ?? "";
      filePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(cwd, filePath);
      break;
    case "Bash":
      command = (toolInput.command as string) ?? "";
      break;
    case "WebSearch":
      break; // read-only, no target needed
    case "WebFetch":
      url = (toolInput.url as string) ?? "";
      break;
    case "Agent":
      break;
    default: {
      const p =
        (toolInput.file_path as string) ?? (toolInput.path as string) ?? "";
      if (p) {
        filePath = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      }
    }
  }

  return { path: filePath, command, url };
}

function getTargetPath(info: ReturnType<typeof getTargetInfo>): string {
  return info.path || info.command || info.url || "";
}

// --- Public API ---

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function checkPermission(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<PermissionResult> {
  // Read-only tools always allowed
  if (tool.isReadOnly) {
    return { allowed: true };
  }

  // Read-only bash commands always allowed
  if (tool.name === "Bash" && isBashReadOnly(input.command as string)) {
    return { allowed: true };
  }

  const targetInfo = getTargetInfo(tool.name, input, context.cwd);
  const targetPath = getTargetPath(targetInfo);

  // Sub-agent: check rules and session grants only
  if (context.isSubAgent) {
    const ruleResult = await checkAgainstRules(
      tool.name,
      targetPath,
      context.cwd,
    );
    if (ruleResult) return ruleResult;
    if (
      hasDirectoryGrant(tool.name, targetInfo.path, context.permissionGrants)
    ) {
      return { allowed: true };
    }
    return { allowed: false, reason: "子代理无权执行此写操作" };
  }

  // Check rules file
  const ruleResult = await checkAgainstRules(
    tool.name,
    targetPath,
    context.cwd,
  );
  if (ruleResult) return ruleResult;

  // Check session-level directory grants
  if (
    hasDirectoryGrant(tool.name, targetInfo.path, context.permissionGrants) &&
    !isDangerousPath(targetInfo.path)
  ) {
    return { allowed: true };
  }

  // Interactive prompt
  if (!context.askUser) {
    return { allowed: false, reason: "无法询问用户" };
  }

  // Dangerous warnings
  if (tool.name === "Bash" && isDangerousCommand(input.command as string)) {
    console.error(`\n\x1b[31m[⚠️ 危险命令检测]\x1b[0m ${input.command}`);
  }

  const preview = buildPreview(tool.name, input);
  const grantDir = context.cwd;
  const prompt =
    `\n\x1b[33m[权限请求]\x1b[0m 工具: ${tool.name}\n${preview}\n\n` +
    `允许此操作？\n` +
    `  y = 允许一次\n` +
    `  a = 允许 ${tool.name} 在 ${grantDir} 下所有操作\n` +
    `  r = 保存规则 (持久生效)\n` +
    `  n = 拒绝\n` +
    `> `;
  const answer = (await context.askUser(prompt)).toLowerCase();

  if (answer === "y" || answer === "yes") {
    return { allowed: true };
  }
  if (answer === "a" || answer === "all") {
    context.permissionGrants.add(`${tool.name}:${grantDir}`);
    console.error(
      `\x1b[32m[已授权]\x1b[0m ${tool.name} 在 ${grantDir} 及子目录下自动放行`,
    );
    return { allowed: true };
  }
  if (answer === "r" || answer === "rule") {
    await addRule({
      tool: tool.name,
      effect: "allow",
      match: `dir:${grantDir}`,
      note: `Auto-created for ${tool.name} in ${grantDir}`,
    });
    console.error(
      `\x1b[32m[已保存规则]\x1b[0m ${tool.name} 在 ${grantDir} 下永久放行`,
    );
    return { allowed: true };
  }
  return { allowed: false, reason: "用户拒绝了此操作" };
}

function hasDirectoryGrant(
  toolName: string,
  targetDir: string,
  grants: Set<string>,
): boolean {
  if (!targetDir) return false;
  for (const grant of grants) {
    if (!grant.startsWith(`${toolName}:`)) continue;
    const grantedDir = grant.slice(toolName.length + 1);
    if (grantedDir === "*") return true;
    const normalizedTarget = targetDir.endsWith("/")
      ? targetDir
      : targetDir + "/";
    const normalizedGrant = grantedDir.endsWith("/")
      ? grantedDir
      : grantedDir + "/";
    if (
      normalizedTarget === normalizedGrant ||
      normalizedTarget.startsWith(normalizedGrant)
    ) {
      return true;
    }
  }
  return false;
}

async function checkAgainstRules(
  toolName: string,
  targetPath: string,
  cwd: string,
): Promise<PermissionResult | null> {
  const rules = await loadRules();

  // Deny rules take precedence
  for (const rule of rules) {
    if (rule.effect === "deny" && matchRule(rule, toolName, targetPath, cwd)) {
      return {
        allowed: false,
        reason: `被规则拦截: ${rule.note ?? rule.match}`,
      };
    }
  }

  // Then check allow rules
  for (const rule of rules) {
    if (rule.effect === "allow" && matchRule(rule, toolName, targetPath, cwd)) {
      return { allowed: true };
    }
  }

  return null; // No rule matched
}

async function addRule(rule: Omit<PermissionRule, "id">): Promise<void> {
  const rules = await loadRules();
  const id = `rule_${Date.now()}`;
  rules.push({ id, ...rule });
  await saveRules(rules);
}

function buildPreview(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Write": {
      const content = (input.content as string) ?? "";
      const lines = content.split("\n");
      const preview = lines.slice(0, 3).join("\n");
      return `  文件: ${input.file_path}\n  内容预览:\n  ${preview}${lines.length > 3 ? "\n  ..." : ""}`;
    }
    case "Edit":
      return `  文件: ${input.file_path}\n  替换: "${(input.old_string as string)?.slice(0, 80)}" → "${(input.new_string as string)?.slice(0, 80)}"`;
    case "Bash":
      return `  命令: ${input.command}`;
    case "Agent":
      return `  任务: ${(input.task as string)?.slice(0, 80)}`;
    default:
      return `  ${JSON.stringify(input, null, 2).slice(0, 200)}`;
  }
}
