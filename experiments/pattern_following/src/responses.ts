export type InputItem = Record<string, unknown> & { type?: string };

export type ResponsesRequest = Record<string, unknown> & {
  model: string;
  input: InputItem[];
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

type OutputItem = {
  type: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
  summary?: { text?: string }[];
};

export type ResponsesResponse = { output: OutputItem[]; usage?: Usage };

const RESPONSES_URL = "https://api.openai.com/v1/responses";

export async function sendResponses(
  request: ResponsesRequest,
  apiKey: string
): Promise<ResponsesResponse> {
  const res = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request),
  });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as ResponsesResponse;
}
