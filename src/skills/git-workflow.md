---
name: git-workflow
description: Git 工作流技能，规范 commit message、分支操作、PR 创建等操作
---

# Git 工作流

当需要执行 Git 操作时，遵循以下规范：

## 提交规范

### Commit Message 格式
```
<type>(<scope>): <subject>

<body>
```

### Type 列表
- `feat`: 新功能
- `fix`: 修复 bug
- `refactor`: 重构（不改变行为）
- `docs`: 文档
- `test`: 测试
- `chore`: 构建/工具变动

### 规则
1. 提交前先 `git status` 检查变更范围
2. 使用 `git diff --staged` 确认暂存内容
3. subject 不超过 72 个字符
4. body 解释"为什么"而非"做了什么"
5. 不要提交包含敏感信息的文件（.env、密钥等）

## 分支操作
- 创建分支前先 `git pull`
- 删除分支前确认已合并
- 不要 force push 到 main/master

## PR 操作
- PR 标题不超过 70 字符
- body 包含 Summary 和 Test plan
- 先本地测试通过再创建 PR
