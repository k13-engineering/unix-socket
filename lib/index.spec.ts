import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createUnixStreamSocketClient, streamSocketPair } from "./index.ts";

describe("index", () => {
  it("should export expected functions", () => {
    assert.equal(typeof createUnixStreamSocketClient, "function");
    assert.equal(typeof streamSocketPair, "function");
  });
});
