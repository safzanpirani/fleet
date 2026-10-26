/**
 * The secret check `fleet tools sync` and `fleet skills sync` run on the exact
 * file set they are about to ship. A file that looks like a credential, by name
 * or by content, refuses the whole tool or skill set before anything is
 * archived or sent. Findings name the file and the rule; a matched value never leaves
 * this module. A config `allowFiles` list (relative paths or globs) exempts a
 * file the owner has checked.
 */
import { basename } from "node:path";
import { lstat, readFile, stat } from "node:fs/promises";

/** Text files above this size are judged by name only. */
const CONTENT_SCAN_MAX_BYTES = 1024 * 1024;

export interface SecretFile {
  rel: string;           // path as the config's allowFiles names it
  path: string;          // where to read it on the controller
}
export interface SecretHit { file: string; rule: string }

const NAME_RULES: { rule: string; test: (name: string) => boolean }[] = [
  { rule: "env file", test: (n) => (n === ".env" || n.startsWith(".env.")) && n !== ".env.example" && n !== ".env.sample" },
  { rule: "PEM file", test: (n) => n.endsWith(".pem") },
  { rule: "key file", test: (n) => n.endsWith(".key") },
  { rule: "PKCS#12 keystore", test: (n) => n.endsWith(".p12") || n.endsWith(".pfx") },
  { rule: "SSH private key", test: (n) => n === "id_rsa" || n === "id_ed25519" || n === "id_ecdsa" },
  { rule: "credentials.json", test: (n) => n === "credentials.json" },
  { rule: "auth.json", test: (n) => n === "auth.json" },
  { rule: "KeePass database", test: (n) => n.endsWith(".kdbx") },
];

const CONTENT_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "private key block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { rule: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "GitHub token", pattern: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/ },
  { rule: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  // OpenAI-style keys (sk-, sk-proj-, OpenRouter's sk-or-v1-…). A digit is
  // required so a long kebab-case identifier that starts with "sk-" passes.
  { rule: "OpenAI-style API key", pattern: /\bsk-(?!ant-)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/ },
  { rule: "Slack token", pattern: /\bxox[bp]-[0-9A-Za-z-]{10,}/ },
  { rule: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
];

/** An npm auth line with a literal value: `_authToken=`, `_auth=` or
 *  `_password=`. A `${VAR}` reference keeps the secret out of the file. */
const NPMRC_AUTH = /^\s*(?:\/\/[^\s=]*:)?_(?:authToken|auth|password)\s*=\s*(?!\$\{)\S/m;

/** Whether an allowFiles entry exempts `rel`: an exact relative path or a glob. */
function allowed(rel: string, allow: readonly { pattern: string; glob: Bun.Glob }[]): boolean {
  return allow.some(({ pattern, glob }) => pattern === rel || glob.match(rel));
}

/** Every rule a file breaks. Syncs pass their staged snapshot, the bytes they
 *  send; a staged link ships as a link and is judged by name only.
 *  `followLinks` reads a link's target, for a skills dry run that judges the
 *  source files a sync would copy. */
export async function scanSecretFiles(
  files: readonly SecretFile[], allowFiles: readonly string[] = [], opts: { followLinks?: boolean } = {},
): Promise<SecretHit[]> {
  const allow = allowFiles.map((pattern) => ({ pattern, glob: new Bun.Glob(pattern) }));
  const hits: SecretHit[] = [];
  for (const { rel, path } of files) {
    if (allowed(rel, allow)) continue;
    // Name rules ignore case: `.ENV` and `vault.P12` are the same credentials.
    const name = basename(rel).toLowerCase();
    for (const { rule, test } of NAME_RULES) if (test(name)) hits.push({ file: rel, rule });
    const info = await (opts.followLinks ? stat(path) : lstat(path)).catch(() => null);
    if (!info?.isFile() || info.size > CONTENT_SCAN_MAX_BYTES) continue;
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;   // binary: name rules only
    const text = bytes.toString("utf8");
    if (name === ".npmrc" && NPMRC_AUTH.test(text)) hits.push({ file: rel, rule: "npmrc auth token" });
    for (const { rule, pattern } of CONTENT_RULES) if (pattern.test(text)) hits.push({ file: rel, rule });
  }
  return hits;
}

/** The refusal for `what` ("tool fleet", "skill set agents"): each file and
 *  rule, never a value, and the config key that exempts a file. */
export function secretRefusal(what: string, hits: readonly SecretHit[], allowKey: string): Error {
  const files = [...new Set(hits.map((h) => h.file))];
  const lines = files.map((file) => `  ${file}: ${hits.filter((h) => h.file === file).map((h) => h.rule).join(", ")}`);
  return new Error(`refusing to sync ${what}: ${files.length} file${files.length === 1 ? "" : "s"} look${files.length === 1 ? "s" : ""} secret; nothing was sent\n`
    + `${lines.join("\n")}\nremove or exclude ${files.length === 1 ? "it" : "them"}, or list a checked file in ${allowKey}`);
}
