import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CreateHostDto } from "@hosts/dto/create-host.dto";
import { UpdateHostDto } from "@hosts/dto/update-host.dto";

/**
 * The roots array is the security boundary arriving over HTTP (TRE-43 §2), and
 * it reaches the service through a nested `@ValidateNested` + `@Type` pair.
 *
 * That pairing is the part worth a test: the app's pipe runs with
 * `whitelist: true` and no `transform`, and in that mode an array of plain
 * objects that Nest failed to instantiate would validate vacuously — every
 * root would pass, whatever was in it, and a malformed allowlist would reach
 * the database. These cases fail loudly if that ever changes.
 */

// The same construction as main.ts. A test that configured its own pipe would
// prove something about a pipe the app does not use.
const pipe = new ValidationPipe({ whitelist: true });

const metadata = (metatype: unknown) => ({ type: "body" as const, metatype: metatype as never });

const validCreate = {
  label: "web",
  transport: "LOCAL",
  roots: [{ path: "/srv", access: "WRITE" }],
};

/**
 * The lines the pipe would send back.
 *
 * `error.message` is only ever "Bad Request Exception" — the per-field reasons
 * live in the response body, which is what a client actually reads, so that is
 * what these assertions look at.
 */
async function refusalOf(value: unknown, metatype: unknown): Promise<string[]> {
  try {
    await pipe.transform(value, metadata(metatype));
  } catch (error) {
    const body = (error as BadRequestException).getResponse() as { message?: string[] };
    return body.message ?? [];
  }
  throw new Error("The pipe accepted a payload it should have refused.");
}

describe("CreateHostDto", () => {
  it("keeps the roots array rather than whitelisting it away", async () => {
    const result = (await pipe.transform(validCreate, metadata(CreateHostDto))) as typeof validCreate;

    expect(result.roots).toEqual([{ path: "/srv", access: "WRITE" }]);
  });

  it("refuses a relative root path", async () => {
    const reasons = await refusalOf({ ...validCreate, roots: [{ path: "srv", access: "READ" }] }, CreateHostDto);

    expect(reasons.join(" ")).toMatch(/absolute/);
  });

  it("refuses an unknown access level", async () => {
    const reasons = await refusalOf({ ...validCreate, roots: [{ path: "/srv", access: "EXECUTE" }] }, CreateHostDto);

    expect(reasons.join(" ")).toMatch(/READ or WRITE/);
  });

  it("refuses an empty roots array, which would serve nothing", async () => {
    const reasons = await refusalOf({ ...validCreate, roots: [] }, CreateHostDto);

    expect(reasons.join(" ")).toMatch(/no roots/);
  });

  it("still accepts a host with no roots at all, which takes the home default", async () => {
    const result = (await pipe.transform(
      { label: "web", transport: "LOCAL" },
      metadata(CreateHostDto),
    )) as typeof validCreate;

    expect(result.roots).toBeUndefined();
  });

  it("strips a property no DTO declares", async () => {
    const result = (await pipe.transform(
      { ...validCreate, userId: "someone-else" },
      metadata(CreateHostDto),
    )) as Record<string, unknown>;

    expect(result.userId).toBeUndefined();
  });
});

describe("UpdateHostDto", () => {
  it("accepts roots on their own", async () => {
    const result = (await pipe.transform(
      { roots: [{ path: "/var/log", access: "READ" }] },
      metadata(UpdateHostDto),
    )) as { roots: unknown };

    expect(result.roots).toEqual([{ path: "/var/log", access: "READ" }]);
  });

  it("refuses a malformed root inside an otherwise valid patch", async () => {
    const reasons = await refusalOf(
      {
        label: "renamed",
        roots: [
          { path: "/srv", access: "WRITE" },
          { path: "nope", access: "READ" },
        ],
      },
      UpdateHostDto,
    );

    expect(reasons.join(" ")).toMatch(/absolute/);
  });
});
