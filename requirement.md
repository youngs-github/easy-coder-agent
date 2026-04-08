# easy-coder-agent 实现需求

## 项目概述

实现一个简化版的 AI 编程助手命令行工具（参考 Claude Code），具备完整的工具调用循环、上下文压缩、子代理系统和持久化记忆能力，可实际用于日常编程辅助工作。

**技术栈**：TypeScript + Node.js，使用 `readline` 做交互界面，不依赖 React/Ink 等 UI 框架。

---

## 一、核心数据结构

### 1.1 消息类型

```typescript
type TextBlock = { type: "text"; text: string };
type ThinkingBlock = { type: "thinking"; thinking: string };
type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type MessageContent =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

type Message = {
  role: "user" | "assistant";
  content: string | MessageContent[];
  // 内部元数据，不发给 API
  _meta?: {
    isContext?: boolean; // 系统上下文注入消息（EasyCoder.md 等）
    isCompactSummary?: boolean; // compact 生成的摘要消息
  };
};
```

### 1.2 工具定义

```typescript
type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
  isReadOnly: boolean; // 用于权限判断，只读工具自动允许
};

type ToolResult = {
  success: boolean;
  output: string; // 返回给模型的文本
  error?: string;
};
```

### 1.3 会话状态

```typescript
type SessionState = {
  sessionId: string;
  messages: Message[];
  cwd: string;
  model: string;
  // 权限记忆：用户选择"永久允许"的工具+路径组合
  permissionGrants: Set<string>;
  // compact 时记录，用于判断是否需要再次 compact
  lastCompactTokenCount: number;
};
```

---

## 二、System Prompt 构建

### 2.1 静态 System Prompt

在所有 API 调用中使用，内容包含：

1. **角色描述**：你是一个 AI 编程助手，运行在用户的终端里，帮助用户完成编程任务
2. **工具使用规范**：
   - Read 工具用于读取文件，避免重复读取同一文件
   - Edit 工具的 old_string 必须在文件中唯一存在，否则报错
   - Bash 工具执行的命令应当是幂等的或可逆的
   - 在修改文件前先读取确认内容
3. **行为约束**：
   - 不要在没有充分理由的情况下执行破坏性操作
   - 遇到不确定的情况先询问用户
   - 完成任务后简洁说明做了什么，不要冗长总结

### 2.2 动态上下文注入

每轮 API 调用前，在消息数组**最前面**插入一条 `_meta.isContext: true` 的 user 消息（不显示给用户），内容为：

```
<system-context>
currentDate: {{今天的日期，格式 YYYY-MM-DD}}
cwd: {{当前工作目录绝对路径}}
{{如果存在 EasyCoder.md，则追加：}}
projectInstructions: {{EasyCoder.md 文件内容}}
</system-context>
```

发送消息前从消息列表中过滤掉上一次的 context 消息（`_meta.isContext: true`），重新生成最新的插入最前面。确保 context 消息始终是最新值。

### 2.3 EasyCoder.md 读取规则

启动时和每次对话开始时，按以下顺序查找并合并：

1. `~/.easy-coder-agent/EasyCoder.md`（全局用户配置）
2. `<git根目录>/EasyCoder.md`（项目配置，通过 `git rev-parse --show-toplevel` 获取）
3. `<cwd>/EasyCoder.md`（当前目录配置）

若多个文件均存在，按顺序拼接，用 `---` 分隔。

---

## 三、Agent Loop（核心循环）

### 3.1 主循环逻辑

```
function queryLoop(params):
  while true:
    1. 注入动态上下文到 messages 头部
    2. 调用 API（流式），实时打印 text 内容
    3. 解析 response:
       - 如果 stop_reason == 'end_turn' 且无 tool_use → 返回（本轮结束）
       - 如果 stop_reason == 'max_tokens' → 报错提示用户
       - 如果包含 tool_use blocks:
           a. 将 assistant response 追加到 messages
           b. 对每个 tool_use，依次执行工具（见第四章）
           c. 将所有 tool_result 组合为一条 user 消息追加到 messages
           d. continue（继续循环）
    4. 检查是否达到 maxTurns 上限 → 报错退出
```

### 3.2 流式输出处理

使用 stream 模式：

- `content_block_start`（type=text）→ 开始打印
- `content_block_delta`（text_delta）→ 实时 `process.stdout.write(delta.text)`
- `content_block_start`（type=tool_use）→ 打印 `\n[工具调用: <名称>]`
- `content_block_stop` → 换行
- `message_stop` → 收集完整的 content blocks 用于工具执行

thinking block 的处理：收集但不打印（默认隐藏），完整保留在 message 里（API 要求 thinking 必须跟随到对应 tool_result 之后）。

