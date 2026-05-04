import { createUnixStreamSocketServer, createUnixStreamSocketClient } from "../lib/index.ts";
import nodeFs from "node:fs";

const socketPath = "/tmp/unix-socket-server.sock";
if (nodeFs.existsSync(socketPath)) {
  nodeFs.rmSync(socketPath);
}

const { error: serverError, server } = createUnixStreamSocketServer({ socketPath });
if (serverError !== undefined) {
  throw serverError;
}

const { error: listenError } = server.listen({ backlog: 1 });
if (listenError !== undefined) {
  throw listenError;
}

const client = createUnixStreamSocketClient({ socketPath });

const { error: acceptError, clientSocket } = server.accept();
if (acceptError !== undefined) {
  throw acceptError;
}

if (clientSocket === undefined) {
  throw Error("expected client socket");
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const dataServerToClient = textEncoder.encode("hello from socket1");
const dataClientToServer = textEncoder.encode("hello from socket2");

const { bytesSent: bytesSent01 } = client.sendmsg({
  data: dataClientToServer,
  controlMessages: [],
  flags: {}
});

if (bytesSent01 !== dataClientToServer.length) {
  throw Error(`expected to send ${dataClientToServer.length} bytes, but sent ${bytesSent01}`);
}

const { data: receivedData01 } = clientSocket.recvmsg({
  count: 1024,
  maxControlMessageBytes: 0,
  flags: {}
});

const receivedText01 = textDecoder.decode(receivedData01);

console.log({ receivedText01 });

const { bytesSent: bytesSent02 } = clientSocket.sendmsg({
  data: dataServerToClient,
  controlMessages: [],
  flags: {}
});

if (bytesSent02 !== dataServerToClient.length) {
  throw Error(`expected to send ${dataServerToClient.length} bytes, but sent ${bytesSent02}`);
}

const { data: receivedData02 } = client.recvmsg({
  count: 1024,
  maxControlMessageBytes: 0,
  flags: {}
});

const receivedText02 = textDecoder.decode(receivedData02);

console.log({ receivedText02 });

client.close();
server.close();
