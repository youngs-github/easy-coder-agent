import { getSkillRegistry, lookupSkill } from "../skills/loader.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

async function execute(
  input: Record<string, unknown>,
  _context: ToolContext
): Promise<ToolResult> {
  const name = input.name as string;
  if (!name) {
    // List all available skills
    const skills = getSkillRegistry();
    if (skills.length === 0) {
      return { success: true, output: "(无可用技能)" };
    }
    const lines = skills.map(
      (s) => `  ${s.name}: ${s.description}`
    );
    return {
      success: true,
      output: `可用技能:\n${lines.join("\n")}\n\n使用 name 参数获取具体技能内容。`,
    };
  }

  const skill = lookupSkill(name);
  if (!skill) {
    return { success: false, output: "", error: `未找到技能: ${name}` };
  }

  return { success: true, output: skill.content };
}

export const skillReadTool: Tool = {
  definition: {
    name: "SkillRead",
    description:
      "按名称检索技能的完整内容。不传 name 参数时列出所有可用技能。模型应先查看技能索引，再按需读取具体内容。",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "要检索的技能名称（可选，不传则列出所有可用技能）",
        },
      },
    },
    isReadOnly: true,
  },
  execute,
};
