import { parseControlMessagesFromBuffer, type TRawControlMessage } from "./abi.ts";
import {
  EAGAIN,
  EPIPE,
  MSG_PEEK,
  SCM_RIGHTS,
  SOL_SOCKET
} from "./constants.ts";
// import { createStateMachine, stateInfo, transitionTo, type TState, type TTransitionTo } from "./state-machine-v3.ts";
import {
  createStateMachine,
  stateInfo,
  transitionInfo,
  transitionTo,
  type TStateMachineNamespace
} from "@k13engineering/state-machine";

import {
  type TSyscallInterface,
} from "./syscalls.ts";

type TUnixSocketStatus = {
  type: "connect-error",
  error: Error
} | {
  type: "remote-reset",
} | {
  type: "open",
  remote: {
    reading: boolean,
    writing: boolean
  },
  local: {
    reading: boolean,
    writing: boolean
  }
} | {
  type: "closed"
};

// type TNextResult = {
//   poll: {
//     readable: boolean,
//     writable: boolean,
//   },
// };

type TControlMessage = {
  level: "SOL_SOCKET",
  type: "SCM_RIGHTS",
  fd: number
};

type TConnectionInputEvents = {
  status: () => TUnixSocketStatus,
  dup: () => { socketFd: number },
  recvmsg: (args: {
    count: number,
    maxControlMessageBytes: number,
    flags: {
      peek?: boolean
    }
  }) => {
    data: Uint8Array,
    controlMessages: TControlMessage[]
  },
  sendmsg: (args: {
    data: Uint8Array,
    controlMessages: TControlMessage[],
    flags: Record<string, never>
  }) => { bytesSent: number },
  close: () => Record<string, unknown>
};

type TUnixSocket = {
  status: TConnectionInputEvents["status"],
  dup: TConnectionInputEvents["dup"],
  recvmsg: TConnectionInputEvents["recvmsg"],
  sendmsg: TConnectionInputEvents["sendmsg"],
  close: () => void;
};

// type TConnectionInputs = {
//   readable: boolean,
//   writable: boolean,
//   disconnected: boolean
// };

type TStateOrTransitionInfo = { name: string };

type TSocketStateMachineNamespace = TStateMachineNamespace<TConnectionInputEvents, TStateOrTransitionInfo, TStateOrTransitionInfo>;

type TConnectionState = TSocketStateMachineNamespace["state"];

