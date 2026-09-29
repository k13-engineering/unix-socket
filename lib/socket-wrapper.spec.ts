import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createSocketWrapper, type TControlMessage, type TUnixSocket } from "./socket-wrapper.ts";
import type { TSyscallInterface } from "./syscalls.ts";
import {
  EAGAIN,
  ECONNREFUSED,
  ECONNRESET,
  EPIPE,
  F_DUPFD_CLOEXEC,
  MSG_CMSG_CLOEXEC,
  MSG_CTRUNC,
  MSG_PEEK,
  MSG_TRUNC,
  SOL_SOCKET,
  SCM_RIGHTS
} from "./constants.ts";
import { CMSG_ALIGN, createScmRightsPayload, parsers } from "./abi.ts";

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
    ...overrides
  };
};

describe("socket-wrapper", () => {

  describe("createSocketWrapper with connectError", () => {

    it("should report connect-error status", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: { errno: ECONNREFUSED, error: Error("connection refused") }
      });

      const status = wrapper.status();
      assert.deepEqual(status, {
        type: "connect-error",
        errno: ECONNREFUSED,
        error: Error("connection refused")
      });
    });

    [
      {
        operation: "dup",
        call: (wrapper: TUnixSocket) => {
          wrapper.dup();
        }
      },
      {
        operation: "sendmsg",
        call: (wrapper: TUnixSocket) => {
          wrapper.sendmsg({ data: new Uint8Array([1, 2, 3]), controlMessages: [], flags: {} });
        }
      },
      {
        operation: "recvmsg",
        call: (wrapper: TUnixSocket) => {
          wrapper.recvmsg({ count: 1024, maxControlMessageBytes: 256, flags: {} });
        }
      },
      {
        operation: "close",
        call: (wrapper: TUnixSocket) => {
          wrapper.close();
        }
      }
    ].forEach(({ operation, call }) => {
      it(`should throw invalid state on ${operation} in connect-error state`, () => {
        const wrapper = createSocketWrapper({
          syscallInterface: createMockSyscallInterface(),
          socketFd: 5,
          connectError: { errno: ECONNREFUSED, error: Error("connection refused") }
        });

        assert.throws(() => {
          call(wrapper);
        }, { message: /invalid state/ });

        assert.equal(wrapper.status().type, "connect-error");
      });
    });

    it("should not touch the already closed socket fd in connect-error state", () => {
      const calledSyscalls: string[] = [];

      const recordCall = ({ name }: { name: string }) => {
        // eslint-disable-next-line fp/no-mutating-methods
        calledSyscalls.push(name);
      };

      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          close: () => {
            recordCall({ name: "close" });
            return { errno: undefined };
          },
          fcntl: () => {
            recordCall({ name: "fcntl" });
            return { errno: undefined, ret: 42n };
          }
        }),
        socketFd: 5,
        connectError: { errno: ECONNREFUSED, error: Error("connection refused") }
      });

      assert.throws(() => {
        wrapper.close();
      });
      assert.throws(() => {
        wrapper.dup();
      });

      assert.deepEqual(calledSyscalls, []);
    });
  });

  describe("createSocketWrapper in open state", () => {

    it("should report open status with all flags true", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      const status = wrapper.status();
      assert.equal(status.type, "open");
      if (status.type === "open") {
        assert.deepEqual(status.remote, { reading: true, writing: true });
        assert.deepEqual(status.local, { reading: true, writing: true });
      }
    });

    it("should transition to closed state on close", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.close();

      const status = wrapper.status();
      assert.equal(status.type, "closed");
    });

    it("should close the socket fd on close", () => {
      const closedFds: number[] = [];

      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          close: ({ fd }) => {
            // eslint-disable-next-line fp/no-mutating-methods
            closedFds.push(fd);
            return { errno: undefined };
          }
        }),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.close();

      assert.deepEqual(closedFds, [5]);
    });

    it("should throw on close syscall failure, but still transition to closed state", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          close: () => {
            return { errno: 5 };
          }
        }),
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(() => {
        wrapper.close();
      }, { message: /close syscall failed with errno 5/ });

      // the fd is released even if close fails, so it must not be closed a second time
      assert.equal(wrapper.status().type, "closed");
      assert.throws(() => {
        wrapper.close();
      }, { message: /invalid state/ });
    });

    it("should dup the socket fd with close-on-exec in open state", () => {
      let fcntlArgs: { fd: number, cmd: bigint, arg: bigint } | undefined;

      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          fcntl: (args) => {
            fcntlArgs = args;
            return { errno: undefined, ret: 99n };
          }
        }),
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.dup();
      assert.equal(result.socketFd, 99);
      assert.deepEqual(fcntlArgs, { fd: 5, cmd: F_DUPFD_CLOEXEC, arg: 0n });
    });

    it("should throw when dupping fails in open state", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          fcntl: () => {
            return { errno: 9, ret: undefined };
          }
        }),
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(
        () => {
          wrapper.dup();
        },
        { message: /fcntl syscall failed with errno 9/ }
      );
    });
  });

  describe("sendmsg in open state", () => {

    it("should send data and return bytes sent", () => {
      const sentData: Uint8Array[] = [];

      const syscallInterface = createMockSyscallInterface({
        sendmsg: ({ dataBuffers }) => {
          const total = dataBuffers.reduce((sum, buf) => {
            return sum + buf.length;
          }, 0);
          dataBuffers.forEach((buf) => {
            // eslint-disable-next-line fp/no-mutating-methods
            sentData.push(buf);
          });
          return { errno: undefined, bytesSent: total };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.sendmsg({
        data: new Uint8Array([1, 2, 3]),
        controlMessages: [],
        flags: {}
      });

      assert.equal(result.bytesSent, 3);
      assert.equal(sentData.length, 1);
    });

    it("should return 0 bytesSent on EAGAIN", () => {
      const syscallInterface = createMockSyscallInterface({
        sendmsg: () => {
          return { errno: EAGAIN, bytesSent: undefined };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.sendmsg({
        data: new Uint8Array([1, 2, 3]),
        controlMessages: [],
        flags: {}
      });

      assert.equal(result.bytesSent, 0);
    });

    it("should mark remote.reading as false on EPIPE", () => {
      const syscallInterface = createMockSyscallInterface({
        sendmsg: () => {
          return { errno: EPIPE, bytesSent: undefined };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.sendmsg({
        data: new Uint8Array([1, 2, 3]),
        controlMessages: [],
        flags: {}
      });

      assert.equal(result.bytesSent, 0);

      const status = wrapper.status();
      assert.equal(status.type, "open");
      if (status.type === "open") {
        assert.equal(status.remote.reading, false);
        assert.equal(status.remote.writing, true);
      }
    });

    it("should transition to remote-reset state when sendmsg reports ECONNRESET", () => {
      const syscallInterface = createMockSyscallInterface({
        sendmsg: () => {
          return { errno: ECONNRESET, bytesSent: undefined };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.sendmsg({
        data: new Uint8Array([1]),
        controlMessages: [],
        flags: {}
      });

      assert.equal(result.bytesSent, 0);
      assert.deepEqual(wrapper.status(), { type: "remote-reset" });
    });

    it("should throw on unexpected sendmsg errno", () => {
      const syscallInterface = createMockSyscallInterface({
        sendmsg: () => {
          return { errno: 999, bytesSent: undefined };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(
        () => {
          wrapper.sendmsg({
            data: new Uint8Array([1]),
            controlMessages: [],
            flags: {}
          });
        },
        { message: /sendmsg syscall failed with errno 999/ }
      );
    });

    it("should throw when unsupported flags are provided", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(
        () => {
          wrapper.sendmsg({
            data: new Uint8Array([1]),
            controlMessages: [],
            flags: { something: "unexpected" } as unknown as Record<string, never>
          });
        },
        { message: /unsupported flags/ }
      );
    });

    it("should convert SCM_RIGHTS control messages", () => {
      let capturedControlMessages: unknown[] = [];

      const syscallInterface = createMockSyscallInterface({
        sendmsg: ({ controlMessages }) => {
          capturedControlMessages = controlMessages;
          return { errno: undefined, bytesSent: 1 };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const controlMessages: TControlMessage[] = [
        { level: "SOL_SOCKET", type: "SCM_RIGHTS", fd: 42 }
      ];

      wrapper.sendmsg({
        data: new Uint8Array([1]),
        controlMessages,
        flags: {}
      });

      assert.equal(capturedControlMessages.length, 1);
      const raw = capturedControlMessages[0] as { level: bigint, type: bigint, data: Uint8Array };
      assert.equal(raw.level, SOL_SOCKET);
      assert.equal(raw.type, SCM_RIGHTS);
      assert.deepEqual(raw.data, createScmRightsPayload({ fds: [42] }));
    });

    it("should throw on unsupported control message type", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(
        () => {
          wrapper.sendmsg({
            data: new Uint8Array([1]),
            controlMessages: [
              { level: "SOL_SOCKET", type: "UNKNOWN" } as unknown as TControlMessage
            ],
            flags: {}
          });
        },
        { message: /unsupported control message/ }
      );
    });
  });

  describe("recvmsg in open state", () => {

    it("should receive data and return it", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ dataBuffers }) => {
          // Simulate writing data into the buffer
          dataBuffers[0].set([10, 20, 30]);
          return { errno: undefined, controlMessages: [], bytesReceived: 3, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      assert.equal(result.data.length, 3);
      assert.deepEqual(Array.from(result.data), [10, 20, 30]);
      assert.deepEqual(result.controlMessages, []);
      assert.deepEqual(result.flags, { trunc: false, ctrunc: false });
    });

    [
      { msgFlags: MSG_TRUNC, expectedFlags: { trunc: true, ctrunc: false } },
      { msgFlags: MSG_CTRUNC, expectedFlags: { trunc: false, ctrunc: true } },
      { msgFlags: MSG_TRUNC | MSG_CTRUNC, expectedFlags: { trunc: true, ctrunc: true } }
    ].forEach(({ msgFlags, expectedFlags }) => {
      it(`should report msg_flags ${msgFlags} as ${JSON.stringify(expectedFlags)}`, () => {
        const syscallInterface = createMockSyscallInterface({
          recvmsg: () => {
            return { errno: undefined, controlMessages: [], bytesReceived: 1, msgFlags };
          }
        });

        const wrapper = createSocketWrapper({
          syscallInterface,
          socketFd: 5,
          connectError: undefined
        });

        const result = wrapper.recvmsg({
          count: 1024,
          maxControlMessageBytes: 256,
          flags: {}
        });

        assert.deepEqual(result.flags, expectedFlags);
      });
    });

    it("should return empty data on EAGAIN", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: () => {
          return { errno: EAGAIN, controlMessages: undefined, bytesReceived: undefined, msgFlags: undefined };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      assert.equal(result.data.length, 0);
      assert.deepEqual(result.controlMessages, []);
      assert.deepEqual(result.flags, { trunc: false, ctrunc: false });
    });

    it("should mark remote.writing as false when 0 bytes received", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: () => {
          return { errno: undefined, controlMessages: [], bytesReceived: 0, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      const status = wrapper.status();
      assert.equal(status.type, "open");
      if (status.type === "open") {
        assert.equal(status.remote.writing, false);
        assert.equal(status.remote.reading, true);
      }
    });

    it("should transition to remote-reset state when recvmsg reports ECONNRESET", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: () => {
          return { errno: ECONNRESET, controlMessages: undefined, bytesReceived: undefined, msgFlags: undefined };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      assert.equal(result.data.length, 0);
      assert.deepEqual(result.controlMessages, []);
      assert.deepEqual(result.flags, { trunc: false, ctrunc: false });
      assert.deepEqual(wrapper.status(), { type: "remote-reset" });
    });

    it("should throw on unexpected recvmsg errno", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: () => {
          return { errno: 999, controlMessages: undefined, bytesReceived: undefined, msgFlags: undefined };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(
        () => {
          wrapper.recvmsg({
            count: 1024,
            maxControlMessageBytes: 256,
            flags: {}
          });
        },
        { message: /recvmsg syscall failed with errno 999/ }
      );
    });

    it("should pass peek flag as MSG_PEEK, along with MSG_CMSG_CLOEXEC", () => {
      let capturedFlags = 0n;

      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ flags }) => {
          capturedFlags = flags;
          return { errno: undefined, controlMessages: [], bytesReceived: 0, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: { peek: true }
      });

      assert.equal(capturedFlags, MSG_PEEK | MSG_CMSG_CLOEXEC);
    });

    it("should only pass MSG_CMSG_CLOEXEC when peek is not set", () => {
      let capturedFlags = 99n;

      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ flags }) => {
          capturedFlags = flags;
          return { errno: undefined, controlMessages: [], bytesReceived: 0, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      assert.equal(capturedFlags, MSG_CMSG_CLOEXEC);
    });

    it("should parse SCM_RIGHTS control messages from recvmsg", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ controlMessageBuffer }) => {
          // Write a SCM_RIGHTS control message into the control message buffer
          const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });

          const fdPayload = createScmRightsPayload({ fds: [77] });

          const header = parsers.cmsghdr.format({
            value: {
              cmsg_len: BigInt(alignedHeaderSize + fdPayload.length),
              cmsg_level: SOL_SOCKET,
              cmsg_type: SCM_RIGHTS
            }
          });

          controlMessageBuffer.set(header, 0);
          controlMessageBuffer.set(fdPayload, alignedHeaderSize);

          return { errno: undefined, controlMessages: [], bytesReceived: 1, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      assert.equal(result.controlMessages.length, 1);
      assert.equal(result.controlMessages[0].level, "SOL_SOCKET");
      assert.equal(result.controlMessages[0].type, "SCM_RIGHTS");
      assert.equal(result.controlMessages[0].fd, 77);
    });

    it("should return every fd of a SCM_RIGHTS control message carrying multiple fds", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ controlMessageBuffer }) => {
          // the kernel merges all fds of a sendmsg call into a single SCM_RIGHTS message
          const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });

          const fdPayload = createScmRightsPayload({ fds: [77, 78, 79] });

          const header = parsers.cmsghdr.format({
            value: {
              cmsg_len: BigInt(alignedHeaderSize + fdPayload.length),
              cmsg_level: SOL_SOCKET,
              cmsg_type: SCM_RIGHTS
            }
          });

          controlMessageBuffer.set(header, 0);
          controlMessageBuffer.set(fdPayload, alignedHeaderSize);

          return { errno: undefined, controlMessages: [], bytesReceived: 1, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      assert.deepEqual(result.controlMessages, [
        { level: "SOL_SOCKET", type: "SCM_RIGHTS", fd: 77 },
        { level: "SOL_SOCKET", type: "SCM_RIGHTS", fd: 78 },
        { level: "SOL_SOCKET", type: "SCM_RIGHTS", fd: 79 }
      ]);
    });

    it("should return fds of multiple SCM_RIGHTS control messages in order", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ controlMessageBuffer }) => {
          const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });

          const writeControlMessage = ({ offset, fds }: { offset: number, fds: number[] }) => {
            const fdPayload = createScmRightsPayload({ fds });

            const header = parsers.cmsghdr.format({
              value: {
                cmsg_len: BigInt(alignedHeaderSize + fdPayload.length),
                cmsg_level: SOL_SOCKET,
                cmsg_type: SCM_RIGHTS
              }
            });

            controlMessageBuffer.set(header, offset);
            controlMessageBuffer.set(fdPayload, offset + alignedHeaderSize);

            return offset + alignedHeaderSize + CMSG_ALIGN({ length: fdPayload.length });
          };

          const nextOffset = writeControlMessage({ offset: 0, fds: [77, 78] });
          writeControlMessage({ offset: nextOffset, fds: [79] });

          return { errno: undefined, controlMessages: [], bytesReceived: 1, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      const receivedFds = result.controlMessages.map(({ fd }) => {
        return fd;
      });

      assert.deepEqual(receivedFds, [77, 78, 79]);
    });

    it("should throw on unsupported received control message", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ controlMessageBuffer }) => {
          const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });

          const header = parsers.cmsghdr.format({
            value: {
              cmsg_len: BigInt(alignedHeaderSize + 4),
              cmsg_level: 999n,
              cmsg_type: 888n
            }
          });

          controlMessageBuffer.set(header, 0);
          controlMessageBuffer.set(new Uint8Array([0, 0, 0, 0]), alignedHeaderSize);

          return { errno: undefined, controlMessages: [], bytesReceived: 1, msgFlags: 0n };
        }
      });

      const wrapper = createSocketWrapper({
        syscallInterface,
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(
        () => {
          wrapper.recvmsg({
            count: 1024,
            maxControlMessageBytes: 256,
            flags: {}
          });
        },
        { message: /unsupported control message received/ }
      );
    });
  });

  describe("remote-reset state", () => {

    const createRemoteResetWrapper = ({ close }: { close: TSyscallInterface["close"] }) => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          recvmsg: () => {
            return { errno: ECONNRESET, controlMessages: undefined, bytesReceived: undefined, msgFlags: undefined };
          },
          close
        }),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.recvmsg({ count: 1024, maxControlMessageBytes: 256, flags: {} });
      assert.equal(wrapper.status().type, "remote-reset");

      return wrapper;
    };

    [
      {
        operation: "dup",
        call: (wrapper: TUnixSocket) => {
          wrapper.dup();
        }
      },
      {
        operation: "sendmsg",
        call: (wrapper: TUnixSocket) => {
          wrapper.sendmsg({ data: new Uint8Array([1]), controlMessages: [], flags: {} });
        }
      },
      {
        operation: "recvmsg",
        call: (wrapper: TUnixSocket) => {
          wrapper.recvmsg({ count: 1024, maxControlMessageBytes: 256, flags: {} });
        }
      }
    ].forEach(({ operation, call }) => {
      it(`should throw invalid state on ${operation}`, () => {
        const wrapper = createRemoteResetWrapper({
          close: () => {
            return { errno: undefined };
          }
        });

        assert.throws(() => {
          call(wrapper);
        }, { message: /invalid state/ });

        assert.equal(wrapper.status().type, "remote-reset");
      });
    });

    it("should close the socket fd on close and transition to closed state", () => {
      const closedFds: number[] = [];

      const wrapper = createRemoteResetWrapper({
        close: ({ fd }) => {
          // eslint-disable-next-line fp/no-mutating-methods
          closedFds.push(fd);
          return { errno: undefined };
        }
      });

      wrapper.close();

      assert.deepEqual(closedFds, [5]);
      assert.equal(wrapper.status().type, "closed");
    });

    it("should throw on close syscall failure, but still transition to closed state", () => {
      const wrapper = createRemoteResetWrapper({
        close: () => {
          return { errno: 5 };
        }
      });

      assert.throws(() => {
        wrapper.close();
      }, { message: /close syscall failed with errno 5/ });

      assert.equal(wrapper.status().type, "closed");
    });
  });

  describe("closed state", () => {

    it("should report closed status after close", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.close();
      assert.equal(wrapper.status().type, "closed");
    });

    it("should throw on sendmsg after close", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.close();

      assert.throws(
        () => {
          wrapper.sendmsg({
            data: new Uint8Array([1]),
            controlMessages: [],
            flags: {}
          });
        },
        { message: /invalid state/ }
      );
    });

    it("should throw on recvmsg after close", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.close();

      assert.throws(
        () => {
          wrapper.recvmsg({
            count: 1024,
            maxControlMessageBytes: 256,
            flags: {}
          });
        },
        { message: /invalid state/ }
      );
    });

    it("should throw on close after close", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.close();

      assert.throws(
        () => {
          wrapper.close();
        },
        { message: /invalid state/ }
      );
    });

    it("should throw on dup after close", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: undefined
      });

      wrapper.close();

      assert.throws(
        () => {
          wrapper.dup();
        },
        { message: /invalid state/ }
      );
    });
  });
});
