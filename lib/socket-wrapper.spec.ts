import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createSocketWrapper, type TControlMessage } from "./socket-wrapper.ts";
import type { TSyscallInterface } from "./syscalls.ts";
import { EAGAIN, EPIPE, SOL_SOCKET, SCM_RIGHTS } from "./constants.ts";
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

describe("socket-wrapper", () => {

  describe("createSocketWrapper with connectError", () => {

    it("should report connect-error status", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: Error("connection refused")
      });

      const status = wrapper.status();
      assert.equal(status.type, "connect-error");
      if (status.type === "connect-error") {
        assert.equal(status.error.message, "connection refused");
      }
    });

    it("should return empty data on recvmsg in connect-error state", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: Error("connection refused")
      });

      const result = wrapper.recvmsg({
        count: 1024,
        maxControlMessageBytes: 256,
        flags: {}
      });

      assert.equal(result.data.length, 0);
      assert.deepEqual(result.controlMessages, []);
    });

    it("should return 0 bytes sent on sendmsg in connect-error state", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: Error("connection refused")
      });

      const result = wrapper.sendmsg({
        data: new Uint8Array([1, 2, 3]),
        controlMessages: [],
        flags: {}
      });

      assert.equal(result.bytesSent, 0);
    });

    it("should transition to closed state on close", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface(),
        socketFd: 5,
        connectError: Error("connection refused")
      });

      wrapper.close();

      const status = wrapper.status();
      assert.equal(status.type, "closed");
    });

    it("should dup in connect-error state", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          dup: () => {
            return { errno: undefined, fd: 42 };
          }
        }),
        socketFd: 5,
        connectError: Error("connection refused")
      });

      const result = wrapper.dup();
      assert.equal(result.socketFd, 42);
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

    it("should dup in open state", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          dup: () => {
            return { errno: undefined, fd: 99 };
          }
        }),
        socketFd: 5,
        connectError: undefined
      });

      const result = wrapper.dup();
      assert.equal(result.socketFd, 99);
    });

    it("should throw on dup syscall failure in open state", () => {
      const wrapper = createSocketWrapper({
        syscallInterface: createMockSyscallInterface({
          dup: () => {
            return { errno: 9, fd: undefined };
          }
        }),
        socketFd: 5,
        connectError: undefined
      });

      assert.throws(
        () => {
          wrapper.dup();
        },
        { message: /dup syscall failed with errno 9/ }
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
          return { errno: undefined, controlMessages: [], bytesReceived: 3 };
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
    });

    it("should return empty data on EAGAIN", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: () => {
          return { errno: EAGAIN, controlMessages: undefined, bytesReceived: undefined };
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
    });

    it("should mark remote.writing as false when 0 bytes received", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: () => {
          return { errno: undefined, controlMessages: [], bytesReceived: 0 };
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

    it("should throw on unexpected recvmsg errno", () => {
      const syscallInterface = createMockSyscallInterface({
        recvmsg: () => {
          return { errno: 999, controlMessages: undefined, bytesReceived: undefined };
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

    it("should pass peek flag as MSG_PEEK", () => {
      let capturedFlags = 0n;

      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ flags }) => {
          capturedFlags = flags;
          return { errno: undefined, controlMessages: [], bytesReceived: 0 };
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

      // MSG_PEEK
      assert.equal(capturedFlags, 0x02n);
    });

    it("should not set MSG_PEEK when peek is not set", () => {
      let capturedFlags = 99n;

      const syscallInterface = createMockSyscallInterface({
        recvmsg: ({ flags }) => {
          capturedFlags = flags;
          return { errno: undefined, controlMessages: [], bytesReceived: 0 };
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

      assert.equal(capturedFlags, 0n);
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

          return { errno: undefined, controlMessages: [], bytesReceived: 1 };
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

          return { errno: undefined, controlMessages: [], bytesReceived: 1 };
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

          return { errno: undefined, controlMessages: [], bytesReceived: 1 };
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

          return { errno: undefined, controlMessages: [], bytesReceived: 1 };
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
