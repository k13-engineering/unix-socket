import { createUnixSocketAddressAsBuffer } from "./abi.ts";
import {
  AF_UNIX,
  EACCES,
  EAGAIN,
  ECONNREFUSED,
  ELOOP,
  ENOENT,
  ENOTDIR,
  EPERM,
  EPROTOTYPE,
  F_GETFL,
  F_SETFL,
  O_NONBLOCK,
  SOCK_NONBLOCK,
  SOCK_STREAM
} from "./constants.ts";
import {
  createUnixStreamSocketServerWrapper,
  type TUnixStreamSocketServer
} from "./server-wrapper.ts";
import { createSocketWrapper, type TConnectError, type TUnixSocket } from "./socket-wrapper.ts";
import type { TSyscallInterface } from "./syscalls.ts";

// failures of connect that depend on what is (or isn't) at the socket path rather than on a bug,
// a client has to expect them, so they are reported via the connect-error state instead of an exception
const routineConnectErrors = [
  { errno: ENOENT, description: "No such file or directory" },
  { errno: ENOTDIR, description: "Not a directory" },
  { errno: ELOOP, description: "Too many levels of symbolic links" },
  { errno: EACCES, description: "Permission denied" },
  { errno: EPERM, description: "Operation not permitted" },
  { errno: ECONNREFUSED, description: "Connection refused" },
  { errno: EAGAIN, description: "Listen backlog of the server is full" },
  { errno: EPROTOTYPE, description: "Protocol wrong type for socket" }
];

type TStreamSocketPairResult = {
  errno: undefined;
  socket1: TUnixSocket;
  socket2: TUnixSocket;
} | {
  errno: number;
  socket1: undefined;
  socket2: undefined;
};

type TCreateUnixStreamSocketServerResult = {
  error: Error;
  server: undefined;
} | {
  error: undefined;
  server: TUnixStreamSocketServer;
};

const createSocketsFactory = ({
  syscallInterface
}: {
  syscallInterface: TSyscallInterface;
}) => {

  const createUnixSocketFd = () => {
    const { errno: socketErrno, socketFd } = syscallInterface.socket({
      domain: AF_UNIX,
      type: SOCK_STREAM | SOCK_NONBLOCK,
      protocol: BigInt(0)
    });

    if (socketErrno !== undefined) {
      throw Error(`socket syscall failed with errno ${socketErrno}`);
    }

    return socketFd;
  };

  const createUnixStreamSocketClient = ({ socketPath }: { socketPath: string }) => {
    const socketFd = createUnixSocketFd();
    const socketAddressAsBuffer = createUnixSocketAddressAsBuffer({ socketPath });

    const { errno } = syscallInterface.connect({
      socketFd,
      socketAddressAsBuffer
    });

    let connectError: TConnectError | undefined = undefined;

    if (errno !== undefined) {

      const { errno: closeErrno } = syscallInterface.close({
        fd: socketFd
      });

      if (closeErrno !== undefined) {
        throw Error(`close syscall failed with errno ${closeErrno}`);
      }

      const routineConnectError = routineConnectErrors.find((candidate) => {
        return candidate.errno === errno;
      });

      if (routineConnectError === undefined) {
        throw Error(`connect syscall failed with errno ${errno}`);
      }

      connectError = {
        errno,
        error: Error(`${routineConnectError.description}: ${socketPath}`)
      };
    }

    return createSocketWrapper({
      syscallInterface,
      socketFd,
      connectError
    });
  };

  const createUnixStreamSocketServer = ({ socketPath }: { socketPath: string }): TCreateUnixStreamSocketServerResult => {

    const socketFd = createUnixSocketFd();
    const socketAddressAsBuffer = createUnixSocketAddressAsBuffer({ socketPath });

    // bind creates the socket file at socketPath and fails with EADDRINUSE if a file already exists there,
    // e.g. one left over by a previous server, because the socket file is not removed on close (see server-wrapper.ts)
    const { errno: bindErrno } = syscallInterface.bind({
      socketFd,
      socketAddressAsBuffer
    });

    if (bindErrno !== undefined) {
      const { errno: closeErrno } = syscallInterface.close({
        fd: socketFd
      });

      if (closeErrno !== undefined) {
        throw Error(`close syscall failed with errno ${closeErrno}`);
      }

      return {
        error: Error(`bind syscall failed with errno ${bindErrno}`),
        server: undefined
      };
    }

    return {
      error: undefined,
      server: createUnixStreamSocketServerWrapper({
        syscallInterface,
        serverSocketFd: socketFd
      })
    };
  };

  const streamSocketPair = (): TStreamSocketPairResult => {
    const { errno, fd1, fd2 } = syscallInterface.socketpair({
      domain: AF_UNIX,
      type: SOCK_STREAM | SOCK_NONBLOCK,
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

  const importConnectedSocket = ({ socketFd }: { socketFd: number }) => {
    // the fd was opened elsewhere, so it has to be switched to non-blocking mode here - note that
    // this also affects all other fds that share its open file description, e.g. the one it was dupped from
    const { errno: getErrno, ret: fileStatusFlags } = syscallInterface.fcntl({
      fd: socketFd,
      cmd: F_GETFL,
      arg: 0n
    });

    if (getErrno !== undefined) {
      throw Error(`fcntl syscall failed with errno ${getErrno}`);
    }

    const { errno: setErrno } = syscallInterface.fcntl({
      fd: socketFd,
      cmd: F_SETFL,
      arg: fileStatusFlags | O_NONBLOCK
    });

    if (setErrno !== undefined) {
      throw Error(`fcntl syscall failed with errno ${setErrno}`);
    }

    return createSocketWrapper({
      syscallInterface,
      socketFd,
      connectError: undefined
    });
  };

  return {
    createUnixStreamSocketClient,
    createUnixStreamSocketServer,
    importConnectedSocket,
    streamSocketPair
  };
};

export {
  createSocketsFactory
};

export type {
  TStreamSocketPairResult,
  TCreateUnixStreamSocketServerResult
};
