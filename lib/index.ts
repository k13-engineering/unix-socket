import { createSyscallInterface } from "./syscalls.ts";
import { type TControlMessage, type TUnixSocket } from "./socket-wrapper.ts";
import { syscall } from "syscall-napi";
import { createSocketsFactory, type TStreamSocketPairResult } from "./sockets.ts";

const linuxSyscallInterface = createSyscallInterface({
  syscall
});

const socketFactory = createSocketsFactory({
  syscallInterface: linuxSyscallInterface
});

const createUnixStreamSocketClient = ({ socketPath }: { socketPath: string }): TUnixSocket => {
  return socketFactory.createUnixStreamSocketClient({
    socketPath
  });
};

const streamSocketPair = (): TStreamSocketPairResult => {
  return socketFactory.streamSocketPair();
};

export {
  createUnixStreamSocketClient,
  streamSocketPair
};

export type {
  TControlMessage,
  TUnixSocket
};
