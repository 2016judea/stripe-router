// Only public/ may be static. 2026-10-19: with outputDirectory "." the functions' own source
// (prompt, paywall, router) was served as plain text at /api/<file>.js (curl, 200).
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const read = (f) => readFileSync(require("node:path").join(__dirname, "..", f), "utf8");

test("only public/ is served, in vercel.json and in the deploy payload", () => {
  assert.equal(JSON.parse(read("vercel.json")).outputDirectory, "public");
  const deploy = read("scripts/deploy.py");
  assert.match(deploy, /"outputDirectory": "public"/);
  assert.doesNotMatch(deploy, /"outputDirectory": "\."/);
  assert.match(deploy, /"public\/robots\.txt"/);
});
