import { importConnectedSocket, streamSocketPair } from "../lib/index.ts";

const { errno, socket1, socket2 } = streamSocketPair();
if (errno !== undefined) {
  throw Error(`socketpair syscall failed with errno ${errno}`);
}

const { socketFd: socket1Fd } = socket1.dup();
const { socketFd: socket2Fd } = socket2.dup();

const importedSocket1 = importConnectedSocket({ socketFd: socket1Fd });
const importedSocket2 = importConnectedSocket({ socketFd: socket2Fd });

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const dataToSend = "hello from socket1";

console.log({ dataToSend });

importedSocket1.sendmsg({
  controlMessages: [],
  data: textEncoder.encode(dataToSend),
  flags: {}
});

const { data: receivedData } = importedSocket2.recvmsg({
  count: 1024,
  maxControlMessageBytes: 0,
  flags: {}
});

const receivedText = textDecoder.decode(receivedData);

console.log({ receivedText });
