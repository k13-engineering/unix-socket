import assert from "node:assert/strict";
import { describe, it } from "mocha";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createUnixStreamSocketClient,
  createUnixStreamSocketServer,
  importConnectedSocket,
  streamSocketPair
} from "./index.ts";

describe("index", () => {
  it("should export expected functions", () => {
    assert.equal(typeof createUnixStreamSocketClient, "function");
    assert.equal(typeof createUnixStreamSocketServer, "function");
    assert.equal(typeof importConnectedSocket, "function");
    assert.equal(typeof streamSocketPair, "function");
  });

  it("should receive all fds passed in a single sendmsg call", () => {
    const { errno, socket1, socket2 } = streamSocketPair();
    if (errno !== undefined) {
      throw Error(`socketpair syscall failed with errno ${errno}`);
    }

    const filePaths = [
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      fileURLToPath(new URL("./index.spec.ts", import.meta.url))
    ];

    const sentFds = filePaths.map((filePath) => {
      return fs.openSync(filePath, "r");
    });

    socket1.sendmsg({
      data: new Uint8Array([1]),
      controlMessages: sentFds.map((fd) => {
        return { level: "SOL_SOCKET", type: "SCM_RIGHTS", fd } as const;
      }),
      flags: {}
    });

    const { data, controlMessages } = socket2.recvmsg({
      count: 16,
      maxControlMessageBytes: 256,
      flags: {}
    });

    const receivedFds = controlMessages.map(({ fd }) => {
      return fd;
    });

    const receivedInodes = receivedFds.map((fd) => {
      return fs.fstatSync(fd).ino;
    });

    const expectedInodes = filePaths.map((filePath) => {
      return fs.statSync(filePath).ino;
    });

    [...sentFds, ...receivedFds].forEach((fd) => {
      fs.closeSync(fd);
    });

    socket1.close();
    socket2.close();

    assert.deepEqual(data, new Uint8Array([1]));
    assert.deepEqual(receivedInodes, expectedInodes);
  });
});
