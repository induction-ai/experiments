// Shared setup for the claim tests. Each test sends an edited history the
// same way the scripts do; recordings are committed, so
// `pnpm test` re-checks every claim offline and `RECORD=true pnpm test`
// re-runs them live.
import { getApiKey } from "@experiments/shared";
import { measureReply, type ReplyMeasures } from "../measure.js";
import { sendResponses, type InputItem } from "../responses.js";
import { historyBeforeLastSearch, searchPairs } from "../setups.js";
import { loadCapturedRequest, type CapturedRequest } from "../trials.js";

export const LIVE = Boolean(process.env.RECORD);
/** A live claim sends up to 3 requests of up to ~200k input tokens each. */
export const TIMEOUT = 600_000;

export const captured = loadCapturedRequest("banking_021");
export const history = historyBeforeLastSearch(captured.input);

export type Reply = ReplyMeasures & { reasoning_tokens: number };

/**
 * Sends `input` `n` times, one after another, and measures each reply. `base`
 * supplies the model, reasoning settings and tools.
 */
export async function sample(
  input: InputItem[],
  n: number,
  base: CapturedRequest = captured
): Promise<Reply[]> {
  // Replays are matched on the request body, so no key is needed offline.
  const apiKey = LIVE ? getApiKey("openai") : "replay";
  const historyQueries = new Set(searchPairs(input).map((p) => p.query));
  const replies: Reply[] = [];
  for (let i = 0; i < n; i++) {
    const response = await sendResponses({ ...base, input }, apiKey);
    replies.push({
      ...measureReply(response, historyQueries),
      reasoning_tokens:
        response.usage?.output_tokens_details?.reasoning_tokens ?? -1,
    });
  }
  return replies;
}