const createSocketWrapper = ({
  syscallInterface,
  socketFd,
  connectError: providedConnectError
}: {
  syscallInterface: TSyscallInterface,
  socketFd: number,
  connectError: Error | undefined
}): TUnixSocket => {

  // type E = TConnectionInputEvents;
  type E = TSocketStateMachineNamespace["state"];
  type T = TSocketStateMachineNamespace["transition"];

  const raiseInvalidState = () => {
    throw Error(`invalid state`);
  };

  const transitionToClosedState = (): T => {
    return {
      [transitionInfo]: { name: "closing" },
      perform: () => {
        // eslint-disable-next-line no-use-before-define
        return createClosedState();
      }
    };
  };

  const commonDup = () => {
    const { errno, fd: duppedFd } = syscallInterface.dup({
      fd: socketFd
    });

    if (errno !== undefined) {
      throw Error(`dup syscall failed with errno ${errno}`);
    }

    return {
      socketFd: duppedFd
    };
  };

  const createConnectErrorState = ({ connectError }: { connectError: Error }): TConnectionState => {

    const status = (): TUnixSocketStatus => {
      return {
        type: "connect-error",
        error: connectError
      };
    };

    const dup: E["dup"] = () => {
      return commonDup();
    };

    const sendmsg: E["sendmsg"] = () => {
      return { bytesSent: 0 };
    };
    const recvmsg: E["recvmsg"] = () => {
      return { data: new Uint8Array(0), controlMessages: [] };
    };

    const close: E["close"] = () => {
      return {
        [transitionTo]: transitionToClosedState()
      };
    };

    return {
      [stateInfo]: () => {
        return { name: "connect-error" };
      },

      status,
      dup,
      sendmsg,
      recvmsg,
      close
    };
  };

  const createOpenState = (): TConnectionState => {

    let remote = {
      reading: true,
      writing: true
    };

    // TODO: implement
    // eslint-disable-next-line prefer-const
    let local = {
      reading: true,
      writing: true
    };

    const status = (): TUnixSocketStatus => {
      return {
        type: "open",
        remote,
        local
      };
    };

    const dup: E["dup"] = () => {
      return commonDup();
    };

    // eslint-disable-next-line complexity
    const sendmsg: E["sendmsg"] = ({ data, controlMessages, flags }) => {

      if (Object.keys(flags).length > 0) {
        throw Error(`unsupported flags provided`);
      }

      const rawControlMessages: TRawControlMessage[] = controlMessages.map((controlMessage) => {

        if (controlMessage.level === "SOL_SOCKET" && controlMessage.type === "SCM_RIGHTS") {
          const controlMessagePayload = new Uint8Array(4);
          // TODO: size and endianness for different architectures
          new DataView(controlMessagePayload.buffer).setInt32(0, controlMessage.fd, true);

          return {
            level: SOL_SOCKET,
            type: SCM_RIGHTS,
            data: controlMessagePayload
          };
        }

        throw Error(`unsupported control message`);
      });

      // eslint-disable-next-line prefer-const
      let rawFlags = 0n;

      const { errno, bytesSent } = syscallInterface.sendmsg({
        socketFd,
        dataBuffers: [data],
        controlMessages: rawControlMessages,
        flags: rawFlags
      });

      if (errno !== undefined) {

        if (errno === EAGAIN) {
          return {
            bytesSent: 0
          };
        }

        if (errno === EPIPE) {
          remote = {
            ...remote,
            reading: false
          };

          return {
            bytesSent: 0
          };
        }

        throw Error(`sendmsg syscall failed with errno ${errno}`);
      }

      return {
        bytesSent
      };
    };

    // eslint-disable-next-line complexity
    const recvmsg: E["recvmsg"] = ({ count, maxControlMessageBytes, flags }) => {

      const buffer = new Uint8Array(count);
      const controlMessageBuffer = new Uint8Array(maxControlMessageBytes);

      let rawFlags = 0n;

      if (flags.peek) {
        rawFlags |= MSG_PEEK;
      }

      const { errno, bytesReceived } = syscallInterface.recvmsg({
        socketFd,
        dataBuffers: [buffer],
        controlMessageBuffer,
        flags: rawFlags
      });

      if (errno !== undefined) {

        if (errno === EAGAIN) {
          return {
            data: new Uint8Array(0),
            controlMessages: []
          };
        }

        throw Error(`recvmsg syscall failed with errno ${errno}`);
      }

      if (bytesReceived === 0) {
        remote = {
          ...remote,
          writing: false
        };
      }

      const rawControlMessages = parseControlMessagesFromBuffer({ buffer: controlMessageBuffer });

      const controlMessages = rawControlMessages.map((rawControlMessage): TControlMessage => {
        if (rawControlMessage.level === SOL_SOCKET && rawControlMessage.type === SCM_RIGHTS) {
          const fd = new DataView(rawControlMessage.data.buffer).getInt32(0, true);

          return {
            level: "SOL_SOCKET",
            type: "SCM_RIGHTS",
            fd
          };
        }

        throw Error(`unsupported control message received`);
      });

      return {
        data: buffer.subarray(0, bytesReceived),
        controlMessages
      };
    };

    const close: E["close"] = () => {
      return {
        [transitionTo]: transitionToClosedState()
      };
    };

    return {
      [stateInfo]: () => {
        return { name: "open" };
      },

      status,
      dup,
      sendmsg,
      recvmsg,
      close
    };
  };

  const createClosedState = (): TConnectionState => {

    const status = (): TUnixSocketStatus => {
      return {
        type: "closed"
      };
    };

    const dup: E["dup"] = () => {
      return raiseInvalidState();
    };

    const sendmsg: E["sendmsg"] = () => {
      return raiseInvalidState();
    };
    const recvmsg: E["recvmsg"] = () => {
      return raiseInvalidState();
    };
    const close: E["close"] = () => {
      return raiseInvalidState();
    };

    return {
      [stateInfo]: () => {
        return { name: "closed" };
      },

      status,
      dup,
      sendmsg,
      recvmsg,
      close
    };
  };

  const stateMachine = createStateMachine({
    initialState: providedConnectError === undefined ? createOpenState() : createConnectErrorState({ connectError: providedConnectError }),

    // logger: {
    //   inputEvent: ({ state, event, args }) => {
    //     console.log(`{socket ${socketFd}} [state ${state.name}] --> input event: ${event}`, args);
    //   },

    //   outputEvent: ({ state, event, args }) => {
    //     console.log(`{socket ${socketFd}} [state ${state.name}] <-- output event: ${event}`, args);
    //   },

    //   transition: {
    //     start: ({ from, via }) => {
    //       console.log(`{socket ${socketFd}} [state ${from.name}] ---(${via.name})-->`);
    //     },

    //     end: ({ from, via, to }) => {
    //       console.log(`{socket ${socketFd}} ---(${via.name})--> [state ${to.name}] (from ${from.name})`);
    //     }
    //   }
    // }
  }) as TSocketStateMachineNamespace["stateMachine"];

  const close = () => {
    stateMachine.close();
  };

  return {
    status: stateMachine.status,
    dup: stateMachine.dup,
    recvmsg: stateMachine.recvmsg,
    sendmsg: stateMachine.sendmsg,
    close
  };
};

export {
  createSocketWrapper
};

export type {
  TControlMessage,
  TUnixSocket,
};
