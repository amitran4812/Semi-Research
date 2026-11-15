import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newLock, unlock, seal, open, isSealed, exportKey, importKey, CHECK } from "../site/lib/lock.js";
import { setupLock, readJson, writeJson } from "../pipeline/run.mjs";

test("lock: right code opens, wrong code does not, nothing secret is stored", async () => {
  const { lock, key } = await newLock("correct horse battery staple");
  assert.ok(!JSON.stringify(lock).includes("correct horse"));
  assert.ok(await unlock(lock, "correct horse battery staple"));
  assert.equal(await unlock(lock, "wrong"), null);
  const box = await seal(key, { hello: "NAND" });
  assert.ok(isSealed(box) && !JSON.stringify(box).includes("NAND"));
  assert.deepEqual(await open(await importKey(await exportKey(key)), box), { hello: "NAND" });
  assert.equal(await open(key, lock.check), CHECK);
});

test("pipeline writes sealed data with a code, reuses the salt, and opens the site without one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gf-lock-"));
  await setupLock("code-one", dir);
  const salt = JSON.parse(fs.readFileSync(path.join(dir, "lock.json"))).salt;
  const f = path.join(dir, "index.json");
  await writeJson(f, { categories: [{ id: "nand" }] });
  assert.ok(isSealed(JSON.parse(fs.readFileSync(f))), "file on disk is encrypted");
  await setupLock("code-one", dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "lock.json"))).salt, salt, "same code keeps the salt");
  assert.deepEqual(await readJson(f, null), { categories: [{ id: "nand" }] });
  await setupLock("code-two", dir);
  assert.equal(await readJson(f, "fresh"), "fresh", "data sealed with an old code is rebuilt");
  await setupLock("", dir);
  assert.ok(!fs.existsSync(path.join(dir, "lock.json")));
  await writeJson(f, { open: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f)), { open: true });
});
