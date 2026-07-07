import { test, expect, describe } from "bun:test";
import { resolveJobRef, parseRows, newId } from "../src/jobs.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = {
  hosts: { oracle: host("oracle", "linux"), winbox: host("winbox", "windows") },
  groups: { cloud: ["oracle", "winbox"] },
};

describe("resolveJobRef", () => {
  test("two-arg form: host + id", () => {
    const { host, id } = resolveJobRef(cfg, "oracle", "abc123-xy");
    expect(host.name).toBe("oracle");
    expect(id).toBe("abc123-xy");
  });

  test("collapsed host:id form", () => {
    const { host, id } = resolveJobRef(cfg, "oracle:abc123-xy");
    expect(host.name).toBe("oracle");
    expect(id).toBe("abc123-xy");
  });

  test("label-prefixed id (contains hyphens) round-trips", () =>
    expect(resolveJobRef(cfg, "oracle:my-train-mr0g-rzgy").id).toBe("my-train-mr0g-rzgy"));

  test("missing id throws usage", () =>
    expect(() => resolveJobRef(cfg, "oracle")).toThrow(/usage:/));

  test("id outside [a-z0-9-] is rejected (path-injection guard)", () => {
    expect(() => resolveJobRef(cfg, "oracle", "../etc")).toThrow(/bad job id/);
    expect(() => resolveJobRef(cfg, "oracle", "a b")).toThrow(/bad job id/);
    expect(() => resolveJobRef(cfg, "oracle:$(whoami)")).toThrow(/bad job id/);
  });

  test("a selector that resolves to >1 host is rejected", () =>
    expect(() => resolveJobRef(cfg, "@cloud:abc")).toThrow(/exactly one host/));
});

describe("parseRows", () => {
  test("parses a well-formed row", () => {
    const [r] = parseRows("oracle", "id1\trunning\t-\t4242\t1700000000\techo hi");
    expect(r).toEqual({
      host: "oracle", id: "id1", status: "running",
      code: null, pid: 4242, started: 1700000000, cmd: "echo hi",
    });
  });

  test("exited row carries the exit code; '-' fields become null", () => {
    const [r] = parseRows("oracle", "id2\texited\t0\t-\t-\tdone");
    expect(r!.status).toBe("exited");
    expect(r!.code).toBe(0);
    expect(r!.pid).toBeNull();
    expect(r!.started).toBeNull();
  });

  test("strips trailing CR (windows CRLF output)", () =>
    expect(parseRows("winbox", "id3\texited\t1\t100\t1700\tcmd\r")[0]!.cmd).toBe("cmd"));

  test("a command containing tabs is preserved (rejoined)", () =>
    expect(parseRows("oracle", "id4\trunning\t-\t1\t2\ta\tb\tc")[0]!.cmd).toBe("a\tb\tc"));

  test("blank lines are skipped", () =>
    expect(parseRows("oracle", "\nid5\trunning\t-\t1\t2\tx\n\n").length).toBe(1));

  test("an unrecognised status token degrades to 'dead', never garbage", () =>
    expect(parseRows("oracle", "id6\tWARNING: whatever\t-\t1\t2\tx")[0]!.status).toBe("dead"));

  test("non-numeric code/pid/started become null, not NaN", () => {
    const [r] = parseRows("oracle", "id7\texited\tabc\txyz\tnope\tx");
    expect(r!.code).toBeNull();
    expect(r!.pid).toBeNull();
    expect(r!.started).toBeNull();
  });
});

describe("newId", () => {
  test("bare id matches the safe charset and is time-sortable shape", () =>
    expect(newId()).toMatch(/^[a-z0-9]+-[a-z0-9]{4}$/));

  test("label is slugged onto the front, kept in the id charset", () => {
    expect(newId("My Train Run!")).toMatch(/^my-train-run-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(newId("../../etc")).toMatch(/^etc-[a-z0-9]+-[a-z0-9]{4}$/);   // dangerous chars stripped
  });

  test("an all-junk label degrades to a bare id (never empty/unsafe)", () =>
    expect(newId("!!!")).toMatch(/^[a-z0-9]+-[a-z0-9]{4}$/));
});
