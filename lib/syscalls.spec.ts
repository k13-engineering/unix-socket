import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createSyscallInterface } from "./syscalls.ts";
import { syscallNumbers } from "syscall-napi";
import {
  createControlMessageListAsBuffer,
  createScmRightsPayload,
  parsers,
  type TRawControlMessage
} from "./abi.ts";
import {
  MSG_CTRUNC,
  MSG_TRUNC,
  SCM_RIGHTS,
  SOL_SOCKET
} from "./constants.ts";
import { address2buffer } from "buffer2address";

type TSyscallArgs = {
  syscallNumber: bigint,
  args: unknown[]
};

const createMockSyscall = () => {
  const calls: TSyscallArgs[] = [];
  let nextResult: { errno?: number, ret?: bigint } = { ret: 0n };

  const syscall = ({ syscallNumber, args }: TSyscallArgs) => {
    // eslint-disable-next-line fp/no-mutating-methods
    calls.push({ syscallNumber, args });

    if (nextResult.errno !== undefined) {
      return { errno: nextResult.errno, ret: undefined };
    }

    return { errno: undefined, ret: nextResult.ret ?? 0n };
  };

  const setNextResult = (result: { errno?: number, ret?: bigint }) => {
    nextResult = result;
  };

  return { syscall, calls, setNextResult };
};

// follows the pointers of a msghdr like the kernel does, returning the memory each iovec describes
const memoryOfIovecs = ({ msghdr }: { msghdr: ReturnType<typeof parsers.msghdr.parse> }) => {
  const iovecCount = Number(msghdr.msg_iovlen);
  const iovecs = address2buffer({ address: msghdr.msg_iov, size: iovecCount * parsers.iovec.size });

  return [...Array(iovecCount).keys()].map((index) => {
    const iovec = parsers.iovec.parse({ data: iovecs.subarray(index * parsers.iovec.size) });
    return address2buffer({ address: iovec.iov_base, size: Number(iovec.iov_len) });
  });
};

