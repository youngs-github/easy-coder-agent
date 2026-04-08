import type { Tool, ToolContext, ToolResult } from "../types.js";

const DEFAULT_MAX_RESULTS = 8;
const SEARCH_TIMEOUT = 15000;

interface JinaSearchResult {
  title: string;
  url: string;
  description: string;
  content?: string;
}

async function execute(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const query = input.query as string;
  const maxResults = (input.max_results as number) ?? DEFAULT_MAX_RESULTS;

  try {
    const results = await searchWithJina(query, maxResults, context.abortSignal);
    if (results.length === 0) {
      return { success: true, output: "未找到相关搜索结果" };
    }
    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`
      )
      .join("\n\n");
    return {
      success: true,
      output: `搜索 "${query}" 的结果 (${results.length} 条):\n\n${formatted}`,
    };
  } catch (err: any) {
    // Fallback to DuckDuckGo HTML
    try {
      const results = await searchWithDuckDuckGo(query, maxResults, context.abortSignal);
      if (results.length === 0) {
        return { success: true, output: "未找到相关搜索结果" };
      }
      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`
        )
        .join("\n\n");
      return {
        success: true,
        output: `搜索 "${query}" 的结果 (${results.length} 条):\n\n${formatted}`,
      };
    } catch (fallbackErr: any) {
      return {
        success: false,
        output: "",
        error: `搜索失败: ${err.message}; 备选方案也失败: ${fallbackErr.message}`,
      };
    }
  }
}

async function searchWithJina(
  query: string,
  maxResults: number,
  abortSignal?: AbortSignal
): Promise<JinaSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(
      `https://s.jina.ai/${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: "application/json",
          "X-Retain-Images": "none",
        },
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Jina API 返回 ${response.status}`);
    }

    const data = (await response.json()) as { data?: Array<{ title: string; url: string; description: string; content?: string }> };
    const items = data.data ?? [];
    return items.slice(0, maxResults).map((item) => ({
      title: item.title || "(无标题)",
      url: item.url,
      description: item.description || item.content?.slice(0, 200) || "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWithDuckDuckGo(
  query: string,
  maxResults: number,
  abortSignal?: AbortSignal
): Promise<JinaSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `q=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo 返回 ${response.status}`);
    }

    const html = await response.text();
    return parseDuckDuckGoHTML(html, maxResults);
  } finally {
    clearTimeout(timeout);
  }
}

function parseDuckDuckGoHTML(html: string, maxResults: number): JinaSearchResult[] {
  const results: JinaSearchResult[] = [];
  // Match result links: <a rel="nofollow" class="result__a" href="...">title</a>
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Match snippets: <a class="result__snippet" ...>snippet</a>
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: { url: string; title: string }[] = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = decodeURIComponent(
      match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").replace(/&rut=.*$/, "")
    );
    const title = match[2].replace(/<[^>]*>/g, "").trim();
    if (url.startsWith("http")) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]*>/g, "").trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      description: snippets[i] ?? "",
    });
  }

  return results;
}

export const webSearchTool: Tool = {
  definition: {
    name: "WebSearch",
    description:
      "搜索互联网上的信息，包括技术文档、新闻、GitHub 仓库、Stack Overflow 问题等。返回搜索结果的标题、链接和摘要。搜索到感兴趣的结果后，可以用 WebFetch 工具深入阅读。",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词（建议使用英文以获得更好的结果）",
        },
        max_results: {
          type: "number",
          description: "最大返回结果数量（默认 8）",
        },
      },
      required: ["query"],
    },
    isReadOnly: true,
  },
  execute,
};
