import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createSocketsFactory } from "./sockets.ts";
import type { TSyscallInterface } from "./syscalls.ts";
import {
  AF_UNIX,
  ENOENT,
  F_GETFL,
  F_SETFL,
  O_NONBLOCK,
  SOCK_NONBLOCK,
  SOCK_STREAM
} from "./constants.ts";
import { createUnixSocketAddressAsBuffer } from "./abi.ts";

const createMockSyscallInterface = (overrides?: Partial<TSyscallInterface>): TSyscallInterface => {
  return {
    socket: () => {
      return { errno: undefined, socketFd: 10 };
    },
    connect: () => {
      return { errno: undefined };
    },
    bind: () => {
      return { errno: undefined };
    },
    listen: () => {
      return { errno: undefined };
    },
    accept: () => {
      return { errno: undefined, socketFd: 12 };
    },
    unlink: () => {
      return { errno: undefined };
    },
    close: () => {
      return { errno: undefined };
    },
    fcntl: () => {
      return { errno: undefined, ret: 0n };
    },
    recvmsg: () => {
      return { errno: undefined, controlMessages: [], bytesReceived: 0, msgFlags: 0n };
    },
    sendmsg: () => {
      return { errno: undefined, bytesSent: 0 };
    },
    getsockopt: () => {
      return { errno: undefined, value: new Uint8Array(0) };
    },
    socketpair: () => {
      return { errno: undefined, fd1: 10, fd2: 11 };
    },
    dup: () => {
      return { errno: undefined, fd: 20 };
    },
    ...overrides
  };
};