### 3.3 Turn 数限制

- 主代理默认 `maxTurns: 50`
- 子代理默认 `maxTurns: 15`
- 达到上限时，追加一条 user 消息告知模型已达到 turn 限制，让其给出当前状态总结后退出

---

## 四、工具系统

### 4.1 工具注册表

实现以下工具，每个工具是一个对象，包含 `definition`（传给 API 的 schema）和 `execute(input, context)` 函数：

#### Read（文件读取）

- 参数：`file_path: string`，可选 `start_line: number`，`end_line: number`
- 行为：读取文件内容，带行号返回（`1|第一行内容\n2|第二行内容`）
- 支持行号范围读取，大文件（>2000行）默认只读前 200 行并提示总行数
- `isReadOnly: true`

#### Write（文件写入）

- 参数：`file_path: string`，`content: string`
- 行为：覆盖写入文件（自动创建父目录）
- 写入前显示 diff 摘要（新建文件：显示行数；覆盖：显示增删行数）
- `isReadOnly: false`

#### Edit（精确编辑）

- 参数：`file_path: string`，`old_string: string`，`new_string: string`
- 行为：在文件中替换**唯一**匹配的 `old_string` 为 `new_string`
- 错误处理：
  - `old_string` 不存在 → 返回错误："old_string 在文件中未找到"
  - `old_string` 出现多次 → 返回错误："old_string 出现了 N 次，需要提供更多上下文确保唯一性"
- `isReadOnly: false`

#### Bash（Shell 执行）

- 参数：`command: string`，可选 `timeout_ms: number`（默认 30000）
- 行为：在当前 `cwd` 下执行命令，返回 stdout + stderr
- 输出截断：超过 10000 字符时截断并提示
- 超时处理：kill 进程后返回已有输出 + 超时提示
- 危险命令检测（以下需额外确认）：`rm -rf`、`sudo`、`chmod 777`、`> /dev/`、`dd if=`
- `isReadOnly: false`
- 只读判断（用于子代理自动允许）：命令以 `ls`、`cat`、`grep`、`find`、`wc`、`head`、`tail`、`git log`、`git diff`、`git status` 开头

#### Grep（内容搜索）

- 参数：`pattern: string`，`path: string`，可选 `glob: string`（文件过滤，如 `*.ts`）
- 行为：使用系统 ripgrep（`rg`）或 grep 搜索，返回匹配行（格式：`文件名:行号:内容`）
- 结果上限：最多返回 100 条匹配
- `isReadOnly: true`

#### Glob（文件搜索）

- 参数：`pattern: string`，可选 `path: string`（搜索根目录，默认 cwd）
- 行为：返回匹配的文件路径列表，按修改时间降序排列
- 结果上限：最多返回 200 个文件
- `isReadOnly: true`

#### Agent（子代理）

- 参数：`task: string`，可选 `allowed_tools: string[]`
- 行为：见第六章
- `isReadOnly: false`

### 4.2 权限系统

工具执行前调用 `checkPermission(tool, input, session)` 函数：

**自动允许条件**（无需询问）：

- `tool.isReadOnly === true`
- 路径在 `session.permissionGrants` 中有记录（用户曾选择"永久允许"）
- 当前是子代理且工具为只读（子代理只读操作静默执行）

**需要询问**：

- 所有写操作（Write/Edit/Bash 非只读命令）

**询问交互格式**：

```
[权限请求] 工具: Write
文件路径: /Users/xxx/project/src/utils.ts
内容预览: （前3行）

允许此操作？[y=允许一次 / Y=永久允许此路径 / n=拒绝]
```

用户选 `Y` 时，将 `tool.name + ":" + filePath` 加入 `session.permissionGrants`。

**危险路径黑名单**（即使选永久允许也每次提示）：

- `~/.ssh/`
- `~/.aws/`
- `/etc/`
- `/usr/`
- `/bin/`
- `/sbin/`

### 4.3 工具执行编排

多个 `tool_use` blocks 的执行策略：

- **只读工具**：全部并发执行（`Promise.all`）
- **写操作工具**：串行执行，一个完成后再执行下一个
- **混合情况**：先并发执行所有只读，再串行执行写操作

执行时在终端实时显示进度：

```
[执行工具] Read: src/utils.ts ... ✓ (245 行)
[执行工具] Bash: npm test ... ✓ (2.3s)
[执行工具] Edit: src/utils.ts ... ✓
```

---

## 五、上下文压缩（Compact）

### 5.1 触发时机

每次 API 调用**收到响应后**，检查 `response.usage.input_tokens + response.usage.output_tokens`，若超过以下阈值则在下一轮开始前执行压缩：

