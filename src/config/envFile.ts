import fs from "node:fs";
import path from "node:path";

/**
 * 将当前工作目录下的 `.env` 解析进 `process.env`。
 * 不覆盖已在环境中存在的键（与常见 dotenv 行为一致）。
 * 支持 `KEY=value`、`export KEY=value`，以及带引号的值；`#` 开头为注释。
 */
export function loadDotEnv(cwd: string): void {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let rest = trimmed.startsWith("export ")
      ? trimmed.slice(7).trimStart()
      : trimmed;

    const eq = rest.indexOf("=");
    if (eq === -1) continue;

    const key = rest.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (process.env[key] !== undefined) continue;

    let value = rest.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
