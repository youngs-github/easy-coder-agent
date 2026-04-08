export class ApiError extends Error {
  statusCode: number;
  statusText: string;
  body: string;

  constructor(statusCode: number, statusText: string, body: string) {
    const detail = extractErrorMessage(body);
    super(
      detail
        ? `API Error ${statusCode}: ${detail}`
        : `API Error ${statusCode}: ${statusText}`,
    );
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.statusText = statusText;
    this.body = body;
  }

  get isAuth(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  get isRateLimit(): boolean {
    return this.statusCode === 429;
  }
}

function extractErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    // OpenAI: { error: { message: "..." } }
    // Anthropic: { error: { message: "..." } }
    if (parsed?.error?.message) return parsed.error.message;
    // Fallback: return first string value
    if (typeof parsed?.error === "string") return parsed.error;
    if (parsed?.message) return parsed.message;
  } catch {
    // Non-JSON body
    if (body.length > 0 && body.length < 500) return body;
  }
  return null;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
}

export function getRetryConfig(err: ApiError): RetryConfig | null {
  if (err.isRateLimit) {
    return { maxRetries: 3, baseDelay: 5000 };
  }
  if (err.statusCode >= 500) {
    return { maxRetries: 2, baseDelay: 2000 };
  }
  return null;
}
