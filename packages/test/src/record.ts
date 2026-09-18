import fs from "node:fs";
import path from "node:path";
import FetchAdapter from "@pollyjs/adapter-fetch";
import NodeHttpAdapter from "@pollyjs/adapter-node-http";
import { Polly, type MODE } from "@pollyjs/core";
import FSPersister from "@pollyjs/persister-fs";
import { expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Polly.register(FetchAdapter as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Polly.register(NodeHttpAdapter as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Polly.register(FSPersister as any);

// Substring-matched against lowercased header names. Recordings are committed
// to a public repo, so this covers account identifiers as well as credentials.
const SENSITIVE_HEADERS = [
  "authorization",
  "x-goog-api-key",
  "x-api-key",
  "api-key",
  "cookie", // cookie, set-cookie
  "organization", // openai-organization, anthropic-organization-id
  "openai-project",
  "workspace", // anthropic-workspace-id
  "ratelimit", // x-ratelimit-*, anthropic-ratelimit-*: reveal account tier
];

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

// Tri-state RECORD env:
//   "true" → record: nukes the existing recording dir, calls the real API.
//   "new"  → replay-with-fallback: replays requests whose body matches an
//            existing recording; records new ones. Enables body matching so
//            adding new probes doesn't invalidate existing HARs.
//   else   → replay: never hits the real API; errors if no match exists.
const RECORD_ENV = process.env.RECORD ?? "";
const RECORD = RECORD_ENV === "true";
const RECORD_NEW = RECORD_ENV === "new";

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 100);
}

function maskHeaders(
  headers: Array<{ name: string; value: string }> | undefined
): void {
  if (!headers) return;
  for (const header of headers) {
    const lower = header.name.toLowerCase();
    if (SENSITIVE_HEADERS.some((s) => lower.includes(s))) {
      header.value = "[MASKED]";
    }
  }
}

// Normalize a request body to a canonical JSON string so bodies captured
// across environments (Buffer vs string, pretty vs compact) compare equal
// when semantically identical.
function normalizeBody(body: unknown): string {
  if (body === null || body === undefined) return "";

  let contents: string;
  if (typeof body === "string") {
    contents = body;
  } else if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
    contents = new TextDecoder().decode(body);
  } else if (
    typeof body === "object" &&
    body !== null &&
    "type" in body &&
    String((body as { type?: string }).type).toLowerCase() === "buffer" &&
    "data" in body &&
    Array.isArray((body as { data?: unknown }).data)
  ) {
    contents = Buffer.from((body as { data: number[] }).data).toString("utf8");
  } else if (typeof body === "object") {
    contents = JSON.stringify(body);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    contents = String(body);
  }

  if (!contents.trim()) return contents;

  try {
    let parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      String((parsed as { type?: string }).type).toLowerCase() === "buffer" &&
      "data" in parsed &&
      Array.isArray((parsed as { data?: unknown }).data)
    ) {
      parsed = JSON.parse(
        Buffer.from((parsed as { data: number[] }).data).toString("utf8")
      );
    }
    return JSON.stringify(parsed);
  } catch {
    return contents;
  }
}

// Auto-suffix recording names when a single test calls recordHttp more than once.
const usedNames = new Map<string, number>();

// Track test files whose recordings dir we've wiped in this run. RECORD=true
// wipes the whole file's dir once on the first test in it — fresh recordings
// for every test, matching induction/src/test_helpers/setup.ts behavior.
const wipedFiles = new Set<string>();

// Walk up from the test file to find the nearest package.json — that's the
// workspace root, where `test/__recordings__/` lives.
function findWorkspaceRoot(testFilePath: string): string {
  let dir = path.dirname(testFilePath);
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(testFilePath);
}

function recordingsDirFor(testFilePath: string): string {
  const workspaceRoot = findWorkspaceRoot(testFilePath);
  const rel = path
    .relative(workspaceRoot, testFilePath)
    .replace(/^src[/\\]/, "")
    .replace(/\.test\.(ts|mts|js|mjs|cjs)$/, "");
  return path.join(workspaceRoot, "test", "__recordings__", rel);
}

