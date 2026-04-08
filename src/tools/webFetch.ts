import type { Tool, ToolContext, ToolResult } from "../types.js";

const FETCH_TIMEOUT = 20000;
const MAX_CONTENT_LENGTH = 15000;

async function execute(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const url = input.url as string;

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return {
      success: false,
      output: "",
      error: "URL 必须以 http:// 或 https:// 开头",
    };
  }

  try {
    const content = await fetchWithJinaReader(url, context.abortSignal);
    return { success: true, output: content };
  } catch (err: any) {
    // Fallback to direct fetch
    try {
      const content = await fetchDirect(url, context.abortSignal);
      return { success: true, output: content };
    } catch (fallbackErr: any) {
      return {
        success: false,
        output: "",
        error: `获取页面失败: ${err.message}`,
      };
    }
  }
}

async function fetchWithJinaReader(
  url: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }

  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: "text/plain",
        "X-Retain-Images": "none",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Jina Reader 返回 ${response.status}`);
    }

    let content = await response.text();
    if (content.length > MAX_CONTENT_LENGTH) {
      content =
        content.slice(0, MAX_CONTENT_LENGTH) +
        `\n\n[...内容已截断，共约 ${Math.round(content.length / 1000)}k 字符]`;
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDirect(
  url: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; EasyCoder/0.1; +https://github.com/easy-coder-agent)",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/") &&
      !contentType.includes("application/json")
    ) {
      return `[二进制内容，类型: ${contentType}，无法显示]`;
    }

    let text = await response.text();

    // Strip HTML tags for rough text extraction
    if (contentType.includes("text/html")) {
      // Remove script/style blocks
      text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
      text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
      // Remove tags
      text = text.replace(/<[^>]+>/g, " ");
      // Collapse whitespace
      text = text.replace(/\s+/g, " ").trim();
    }

    if (text.length > MAX_CONTENT_LENGTH) {
      text =
        text.slice(0, MAX_CONTENT_LENGTH) +
        `\n\n[...内容已截断，共约 ${Math.round(text.length / 1000)}k 字符]`;
    }
    return text || "(页面内容为空)";
  } finally {
    clearTimeout(timeout);
  }
}

export const webFetchTool: Tool = {
  definition: {
    name: "WebFetch",
    description:
      "获取指定 URL 的网页内容，返回可读的纯文本/Markdown。适合在 WebSearch 找到目标链接后深入阅读页面内容。",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要获取内容的完整 URL（以 http:// 或 https:// 开头）",
        },
      },
      required: ["url"],
    },
    isReadOnly: true,
  },
  execute,
};
