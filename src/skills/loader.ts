import fs from "node:fs/promises";
import path from "node:path";
import { SKILLS_DIR, APP_SKILLS_DIR } from "../config/index.js";

export type SkillSource = "application" | "global" | "project";

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: SkillSource;
}

// In-memory skill registry — populated at startup, read by SkillRead tool on demand
let skillRegistry: Skill[] = [];

export function setSkillRegistry(skills: Skill[]): void {
  skillRegistry = skills;
}

export function getSkillRegistry(): Skill[] {
  return skillRegistry;
}

export function lookupSkill(name: string): Skill | undefined {
  return skillRegistry.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  // 0. Application skills: bundled with the agent
  const appSkills = await loadSkillsFromDir(APP_SKILLS_DIR, "application");
  skills.push(...appSkills);

  // 1. Global skills: ~/.easy-coder/skills/**/*
  const globalSkills = await loadSkillsFromDir(SKILLS_DIR, "global");
  skills.push(...globalSkills);

  // 2. Project skills: <cwd>/skills/**/*
  const projectSkills = await loadSkillsFromDir(
    path.join(cwd, "skills"),
    "project",
  );
  skills.push(...projectSkills);

  // Store in registry for on-demand lookup
  setSkillRegistry(skills);

  return skills;
}

async function loadSkillsFromDir(
  dir: string,
  source: SkillSource,
): Promise<Skill[]> {
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) continue;

    if (stat.isFile() && (entry.endsWith(".md") || entry.endsWith(".txt"))) {
      try {
        const raw = await fs.readFile(fullPath, "utf-8");
        const fallback = path.basename(entry, path.extname(entry));
        const { body } = parseFrontmatter(raw);
        skills.push({
          name: extractName(raw, fallback),
          description: extractDescription(raw),
          content: body,
          source,
        });
      } catch {
        /* skip unreadable */
      }
    } else if (stat.isDirectory()) {
      for (const indexFile of ["SKILL.md", "README.md", "index.md"]) {
        const indexPath = path.join(fullPath, indexFile);
        const raw = await fs.readFile(indexPath, "utf-8").catch(() => null);
        if (raw) {
          const { body } = parseFrontmatter(raw);
          skills.push({
            name: extractName(raw, entry),
            description: extractDescription(raw),
            content: body,
            source,
          });
          break;
        }
      }
    }
  }

  return skills;
}

/**
 * Parse YAML-like frontmatter from skill content.
 * Expects:
 *   ---
 *   name: skill-name
 *   description: A short description
 *   ---
 *
 * Returns { meta, body } where meta has parsed fields and body is the content after frontmatter.
 */
function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }

  const frontmatter = match[1];
  const body = raw.slice(match[0].length).trim();

  const meta: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) meta[key] = value;
  }

  return { meta, body };
}

function extractDescription(content: string): string {
  const { meta, body } = parseFrontmatter(content);
  if (meta.description) return meta.description.slice(0, 200);

  // Fallback: first non-empty, non-heading line from body
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const first = lines[0].replace(/^#+\s*/, "");
  return first.slice(0, 120);
}

function extractName(content: string, fallback: string): string {
  const { meta } = parseFrontmatter(content);
  return meta.name || fallback;
}

/**
 * Generate a lightweight skill index for context injection.
 * Only includes name + description — NOT full content.
 * The model should use SkillRead tool to retrieve content on demand.
 */
export function formatSkillsIndex(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const tag = (source: SkillSource) =>
    source === "application" ? "内置" : source === "global" ? "全局" : "项目";

  const lines = skills.map(
    (s) => `  - ${s.name} [${tag(s.source)}]: ${s.description}`,
  );

  return `<skills>\n以下是可用的技能列表（仅名称和描述）。当你需要某个技能的详细指导时，使用 SkillRead 工具按名称检索完整内容。\n\n${lines.join("\n")}\n</skills>`;
}
