import { describe, it, expect, vi, afterEach } from "vitest";
import { submitIndexNow } from "../index";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.restoreAllMocks());

const ok = new Response("OK", { status: 200 });

describe("submitIndexNow", () => {
  it("writes key file to custom public dir and submits one URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "indexnow-"));
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok);
    const publicDir = "public";

    const res = await submitIndexNow({
      urls: "https://example.com/a",
      host: "example.com",
      projectRoot: root,
      publicDir: publicDir      // custom public folder name
      // no key provided → it will generate one and write static/<KEY>.txt
    });

    expect(res.total).toBe(1);
    expect(res.keyUsed).toBeTruthy();
    expect(res.keyFilePath?.includes("\\"+publicDir+"\\")).toBe(true);
    expect(spy).toHaveBeenCalledOnce();

    rmSync(root, { recursive: true, force: true });
  });
});