describe("syscalls", () => {

  describe("createSyscallInterface", () => {

    it("should return an object with expected methods", () => {
      const { syscall } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      assert.equal(typeof iface.socket, "function");
      assert.equal(typeof iface.connect, "function");
      assert.equal(typeof iface.bind, "function");
      assert.equal(typeof iface.listen, "function");
      assert.equal(typeof iface.accept, "function");
      assert.equal(typeof iface.unlink, "function");
      assert.equal(typeof iface.close, "function");
      assert.equal(typeof iface.fcntl, "function");
      assert.equal(typeof iface.recvmsg, "function");
      assert.equal(typeof iface.sendmsg, "function");
      assert.equal(typeof iface.getsockopt, "function");
      assert.equal(typeof iface.socketpair, "function");
    });
  });

  describe("socket", () => {

    it("should call syscall with socket number and return socketFd", () => {
      const { syscall, calls, setNextResult } = createMockSyscall();
      setNextResult({ ret: 5n });
      const iface = createSyscallInterface({ syscall });

      const result = iface.socket({
        domain: 1n,
        type: 2n,
        protocol: 3n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.socketFd, 5);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.socket);
      assert.deepEqual(calls[0].args, [1n, 2n, 3n]);
    });

    it("should return errno when syscall fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 13 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.socket({
        domain: 1n,
        type: 1n,
        protocol: 0n
      });

      assert.equal(result.errno, 13);
      assert.equal(result.socketFd, undefined);
    });
  });

  describe("connect", () => {

    it("should call syscall with connect number and return success", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      const socketAddressAsBuffer = new Uint8Array(16);
      const result = iface.connect({
        socketFd: 3,
        socketAddressAsBuffer
      });

      assert.equal(result.errno, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.connect);
      assert.equal(calls[0].args[0], 3n);
      assert.equal(calls[0].args[1], socketAddressAsBuffer);
      assert.equal(calls[0].args[2], BigInt(socketAddressAsBuffer.length));
    });

    it("should return errno when connect fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 111 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.connect({
        socketFd: 3,
        socketAddressAsBuffer: new Uint8Array(16)
      });

      assert.equal(result.errno, 111);
    });
  });

  describe("bind", () => {

    it("should call syscall with bind number and return success", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      const socketAddressAsBuffer = new Uint8Array(16);
      const result = iface.bind({
        socketFd: 3,
        socketAddressAsBuffer
      });

      assert.equal(result.errno, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.bind);
      assert.equal(calls[0].args[0], 3n);
      assert.equal(calls[0].args[1], socketAddressAsBuffer);
      assert.equal(calls[0].args[2], BigInt(socketAddressAsBuffer.length));
    });

    it("should return errno when bind fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 98 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.bind({
        socketFd: 3,
        socketAddressAsBuffer: new Uint8Array(16)
      });

      assert.equal(result.errno, 98);
    });
  });

  describe("listen", () => {

    it("should call syscall with listen number and return success", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      const result = iface.listen({
        socketFd: 3,
        backlog: 128
      });

      assert.equal(result.errno, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.listen);
      assert.deepEqual(calls[0].args, [3n, 128n]);
    });

    it("should return errno when listen fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 95 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.listen({
        socketFd: 3,
        backlog: 128
      });

      assert.equal(result.errno, 95);
    });
  });

  describe("accept", () => {

    it("should call syscall with accept4 number and flags and return socketFd", () => {
      const { syscall, calls, setNextResult } = createMockSyscall();
      setNextResult({ ret: 8n });
      const iface = createSyscallInterface({ syscall });

      const result = iface.accept({
        socketFd: 3,
        flags: 2048n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.socketFd, 8);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.accept4);
      assert.deepEqual(calls[0].args, [3n, 0n, 0n, 2048n]);
    });

    it("should return errno when accept fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 11 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.accept({
        socketFd: 3,
        flags: 0n
      });

      assert.equal(result.errno, 11);
      assert.equal(result.socketFd, undefined);
    });
  });

  describe("unlink", () => {

    it("should call syscall with unlinkat number and return success", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      const result = iface.unlink({
        path: "/tmp/test.sock"
      });

      assert.equal(result.errno, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.unlinkat);
      assert.equal(calls[0].args[0], BigInt(-100));
      assert.deepEqual(calls[0].args[1], new TextEncoder().encode("/tmp/test.sock\0"));
      assert.equal(calls[0].args[2], 0n);
    });

    it("should return errno when unlink fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 2 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.unlink({
        path: "/tmp/test.sock"
      });

      assert.equal(result.errno, 2);
    });
  });

  describe("fcntl", () => {

    it("should call syscall with fcntl number and return result", () => {
      const { syscall, calls, setNextResult } = createMockSyscall();
      setNextResult({ ret: 42n });
      const iface = createSyscallInterface({ syscall });

      const result = iface.fcntl({
        fd: 5,
        cmd: 4n,
        arg: 2048n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.ret, 42n);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.fcntl);
      assert.deepEqual(calls[0].args, [5n, 4n, 2048n]);
    });

    it("should return errno when fcntl fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 9 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.fcntl({
        fd: 5,
        cmd: 4n,
        arg: 2048n
      });

      assert.equal(result.errno, 9);
      assert.equal(result.ret, undefined);
    });
  });

  describe("recvmsg", () => {

    it("should call syscall with recvmsg number and return bytes received", () => {
      const { syscall, calls, setNextResult } = createMockSyscall();
      setNextResult({ ret: 10n });
      const iface = createSyscallInterface({ syscall });

      const dataBuffer = new Uint8Array(64);
      const controlMessageBuffer = new Uint8Array(128);

      const result = iface.recvmsg({
        socketFd: 7,
        dataBuffers: [dataBuffer],
        controlMessageBuffer,
        flags: 0n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.bytesReceived, 10);
      assert.equal(result.msgFlags, 0n);
      assert.ok(Array.isArray(result.controlMessages));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.recvmsg);
      assert.equal(calls[0].args[0], 7n);
      assert.equal(calls[0].args[2], 0n);
    });

    it("should return errno when recvmsg fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 11 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.recvmsg({
        socketFd: 7,
        dataBuffers: [new Uint8Array(64)],
        controlMessageBuffer: new Uint8Array(128),
        flags: 0n
      });

      assert.equal(result.errno, 11);
      assert.equal(result.controlMessages, undefined);
      assert.equal(result.bytesReceived, undefined);
      assert.equal(result.msgFlags, undefined);
    });

    it("should return the msg_flags written back by the kernel", () => {
      const syscall = ({ args }: TSyscallArgs) => {
        // the kernel reports flags by writing msg_flags into the passed msghdr
        const msghdr = args[1] as Uint8Array;
        const value = parsers.msghdr.parse({ data: msghdr });
        msghdr.set(parsers.msghdr.format({ value: { ...value, msg_flags: MSG_TRUNC | MSG_CTRUNC } }));

        return { errno: undefined, ret: 4n };
      };

      const iface = createSyscallInterface({ syscall });

      const result = iface.recvmsg({
        socketFd: 7,
        dataBuffers: [new Uint8Array(4)],
        controlMessageBuffer: new Uint8Array(0),
        flags: 0n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.msgFlags, MSG_TRUNC | MSG_CTRUNC);
    });

    it("should handle multiple data buffers", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ ret: 20n });
      const iface = createSyscallInterface({ syscall });

      const result = iface.recvmsg({
        socketFd: 3,
        dataBuffers: [new Uint8Array(32), new Uint8Array(32)],
        controlMessageBuffer: new Uint8Array(64),
        flags: 0n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.bytesReceived, 20);
    });
  });

  describe("sendmsg", () => {

    it("should call syscall with sendmsg number and return bytes sent", () => {
      const { syscall, calls, setNextResult } = createMockSyscall();
      setNextResult({ ret: 5n });
      const iface = createSyscallInterface({ syscall });

      const dataBuffer = new Uint8Array([1, 2, 3, 4, 5]);
      const controlMessages: TRawControlMessage[] = [];

      const result = iface.sendmsg({
        socketFd: 4,
        dataBuffers: [dataBuffer],
        controlMessages,
        flags: 0n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.bytesSent, 5);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.sendmsg);
      assert.equal(calls[0].args[0], 4n);
      assert.equal(calls[0].args[2], 0n);
    });

    it("should return errno when sendmsg fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 32 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.sendmsg({
        socketFd: 4,
        dataBuffers: [new Uint8Array(5)],
        controlMessages: [],
        flags: 0n
      });

      assert.equal(result.errno, 32);
      assert.equal(result.bytesSent, undefined);
    });

    it("should handle control messages", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ ret: 3n });
      const iface = createSyscallInterface({ syscall });

      const controlMessages: TRawControlMessage[] = [
        {
          level: 1n,
          type: 1n,
          data: new Uint8Array([0, 0, 0, 5])
        }
      ];

      const result = iface.sendmsg({
        socketFd: 4,
        dataBuffers: [new Uint8Array(3)],
        controlMessages,
        flags: 0n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.bytesSent, 3);
    });

    it("should handle multiple data buffers", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ ret: 10n });
      const iface = createSyscallInterface({ syscall });

      const result = iface.sendmsg({
        socketFd: 4,
        dataBuffers: [new Uint8Array(5), new Uint8Array(5)],
        controlMessages: [],
        flags: 0n
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.bytesSent, 10);
    });
  });

  describe("getsockopt", () => {

    it("should call syscall with getsockopt number and return value", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      const result = iface.getsockopt({
        socketFd: 3,
        level: 1n,
        optionName: 4n,
        length: 8
      });

      assert.equal(result.errno, undefined);
      assert.ok(result.value instanceof Uint8Array);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.getsockopt);
      assert.equal(calls[0].args[0], 3n);
      assert.equal(calls[0].args[1], 1n);
      assert.equal(calls[0].args[2], 4n);
    });

    it("should return errno when getsockopt fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 22 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.getsockopt({
        socketFd: 3,
        level: 1n,
        optionName: 4n,
        length: 8
      });

      assert.equal(result.errno, 22);
      assert.equal(result.value, undefined);
    });

    it("should pass the length to the kernel as a 4 byte socklen_t", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      iface.getsockopt({
        socketFd: 3,
        level: 1n,
        optionName: 4n,
        length: 16
      });

      // the kernel reads and writes exactly sizeof(socklen_t) bytes there
      assert.deepEqual(calls[0].args[4], new Uint8Array([16, 0, 0, 0]));
    });

    it("should return the value cut to the length written back by the kernel", () => {
      const syscall = ({ args }: TSyscallArgs) => {
        const valueBuffer = args[3] as Uint8Array;
        const lengthBuffer = args[4] as Uint8Array;

        // like the kernel does for an int option such as SO_ERROR
        valueBuffer.set([111, 0, 0, 0]);
        lengthBuffer.set(parsers.sockopt_length.format({ value: { length: 4n } }));

        return { errno: undefined, ret: 0n };
      };

      const iface = createSyscallInterface({ syscall });

      const result = iface.getsockopt({
        socketFd: 3,
        level: 1n,
        optionName: 4n,
        length: 16
      });

      assert.deepEqual(result.value, new Uint8Array([111, 0, 0, 0]));
    });
  });

  describe("memory handed to the kernel", () => {

    it("should describe exactly the receive buffers in the msghdr of recvmsg", () => {
      const dataBuffers = [new Uint8Array(3), new Uint8Array(5)];
      const controlMessageBuffer = new Uint8Array(24);
      let msghdrSize = 0;

      const syscall = ({ args }: TSyscallArgs) => {
        const msghdrBuffer = args[1] as Uint8Array;
        msghdrSize = msghdrBuffer.length;
        const msghdr = parsers.msghdr.parse({ data: msghdrBuffer });

        // write through the pointers and lengths like the kernel does
        memoryOfIovecs({ msghdr }).forEach((memory, index) => {
          memory.fill(index + 1);
        });
        address2buffer({ address: msghdr.msg_control, size: Number(msghdr.msg_controllen) }).fill(9);

        return { errno: undefined, ret: 8n };
      };

      const iface = createSyscallInterface({ syscall });
      iface.recvmsg({ socketFd: 3, dataBuffers, controlMessageBuffer, flags: 0n });

      // the kernel always copies sizeof(struct msghdr) bytes
      assert.equal(msghdrSize, parsers.msghdr.size);
      assert.deepEqual(dataBuffers, [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2, 2, 2, 2])]);
      assert.deepEqual(controlMessageBuffer, new Uint8Array(24).fill(9));
    });

    it("should describe exactly the send buffers in the msghdr of sendmsg", () => {
      const controlMessages: TRawControlMessage[] = [
        { level: SOL_SOCKET, type: SCM_RIGHTS, data: createScmRightsPayload({ fds: [7] }) }
      ];
      let sent: { msghdrSize: number, data: number[][], control: number[] } | undefined;

      const syscall = ({ args }: TSyscallArgs) => {
        const msghdrBuffer = args[1] as Uint8Array;
        const msghdr = parsers.msghdr.parse({ data: msghdrBuffer });

        // read through the pointers and lengths like the kernel does
        sent = {
          msghdrSize: msghdrBuffer.length,
          data: memoryOfIovecs({ msghdr }).map((memory) => {
            return Array.from(memory);
          }),
          control: Array.from(address2buffer({ address: msghdr.msg_control, size: Number(msghdr.msg_controllen) }))
        };

        return { errno: undefined, ret: 5n };
      };

      const iface = createSyscallInterface({ syscall });
      iface.sendmsg({
        socketFd: 3,
        dataBuffers: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
        controlMessages,
        flags: 0n
      });

      assert.deepEqual(sent, {
        msghdrSize: parsers.msghdr.size,
        data: [[1, 2, 3], [4, 5]],
        control: Array.from(createControlMessageListAsBuffer({ controlMessages }))
      });
    });

    it("should read both fds from the int[2] socketpair writes", () => {
      const syscall = ({ args }: TSyscallArgs) => {
        // the kernel writes two ints to the address passed as last argument
        const sv = address2buffer({ address: args[3] as bigint, size: parsers.socketpair_sv.size });
        sv.set(parsers.socketpair_sv.format({ value: { fd1: 21n, fd2: 22n } }));

        return { errno: undefined, ret: 0n };
      };

      const iface = createSyscallInterface({ syscall });
      const result = iface.socketpair({ domain: 1n, type: 1n, protocol: 0n });

      assert.deepEqual(result, { errno: undefined, fd1: 21, fd2: 22 });
    });
  });

  describe("socketpair", () => {

    it("should call syscall with socketpair number and return two fds", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      const result = iface.socketpair({
        domain: 1n,
        type: 1n,
        protocol: 0n
      });

      assert.equal(result.errno, undefined);
      assert.equal(typeof result.fd1, "number");
      assert.equal(typeof result.fd2, "number");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.socketpair);
      assert.deepEqual(calls[0].args[0], 1n);
      assert.deepEqual(calls[0].args[1], 1n);
      assert.deepEqual(calls[0].args[2], 0n);
    });

    it("should return errno when socketpair fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 24 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.socketpair({
        domain: 1n,
        type: 1n,
        protocol: 0n
      });

      assert.equal(result.errno, 24);
      assert.equal(result.fd1, undefined);
      assert.equal(result.fd2, undefined);
    });
  });

  describe("close", () => {

    it("should call syscall with close number and return success", () => {
      const { syscall, calls } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      const result = iface.close({
        fd: 5
      });

      assert.equal(result.errno, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.close);
      assert.deepEqual(calls[0].args, [5n]);
    });

    it("should return errno when close fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 9 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.close({
        fd: 5
      });

      assert.equal(result.errno, 9);
    });
  });
});
