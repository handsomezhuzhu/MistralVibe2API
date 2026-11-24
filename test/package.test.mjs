/**
 * Package and plugin-contract checks.
 *
 * These guard the magpie plugin contract (package.json shape, hook exports,
 * discovery keywords) so a refactor cannot silently break "magpie plugin add"
 * or the discovery card.
 */

import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("package.json declares a module entry magpie can load", () => {
  assert.equal(pkg.type, "module", "must be ESM for Bun to run it directly");
  assert.ok(pkg.main, "main is how magpie finds the plugin entry");
  const entry = join(root, pkg.main);
  assert.ok(existsSync(entry), `${pkg.main} must exist`);
});

test("package.json carries the magpie fields the discovery card reads", () => {
  const magpie = pkg.magpie;
  assert.ok(magpie, "magpie field present");
  assert.ok(
    Number.isInteger(magpie.maxConcurrency) &&
      magpie.maxConcurrency >= 1 &&
      magpie.maxConcurrency <= 1000,
    "maxConcurrency is an integer in 1..1000"
  );
  if (magpie.name) {
    assert.ok(
      Buffer.byteLength(magpie.name, "utf8") <= 80,
      "magpie.name is at most 80 bytes"
    );
  }
  if (magpie.icon) {
    const isData = magpie.icon.startsWith("data:image/");
    const isHttps = magpie.icon.startsWith("https://");
    assert.ok(isData || isHttps, "magpie.icon is a data: or https: URL");
    assert.ok(
      magpie.icon.length <= 1_000_000,
      "magpie.icon is at most 1 MB"
    );
  }
  for (const [lang, summary] of Object.entries(magpie.summary ?? {})) {
    assert.ok(
      Buffer.byteLength(summary, "utf8") <= 300,
      `magpie.summary.${lang} is at most 300 bytes`
    );
  }
});

test("keywords satisfy magpie's npm search rule", () => {
  // The search queries npm for "<term> opencode" and shows packages whose
  // name or keywords hold "opencode" AND one of auth/plugin/provider.
  const keywords = pkg.keywords ?? [];
  const haystack = [pkg.name, ...keywords].join(" ").toLowerCase();
  assert.ok(haystack.includes("opencode"), 'name or keywords mention "opencode"');
  assert.ok(
    ["auth", "plugin", "provider"].some((word) => haystack.includes(word)),
    'name or keywords mention "auth", "plugin" or "provider"'
  );
});

test("package.json has license, engines and an npm files list", () => {
  assert.ok(pkg.license, "license present");
  assert.ok(pkg.engines?.node, "engines.node present");
  for (const file of pkg.files ?? []) {
    assert.ok(existsSync(join(root, file)), `files entry "${file}" exists`);
  }
  assert.ok(existsSync(join(root, "LICENSE")), "LICENSE file present");
});

test("every tracked source file parses as ESM", async () => {
  const files = [
    "index.mjs",
    ...readdirSync(join(root, "src")).map((f) => `src/${f}`),
  ];
  for (const file of files) {
    execFileSync(process.execPath, ["--check", join(root, file)], {
      stdio: "pipe",
    });
  }
  assert.ok(files.length >= 3, "core files present");
});

test("no tracked file carries a key-shaped secret", () => {
  const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(tracked.length > 0, "repository has tracked files");
  const patterns = [
    /mstrl_[A-Za-z0-9_]{10,}/, // Mistral API keys
    /sk-[A-Za-z0-9]{20,}/, // OpenAI-style keys
  ];
  const offenders = [];
  for (const file of tracked) {
    const content = readFileSync(join(root, file), "utf8");
    for (const pattern of patterns) {
      if (pattern.test(content)) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `no key-shaped strings in: ${offenders.join(", ")}`);
});
