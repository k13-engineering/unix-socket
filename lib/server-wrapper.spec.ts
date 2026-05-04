import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createUnixStreamSocketServerWrapper } from "./server-wrapper.ts";
import type { TSyscallInterface } from "./syscalls.ts";

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
      return { errno: undefined, controlMessages: [], bytesReceived: 0 };
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

describe("server-wrapper", () => {

  describe("createUnixStreamSocketServerWrapper", () => {

    it("should return an object with expected methods", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface(),
        serverSocketFd: 5
      });

      assert.equal(typeof server.listen, "function");
      assert.equal(typeof server.accept, "function");
      assert.equal(typeof server.dup, "function");
      assert.equal(typeof server.close, "function");
    });
  });

  describe("listen", () => {

    it("should call listen syscall and return no error on success", () => {
      let listenArgs: { socketFd: number, backlog: number } | undefined;

      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          listen: (args) => {
            listenArgs = args;
            return { errno: undefined };
          }
        }),
        serverSocketFd: 5
      });

      const result = server.listen({ backlog: 128 });

      assert.equal(result.error, undefined);
      assert.deepEqual(listenArgs, { socketFd: 5, backlog: 128 });
    });

    it("should return error when listen syscall fails", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          listen: () => {
            return { errno: 98 };
          }
        }),
        serverSocketFd: 5
      });

      const result = server.listen({ backlog: 128 });

      assert.ok(result.error instanceof Error);
      assert.ok(result.error.message.includes("98"));
    });

    it("should throw when called after close", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface(),
        serverSocketFd: 5
      });

      server.close();

      assert.throws(() => {
        server.listen({ backlog: 128 });
      }, /already closed/);
    });
  });

  describe("accept", () => {

    it("should return a client socket on success", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          accept: () => {
            return { errno: undefined, socketFd: 15 };
          }
        }),
        serverSocketFd: 5
      });

      const result = server.accept();

      assert.equal(result.error, undefined);
      assert.ok(result.clientSocket !== undefined);
    });

    it("should pass the server socket fd to accept syscall", () => {
      let acceptArgs: { socketFd: number } | undefined;

      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          accept: (args) => {
            acceptArgs = args;
            return { errno: undefined, socketFd: 15 };
          }
        }),
        serverSocketFd: 5
      });

      server.accept();

      assert.deepEqual(acceptArgs, { socketFd: 5 });
    });

    it("should return undefined clientSocket on EAGAIN", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          accept: () => {
            return { errno: 11, socketFd: undefined };
          }
        }),
        serverSocketFd: 5
      });

      const result = server.accept();

      assert.equal(result.error, undefined);
      assert.equal(result.clientSocket, undefined);
    });

    it("should return error on non-EAGAIN errno", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          accept: () => {
            return { errno: 22, socketFd: undefined };
          }
        }),
        serverSocketFd: 5
      });

      const result = server.accept();

      assert.ok(result.error instanceof Error);
      assert.ok(result.error.message.includes("22"));
      assert.equal(result.clientSocket, undefined);
    });

    it("should throw when called after close", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface(),
        serverSocketFd: 5
      });

      server.close();

      assert.throws(() => {
        server.accept();
      }, /already closed/);
    });
  });

  describe("dup", () => {

    it("should return dupped server socket fd on success", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          dup: () => {
            return { errno: undefined, fd: 25 };
          }
        }),
        serverSocketFd: 5
      });

      const result = server.dup();

      assert.equal(result.serverSocketFd, 25);
    });

    it("should pass the server socket fd to dup syscall", () => {
      let dupArgs: { fd: number } | undefined;

      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          dup: (args) => {
            dupArgs = args;
            return { errno: undefined, fd: 25 };
          }
        }),
        serverSocketFd: 5
      });

      server.dup();

      assert.deepEqual(dupArgs, { fd: 5 });
    });

    it("should throw when dup syscall fails", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          dup: () => {
            return { errno: 24, fd: undefined };
          }
        }),
        serverSocketFd: 5
      });

      assert.throws(() => {
        server.dup();
      }, /dup syscall failed with errno 24/);
    });

    it("should throw when called after close", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface(),
        serverSocketFd: 5
      });

      server.close();

      assert.throws(() => {
        server.dup();
      }, /already closed/);
    });
  });

  describe("close", () => {

    it("should close the server socket", () => {
      let closeArgs: { fd: number } | undefined;

      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          close: (args) => {
            closeArgs = args;
            return { errno: undefined };
          }
        }),
        serverSocketFd: 5
      });

      server.close();

      assert.deepEqual(closeArgs, { fd: 5 });
    });

    it("should throw when close syscall fails", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface({
          close: () => {
            return { errno: 9 };
          }
        }),
        serverSocketFd: 5
      });

      assert.throws(() => {
        server.close();
      }, /close syscall failed with errno 9/);
    });

    it("should throw when called twice", () => {
      const server = createUnixStreamSocketServerWrapper({
        syscallInterface: createMockSyscallInterface(),
        serverSocketFd: 5
      });

      server.close();

      assert.throws(() => {
        server.close();
      }, /already closed/);
    });
  });
});
