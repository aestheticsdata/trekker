import { resolve } from "node:path";
import {
  guardDevelopmentDatabase,
  installRoot,
  isInside,
  isLoopbackHost,
  MockRefusal,
  mockHome,
  treeRoot,
} from "./env";

/**
 * The guards, without a database (TRE-140).
 *
 * `guardDevelopmentDatabase` is exercised through the environment it reads:
 * `NODE_ENV` and `DATABASE_URL`. `loadEnv` is stubbed: the real one throws
 * when the gitignored `ecosystem.config.js` is missing, and these must run
 * on a fresh clone. What the guard does *after* loading is the whole test.
 */
jest.mock("../src/config/load-env", () => ({ loadEnv: jest.fn() }));

const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("isLoopbackHost", () => {
  it("admits the loopback spellings and nothing else", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["db.example.com", "192.0.2.10", "10.0.0.1", "0.0.0.0", ""]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("guardDevelopmentDatabase", () => {
  it("refuses NODE_ENV=production before reading anything", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "mysql://trekker:secret@127.0.0.1:3306/trekker";
    expect(() => guardDevelopmentDatabase()).toThrow(MockRefusal);
    expect(() => guardDevelopmentDatabase()).toThrow(/NODE_ENV=production/);
  });

  it("refuses a non-loopback database host and names it", () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "mysql://trekker:secret@db.example.com:3306/trekker";
    expect(() => guardDevelopmentDatabase()).toThrow(MockRefusal);
    expect(() => guardDevelopmentDatabase()).toThrow(/db\.example\.com/);
  });

  it("admits a loopback host, however it is spelled", () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "mysql://trekker:secret@localhost:3306/trekker";
    const connection = guardDevelopmentDatabase();
    expect(connection.host).toBe("127.0.0.1");
    expect(connection.database).toBe("trekker");
  });
});

describe("the tree's home", () => {
  it("lives under the home directory by default and under TREKKER_MOCK_HOME when set", () => {
    delete process.env.TREKKER_MOCK_HOME;
    expect(mockHome()).toMatch(/\.mock$/);
    expect(treeRoot()).toBe(`${mockHome()}/tree`);

    process.env.TREKKER_MOCK_HOME = "/srv/somewhere/else";
    expect(treeRoot()).toBe("/srv/somewhere/else/tree");
  });

  it("reads an empty TREKKER_MOCK_HOME as unset, and makes a relative one absolute", () => {
    process.env.TREKKER_MOCK_HOME = "";
    expect(mockHome()).toMatch(/\.mock$/);
    process.env.TREKKER_MOCK_HOME = "   ";
    expect(mockHome()).toMatch(/\.mock$/);
    process.env.TREKKER_MOCK_HOME = "somewhere/relative";
    expect(mockHome()).toBe(resolve("somewhere/relative"));
  });

  it("knows the install tree, and containment is segment-wise", () => {
    expect(installRoot()).toMatch(/trekker$/);
    expect(isInside("/data", "/data/x")).toBe(true);
    expect(isInside("/data", "/database")).toBe(false);
    expect(isInside("/data", "/data")).toBe(true);
  });
});
