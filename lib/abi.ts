import { define, types, type TAbi } from "ya-struct";
import { AF_UNIX } from "./constants.ts";
import type { TFieldType } from "ya-struct/dist/lib/types/index.js";
import os from "node:os";
import process from "node:process";

const { ascii, pointer, UInt16 } = types;

const dataModelByArch: Partial<Record<NodeJS.Architecture, TAbi["dataModel"]>> = {
  x64: "LP64",
  arm64: "LP64",
  arm: "ILP32"
};

const determineAbi = ({
  arch,
  endianness
}: {
  arch: NodeJS.Architecture,
  endianness: ReturnType<typeof os.endianness>
}): TAbi => {
  const dataModel = dataModelByArch[arch];
  if (dataModel === undefined) {
    throw Error(`architecture ${arch} not implemented yet`);
  }

  return {
    endianness: endianness === "LE" ? "little" : "big",
    compiler: "gcc",
    dataModel
  };
};

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

// unsigned long on 64-bit architectures, unsigned int on arm, which has the same size there
// eslint-disable-next-line no-underscore-dangle
const __kernel_size_t: TFieldType = {
  type: "c-type",
  cType: "unsigned long",
  fixedAbi: {}
};

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

// socklen_t
const sockopt_length = define({
  definition: {
    type: "struct",
    fields: [
      {
        name: "length",
        definition: { type: "c-type", cType: "unsigned int", fixedAbi: {} }
      }
    ],
    packed: false,
    fixedAbi: {}
  }
});

// the value of the SO_ERROR socket option
const sockopt_error = define({
  definition: {
    type: "struct",
    fields: [
      {
        name: "error",
        definition: { type: "c-type", cType: "int", fixedAbi: {} }
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

// used to determine sizeof(long), which control messages are aligned to
const c_long = define({
  definition: {
    type: "struct",
    fields: [
      { name: "value", definition: { type: "c-type", cType: "long", fixedAbi: {} } }
    ],
    packed: false,
    fixedAbi: {}
  }
});

// the payload of a SCM_RIGHTS control message is an array of these
const scm_rights_fd = define({
  definition: {
    type: "struct",
    fields: [
      { name: "fd", definition: { type: "c-type", cType: "int", fixedAbi: {} } }
    ],
    packed: false,
    fixedAbi: {}
  }
});

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

const createAbi =({ abi }: { abi: TAbi }) => {

  const parsers = {
    sockaddr_un: sockaddr_un.parser({ abi }),
    iovec: iovec.parser({ abi }),
    msghdr: msghdr.parser({ abi }),
    cmsghdr: cmsghdr.parser({ abi }),
    sockopt_length: sockopt_length.parser({ abi }),
    sockopt_error: sockopt_error.parser({ abi }),
    socketpair_sv: socketpair_sv.parser({ abi }),
    scm_rights_fd: scm_rights_fd.parser({ abi })
  };

  const longSize = c_long.parser({ abi }).size;

  const CMSG_ALIGN = ({ length }: { length: number }) => {
    return Math.ceil(length / longSize) * longSize;
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

  const createScmRightsPayload = ({ fds }: { fds: number[] }) => {
    const parts = fds.map((fd) => {
      return parsers.scm_rights_fd.format({
        value: {
          fd: BigInt(fd)
        }
      });
    });

    return concatBuffers({ parts });
  };

  const parseScmRightsPayload = ({ data }: { data: Uint8Array }) => {
    const fdSize = parsers.scm_rights_fd.size;
    const fdCount = Math.floor(data.length / fdSize);

    return [...Array(fdCount).keys()].map((index) => {
      const { fd } = parsers.scm_rights_fd.parse({
        data: data.subarray(index * fdSize, (index + 1) * fdSize)
      });

      return Number(fd);
    });
  };

  return {
    parsers,

    CMSG_ALIGN,

    createUnixSocketAddressAsBuffer,
    createControlMessageAsBuffer,
    createControlMessageListAsBuffer,
    parseControlMessagesFromBuffer,
    createScmRightsPayload,
    parseScmRightsPayload
  };
};

const {
  parsers,

  CMSG_ALIGN,

  createUnixSocketAddressAsBuffer,
  createControlMessageAsBuffer,
  createControlMessageListAsBuffer,
  parseControlMessagesFromBuffer,
  createScmRightsPayload,
  parseScmRightsPayload
} = createAbi({
  abi: determineAbi({
    arch: process.arch,
    endianness: os.endianness()
  })
});

export {
  determineAbi,
  createAbi,

  parsers,

  CMSG_ALIGN,

  createUnixSocketAddressAsBuffer,
  createControlMessageAsBuffer,
  createControlMessageListAsBuffer,
  parseControlMessagesFromBuffer,
  createScmRightsPayload,
  parseScmRightsPayload
};

export type {
  TRawControlMessage
};
