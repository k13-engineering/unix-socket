// eslint-disable-next-line k13-engineering/no-import-alias
import { syscall as kernelSyscall, syscallNumbers } from "syscall-napi";
import { createControlMessageListAsBuffer, parsers, type TRawControlMessage } from "./abi.ts";
import { pinBuffer } from "buffer2address";

const createSyscallInterface = ({
  syscall
}: {
  syscall: typeof kernelSyscall
}) => {

  const socket = ({ domain, type, protocol }: { domain: bigint, type: bigint, protocol: bigint }) => {
    const { errno, ret } = syscall({
      syscallNumber: syscallNumbers.socket,
      args: [
        domain,
        type,
        protocol
      ]
    });

    if (errno !== undefined) {
      return {
        errno,
        socketFd: undefined
      };
    }

    return {
      errno: undefined,
      socketFd: Number(ret)
    };
  };

  const connect = ({ socketFd, socketAddressAsBuffer }: { socketFd: number, socketAddressAsBuffer: Uint8Array }) => {
    const { errno } = syscall({
      syscallNumber: syscallNumbers.connect,
      args: [
        BigInt(socketFd),
        socketAddressAsBuffer,
        BigInt(socketAddressAsBuffer.length)
      ]
    });

    if (errno !== undefined) {
      return {
        errno
      };
    }

    return {
      errno: undefined
    };
  };

  const fcntl = ({ fd, cmd, arg }: { fd: number, cmd: bigint, arg: bigint }) => {
    const { errno, ret } = syscall({
      syscallNumber: syscallNumbers.fcntl,
      args: [
        BigInt(fd),
        cmd,
        arg
      ]
    });

    if (errno !== undefined) {
      return {
        errno,
        ret: undefined
      };
    }

    return {
      errno: undefined,
      ret
    };
  };

  const createAndPinIovecArray = ({ buffers }: { buffers: Uint8Array[] }) => {
    const iovec = new Uint8Array(buffers.length * parsers.iovec.size);
    const pinnedBuffers = buffers.map((buffer, index) => {

      const pinnedBuffer = pinBuffer({ buffer });

      const entry = parsers.iovec.format({
        value: {
          iov_base: pinnedBuffer.address,
          iov_len: BigInt(buffer.length)
        }
      });

      iovec.set(entry, index * parsers.iovec.size);

      return pinnedBuffer;
    });

    const pinnedIovec = pinBuffer({ buffer: iovec });

    const unpin = () => {
      pinnedBuffers.forEach((pinnedBuffer) => {
        pinnedBuffer.unpin();
      });
      pinnedIovec.unpin();
    };

    return {
      address: pinnedIovec.address,
      unpin
    };
  };

  const createAndPinControlMessageList = ({ controlMessages }: { controlMessages: TRawControlMessage[] }) => {

    const controlMessageListAsBuffer = createControlMessageListAsBuffer({ controlMessages });
    const pinnedControlMessageBuffer = pinBuffer({ buffer: controlMessageListAsBuffer });

    const unpin = () => {
      pinnedControlMessageBuffer.unpin();
    };

    return {
      address: pinnedControlMessageBuffer.address,
      length: controlMessageListAsBuffer.length,
      unpin
    };
  };

  const recvmsg = ({
    socketFd,
    dataBuffers,
    controlMessageBuffer,
    flags
  }: {
    socketFd: number,
    dataBuffers: Uint8Array[],
    controlMessageBuffer: Uint8Array,
    flags: bigint
  }) => {

    const pinnedIovec = createAndPinIovecArray({ buffers: dataBuffers });
    const pinnedControlMessageBuffer = pinBuffer({ buffer: controlMessageBuffer });

    const msghdr = parsers.msghdr.format({
      value: {
        msg_name: 0n,
        msg_namelen: 0n,
        msg_iov: pinnedIovec.address,
        msg_iovlen: BigInt(dataBuffers.length),
        msg_control: pinnedControlMessageBuffer.address,
        msg_controllen: BigInt(controlMessageBuffer.length),
        msg_flags: 0n
      }
    });

    const { errno, ret } = syscall({
      syscallNumber: syscallNumbers.recvmsg,
      args: [
        BigInt(socketFd),
        msghdr,
        flags
      ]
    });

    pinnedControlMessageBuffer.unpin();
    pinnedIovec.unpin();

    if (errno !== undefined) {
      return {
        errno,
        controlMessages: undefined,
        bytesReceived: undefined
      };
    }

    return {
      errno: undefined,
      controlMessages: [] as TRawControlMessage[],
      bytesReceived: Number(ret)
    };
  };

  const sendmsg = ({
    socketFd,
    dataBuffers,
    controlMessages,
    flags
  }: {
    socketFd: number,
    dataBuffers: Uint8Array[],
    controlMessages: TRawControlMessage[],
    flags: bigint
  }) => {
    const pinnedIovec = createAndPinIovecArray({ buffers: dataBuffers });
    const pinnedControlMessageBuffer = createAndPinControlMessageList({ controlMessages });

    const msghdr = parsers.msghdr.format({
      value: {
        msg_name: 0n,
        msg_namelen: 0n,
        msg_iov: pinnedIovec.address,
        msg_iovlen: BigInt(dataBuffers.length),
        msg_control: pinnedControlMessageBuffer.address,
        msg_controllen: BigInt(pinnedControlMessageBuffer.length),
        msg_flags: 0n
      }
    });

    const { errno, ret } = syscall({
      syscallNumber: syscallNumbers.sendmsg,
      args: [
        BigInt(socketFd),
        msghdr,
        flags
      ]
    });

    pinnedControlMessageBuffer.unpin();
    pinnedIovec.unpin();

    if (errno !== undefined) {
      return {
        errno,
        bytesSent: undefined
      };
    }

    return {
      errno: undefined,
      bytesSent: Number(ret)
    };
  };

  const getsockopt = ({ socketFd, level, optionName, length }: { socketFd: number, level: bigint, optionName: bigint, length: number }) => {

    const buffer = new Uint8Array(length);
    const lengthBuffer = parsers.sockopt_length.format({
      value: {
        length: BigInt(length)
      }
    });

    const { errno } = syscall({
      syscallNumber: syscallNumbers.getsockopt,
      args: [
        BigInt(socketFd),
        level,
        optionName,
        buffer,
        lengthBuffer
      ]
    });

    if (errno !== undefined) {
      return {
        errno,
        value: undefined
      };
    }

    const actualLength = parsers.sockopt_length.parse({
      data: lengthBuffer,
    });

    const value = buffer.subarray(0, Number(actualLength));

    return {
      errno: undefined,
      value
    };
  };

  const socketpair = ({ domain, type, protocol }: { domain: bigint, type: bigint, protocol: bigint }) => {
    const sv = new Uint8Array(parsers.socketpair_sv.size);
    const pinnedSv = pinBuffer({ buffer: sv });

    const { errno } = syscall({
      syscallNumber: syscallNumbers.socketpair,
      args: [
        domain,
        type,
        protocol,
        pinnedSv.address
      ]
    });

    if (errno !== undefined) {
      pinnedSv.unpin();
      return {
        errno,
        fd1: undefined,
        fd2: undefined
      };
    }

    const parsed = parsers.socketpair_sv.parse({
      data: sv
    });

    pinnedSv.unpin();

    return {
      errno: undefined,
      fd1: Number(parsed.fd1),
      fd2: Number(parsed.fd2)
    };
  };

  const dup = ({ fd }: { fd: number }) => {
    const { errno, ret } = syscall({
      syscallNumber: syscallNumbers.dup,
      args: [
        BigInt(fd)
      ]
    });

    if (errno !== undefined) {
      return {
        errno,
        fd: undefined
      };
    }

    return {
      errno: undefined,
      fd: Number(ret)
    };
  };

  return {
    socket,
    connect,
    fcntl,
    recvmsg,
    sendmsg,
    getsockopt,
    socketpair,
    dup
  };
};

type TSyscallInterface = ReturnType<typeof createSyscallInterface>;

export {
  createSyscallInterface
};

export type {
  TSyscallInterface
};
