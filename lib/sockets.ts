import { createUnixSocketAddressAsBuffer } from "./abi.ts";
import {
  AF_UNIX,
  ENOENT,
  F_SETFL,
  O_NONBLOCK,
  SOCK_STREAM
} from "./constants.ts";
import { createSocketWrapper, type TUnixSocket } from "./socket-wrapper.ts";
import type { TSyscallInterface } from "./syscalls.ts";

type TStreamSocketPairResult = {
  errno: undefined;
  socket1: TUnixSocket;
  socket2: TUnixSocket;
} | {
  errno: number;
  socket1: undefined;
  socket2: undefined;
};

const createSocketsFactory = ({
  syscallInterface
}: {
  syscallInterface: TSyscallInterface;
}) => {

  const createUnixSocketFd = () => {
    const { errno: socketErrno, socketFd } = syscallInterface.socket({
      domain: AF_UNIX,
      type: SOCK_STREAM,
      protocol: BigInt(0)
    });

    if (socketErrno !== undefined) {
      throw Error(`socket syscall failed with errno ${socketErrno}`);
    }

    const { errno: fcntlErrno } = syscallInterface.fcntl({
      fd: socketFd,
      cmd: F_SETFL,
      arg: O_NONBLOCK
    });

    if (fcntlErrno !== undefined) {
      throw Error(`fcntl syscall failed with errno ${fcntlErrno}`);
    }

    return socketFd;
  };

  const createUnixStreamSocketClient = ({ socketPath }: { socketPath: string }) => {
    const socketFd = createUnixSocketFd();

    const socketAddressAsBuffer = createUnixSocketAddressAsBuffer({ socketPath });

    console.log({ socketFd });

    const { errno } = syscallInterface.connect({
      socketFd,
      socketAddressAsBuffer
    });

    let connectError: Error | undefined = undefined;

    if (errno !== undefined) {

      if (errno === ENOENT) {
        connectError = Error(`No such file or directory: ${socketPath}`);
      } else {
        throw Error(`connect syscall failed with errno ${errno}`);
      }
    }

    return createSocketWrapper({
      syscallInterface,
      socketFd,
      connectError
    });
  };

  const streamSocketPair = (): TStreamSocketPairResult => {
    const { errno, fd1, fd2 } = syscallInterface.socketpair({
      domain: AF_UNIX,
      type: SOCK_STREAM,
      protocol: BigInt(0)
    });

    if (errno !== undefined) {
      return {
        errno,
        socket1: undefined,
        socket2: undefined
      };
    }

    const socket1 = createSocketWrapper({
      syscallInterface,
      socketFd: fd1,
      connectError: undefined
    });

    const socket2 = createSocketWrapper({
      syscallInterface,
      socketFd: fd2,
      connectError: undefined
    });

    return {
      errno: undefined,
      socket1,
      socket2
    };
  };

  return {
    createUnixStreamSocketClient,
    streamSocketPair
  };
};

export {
  createSocketsFactory
};

export type {
  TStreamSocketPairResult
};