- 默认阈值：**160,000 tokens**（为 200k 上下文窗口的 80%）
- 两次压缩之间至少间隔 **20,000 tokens** 增长（防止频繁压缩）

用户也可通过 `/compact` 命令手动触发。

### 5.2 压缩流程

**Step 1：生成摘要**

发送一次独立的 API 调用（`model: MiniMax-M2.5-highspeed`，节省成本），输入为完整的 messages 历史，user prompt 为：

```
请对以上对话生成一份详细摘要，用于让新的 AI 助手无缝接续当前工作。

摘要必须包含以下章节：

## 任务概述
用户要求做什么，核心目标是什么

## 当前状态
正在进行中的工作，尚未完成的任务，下一步应该做什么

## 已完成的工作
列出所有已完成的修改，包括修改了哪些文件、做了什么改动

## 关键决策
过程中做出的重要技术决策及其原因

## 重要文件
涉及的核心文件路径及其作用简介

## 错误与修复
遇到的问题、失败的方案、最终的解决方法（不要重复已解决的路径）

## 用户偏好
用户在此次对话中表达的偏好和要求（如代码风格、不想用某些方案等）

摘要应当足够详细，让助手读完后能立即继续工作，不需要询问已经讨论过的信息。
```

**Step 2：找安全截断点**

从 messages 末尾往前找，保留最近的 N 条消息，规则：

- 保留最少 **4 条**、最多 **10 条**消息
- 截断点不能落在 `tool_use` 和对应的 `tool_result` 之间（必须成对保留）
- 具体实现：从末尾数消息，遇到 user 消息（非 tool_result）则作为安全截断点

**Step 3：重组 messages**

```
新的 messages = [
  {
    role: 'user',
    content: '<compact-summary>\n' + 摘要内容 + '\n</compact-summary>',
    _meta: { isCompactSummary: true }
  },
  {
    role: 'assistant',
    content: '我已了解之前的工作进度，继续我们的任务。'
  },
  ...最近保留的消息
]
```

**Step 4：用户通知**

压缩完成后在终端打印：

```
[上下文压缩] 已将 X 条消息压缩为摘要 (节省约 Y tokens)
```

### 5.3 手动压缩命令 `/compact`

用户输入 `/compact` 时，无论是否达到阈值都立即执行压缩流程，然后打印摘要内容供用户确认。

---

## 六、子代理系统

### 6.1 Agent 工具执行逻辑

```typescript
async function executeAgentTool(input, parentSession):
  // 1. 确定工具集
  const tools = input.allowed_tools
    ? ALL_TOOLS.filter(t => input.allowed_tools.includes(t.name))
    : ALL_TOOLS.filter(t => t.name !== 'Agent')  // 禁止子代理嵌套

  // 2. 构建子代理的 messages（只有任务描述，不含父对话历史）
  const messages = [{ role: 'user', content: input.task }]

  // 3. 运行独立的 query loop
  const result = await queryLoop({
    messages,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 15,
    isSubAgent: true,
    parentPermissionGrants: parentSession.permissionGrants,
    cwd: parentSession.cwd,
  })

  // 4. 只返回最终文本给父代理
  return extractFinalText(result.messages)
```

### 6.2 子代理的权限策略

`isSubAgent: true` 时，权限判断规则改为：

- 只读工具 → **自动允许**（静默执行，不打印询问）
- 写工具 → 走父代理的 `permissionGrants` 检查，命中则允许，否则**拒绝并在结果中告知**（不询问用户，避免阻断异步执行）

终端显示时，子代理的输出用缩进区分：

```
[子代理启动] 任务: 分析 auth 模块的结构
  [执行工具] Read: src/auth/index.ts ... ✓
  [执行工具] Grep: validateToken ... ✓ (12 条匹配)
  [执行工具] Glob: src/auth/**/*.ts ... ✓ (5 个文件)
[子代理完成] 耗时 8.2s，使用 3 轮对话
```

### 6.3 子代理结果处理

子代理返回的字符串作为对应 `tool_result` 的 `content` 传回父代理。如果子代理内部报错或超出 turn 限制，返回包含错误信息的字符串（不 throw，让父代理决定如何处理）。

---

## 七、持久化记忆（EasyCoder.md 写入）

### 7.1 用户主动记忆

实现 `/remember <内容>` 命令：

- 将内容追加到 `~/.easy-coder-agent/EasyCoder.md`
- 格式：`- [YYYY-MM-DD] <内容>`
- 同时刷新下一轮的 context 注入

### 7.2 会话持久化

每次对话后，将 `messages` 序列化保存到 `~/.easy-coder-agent/sessions/<sessionId>.json`，包含：

