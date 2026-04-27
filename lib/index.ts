import { createSyscallInterface } from "./syscalls.ts";
import { type TControlMessage, type TUnixSocket } from "./socket-wrapper.ts";
import { syscall } from "syscall-napi";
import { createSocketsFactory } from "./sockets.ts";

const linuxSyscallInterface = createSyscallInterface({
  syscall
});

const socketFactory = createSocketsFactory({
  syscallInterface: linuxSyscallInterface
});

const {
  createUnixStreamSocketClient,
  streamSocketPair
} = socketFactory;

export {
  createUnixStreamSocketClient,
  streamSocketPair
};

export type {
  TControlMessage,
  TUnixSocket
};
