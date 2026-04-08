import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { webSearchTool } from "./webSearch.js";
import { webFetchTool } from "./webFetch.js";
import { todoWriteTool } from "./todoWrite.js";
import { todoReadTool } from "./todoRead.js";
import { skillReadTool } from "./skillRead.js";
import type { Tool } from "../types.js";

export { readTool, writeTool, editTool, bashTool, grepTool, globTool, webSearchTool, webFetchTool, todoWriteTool, todoReadTool, skillReadTool };

// Agent tool is registered separately to avoid circular deps
export const BASE_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  webSearchTool,
  webFetchTool,
  todoWriteTool,
  todoReadTool,
  skillReadTool,
];

export function getAllTools(agentTool?: Tool): Tool[] {
  if (agentTool) return [...BASE_TOOLS, agentTool];
  return [...BASE_TOOLS];
}

export function getToolByName(name: string, tools: Tool[]): Tool | undefined {
  return tools.find((t) => t.definition.name === name);
}
