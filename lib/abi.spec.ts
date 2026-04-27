import assert from "node:assert/strict";
import {
  parsers,
  createUnixSocketAddressAsBuffer,
  createControlMessageAsBuffer,
  createControlMessageListAsBuffer,
  parseControlMessagesFromBuffer,
  type TRawControlMessage
} from "./abi.ts";
import { describe, it } from "mocha";

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

      // The alignment is 8 bytes, so header should be aligned to 8
      const alignedHeaderSize = Math.ceil(parsers.cmsghdr.size / 8) * 8;
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

      const alignedHeaderSize = Math.ceil(parsers.cmsghdr.size / 8) * 8;
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
      const alignedHeaderSize = Math.ceil(parsers.cmsghdr.size / 8) * 8;
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
      assert.equal(buffer.length % 8, 0, "total length should be aligned to 8 bytes");
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
      const alignedHeaderSize = Math.ceil(parsers.cmsghdr.size / 8) * 8;
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
});