/**
 * Wrap an async block that makes HTTP requests. On first run with RECORD=true,
 * the real responses are written to `<test-dir>/__recordings__/<test-file>/...`.
 * On subsequent runs (default), Polly replays the recordings — no network.
 *
 * API keys / auth headers are masked before persisting. Must be called inside
 * a vitest test (uses `expect.getState()` to discover the test name/path).
 */
export async function recordHttp(
  fn: () => Promise<void>,
  options?: { mode?: MODE; name?: string }
): Promise<void> {
  const state = expect.getState();
  const testPath = state.testPath;
  const testName = state.currentTestName;
  if (!testPath || !testName) {
    throw new Error(
      "recordHttp must be called inside a vitest test (expect.getState() returned no test context)."
    );
  }

  const baseName = options?.name ?? sanitizeName(testName);
  const dedupKey = `${testPath}::${testName}::${baseName}`;
  const seen = usedNames.get(dedupKey) ?? 0;
  usedNames.set(dedupKey, seen + 1);
  const recordingName = seen === 0 ? baseName : `${baseName}_${seen}`;

  const mode: MODE = RECORD ? "record" : (options?.mode ?? "replay");
  const recordingsDir = recordingsDirFor(testPath);

  const recordIfMissing = RECORD || RECORD_NEW;

  if (mode === "record" && !wipedFiles.has(testPath)) {
    wipedFiles.add(testPath);
    if (fs.existsSync(recordingsDir)) {
      fs.rmSync(recordingsDir, { recursive: true, force: true });
    }
  }

  const polly = new Polly(recordingName, {
    adapters: ["fetch", "node-http"],
    adapterOptions: { fetch: { context: globalThis } },
    persister: "fs",
    persisterOptions: { fs: { recordingsDir } },
    mode,
    recordIfMissing,
    recordFailedRequests: true,
    logLevel: "silent",
    matchRequestsBy: {
      method: true,
      headers: false,
      body: true,
      order: true,
      url: {
        protocol: true,
        username: false,
        password: false,
        hostname: true,
        port: false,
        pathname: true,
        query: true,
        hash: false,
      },
    },
  });

  polly.server.any().on("beforePersist", (request, recording) => {
    maskHeaders(recording.request?.headers);
    maskHeaders(recording.response?.headers);
    if (recording.request) recording.request.cookies = [];
    if (recording.response) recording.response.cookies = [];
    // Polly's HAR persister only writes postData.text for string bodies.
    // For Buffer/typed-array bodies, normalize so beforeReplay can compare.
    if (
      recording.request?.postData &&
      recording.request.postData.text == null &&
      request.body != null
    ) {
      recording.request.postData.text = normalizeBody(request.body);
    }
  });

  // Warn when a replayed request's body differs from the recorded body.
  // Request matching intentionally ignores the body (matchRequestsBy.body: false),
  // so replay succeeds — but a drifted payload usually means the test's inputs
  // have changed and the recording should be refreshed.
  polly.server.any().on("beforeReplay", (request, recording) => {
    const url = new URL(request.url);
    if (LOCAL_HOSTNAMES.has(url.hostname)) return;

    const current = normalizeBody(request.body);
    const recorded = normalizeBody(recording.request?.postData?.text ?? "");
    if (current === recorded) return;

    const shortDir = recordingsDir.split("__recordings__/")[1] ?? recordingsDir;
    const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Write directly to stderr: vitest's default reporter buffers per-test
    // console output and may hide it entirely on passing tests. Going straight
    // to the TTY stream guarantees the warning reaches the user.
    process.stderr.write(
      `\x1b[33m[recordHttp] ${shortDir}/${recordingName}: payload changed for ${request.method} ${request.url}. To re-record:\n  RECORD=true pnpm test -t "${escapedName}"\x1b[0m\n`
    );
  });

  try {
    await fn();
  } finally {
    await polly.stop();
  }
}
