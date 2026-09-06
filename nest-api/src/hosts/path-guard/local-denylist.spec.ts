import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLocalDenylistExceptions } from "@hosts/path-guard/local-denylist";

/**
 * The development-only hole in the denylist (TRE-148): named by an
 * environment variable, ignored outright in production.
 */
describe("computeLocalDenylistExceptions", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "trekker-except-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is empty when nothing is named", async () => {
    expect(await computeLocalDenylistExceptions({ NODE_ENV: "development" })).toEqual([]);
    expect(
      await computeLocalDenylistExceptions({ NODE_ENV: "development", TREKKER_DEV_LOCAL_EXCEPTIONS: "  " }),
    ).toEqual([]);
  });

  it("resolves the named absolute paths, and keeps one that does not exist as written", async () => {
    const missing = join(dir, "not-there");
    const result = await computeLocalDenylistExceptions({
      NODE_ENV: "development",
      TREKKER_DEV_LOCAL_EXCEPTIONS: `${dir}:relative/path:${missing}`,
    });
    expect(result).toEqual([realpathSync(dir), missing]);
  });

  it("ignores the variable in production", async () => {
    expect(await computeLocalDenylistExceptions({ NODE_ENV: "production", TREKKER_DEV_LOCAL_EXCEPTIONS: dir })).toEqual(
      [],
    );
  });
});
