import { streamSocketPair } from "../lib/index.ts";

const { errno, socket1, socket2 } = streamSocketPair();
if (errno !== undefined) {
  throw Error(`socketpair syscall failed with errno ${errno}`);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const dataToSend = "hello from socket1";

console.log({ dataToSend });

socket1.sendmsg({
  controlMessages: [],
  data: textEncoder.encode(dataToSend),
  flags: {}
});

const { data: receivedData } = socket2.recvmsg({
  count: 1024,
  maxControlMessageBytes: 0,
  flags: {}
});

const receivedText = textDecoder.decode(receivedData);

console.log({ receivedText });
