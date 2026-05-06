import { define, types } from "ya-struct";
import { AF_UNIX } from "./constants.ts";
import type { TFieldType } from "ya-struct/dist/lib/types/index.js";
import process from "node:process";

const { ascii, pointer, UInt16, UInt64 } = types;

const hostAbi = {
  endianness: "little",
  compiler: "gcc",
  dataModel: "LP64"
} as const;

const sockaddr_un = define({
  definition: {
    type: "struct",
    fields: [
      { name: "sun_family", definition: UInt16 },
      { name: "sun_path", definition: ascii({ length: 108 }) }
    ],
    packed: false,
    fixedAbi: {}
  }
});

if (process.arch !== "x64" && process.arch !== "arm64") {
  throw Error("not implemented yet");
}

// eslint-disable-next-line no-underscore-dangle
const __kernel_size_t: TFieldType = UInt64;

const iovec = define({
  definition: {
    type: "struct",
    fields: [
      { name: "iov_base", definition: pointer },
      {
        name: "iov_len", definition: __kernel_size_t
      }
    ],
    packed: false,
    fixedAbi: {}
  }
});

const msghdr = define({
  definition: {
    type: "struct",
    fields: [
      { name: "msg_name", definition: pointer },
      {
        name: "msg_namelen",
        definition: {
          type: "c-type",
          cType: "int",
          fixedAbi: {}
        }
      },
      {
        name: "msg_iov",
        definition: pointer
      },
      {
        name: "msg_iovlen",
        definition: __kernel_size_t
      },
      {
        name: "msg_control",
        definition: pointer
      },
      {
        name: "msg_controllen",
        definition: __kernel_size_t
      },
      {
        name: "msg_flags",
        definition: {
          type: "c-type",
          cType: "unsigned int",
          fixedAbi: {}
        }
      }
    ],
    packed: false,
    fixedAbi: {}
  }
});

const cmsghdr = define({
  definition: {
    type: "struct",
    fields: [
      {
        name: "cmsg_len",
        definition: __kernel_size_t
      },
      {
        name: "cmsg_level",
        definition: {
          type: "c-type",
          cType: "int",
          fixedAbi: {}
        }
      },
      {
        name: "cmsg_type",
        definition: {
          type: "c-type",
          cType: "int",
          fixedAbi: {}
        }
      }
    ],
    packed: false,
    fixedAbi: {}
  }
});

const sockopt_length = define({
  definition: {
    type: "struct",
    fields: [
      {
        name: "length",
        definition: UInt64
      }
    ],
    packed: false,
    fixedAbi: {}
  }
});

const sockopt_error = define({
  definition: {
    type: "struct",
    fields: [
      {
        name: "error",
        definition: UInt64
      }
    ],
    packed: false,
    fixedAbi: {}
  }
});

const socketpair_sv = define({
  definition: {
    type: "struct",
    fields: [
      { name: "fd1", definition: { type: "c-type", cType: "int", fixedAbi: {} } },
      { name: "fd2", definition: { type: "c-type", cType: "int", fixedAbi: {} } }
    ],
    packed: false,
    fixedAbi: {}
  }
});

const parsers = {
  sockaddr_un: sockaddr_un.parser({ abi: hostAbi }),
  iovec: iovec.parser({ abi: hostAbi }),
  msghdr: msghdr.parser({ abi: hostAbi }),
  cmsghdr: cmsghdr.parser({ abi: hostAbi }),
  sockopt_length: sockopt_length.parser({ abi: hostAbi }),
  sockopt_error: sockopt_error.parser({ abi: hostAbi }),
  socketpair_sv: socketpair_sv.parser({ abi: hostAbi })
};

const CMSG_ALIGN = ({ length }: { length: number }) => {
  // TODO: make the alignment value arch-dependent
  const alignment = 8;
  return Math.ceil(length / alignment) * alignment;
};

type TRawControlMessage = {
  level: bigint,
  type: bigint,
  data: Uint8Array
};

const concatBuffers = ({ parts }: { parts: Uint8Array[] }) => {
  let totalLength = 0;
  parts.forEach((part) => {
    totalLength += part.length;
  });

  const result = new Uint8Array(totalLength);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });

  return result;
};

const createControlMessageAsBuffer = ({ controlMessage }: { controlMessage: TRawControlMessage }) => {

  const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });
  const alignedDataLength = CMSG_ALIGN({ length: controlMessage.data.length });

  const totalLength = alignedHeaderSize + alignedDataLength;

  const cmsg = new Uint8Array(totalLength);
  const header = parsers.cmsghdr.format({
    value: {
      cmsg_len: BigInt(alignedHeaderSize + controlMessage.data.length),
      cmsg_level: controlMessage.level,
      cmsg_type: controlMessage.type
    }
  });

  let offset = 0;
  cmsg.set(header, offset);
  offset += alignedHeaderSize;
  cmsg.set(controlMessage.data, offset);
  // eslint-disable-next-line no-useless-assignment
  offset += alignedDataLength;

  return cmsg;
};

const parseControlMessagesFromBuffer = ({ buffer }: { buffer: Uint8Array }): TRawControlMessage[] => {
  const messages: TRawControlMessage[] = [];
  const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });

  let offset = 0;
  while (offset + alignedHeaderSize <= buffer.length) {
    const header = parsers.cmsghdr.parse({ data: buffer.subarray(offset) });
    const cmsgLen = Number(header.cmsg_len);

    if (cmsgLen < alignedHeaderSize) {
      break;
    }

    const dataOffset = offset + alignedHeaderSize;
    const dataLength = cmsgLen - alignedHeaderSize;
    const data = buffer.slice(dataOffset, dataOffset + dataLength);

    // eslint-disable-next-line fp/no-mutating-methods -- performance
    messages.push({
      level: header.cmsg_level,
      type: header.cmsg_type,
      data
    });

    offset += CMSG_ALIGN({ length: cmsgLen });
  }

  return messages;
};

const createControlMessageListAsBuffer = ({ controlMessages }: { controlMessages: TRawControlMessage[] }) => {
  const parts = controlMessages.map((controlMessage) => {
    return createControlMessageAsBuffer({ controlMessage });
  });

  return concatBuffers({ parts });
};

const createUnixSocketAddressAsBuffer = ({ socketPath }: { socketPath: string }) => {
  return parsers.sockaddr_un.format({
    value: {
      sun_family: AF_UNIX,
      sun_path: socketPath
    }
  });
};

export {
  parsers,

  createUnixSocketAddressAsBuffer,
  createControlMessageAsBuffer,
  createControlMessageListAsBuffer,
  parseControlMessagesFromBuffer,
};

export type {
  TRawControlMessage
};