- `sessionId`
- `createdAt`、`updatedAt`
- `cwd`（会话工作目录）
- `messages`（完整消息历史）

文件总数超过 20 个时，删除最旧的（按 `updatedAt`）。

### 7.3 会话恢复

启动时支持 `--resume <sessionId>` 参数，或 `/resume` 命令列出最近 5 个会话供选择：

```
最近的会话：
1. [2026-04-06 14:23] auth 模块重构 (session_abc123)
2. [2026-04-05 09:11] 添加单元测试 (session_def456)
...
选择会话编号（回车新建）:
```

---

## 八、Slash 命令系统

用户输入以 `/` 开头时，解析为命令而不是发给 API：

| 命令               | 功能                                                     |
| ------------------ | -------------------------------------------------------- |
| `/help`            | 显示所有命令列表                                         |
| `/clear`           | 清除对话历史（保留 context 注入），重置 permissionGrants |
| `/compact`         | 手动触发上下文压缩                                       |
| `/status`          | 显示当前 token 使用量、消息数、cwd                       |
| `/remember <内容>` | 追加到 `~/.easy-coder-agent/EasyCoder.md`                |
| `/resume`          | 列出历史会话，选择恢复                                   |
| `/exit` 或 `/quit` | 退出程序                                                 |

---

## 九、交互界面

### 9.1 输入处理

使用 Node.js 的 `readline` 模块：

- 支持方向键历史（`readline` 原生支持）
- `Ctrl+C` 取消当前请求（使用 `AbortController`），不退出程序
- `Ctrl+C` 连按两次退出程序

### 9.2 输出格式

- 模型文本输出：直接流式打印
- 工具执行状态：`[工具名: 参数摘要] ... ✓/✗` 格式
- 系统通知（压缩、权限等）：用 `[方括号]` 包裹，与模型输出视觉区分
- 错误信息：`[错误] ...` 格式，打印到 stderr

### 9.3 启动界面

```
EasyCoder v0.1.0
模型: MiniMax-M2.7  |  工作目录: /Users/xxx/project
输入 /help 查看命令，Ctrl+C 取消当前操作

>
```

---

## 十、配置与环境

### 10.1 环境变量

- `OPENAI_KEY`：必须，API 密钥（sk-api-ps3TqZFhpz0uHxUlDtH7RM1FURujUOivXHv7O_hnjKGQL1lTUTYchGGuddwQq8plbTMywdXMcOidfudkjGtzWdyKc1CsxxLKWRa-veuQvTiwGgvtC4jIU7c）
- `OPENAI_URL`：必须，API 地址（https://api.minimaxi.com/anthropic）
- `OPENAI_MODEL`：模型名称，默认 `MiniMax-M2.7`
- `OPENAI_COMPACT_MODEL`：压缩用模型，默认 `MiniMax-M2.5-highspeed`（节省成本）
- `OPENAI_COMPACT_THRESHOLD`：触发压缩的 token 数，默认 `160000`
- `OPENAI_MAX_TURNS`：主代理最大 turn 数，默认 `50`

### 10.2 配置目录

- `~/.easy-coder-agent/` — 主配置目录
- `~/.easy-coder-agent/sessions/` — 会话持久化目录
- `~/.easy-coder-agent/EasyCoder.md` — 与真实 EasyCoder 共享的用户配置（只读，不覆盖）

---

## 十一、错误处理

### API 错误

| 错误类型           | 处理方式                               |
| ------------------ | -------------------------------------- |
| `401 Unauthorized` | 提示检查 `OPENAI_KEY` 并退出           |
| `429 Rate Limit`   | 等待 `retry-after` 秒后重试，最多 3 次 |
| `529 Overloaded`   | 等待 30 秒后重试，最多 3 次            |
| `500/503`          | 等待 10 秒后重试，最多 2 次            |
| 网络超时           | 60 秒超时，超时后报错（不重试）        |

### 工具执行错误

工具执行失败时，返回 `is_error: true` 的 `tool_result`，内容为错误信息。让模型自行决定是否重试或换方案，**不要在代码层面自动重试工具**。

---

## 十二、实现顺序建议

1. **第一阶段（可运行 MVP）**
   - Agent Loop + 流式输出
   - Read / Write / Edit / Bash / Grep / Glob 工具
   - 基础权限询问（只读自动允许，写操作询问）
   - `/clear`、`/help`、`/exit` 命令

2. **第二阶段（实用化）**
   - EasyCoder.md 读取与注入
   - 上下文压缩（Compact）
   - 会话持久化与恢复
   - 完善错误处理与重试

3. **第三阶段（完善功能）**
   - Agent 子代理工具
   - `/remember` 命令
   - `/status` 命令
   - 永久权限授权（`permissionGrants`）
