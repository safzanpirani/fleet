import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanSecretFiles, secretRefusal } from "../src/secrets.ts";

// Fixture values are assembled at run time, so this file never matches the
// rules it tests and a sync of this repository does not trip over it.
const fake = {
  aws: "AKIA" + "QWERTYUIOPASDFGH",
  github: "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  githubPat: "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop",
  openai: "sk" + "-proj-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa",
  anthropic: "sk" + "-ant-" + "api03-abcdefghijklmnopqrstuvwxyz012345",
  slack: "xox" + "b-" + "1234567890-abcdefghij",
  google: "AI" + "za" + "SyA1234567890abcdefghijklmnopqrstuv",
  pem: "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
};

function tree(files: Record<string, string>): { root: string; list: { rel: string; path: string }[] } {
  const root = mkdtempSync(join(tmpdir(), "fleet-secrets-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return { root, list: Object.keys(files).map((rel) => ({ rel, path: join(root, rel) })) };
}

describe("secret file detection", () => {
  test.each([
    [".env", "env file"],
    ["config/.env.production", "env file"],
    ["certs/server.pem", "PEM file"],
    ["tls.key", "key file"],
    ["store.p12", "PKCS#12 keystore"],
    ["store.pfx", "PKCS#12 keystore"],
    ["keys/id_rsa", "SSH private key"],
    ["id_ed25519", "SSH private key"],
    ["id_ecdsa", "SSH private key"],
    ["credentials.json", "credentials.json"],
    ["data/auth.json", "auth.json"],
    ["vault.kdbx", "KeePass database"],
  ])("flags %s by name (%s)", async (rel, rule) => {
    const { root, list } = tree({ [rel]: "nothing secret inside\n" });
    try {
      expect(await scanSecretFiles(list)).toEqual([{ file: rel, rule }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test.each([
    ["private key block", fake.pem],
    ["AWS access key id", `const id = "${fake.aws}";\n`],
    ["GitHub token", `token: ${fake.github}\n`],
    ["GitHub token", `token: ${fake.githubPat}\n`],
    ["OpenAI-style API key", `OPENAI_API_KEY=${fake.openai}\n`],
    ["Anthropic API key", `key = '${fake.anthropic}'\n`],
    ["Slack token", `SLACK=${fake.slack}\n`],
    ["Google API key", `{"key":"${fake.google}"}\n`],
  ])("flags %s by content", async (rule, body) => {
    const { root, list } = tree({ "src/settings.ts": body });
    try {
      expect(await scanSecretFiles(list)).toEqual([{ file: "src/settings.ts", rule }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("name rules ignore case; content rules do not", async () => {
    const { root, list } = tree({
      ".ENV": "TOKEN=1\n",
      "vault.P12": "binary-ish\n",
      "Credentials.JSON": "{}\n",
      "KEYS/ID_RSA": "x\n",
      "x/.NPMRC": `//registry.npmjs.org/:_authToken=npm_abcdef0123456789\n`,
      ".Env.Example": "KEY=\n",
      "src/lower.ts": `const id = "${fake.aws.toLowerCase()}";\n`,
    });
    try {
      expect(await scanSecretFiles(list)).toEqual([
        { file: ".ENV", rule: "env file" },
        { file: "vault.P12", rule: "PKCS#12 keystore" },
        { file: "Credentials.JSON", rule: "credentials.json" },
        { file: "KEYS/ID_RSA", rule: "SSH private key" },
        { file: "x/.NPMRC", rule: "npmrc auth token" },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an .npmrc is flagged only when it holds a literal auth token", async () => {
    const { root, list } = tree({
      "a/.npmrc": `//registry.npmjs.org/:_authToken=npm_abcdef0123456789\n`,
      "b/.npmrc": "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
      "c/.npmrc": "registry=https://registry.npmjs.org/\n",
    });
    try {
      expect(await scanSecretFiles(list)).toEqual([{ file: "a/.npmrc", rule: "npmrc auth token" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("ignores env templates, public keys and lookalike text", async () => {
    const { root, list } = tree({
      ".env.example": "KEY=your-key-here\n",
      ".env.sample": "KEY=\n",
      "id_rsa.pub": "ssh-rsa AAAA user@host\n",
      "id_ed25519.pub": "ssh-ed25519 AAAA user@host\n",
      "README.md": "Set OPENAI_API_KEY to an sk-... key; the class sk-button-primary-large-variant-name styles it.\n",
      "src/keys.ts": "export const key = process.env.API_KEY;\n",
    });
    try {
      expect(await scanSecretFiles(list)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("binary files and files over 1 MiB are judged by name only", async () => {
    const { root, list } = tree({
      "blob.bin": `\0${fake.aws}`,
      "big.txt": `${fake.aws}\n${"x".repeat(1024 * 1024)}`,
    });
    try {
      expect(await scanSecretFiles(list)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("allowFiles exempts exact paths and globs, nothing else", async () => {
    const { root, list } = tree({
      "fixtures/server.pem": "test certificate\n",
      "fixtures/nested/client.key": "test key\n",
      "test/data.ts": `const id = "${fake.aws}";\n`,
      ".env": "TOKEN=1\n",
    });
    try {
      expect(await scanSecretFiles(list, ["fixtures/**", "test/data.ts"])).toEqual([{ file: ".env", rule: "env file" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a tool's symlink is judged by name; a skill's link is read through", async () => {
    const { root } = tree({ "outside/token.txt": `${fake.github}\n` });
    try {
      mkdirSync(join(root, "ship"));
      symlinkSync(join(root, "outside/token.txt"), join(root, "ship/link.txt"));
      const list = [{ rel: "link.txt", path: join(root, "ship/link.txt") }];
      expect(await scanSecretFiles(list)).toEqual([]);
      expect(await scanSecretFiles(list, [], { followLinks: true })).toEqual([{ file: "link.txt", rule: "GitHub token" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the refusal names files and rules, never a value", () => {
    const error = secretRefusal("tool demo", [
      { file: ".env", rule: "env file" },
      { file: "src/a.ts", rule: "AWS access key id" },
      { file: "src/a.ts", rule: "GitHub token" },
    ], "tools.demo.allowFiles");
    expect(error.message).toContain("refusing to sync tool demo: 2 files look secret; nothing was sent");
    expect(error.message).toContain("  .env: env file");
    expect(error.message).toContain("  src/a.ts: AWS access key id, GitHub token");
    expect(error.message).toContain("tools.demo.allowFiles");
  });
});
