/**
 * Framework-agnostic IndexNow submitter with built-in key-file creation.
 * - Accepts single or multiple URLs
 * - Ensures /<KEY>.txt exists in your project's public dir (customizable)
 * - Sends POST JSON to https://api.indexnow.org/indexnow
 * - Auto-chunks to 10k URLs per request; light retries on 429/5xx
 */

export type SubmitIndexNowOptions = {
  key?: string;                 // If omitted on Node, a key will be generated & persisted
  host?: string;                // If omitted, inferred from first URL
  keyLocation?: string;         // If omitted, derived from host + /<KEY>.txt (when possible)
  endpoint?: string;            // Default: https://api.indexnow.org/indexnow
  urls: string | string[];

  batchSize?: number;           // Default 10000 (protocol limit)
  retries?: number;             // Default 2
  retryBaseMs?: number;         // Default 500

  ensureKeyFile?: boolean;      // Default true on Node
  publicDir?: string;           // Default "public" (e.g. "static", "public_html")
  projectRoot?: string;         // Default: auto-resolved consumer root
  manifestPath?: string;        // Default: config/indexnow.manifest.json
  forceRotateKey?: boolean;     // If true, overwrite existing manifest with provided/generated key
};

export type SubmitIndexNowBatchResult = {
  ok: boolean;
  status: number;
  upstreamText: string;
  sentCount: number;
};

export type SubmitIndexNowResult = {
  host: string;
  total: number;
  keyUsed: string;
  keyFilePath?: string;   // absolute file path (if fs available)
  keyFileRoute?: string;  // "/<KEY>.txt"
  batches: SubmitIndexNowBatchResult[];
};

const DEFAULT_ENDPOINT = "https://api.indexnow.org/indexnow";

/** Public API */
export async function submitIndexNow(opts: SubmitIndexNowOptions): Promise<SubmitIndexNowResult> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const list = normalizeUrls(opts.urls);
  if (list.length === 0) throw new Error("No URLs provided");

  const inferredHost = new URL(list[0] as string).host;
  const host = opts.host ?? inferredHost;

  // All URLs must share same host (protocol requirement).
  for (const u of list) {
    const h = new URL(u).host;
    if (h !== host) throw new Error(`All URLs must share the same host. Expected "${host}", got "${h}" for ${u}`);
  }

  let keyToUse = opts.key;
  let keyFileRoute: string | undefined;
  let keyFilePath: string | undefined;

  // Ensure key file on Node (skipped on Edge/browsers)
  if (opts.ensureKeyFile !== false && canUseNodeFs()) {
    const ensured = await ensureIndexNowKeyFile({
      key: keyToUse ?? null,
      publicDir: opts.publicDir ?? "public",
      projectRoot: opts.projectRoot,
      manifestPath: opts.manifestPath ?? "config/indexnow.manifest.json",
      forceRotateKey: opts.forceRotateKey
    });
    keyToUse = ensured.key;
    keyFileRoute = ensured.keyFileRoute;
    keyFilePath = ensured.keyFilePath;
  }

  if (!keyToUse) {
    throw new Error(
      "INDEXNOW key is missing. Provide opts.key, or run submitIndexNow on Node so it can generate & write the key file."
    );
  }

  const keyLocation =
    opts.keyLocation ?? (host && keyFileRoute ? `https://${host}${keyFileRoute}` : undefined);

  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 10000), 10000);
  const batches = chunk(list, batchSize);
  const results: SubmitIndexNowBatchResult[] = [];

  for (const batch of batches) {
    const payload: Record<string, unknown> = { host, key: keyToUse, urlList: batch };
    if (keyLocation) payload.keyLocation = keyLocation;

    const res = await postWithRetry(endpoint, payload, opts.retries ?? 2, opts.retryBaseMs ?? 500);
    const text = await res.text();
    results.push({ ok: res.ok, status: res.status, upstreamText: text, sentCount: batch.length });
  }

  return { host, total: list.length, keyUsed: keyToUse, keyFilePath, keyFileRoute, batches: results };
}

/* =======================  Key-file support (Node only)  ======================= */

type EnsureKeyArgs = {
  key?: string | null;
  publicDir?: string;           // default "public"
  projectRoot?: string;         // default: auto-resolved consumer root
  manifestPath?: string;        // default: config/indexnow.manifest.json
  forceRotateKey?: boolean;     // overwrite existing manifest with provided/generated key
};

