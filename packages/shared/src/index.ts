import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { config as loadDotenv } from "dotenv";

export type Service = "openai" | "anthropic" | "gemini";

export type Provider =
  | "openai_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_generation";

export type ModelFactory = (model: string) => LanguageModel;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const envPath = path.join(repoRoot, ".env");

loadDotenv({ path: envPath, quiet: true });

const SERVICE_ENV_VARS: Record<Service, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function getApiKey(service: Service): string {
  const envVar = SERVICE_ENV_VARS[service];
  const value = process.env[envVar];
  if (!value) {
    throw new Error(
      `Missing API key for ${service}: set ${envVar} in ${envPath} (see .env.example).`
    );
  }
  return value;
}

export function getModel(provider: Provider, model: string): LanguageModel {
  return getClient(provider)(model);
}

export function getClient(provider: Provider): ModelFactory {
  switch (provider) {
    case "openai_completions": {
      const openai = createOpenAI({ apiKey: getApiKey("openai") });
      return (model) => openai.chat(model);
    }
    case "openai_responses": {
      const openai = createOpenAI({ apiKey: getApiKey("openai") });
      return (model) => openai.responses(model);
    }
    case "anthropic_messages": {
      const anthropic = createAnthropic({ apiKey: getApiKey("anthropic") });
      return (model) => anthropic(model);
    }
    case "gemini_generation": {
      const google = createGoogleGenerativeAI({
        apiKey: getApiKey("gemini"),
      });
      return (model) => google(model);
    }
  }
}
