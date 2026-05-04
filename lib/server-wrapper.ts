import { createSocketWrapper, type TUnixSocket } from "./socket-wrapper.ts";
import type { TSyscallInterface } from "./syscalls.ts";

type TUnixStreamSocketServer = {
  listen: (args: { backlog: number }) => { error: Error | undefined };
  accept: () => {
    error: Error;
    clientSocket: undefined;
  } | {
    error: undefined;
    clientSocket: TUnixSocket;
  } | {
    error: undefined;
    clientSocket: undefined;
  };
  dup: () => { serverSocketFd: number };
  close: () => void;
};

const EAGAIN = 11;

const createUnixStreamSocketServerWrapper = ({
  syscallInterface,
  serverSocketFd
}: {
  syscallInterface: TSyscallInterface,
  serverSocketFd: number
}): TUnixStreamSocketServer => {

  let closed = false;

  const listen: TUnixStreamSocketServer["listen"] = ({ backlog }) => {

    if (closed) {
      throw Error("already closed");
    }

    const { errno } = syscallInterface.listen({
      socketFd: serverSocketFd,
      backlog
    });

    if (errno !== undefined) {
      return { error: Error(`listen syscall failed with errno ${errno}`) };
    }

    return { error: undefined };
  };

  const accept: TUnixStreamSocketServer["accept"] = () => {

    if (closed) {
      throw Error("already closed");
    }

    const { errno, socketFd } = syscallInterface.accept({
      socketFd: serverSocketFd
    });

    if (errno !== undefined) {

      if (errno === EAGAIN) {
        return { error: undefined, clientSocket: undefined };
      }

      return { error: Error(`accept syscall failed with errno ${errno}`), clientSocket: undefined };
    }

    return {
      error: undefined,
      clientSocket: createSocketWrapper({
        syscallInterface,
        socketFd,
        connectError: undefined
      })
    };
  };

  const dup: TUnixStreamSocketServer["dup"] = () => {

    if (closed) {
      throw Error("already closed");
    }

    const { errno, fd: duppedServerSocketFd } = syscallInterface.dup({
      fd: serverSocketFd
    });

    if (errno !== undefined) {
      throw Error(`dup syscall failed with errno ${errno}`);
    }

    return { serverSocketFd: duppedServerSocketFd };
  };

  const close: TUnixStreamSocketServer["close"] = () => {
    if (closed) {
      throw Error("already closed");
    }

    closed = true;

    const { errno } = syscallInterface.close({
      fd: serverSocketFd
    });

    if (errno !== undefined) {
      throw Error(`close syscall failed with errno ${errno}`);
    }
  };

  return {
    listen,
    accept,
    dup,
    close
  };
};

export {
  createUnixStreamSocketServerWrapper
};

export type {
  TUnixStreamSocketServer
};
