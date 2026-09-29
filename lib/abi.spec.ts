import assert from "node:assert/strict";
import {
  determineAbi,
  createAbi,
  parsers,
  CMSG_ALIGN,
  createUnixSocketAddressAsBuffer,
  createControlMessageAsBuffer,
  createControlMessageListAsBuffer,
  parseControlMessagesFromBuffer,
  type TRawControlMessage
} from "./abi.ts";
import { SCM_RIGHTS, SOL_SOCKET } from "./constants.ts";
import { describe, it } from "mocha";
import process from "node:process";

const structSizesOf = ({ parsers: parsersToMeasure }: { parsers: Record<string, { size: number }> }) => {
  return Object.fromEntries(Object.entries(parsersToMeasure).map(([structName, parser]) => {
    return [structName, parser.size];
  }));
};

describe("abi", () => {

  describe("parsers", () => {
    it("should expose all expected parsers", () => {
      assert.ok(parsers.sockaddr_un);
      assert.ok(parsers.iovec);
      assert.ok(parsers.msghdr);
      assert.ok(parsers.cmsghdr);
      assert.ok(parsers.sockopt_length);
      assert.ok(parsers.sockopt_error);
      assert.ok(parsers.socketpair_sv);
      assert.ok(parsers.scm_rights_fd);
    });

    it("should have positive sizes for all parsers", () => {
      for (const [name, parser] of Object.entries(parsers)) {
        assert.ok(parser.size > 0, `parser ${name} should have positive size`);
      }
    });
  });

  describe("createUnixSocketAddressAsBuffer", () => {
    it("should create a buffer with AF_UNIX family", () => {
      const buffer = createUnixSocketAddressAsBuffer({ socketPath: "/tmp/test.sock" });
      assert.ok(buffer instanceof Uint8Array);
      assert.equal(buffer.length, parsers.sockaddr_un.size);
    });

    it("should round-trip the socket path through sockaddr_un parser", () => {
      const socketPath = "/tmp/test.sock";
      const buffer = createUnixSocketAddressAsBuffer({ socketPath });
      const parsed = parsers.sockaddr_un.parse({ data: buffer });
      // AF_UNIX
      assert.equal(parsed.sun_family, BigInt(1));
      assert.ok(parsed.sun_path.startsWith(socketPath));
    });

    it("should handle empty socket path", () => {
      const buffer = createUnixSocketAddressAsBuffer({ socketPath: "" });
      assert.ok(buffer instanceof Uint8Array);
      assert.equal(buffer.length, parsers.sockaddr_un.size);
    });

    it("should handle long socket paths", () => {
      const socketPath = `/tmp/${"a".repeat(100)}`;
      const buffer = createUnixSocketAddressAsBuffer({ socketPath });
      const parsed = parsers.sockaddr_un.parse({ data: buffer });
      assert.ok(parsed.sun_path.startsWith(socketPath));
    });
  });

  describe("createControlMessageAsBuffer", () => {
    it("should create a buffer from a control message", () => {
      const controlMessage: TRawControlMessage = {
        level: 1n,
        type: 1n,
        data: new Uint8Array([1, 2, 3, 4])
      };
      const buffer = createControlMessageAsBuffer({ controlMessage });
      assert.ok(buffer instanceof Uint8Array);
      assert.ok(buffer.length > 0);
    });

    it("should include the header with correct values", () => {
      const controlMessage: TRawControlMessage = {
        level: 42n,
        type: 7n,
        data: new Uint8Array([0xAA, 0xBB])
      };
      const buffer = createControlMessageAsBuffer({ controlMessage });
      const header = parsers.cmsghdr.parse({ data: buffer });
      assert.equal(header.cmsg_level, 42n);
      assert.equal(header.cmsg_type, 7n);
    });

    it("should include the data after the aligned header", () => {
      const data = new Uint8Array([10, 20, 30, 40]);
      const controlMessage: TRawControlMessage = {
        level: 1n,
        type: 1n,
        data
      };
      const buffer = createControlMessageAsBuffer({ controlMessage });

      const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });
      const extractedData = buffer.slice(alignedHeaderSize, alignedHeaderSize + data.length);
      assert.deepEqual(extractedData, data);
    });

    it("should set cmsg_len to aligned header size + data length", () => {
      const data = new Uint8Array([1, 2, 3]);
      const controlMessage: TRawControlMessage = {
        level: 1n,
        type: 1n,
        data
      };
      const buffer = createControlMessageAsBuffer({ controlMessage });
      const header = parsers.cmsghdr.parse({ data: buffer });

      const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });
      assert.equal(header.cmsg_len, BigInt(alignedHeaderSize + data.length));
    });

    it("should handle empty data", () => {
      const controlMessage: TRawControlMessage = {
        level: 1n,
        type: 1n,
        data: new Uint8Array(0)
      };
      const buffer = createControlMessageAsBuffer({ controlMessage });
      assert.ok(buffer instanceof Uint8Array);

      const header = parsers.cmsghdr.parse({ data: buffer });
      const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });
      assert.equal(header.cmsg_len, BigInt(alignedHeaderSize));
    });

    it("should produce a buffer with aligned total length", () => {
      const controlMessage: TRawControlMessage = {
        level: 1n,
        type: 1n,
        // odd-length data
        data: new Uint8Array([1, 2, 3])
      };
      const buffer = createControlMessageAsBuffer({ controlMessage });
      assert.equal(buffer.length, CMSG_ALIGN({ length: buffer.length }), "total length should be aligned");
    });
  });

  describe("parseControlMessagesFromBuffer", () => {
    it("should parse a single control message", () => {
      const original: TRawControlMessage = {
        level: 1n,
        type: 2n,
        data: new Uint8Array([10, 20, 30, 40])
      };
      const buffer = createControlMessageAsBuffer({ controlMessage: original });
      const messages = parseControlMessagesFromBuffer({ buffer });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].level, 1n);
      assert.equal(messages[0].type, 2n);
      assert.deepEqual(messages[0].data, original.data);
    });

    it("should parse multiple control messages", () => {
      const msg1: TRawControlMessage = {
        level: 1n,
        type: 1n,
        data: new Uint8Array([0xAA, 0xBB])
      };
      const msg2: TRawControlMessage = {
        level: 2n,
        type: 3n,
        data: new Uint8Array([0xCC, 0xDD, 0xEE])
      };
      const buffer = createControlMessageListAsBuffer({ controlMessages: [msg1, msg2] });
      const messages = parseControlMessagesFromBuffer({ buffer });

      assert.equal(messages.length, 2);
      assert.equal(messages[0].level, 1n);
      assert.equal(messages[0].type, 1n);
      assert.deepEqual(messages[0].data, msg1.data);
      assert.equal(messages[1].level, 2n);
      assert.equal(messages[1].type, 3n);
      assert.deepEqual(messages[1].data, msg2.data);
    });

    it("should return empty array for empty buffer", () => {
      const messages = parseControlMessagesFromBuffer({ buffer: new Uint8Array(0) });
      assert.deepEqual(messages, []);
    });

    it("should return empty array for buffer smaller than header", () => {
      const messages = parseControlMessagesFromBuffer({ buffer: new Uint8Array(4) });
      assert.deepEqual(messages, []);
    });

    it("should stop parsing when cmsg_len is smaller than aligned header size", () => {
      // Create a buffer with a zeroed-out header (cmsg_len = 0)
      const alignedHeaderSize = CMSG_ALIGN({ length: parsers.cmsghdr.size });
      const buffer = new Uint8Array(alignedHeaderSize + 16);
      // cmsg_len is 0, which is < alignedHeaderSize, so it should stop
      const messages = parseControlMessagesFromBuffer({ buffer });
      assert.deepEqual(messages, []);
    });

    it("should handle control message with empty data", () => {
      const original: TRawControlMessage = {
        level: 5n,
        type: 10n,
        data: new Uint8Array(0)
      };
      const buffer = createControlMessageAsBuffer({ controlMessage: original });
      const messages = parseControlMessagesFromBuffer({ buffer });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].level, 5n);
      assert.equal(messages[0].type, 10n);
      assert.deepEqual(messages[0].data, new Uint8Array(0));
    });
  });

  describe("createControlMessageListAsBuffer", () => {
    it("should create empty buffer for empty list", () => {
      const buffer = createControlMessageListAsBuffer({ controlMessages: [] });
      assert.ok(buffer instanceof Uint8Array);
      assert.equal(buffer.length, 0);
    });

    it("should create buffer for single message", () => {
      const msg: TRawControlMessage = {
        level: 1n,
        type: 1n,
        data: new Uint8Array([1, 2, 3, 4])
      };
      const listBuffer = createControlMessageListAsBuffer({ controlMessages: [msg] });
      const singleBuffer = createControlMessageAsBuffer({ controlMessage: msg });
      assert.deepEqual(listBuffer, singleBuffer);
    });

    it("should concatenate multiple messages", () => {
      const msg1: TRawControlMessage = {
        level: 1n,
        type: 1n,
        data: new Uint8Array([0x01])
      };
      const msg2: TRawControlMessage = {
        level: 2n,
        type: 2n,
        data: new Uint8Array([0x02])
      };
      const buffer = createControlMessageListAsBuffer({ controlMessages: [msg1, msg2] });

      const buf1 = createControlMessageAsBuffer({ controlMessage: msg1 });
      const buf2 = createControlMessageAsBuffer({ controlMessage: msg2 });
      assert.equal(buffer.length, buf1.length + buf2.length);
    });
  });

  describe("round-trip control messages", () => {
    it("should preserve data through create and parse cycle", () => {
      const original: TRawControlMessage = {
        level: 100n,
        type: 200n,
        data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      };
      const buffer = createControlMessageAsBuffer({ controlMessage: original });
      const parsed = parseControlMessagesFromBuffer({ buffer });

      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].level, original.level);
      assert.equal(parsed[0].type, original.type);
      assert.deepEqual(parsed[0].data, original.data);
    });

    it("should preserve multiple messages through list create and parse cycle", () => {
      const messages: TRawControlMessage[] = [
        { level: 1n, type: 1n, data: new Uint8Array([0x10, 0x20]) },
        { level: 2n, type: 3n, data: new Uint8Array([0x30, 0x40, 0x50]) },
        { level: 4n, type: 5n, data: new Uint8Array([0x60]) }
      ];
      const buffer = createControlMessageListAsBuffer({ controlMessages: messages });
      const parsed = parseControlMessagesFromBuffer({ buffer });

      assert.equal(parsed.length, messages.length);
      parsed.forEach((msg, i) => {
        assert.equal(msg.level, messages[i].level);
        assert.equal(msg.type, messages[i].type);
        assert.deepEqual(msg.data, messages[i].data);
      });
    });

    it("should handle data lengths that are not aligned to 8 bytes", () => {
      for (let dataLen = 0; dataLen < 20; dataLen += 1) {
        const data = new Uint8Array(dataLen);
        for (let i = 0; i < dataLen; i += 1) {
          // eslint-disable-next-line immutable/no-mutation -- filling test data
          data[i] = i;
        }
        const original: TRawControlMessage = {
          level: 1n,
          type: 1n,
          data
        };
        const buffer = createControlMessageAsBuffer({ controlMessage: original });
        const parsed = parseControlMessagesFromBuffer({ buffer });

        assert.equal(parsed.length, 1, `failed for dataLen=${dataLen}`);
        assert.deepEqual(parsed[0].data, data, `data mismatch for dataLen=${dataLen}`);
      }
    });
  });

  describe("createAbi", () => {

    // reference values produced by gcc and glibc on the respective architecture - the kernel reads and
    // writes these structs in full, so any difference in size or layout corrupts memory
    const lp64LittleEndian = {
      abi: { endianness: "little", compiler: "gcc", dataModel: "LP64" },
      expected: {
        structSizes: {
          sockaddr_un: 110,
          iovec: 16,
          msghdr: 56,
          cmsghdr: 16,
          // socklen_t
          sockopt_length: 4,
          // int
          sockopt_error: 4,
          // int[2]
          socketpair_sv: 8,
          // int
          scm_rights_fd: 4
        },
        iovecOffsets: {
          iov_base: 0,
          iov_len: 8
        },
        msghdrOffsets: {
          msg_name: 0,
          msg_namelen: 8,
          msg_iov: 16,
          msg_iovlen: 24,
          msg_control: 32,
          msg_controllen: 40,
          msg_flags: 48
        },
        scmRightsControlMessageOfFds77And78: [
          24, 0, 0, 0, 0, 0, 0, 0,
          1, 0, 0, 0,
          1, 0, 0, 0,
          77, 0, 0, 0,
          78, 0, 0, 0
        ]
      }
    } as const;

    const architectures = [
      { name: "amd64", ...lp64LittleEndian },
      { name: "arm64", ...lp64LittleEndian },
      {
        name: "arm32",
        abi: { endianness: "little", compiler: "gcc", dataModel: "ILP32" },
        expected: {
          structSizes: {
            sockaddr_un: 110,
            iovec: 8,
            msghdr: 28,
            cmsghdr: 12,
            sockopt_length: 4,
            sockopt_error: 4,
            socketpair_sv: 8,
            scm_rights_fd: 4
          },
          iovecOffsets: {
            iov_base: 0,
            iov_len: 4
          },
          msghdrOffsets: {
            msg_name: 0,
            msg_namelen: 4,
            msg_iov: 8,
            msg_iovlen: 12,
            msg_control: 16,
            msg_controllen: 20,
            msg_flags: 24
          },
          scmRightsControlMessageOfFds77And78: [
            20, 0, 0, 0,
            1, 0, 0, 0,
            1, 0, 0, 0,
            77, 0, 0, 0,
            78, 0, 0, 0
          ]
        }
      }
    ] as const;

    architectures.forEach(({ name, abi, expected }) => {

      describe(name, () => {

        const archAbi = createAbi({ abi });

        it("should size every struct like gcc", () => {
          // comparing all parsers at once makes a struct without reference size fail as well
          assert.deepEqual(structSizesOf({ parsers: archAbi.parsers }), expected.structSizes);
        });

        it("should lay out iovec fields like gcc", () => {
          const iovec = archAbi.parsers.iovec.format({ value: { iov_base: 1n, iov_len: 2n } });

          assert.equal(iovec[expected.iovecOffsets.iov_base], 1);
          assert.equal(iovec[expected.iovecOffsets.iov_len], 2);
        });

        it("should lay out msghdr fields like gcc", () => {
          const fieldNames = Object.keys(expected.msghdrOffsets) as (keyof typeof expected.msghdrOffsets)[];

          const value = Object.fromEntries(fieldNames.map((fieldName) => {
            // mark each field with a distinct value, so its offset can be located
            return [fieldName, BigInt(fieldNames.indexOf(fieldName) + 1)];
          })) as Record<keyof typeof expected.msghdrOffsets, bigint>;

          const msghdr = archAbi.parsers.msghdr.format({ value });

          fieldNames.forEach((fieldName) => {
            assert.equal(
              msghdr[expected.msghdrOffsets[fieldName]],
              fieldNames.indexOf(fieldName) + 1,
              `unexpected offset of ${fieldName}`
            );
          });
        });

        it("should encode a SCM_RIGHTS control message like gcc", () => {
          const buffer = archAbi.createControlMessageAsBuffer({
            controlMessage: {
              level: SOL_SOCKET,
              type: SCM_RIGHTS,
              data: archAbi.createScmRightsPayload({ fds: [77, 78] })
            }
          });

          assert.deepEqual(buffer, Uint8Array.from(expected.scmRightsControlMessageOfFds77And78));
        });

        it("should decode a SCM_RIGHTS control message produced by gcc", () => {
          const messages = archAbi.parseControlMessagesFromBuffer({
            buffer: Uint8Array.from(expected.scmRightsControlMessageOfFds77And78)
          });

          assert.equal(messages.length, 1);
          assert.equal(messages[0].level, SOL_SOCKET);
          assert.equal(messages[0].type, SCM_RIGHTS);
          assert.deepEqual(archAbi.parseScmRightsPayload({ data: messages[0].data }), [77, 78]);
        });
      });
    });

    it("should use the struct sizes of the host architecture", () => {
      const architectureNames: Record<string, string> = {
        x64: "amd64",
        arm64: "arm64",
        arm: "arm32"
      };

      const hostArchitecture = architectures.find(({ name }) => {
        return name === architectureNames[process.arch];
      });
      assert.ok(hostArchitecture, `no reference values for ${process.arch}`);

      assert.deepEqual(structSizesOf({ parsers }), hostArchitecture.expected.structSizes);
    });

    it("should encode fds with the endianness of the ABI", () => {
      const bigEndianAbi = createAbi({ abi: { endianness: "big", compiler: "gcc", dataModel: "LP64" } });
      const payload = bigEndianAbi.createScmRightsPayload({ fds: [77, 0x01020304] });

      assert.deepEqual(payload, new Uint8Array([0, 0, 0, 77, 1, 2, 3, 4]));
      assert.deepEqual(bigEndianAbi.parseScmRightsPayload({ data: payload }), [77, 0x01020304]);
    });
  });

  describe("determineAbi", () => {

    it("should use the LP64 data model on amd64", () => {
      assert.deepEqual(determineAbi({ arch: "x64", endianness: "LE" }), {
        endianness: "little",
        compiler: "gcc",
        dataModel: "LP64"
      });
    });

    it("should use the LP64 data model on arm64", () => {
      assert.equal(determineAbi({ arch: "arm64", endianness: "LE" }).dataModel, "LP64");
    });

    it("should use the ILP32 data model on arm32", () => {
      assert.equal(determineAbi({ arch: "arm", endianness: "LE" }).dataModel, "ILP32");
    });

    it("should map big endian hosts to a big endian ABI", () => {
      assert.equal(determineAbi({ arch: "arm64", endianness: "BE" }).endianness, "big");
    });

    it("should throw on unsupported architectures", () => {
      assert.throws(() => {
        determineAbi({ arch: "ia32", endianness: "LE" });
      }, { message: /architecture ia32 not implemented yet/ });
    });
  });
});
