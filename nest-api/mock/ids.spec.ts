import { choose, pick, seededRandom, stableUuid, uuidV7 } from "./ids";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("uuidV7", () => {
  it("is shaped like a uuid, version 7, with the RFC variant", () => {
    const id = uuidV7(1_756_728_000_000, "activity:1");
    expect(id).toMatch(UUID);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
  });

  it("is a function of its inputs and nothing else", () => {
    expect(uuidV7(1_756_728_000_000, "a")).toBe(uuidV7(1_756_728_000_000, "a"));
    expect(uuidV7(1_756_728_000_000, "a")).not.toBe(uuidV7(1_756_728_000_000, "b"));
    expect(uuidV7(1_756_728_000_000, "a")).not.toBe(uuidV7(1_756_728_000_001, "a"));
  });

  it("sorts as its timestamps sort, which is the order the activity strip pages by", () => {
    const stamps = [1_700_000_000_000, 1_700_000_000_001, 1_756_728_000_000, 1_756_728_000_000 + 86_400_000];
    const ids = stamps.map((ms, index) => uuidV7(ms, `row:${index}`));
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("stableUuid", () => {
  it("is shaped like a uuid v4 and stable per key", () => {
    const id = stableUuid("host:local");
    expect(id).toMatch(UUID);
    expect(id[14]).toBe("4");
    expect(stableUuid("host:local")).toBe(id);
    expect(stableUuid("host:remote")).not.toBe(id);
  });
});

describe("seededRandom", () => {
  it("replays the same sequence for the same seed", () => {
    const a = seededRandom("nginx");
    const b = seededRandom("nginx");
    const sequence = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(sequence);
    for (const value of sequence) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("picks inside the bounds and chooses by weight", () => {
    const random = seededRandom("bounds");
    for (let index = 0; index < 500; index += 1) {
      const value = pick(random, 3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
    const counts = { a: 0, b: 0 };
    for (let index = 0; index < 2_000; index += 1)
      counts[
        choose(random, [
          ["a", 9],
          ["b", 1],
        ] as const)
      ] += 1;
    expect(counts.a).toBeGreaterThan(counts.b * 4);
  });
});
