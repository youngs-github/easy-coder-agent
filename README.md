# EasyCoder Agent

轻量级 **AI 编程助手 CLI**：在终端中与模型对话，通过工具读写代码、执行命令、检索与联网，并支持会话持久化、上下文压缩与可扩展技能。

---

## 面向 AI / 自动化工具的元信息（便于识别与抽取）

以下字段用于索引、RAG 或 IDE 插件快速理解本仓库；**以 `package.json` 与源码为准**，版本号随发布更新。

| 字段 | 值 |
|------|-----|
| `project.name` | `easy-coder-agent` |
| `project.type` | `cli` / `nodejs` / `typescript` |
| `cli.binary` | `easy-coder`（`package.json` → `bin`） |
| `runtime` | Node.js `>=18` |
| `entry.source` | `src/main.ts` |
| `entry.build` | `dist/main.js` |
| `license` | MIT |
| `primary.language` | zh-CN（界面与默认文档语言） |

**能力标签（关键词）**：`coding-agent`、`llm`、`agentic`、`cli`、`tool-use`、`session`、`skills`

**配置入口**：**统一使用 `OPENAI_*` 前缀**；协议类型由 **`OPENAI_API_TYPE`** 区分（`openai` 或 `anthropic`）。启动时加载**当前目录 `.env`**（内置解析，不依赖 dotenv），另有全局 **`~/.easy-coder/settings.json`**（见下文优先级）。

**用户数据目录**：`~/.easy-coder/`（会话、全局技能、全局 `EasyCoder.md` 等）。

---

## 功能概览

- **交互模式**：在启动目录下与模型多轮对话；写操作前可确认，支持会话级/持久权限规则。
- **打印模式**：`-p` / `--print` 单次问答，适合脚本与 CI；可配合 `--auto-approve` 自动放行写操作。
- **工具**：读/写/编辑文件、`grep`/`glob`、Bash、联网搜索与抓取、子代理、待办读写、技能读取等（见 `src/tools/`）。
- **上下文**：超长对话可自动或手动压缩（`/compact`）；用量与费用在状态中展示。
- **技能（Skills）**：内置 + `~/.easy-coder/skills/` + 项目内 `skills/`，启动时注入系统提示。
- **记忆**：`/remember` 追加到 `~/.easy-coder/EasyCoder.md`；也可在仓库或 Git 根目录放置 `EasyCoder.md` 作为项目说明。

---

## 环境要求