describe("sockets", () => {

  describe("createSocketsFactory", () => {

    it("should return an object with expected methods", () => {
      const factory = createSocketsFactory({
        syscallInterface: createMockSyscallInterface()
      });

      assert.equal(typeof factory.createUnixStreamSocketClient, "function");
      assert.equal(typeof factory.streamSocketPair, "function");
    });
  });

  describe("createUnixStreamSocketClient", () => {

    it("should create a socket, set non-blocking, and connect", () => {
      const calls: string[] = [];

      const syscallInterface = createMockSyscallInterface({
        socket: ({ domain, type, protocol }) => {
          // eslint-disable-next-line fp/no-mutating-methods
          calls.push("socket");
          assert.equal(domain, AF_UNIX);
          assert.equal(type, SOCK_STREAM | SOCK_NONBLOCK);
          assert.equal(protocol, 0n);
          return { errno: undefined, socketFd: 7 };
        },
        connect: ({ socketFd }) => {
          // eslint-disable-next-line fp/no-mutating-methods
          calls.push("connect");
          assert.equal(socketFd, 7);
          return { errno: undefined };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });
      const client = factory.createUnixStreamSocketClient({ socketPath: "/tmp/test.sock" });

      assert.ok(client);
      assert.deepEqual(calls, ["socket", "connect"]);
    });

    it("should return a socket with status, recvmsg, sendmsg, close methods", () => {
      const factory = createSocketsFactory({
        syscallInterface: createMockSyscallInterface()
      });

      const client = factory.createUnixStreamSocketClient({ socketPath: "/tmp/test.sock" });

      assert.equal(typeof client.status, "function");
      assert.equal(typeof client.recvmsg, "function");
      assert.equal(typeof client.sendmsg, "function");
      assert.equal(typeof client.close, "function");
    });

    it("should throw when socket syscall fails", () => {
      const syscallInterface = createMockSyscallInterface({
        socket: () => {
          return { errno: 24, socketFd: undefined };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });

      assert.throws(
        () => {
          factory.createUnixStreamSocketClient({ socketPath: "/tmp/test.sock" });
        },
        { message: /socket syscall failed/ }
      );
    });

    it("should handle ENOENT connect error gracefully", () => {
      const syscallInterface = createMockSyscallInterface({
        connect: () => {
          return { errno: ENOENT };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });
      const client = factory.createUnixStreamSocketClient({ socketPath: "/tmp/missing.sock" });

      const status = client.status();
      assert.equal(status.type, "connect-error");
      if (status.type === "connect-error") {
        assert.ok(status.error.message.includes("/tmp/missing.sock"));
      }
    });

    it("should throw for non-ENOENT connect errors", () => {
      const syscallInterface = createMockSyscallInterface({
        connect: () => {
          return { errno: 111 };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });

      assert.throws(
        () => {
          factory.createUnixStreamSocketClient({ socketPath: "/tmp/test.sock" });
        },
        { message: /connect syscall failed/ }
      );
    });

    it("should throw when closing the socket after a failed connect fails", () => {
      const syscallInterface = createMockSyscallInterface({
        connect: () => {
          return { errno: ENOENT };
        },
        close: () => {
          return { errno: 9 };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });

      assert.throws(
        () => {
          factory.createUnixStreamSocketClient({ socketPath: "/tmp/missing.sock" });
        },
        { message: /close syscall failed with errno 9/ }
      );
    });
  });

  describe("createUnixStreamSocketServer", () => {

    it("should create a socket, set non-blocking, and bind", () => {
      const calls: string[] = [];

      const syscallInterface = createMockSyscallInterface({
        socket: () => {
          // eslint-disable-next-line fp/no-mutating-methods
          calls.push("socket");
          return { errno: undefined, socketFd: 7 };
        },
        bind: ({ socketFd, socketAddressAsBuffer }) => {
          // eslint-disable-next-line fp/no-mutating-methods
          calls.push("bind");
          assert.equal(socketFd, 7);
          assert.deepEqual(socketAddressAsBuffer, createUnixSocketAddressAsBuffer({ socketPath: "/tmp/server.sock" }));
          return { errno: undefined };
        },
        listen: ({ socketFd }) => {
          // eslint-disable-next-line fp/no-mutating-methods
          calls.push("listen");
          assert.equal(socketFd, 7);
          return { errno: undefined };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });
      const { error, server } = factory.createUnixStreamSocketServer({ socketPath: "/tmp/server.sock" });

      assert.equal(error, undefined);
      assert.deepEqual(calls, ["socket", "bind"]);

      // the returned server operates on the bound socket
      server!.listen({ backlog: 1 });
      assert.deepEqual(calls, ["socket", "bind", "listen"]);
    });

    it("should return an error when bind fails", () => {
      const syscallInterface = createMockSyscallInterface({
        bind: () => {
          return { errno: 98 };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });
      const { error, server } = factory.createUnixStreamSocketServer({ socketPath: "/tmp/server.sock" });

      assert.equal(server, undefined);
      assert.match(error!.message, /bind syscall failed with errno 98/);
    });
  });

  describe("streamSocketPair", () => {

    it("should create a socket pair and return two sockets", () => {
      const syscallInterface = createMockSyscallInterface({
        socketpair: ({ domain, type, protocol }) => {
          assert.equal(domain, AF_UNIX);
          assert.equal(type, SOCK_STREAM | SOCK_NONBLOCK);
          assert.equal(protocol, 0n);
          return { errno: undefined, fd1: 10, fd2: 11 };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });
      const result = factory.streamSocketPair();

      assert.equal(result.errno, undefined);
      assert.ok(result.socket1);
      assert.ok(result.socket2);
    });

    it("should return sockets with expected methods", () => {
      const factory = createSocketsFactory({
        syscallInterface: createMockSyscallInterface()
      });

      const { socket1, socket2 } = factory.streamSocketPair();

      assert.equal(typeof socket1!.status, "function");
      assert.equal(typeof socket1!.recvmsg, "function");
      assert.equal(typeof socket1!.sendmsg, "function");
      assert.equal(typeof socket1!.close, "function");

      assert.equal(typeof socket2!.status, "function");
      assert.equal(typeof socket2!.recvmsg, "function");
      assert.equal(typeof socket2!.sendmsg, "function");
      assert.equal(typeof socket2!.close, "function");
    });

    it("should return errno when socketpair fails", () => {
      const syscallInterface = createMockSyscallInterface({
        socketpair: () => {
          return { errno: 24, fd1: undefined, fd2: undefined };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });
      const result = factory.streamSocketPair();

      assert.equal(result.errno, 24);
      assert.equal(result.socket1, undefined);
      assert.equal(result.socket2, undefined);
    });

    it("should return open status for both sockets", () => {
      const factory = createSocketsFactory({
        syscallInterface: createMockSyscallInterface()
      });

      const { socket1, socket2 } = factory.streamSocketPair();

      assert.equal(socket1!.status().type, "open");
      assert.equal(socket2!.status().type, "open");
    });
  });

  describe("importConnectedSocket", () => {

    it("should switch the fd to non-blocking mode, keeping its other file status flags", () => {
      const fcntlCalls: { fd: number, cmd: bigint, arg: bigint }[] = [];
      // O_APPEND, standing in for any flag the fd already has
      const existingFlags = 1024n;

      const syscallInterface = createMockSyscallInterface({
        fcntl: (args) => {
          // eslint-disable-next-line fp/no-mutating-methods
          fcntlCalls.push(args);
          return { errno: undefined, ret: args.cmd === F_GETFL ? existingFlags : 0n };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });
      const socket = factory.importConnectedSocket({ socketFd: 9 });

      assert.equal(socket.status().type, "open");
      assert.deepEqual(fcntlCalls, [
        { fd: 9, cmd: F_GETFL, arg: 0n },
        { fd: 9, cmd: F_SETFL, arg: existingFlags | O_NONBLOCK }
      ]);
    });

    it("should throw when reading the file status flags fails", () => {
      const syscallInterface = createMockSyscallInterface({
        fcntl: () => {
          return { errno: 9, ret: undefined };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });

      assert.throws(() => {
        factory.importConnectedSocket({ socketFd: 9 });
      }, { message: /fcntl syscall failed with errno 9/ });
    });

    it("should throw when setting the file status flags fails", () => {
      const syscallInterface = createMockSyscallInterface({
        fcntl: ({ cmd }) => {
          if (cmd === F_GETFL) {
            return { errno: undefined, ret: 0n };
          }

          return { errno: 22, ret: undefined };
        }
      });

      const factory = createSocketsFactory({ syscallInterface });

      assert.throws(() => {
        factory.importConnectedSocket({ socketFd: 9 });
      }, { message: /fcntl syscall failed with errno 22/ });
    });
  });
});
