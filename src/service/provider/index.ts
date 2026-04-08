import type { ApiType } from "../../config/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

const providers: Partial<Record<ApiType, Provider>> = {};

export function getProvider(apiType: ApiType): Provider {
  let provider = providers[apiType];
  if (provider) return provider;

  switch (apiType) {
    case "anthropic":
      provider = new AnthropicProvider();
      break;
    case "openai":
    default:
      provider = new OpenAIProvider();
      break;
  }

  providers[apiType] = provider;
  return provider;
}
