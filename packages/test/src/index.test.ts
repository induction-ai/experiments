import { describe, expect, it } from "./index.js";

// With no recording on disk, Polly in replay mode must block any request.
// If a test flavour weren't wrapped in recordHttp, the fetch would go to the
// network instead (and fail with a DNS error, not a Polly error).
const blocked = async () => {
  if (process.env.RECORD) return; // recording modes do hit the network
  await expect(fetch("https://recording-guard.invalid/x")).rejects.toThrow(
    /Polly|recording/i
  );
};

describe("every it flavour records", () => {
  it("plain it", blocked);
  it.each([1, 2])("it.each row %i", blocked);
  it.each([1])("it.each row %i with a timeout", blocked, 10_000);
  it.concurrent("it.concurrent", blocked);
});
