import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createSyscallInterface } from "./syscalls.ts";
import { syscallNumbers } from "syscall-napi";
import type { TRawControlMessage } from "./abi.ts";

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

describe("syscalls", () => {

  describe("createSyscallInterface", () => {

    it("should return an object with expected methods", () => {
      const { syscall } = createMockSyscall();
      const iface = createSyscallInterface({ syscall });

      assert.equal(typeof iface.socket, "function");
      assert.equal(typeof iface.connect, "function");
      assert.equal(typeof iface.fcntl, "function");
      assert.equal(typeof iface.recvmsg, "function");
      assert.equal(typeof iface.sendmsg, "function");
      assert.equal(typeof iface.getsockopt, "function");
      assert.equal(typeof iface.socketpair, "function");
      assert.equal(typeof iface.dup, "function");
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

  describe("dup", () => {

    it("should call syscall with dup number and return fd", () => {
      const { syscall, calls, setNextResult } = createMockSyscall();
      setNextResult({ ret: 7n });
      const iface = createSyscallInterface({ syscall });

      const result = iface.dup({
        fd: 3
      });

      assert.equal(result.errno, undefined);
      assert.equal(result.fd, 7);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].syscallNumber, syscallNumbers.dup);
      assert.deepEqual(calls[0].args, [3n]);
    });

    it("should return errno when dup fails", () => {
      const { syscall, setNextResult } = createMockSyscall();
      setNextResult({ errno: 9 });
      const iface = createSyscallInterface({ syscall });

      const result = iface.dup({
        fd: 3
      });

      assert.equal(result.errno, 9);
      assert.equal(result.fd, undefined);
    });
  });
});
