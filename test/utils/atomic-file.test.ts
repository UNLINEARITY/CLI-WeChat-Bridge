import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonFileAtomic } from "../../src/utils/atomic-file.ts";

describe("writeJsonFileAtomic", () => {
  test("writes readable JSON and leaves no temp file behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
    const filePath = path.join(dir, "state.json");
    try {
      writeJsonFileAtomic(filePath, { hello: "world", n: 1 });
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
        hello: "world",
        n: 1,
      });
      expect(fs.readdirSync(dir)).toEqual(["state.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replaces an existing file completely", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
    const filePath = path.join(dir, "state.json");
    try {
      writeJsonFileAtomic(filePath, { version: 1 });
      writeJsonFileAtomic(filePath, { version: 2 });
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
        version: 2,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