type EnsureResult = {
  key: string;
  keyFileRoute: string;         // "/<KEY>.txt"
  keyFilePath: string;          // absolute path on disk
};

/**
 * Ensures ./<publicDir>/<KEY>.txt + config/indexnow.manifest.json in the CONSUMER PROJECT ROOT.
 * Root resolution priority:
 *   1) args.projectRoot (if set)
 *   2) process.env.INIT_CWD (npm sets this to the originating project during scripts)
 *   3) process.cwd()
 *   4) Parent directory *outside* node_modules relative to this library file
 */
export async function ensureIndexNowKeyFile(args: EnsureKeyArgs): Promise<EnsureResult> {
  if (!canUseNodeFs()) throw new Error("Filesystem not available. ensureIndexNowKeyFile must run on Node.");

  // Dynamic imports keep Edge builds happy
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { randomBytes } = await import("node:crypto");

  function generateKey(n = 32) { return randomBytes(n).toString("hex"); }

  // ----- resolve consumer project root -----
  const fromArg = args.projectRoot ? path.resolve(args.projectRoot) : null;
  const fromInitCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : null;
  const fromCwd = path.resolve(process.cwd());

  // Walk up from this file to escape node_modules
  const selfDir = path.dirname(fileURLToPath(import.meta.url)); // e.g., node_modules/@seabu/indexnow/dist/...
  const outsideNodeModules = (() => {
    const parts = selfDir.split(path.sep);
    const idx = parts.lastIndexOf("node_modules");
    if (idx === -1) return null;
    const root = parts.slice(0, idx).join(path.sep) || path.sep;
    return root;
  })();

  const candidates = [fromArg, fromInitCwd, fromCwd, outsideNodeModules].filter(Boolean) as string[];

  // Pick the first that looks like a real project root (has a package.json and is not node_modules)
  let projectRoot = fromCwd;
  for (const c of candidates) {
    const pkg = path.join(c, "package.json");
    const inNodeModules = c.split(path.sep).includes("node_modules");
    if (!inNodeModules && fs.existsSync(pkg)) {
      projectRoot = c;
      break;
    }
  }

  // ----- resolve public dir under that root -----
  const publicDirName = args.publicDir && args.publicDir.trim() ? args.publicDir.trim() : "public";
  const publicDir = path.isAbsolute(publicDirName) ? publicDirName : path.join(projectRoot, publicDirName);

  // manifest lives at root (not inside public)
  const manifestPath = args.manifestPath
    ? path.isAbsolute(args.manifestPath) ? args.manifestPath : path.join(projectRoot, args.manifestPath)
    : path.join(projectRoot, "indexnow.manifest.json");

  // ----- read or create manifest -----
  let key: string;
  let keyFileRoute: string;

  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { key: string; keyFile: string };
    key = m.key;
    keyFileRoute = m.keyFile;
    if (args.forceRotateKey && args.key && args.key !== key) {
      key = args.key;
      keyFileRoute = `/${key}.txt`;
      await fsp.writeFile(manifestPath, JSON.stringify({ key, keyFile: keyFileRoute }, null, 2), "utf8");
    }
  } else {
    key = args.key ?? process.env.INDEXNOW_KEY ?? generateKey();
    keyFileRoute = `/${key}.txt`;
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
    await fsp.writeFile(manifestPath, JSON.stringify({ key, keyFile: keyFileRoute }, null, 2), "utf8");
  }

  // ----- ensure the actual key file under <publicDir> -----
  const keyFilePath = path.join(publicDir, keyFileRoute.replace(/^\//, ""));
  await fsp.mkdir(path.dirname(keyFilePath), { recursive: true });
  await fsp.writeFile(keyFilePath, key, "utf8");

  return { key, keyFileRoute, keyFilePath };
}

/* =======================  Internals  ======================= */

function canUseNodeFs() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function normalizeUrls(urls: string | string[]): string[] {
  const arr = Array.isArray(urls) ? urls : [urls];
  return arr.map((u) => new URL(String(u)).toString());
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postWithRetry(endpoint: string, payload: unknown, retries: number, baseMs: number): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    });
    console.log('endpoint', endpoint)
    console.log('payload', payload)
    console.log('res', res)
    if (res.ok || (res.status < 500 && res.status !== 429) || attempt >= retries) return res;
    await new Promise((r) => setTimeout(r, baseMs * Math.pow(2, attempt)));
    attempt++;
  }
}