- [Node.js](https://nodejs.org/) **18+**
- 可用的 **OpenAI 兼容 API** 或 **Anthropic 兼容端点**（通过 `OPENAI_API_TYPE` 选择）

---

## 安装与构建

```bash
git clone <本仓库 URL>
cd easy-coder-agent
npm install
npm run build
```

开发调试（不先构建）：

```bash
npm run dev
```

全局或本地调用构建产物：

```bash
node dist/main.js
# 或通过 npm link / npx 使用包名提供的 easy-coder 命令
```

---

## 配置

**优先级（后者不覆盖前者已存在的键）**：

1. **操作系统 / Shell 中已设置的环境变量**（最高）
2. **当前工作目录下的 `.env`**：程序启动时会自动解析并写入 `process.env`（**不会覆盖**启动前已存在的同名变量；文件不存在则忽略）
3. **`~/.easy-coder/settings.json`**：仅当某键在以上两处都未提供时，才从该文件读取

`.env` 需使用 `KEY=value` 形式（见 `.env.example`）；**不需要**再安装 `dotenv` 包，CLI 已内置轻量解析。

**键名统一为 `OPENAI_*`**（与底层是 OpenAI 兼容还是 Anthropic Messages 无关）；**`OPENAI_API_TYPE`** 决定走哪种请求格式。

| 变量 | 说明 |
|------|------|
| `OPENAI_KEY` | API 密钥（**必填**） |
| `OPENAI_URL` | API 基础地址（第三方网关或官方/代理根 URL，以服务商文档为准） |
| `OPENAI_MODEL` | 主对话模型 |
| `OPENAI_COMPACT_MODEL` | 上下文压缩等场景使用的模型 |
| `OPENAI_COMPACT_THRESHOLD` | 触发自动压缩的累计 token 阈值（默认 `160000`） |
| `OPENAI_MAX_TURNS` | 单次用户消息内 Agent 最大轮数（默认 `50`） |
| `OPENAI_API_TYPE` | **`openai`**（默认）：Chat Completions 等 OpenAI 兼容接口；**`anthropic`**：[Messages API](https://docs.anthropic.com/en/api/messages) 格式（官方 Anthropic 或同款协议的代理/云厂商） |

使用 **`OPENAI_API_TYPE=anthropic`** 时，仍将 `OPENAI_URL` 设为对应服务的 **Messages API 根地址**（路径以文档为准）。

### 环境变量

复制仓库内 `.env.example` 为参考。

OpenAI 兼容：

```bash
export OPENAI_KEY="your-key"
export OPENAI_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model"
export OPENAI_COMPACT_MODEL="your-compact-model"
export OPENAI_API_TYPE="openai"
```

Anthropic Messages API（**键名仍为 `OPENAI_*`，仅改类型与 URL/模型**）：

```bash
export OPENAI_KEY="your-key"
export OPENAI_URL="https://api.anthropic.com"
export OPENAI_MODEL="claude-sonnet-4-20250514"
export OPENAI_COMPACT_MODEL="claude-sonnet-4-20250514"
export OPENAI_API_TYPE="anthropic"
```

### 全局 `~/.easy-coder/settings.json`

在用户主目录下固定路径（与源码中 `SETTINGS_PATH` 一致）：

- **macOS / Linux**：`~/.easy-coder/settings.json`
- **Windows**：`%USERPROFILE%\.easy-coder\settings.json`

手动创建该文件即可；首次运行程序也会创建 `~/.easy-coder/` 目录（若不存在）。字段与上表一致，例如 OpenAI 兼容：

```json
{
  "OPENAI_KEY": "your-api-key",
  "OPENAI_URL": "https://api.example.com/v1",
  "OPENAI_MODEL": "your-main-model",
  "OPENAI_COMPACT_MODEL": "your-compact-model",
  "OPENAI_COMPACT_THRESHOLD": 160000,
  "OPENAI_MAX_TURNS": 50,
  "OPENAI_API_TYPE": "openai"
}
```

Anthropic 协议示例（**仍为 `OPENAI_*` 键**）：

```json
{
  "OPENAI_KEY": "your-api-key",
  "OPENAI_URL": "https://api.anthropic.com",
  "OPENAI_MODEL": "claude-sonnet-4-20250514",
  "OPENAI_COMPACT_MODEL": "claude-sonnet-4-20250514",
  "OPENAI_COMPACT_THRESHOLD": 160000,
  "OPENAI_MAX_TURNS": 50,
  "OPENAI_API_TYPE": "anthropic"
}
```

说明：`OPENAI_KEY` 必须在环境变量或本文件中至少配置一处，否则启动会报错并退出。

首次运行还会在 `~/.easy-coder/` 下创建会话目录、技能目录，并生成占位 `EasyCoder.md`（若尚不存在）。

---

## 用法

### 交互模式（默认）

在目标项目目录执行：

```bash
easy-coder
# 或
node dist/main.js
```

常用斜杠命令：`/help`、`/clear`、`/compact`、`/status`、`/usage`、`/skills`、`/remember <内容>`、`/resume`、`/version`、`/exit`

恢复历史会话：

```bash
easy-coder --resume <sessionId>
```

### 打印模式（非交互）

```bash
easy-coder -p "你的问题"
echo "你的问题" | easy-coder -p
```

自动批准写类工具（脚本场景慎用）：

```bash
easy-coder -p "任务描述" --auto-approve
```

---

## 仓库结构（给贡献者与 AI）

| 路径 | 说明 |
|------|------|
| `src/main.ts` | CLI 入口：参数解析、交互循环、打印模式 |
| `src/commands/` | 斜杠命令处理 |
| `src/config/` | 配置目录路径、`settings.json`、说明文件加载 |
| `src/context/` | 系统提示、上下文压缩 |
| `src/service/` | API、会话、用量、Agent 主循环 |
| `src/service/provider/` | OpenAI / Anthropic 等提供商适配 |
| `src/tools/` | 各类工具定义与实现 |
| `src/skills/` | 打包随应用分发的内置技能（构建时复制到 `dist/skills`） |
| `tsconfig.json` | TypeScript 配置 |

---

## 许可证

MIT，详见仓库内 `LICENSE`。

---

## 链接

- 作者：`package.json` 中的 `author` 字段
- 包名与发布：`easy-coder-agent`（npm 见 `package.json` → `name` / `publishConfig`）
