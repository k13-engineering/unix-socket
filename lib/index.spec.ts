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
  streamSocketPair,
  type TUnixSocket
} from "./index.ts";
import { syscall, syscallNumbers } from "syscall-napi";
import {
  EAGAIN,
  ECONNREFUSED,
  ELOOP,
  ENOENT,
  ENOTDIR,
  F_SETFL
} from "./constants.ts";

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

const connectUntilConnectError = ({ socketPath, maxAttempts }: { socketPath: string, maxAttempts: number }) => {
  const connectedClients: TUnixSocket[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const client = createUnixStreamSocketClient({ socketPath });

    if (client.status().type !== "open") {
      return { client, connectedClients };
    }

    // eslint-disable-next-line fp/no-mutating-methods
    connectedClients.push(client);
  }

  throw Error(`no connect error after ${maxAttempts} attempts`);
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

  [
    {
      condition: "the socket file does not exist",
      expectedErrno: ENOENT,
      connect: ({ socketPath }: { socketPath: string }) => {
        return createUnixStreamSocketClient({ socketPath });
      }
    },
    {
      condition: "a path component is not a directory",
      expectedErrno: ENOTDIR,
      connect: ({ socketPath }: { socketPath: string }) => {
        fs.writeFileSync(socketPath, "");
        return createUnixStreamSocketClient({ socketPath: path.join(socketPath, "server.sock") });
      }
    },
    {
      condition: "the path is a symlink loop",
      expectedErrno: ELOOP,
      connect: ({ socketPath }: { socketPath: string }) => {
        fs.symlinkSync(socketPath, socketPath);
        return createUnixStreamSocketClient({ socketPath });
      }
    },
    {
      condition: "nobody listens on the socket",
      expectedErrno: ECONNREFUSED,
      connect: ({ socketPath }: { socketPath: string }) => {
        const { server } = createUnixStreamSocketServer({ socketPath });
        assert.ok(server);

        const client = createUnixStreamSocketClient({ socketPath });
        server.close();
        return client;
      }
    },
    {
      condition: "the listen backlog of the server is full",
      expectedErrno: EAGAIN,
      connect: ({ socketPath }: { socketPath: string }) => {
        const { server } = createUnixStreamSocketServer({ socketPath });
        assert.ok(server);
        assert.equal(server.listen({ backlog: 0 }).error, undefined);

        // nobody accepts, so the backlog fills up after a few connections
        const { client, connectedClients } = connectUntilConnectError({ socketPath, maxAttempts: 16 });

        connectedClients.forEach((connectedClient) => {
          connectedClient.close();
        });
        server.close();
        return client;
      }
    }
  ].forEach(({ condition, expectedErrno, connect }) => {
    it(`should report a connect error when ${condition}`, () => {
      withTemporarySocketPath({
        fn: ({ socketPath }) => {
          const status = connect({ socketPath }).status();

          assert.equal(status.type, "connect-error");
          assert.equal(status.type === "connect-error" ? status.errno : undefined, expectedErrno);
        }
      });
    });
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

  it("should report remote-reset when the peer closes with unread data", () => {
    const { socket1, socket2 } = streamSocketPair();
    assert.ok(socket1);
    assert.ok(socket2);

    socket1.sendmsg({
      data: new Uint8Array([1]),
      controlMessages: [],
      flags: {}
    });

    // closing with data still in the receive queue resets the connection
    socket2.close();

    const { data } = socket1.recvmsg({
      count: 16,
      maxControlMessageBytes: 0,
      flags: {}
    });

    const statusAfterReset = socket1.status();
    socket1.close();

    assert.equal(data.length, 0);
    assert.deepEqual(statusAfterReset, { type: "remote-reset" });
    assert.equal(socket1.status().type, "closed");
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
