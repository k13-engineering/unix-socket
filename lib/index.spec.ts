import assert from "node:assert/strict";
import { describe, it } from "mocha";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createUnixStreamSocketClient,
  createUnixStreamSocketServer,
  importConnectedSocket,
  streamSocketPair
} from "./index.ts";
import { syscall, syscallNumbers } from "syscall-napi";
import { F_SETFL } from "./constants.ts";

const withTemporarySocketPath = ({ fn }: { fn: (args: { socketPath: string }) => void }) => {
  const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "unix-socket-"));

  try {
    fn({ socketPath: path.join(socketDirectory, "server.sock") });
  } finally {
    fs.rmSync(socketDirectory, { recursive: true, force: true });
  }
};

const createConnectedClientAndServer = ({ socketPath }: { socketPath: string }) => {
  const { error: serverError, server } = createUnixStreamSocketServer({ socketPath });
  assert.equal(serverError, undefined);
  assert.ok(server);

  assert.equal(server.listen({ backlog: 1 }).error, undefined);

  const client = createUnixStreamSocketClient({ socketPath });

  const { error: acceptError, clientSocket } = server.accept();
  assert.equal(acceptError, undefined);
  assert.ok(clientSocket);

  return { server, client, clientSocket };
};

const isNonBlocking = ({ fd }: { fd: number }) => {
  const flagsLine = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").split("\n").find((line) => {
    return line.startsWith("flags:");
  });
  assert.ok(flagsLine);

  // O_NONBLOCK, the flags are printed in octal
  return (parseInt(flagsLine.split(/\s+/)[1], 8) & 0o4000) !== 0;
};

describe("index", () => {
  it("should export expected functions", () => {
    assert.equal(typeof createUnixStreamSocketClient, "function");
    assert.equal(typeof createUnixStreamSocketServer, "function");
    assert.equal(typeof importConnectedSocket, "function");
    assert.equal(typeof streamSocketPair, "function");
  });

  it("should exchange data between a client and a server", () => {
    withTemporarySocketPath({
      fn: ({ socketPath }) => {
        const { server, client, clientSocket } = createConnectedClientAndServer({ socketPath });
        assert.equal(client.status().type, "open");

        const { bytesSent } = client.sendmsg({
          data: new Uint8Array([1, 2, 3]),
          controlMessages: [],
          flags: {}
        });
        assert.equal(bytesSent, 3);

        const { data } = clientSocket.recvmsg({
          count: 16,
          maxControlMessageBytes: 64,
          flags: {}
        });
        assert.deepEqual(data, new Uint8Array([1, 2, 3]));

        client.close();
        clientSocket.close();
        server.close();
      }
    });
  });

  it("should create clients, accepted sockets and socket pairs in non-blocking mode", () => {
    withTemporarySocketPath({
      fn: ({ socketPath }) => {
        const { server, client, clientSocket } = createConnectedClientAndServer({ socketPath });
        const { socket1, socket2 } = streamSocketPair();
        assert.ok(socket1);
        assert.ok(socket2);

        const sockets = [client, clientSocket, socket1, socket2];

        const nonBlocking = sockets.map((socket) => {
          // a dupped fd shares the file status flags of the original one
          const { socketFd } = socket.dup();
          const result = isNonBlocking({ fd: socketFd });
          fs.closeSync(socketFd);
          return result;
        });

        sockets.forEach((socket) => {
          socket.close();
        });
        server.close();

        assert.deepEqual(nonBlocking, [true, true, true, true]);
      }
    });
  });

  it("should switch an imported socket fd to non-blocking mode", () => {
    const { socket1, socket2 } = streamSocketPair();
    assert.ok(socket1);
    assert.ok(socket2);

    const { socketFd } = socket1.dup();

    // make the fd blocking, as a socket created elsewhere typically is
    const { errno: fcntlErrno } = syscall({
      syscallNumber: syscallNumbers.fcntl,
      args: [BigInt(socketFd), F_SETFL, 0n]
    });
    assert.equal(fcntlErrno, undefined);
    assert.equal(isNonBlocking({ fd: socketFd }), false);

    const importedSocket = importConnectedSocket({ socketFd });
    const nonBlockingAfterImport = isNonBlocking({ fd: socketFd });

    importedSocket.close();
    socket1.close();
    socket2.close();

    assert.equal(nonBlockingAfterImport, true);
  });

  it("should report a connect error when the socket path does not exist", () => {
    const client = createUnixStreamSocketClient({ socketPath: "/nonexistent/unix-socket.sock" });
    assert.equal(client.status().type, "connect-error");
  });

  it("should release the socket fd on close", () => {
    const { errno, socket1, socket2 } = streamSocketPair();
    if (errno !== undefined) {
      throw Error(`socketpair syscall failed with errno ${errno}`);
    }

    const { socketFd } = socket1.dup();
    const importedSocket = importConnectedSocket({ socketFd });

    importedSocket.close();

    assert.throws(() => {
      fs.fstatSync(socketFd);
    }, { code: "EBADF" });

    socket1.close();
    socket2.close();
  });

  it("should import a connected socket fd", () => {
    const { errno, socket1, socket2 } = streamSocketPair();
    if (errno !== undefined) {
      throw Error(`socketpair syscall failed with errno ${errno}`);
    }

    const { socketFd } = socket1.dup();
    const importedSocket = importConnectedSocket({ socketFd });
    assert.equal(importedSocket.status().type, "open");

    importedSocket.sendmsg({
      data: new Uint8Array([4, 5, 6]),
      controlMessages: [],
      flags: {}
    });

    const { data } = socket2.recvmsg({
      count: 16,
      maxControlMessageBytes: 64,
      flags: {}
    });
    assert.deepEqual(data, new Uint8Array([4, 5, 6]));

    importedSocket.close();
    socket1.close();
    socket2.close();
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

  it("should report ctrunc when passed fds do not fit into the control message buffer", () => {
    const { errno, socket1, socket2 } = streamSocketPair();
    if (errno !== undefined) {
      throw Error(`socketpair syscall failed with errno ${errno}`);
    }

    const sentFd = fs.openSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "r");

    socket1.sendmsg({
      data: new Uint8Array([1]),
      controlMessages: [{ level: "SOL_SOCKET", type: "SCM_RIGHTS", fd: sentFd }],
      flags: {}
    });

    const { data, controlMessages, flags } = socket2.recvmsg({
      count: 16,
      maxControlMessageBytes: 0,
      flags: {}
    });

    fs.closeSync(sentFd);
    socket1.close();
    socket2.close();

    assert.deepEqual(data, new Uint8Array([1]));
    assert.deepEqual(controlMessages, []);
    assert.deepEqual(flags, { trunc: false, ctrunc: true });
  });
});
