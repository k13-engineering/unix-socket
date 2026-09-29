# unix-socket

Synchronous, non-blocking Unix domain stream sockets for Node.js on Linux, including file descriptor passing (`SCM_RIGHTS`).

## Non-blocking sockets

All sockets are in non-blocking mode, so no call ever waits. `importConnectedSocket` switches the fd it is given to non-blocking mode. This also affects every other fd that shares its open file description, for example the fd it was dupped from.

## Error handling: look before you leap

This library follows the LBYL ("look before you leap") style. Every socket is in one state, which `status()` reports. Check the state before calling an operation, because each operation is only allowed in some states:

| `status().type`   | `dup` | `sendmsg` | `recvmsg` | `close` |
| ----------------- | :---: | :-------: | :-------: | :-----: |
| `"open"`          | ✓     | ✓         | ✓         | ✓       |
| `"connect-error"` | ✗     | ✗         | ✗         | ✗       |
| `"closed"`        | ✗     | ✗         | ✗         | ✗       |

Calling an operation that isn't allowed throws an `invalid state` error. A socket in the `"connect-error"` state holds no file descriptor, so there is nothing to close.

Exceptions signal programming errors and unexpected failures. They are not meant to be caught: let them crash the process. Conditions a program is expected to handle are reported through `status()` and return values instead.

```ts
const client = createUnixStreamSocketClient({ socketPath });

const status = client.status();
if (status.type === "connect-error") {
  console.error(status.error.message);
} else {
  client.sendmsg({ data, controlMessages: [], flags: {} });
  client.close();
}
```

## Connect errors

`createUnixStreamSocketClient` doesn't throw because of what is, or isn't, at `socketPath`. It returns a socket in the `"connect-error"` state, whose `status()` has the `errno` and an `error` describing the problem:

| `errno`                      | Meaning                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `ENOENT`, `ENOTDIR`, `ELOOP` | There is no socket file at the path                                   |
| `EACCES`, `EPERM`            | No permission to connect                                              |
| `ECONNREFUSED`               | Nobody is listening, e.g. the socket file of a server that has exited |
| `EAGAIN`                     | The server's listen backlog is full; try again later                  |
| `EPROTOTYPE`                 | The socket at the path is not a stream socket                         |

Compare `errno` with the values in `os.constants.errno` from `node:os`. Any other connect failure throws.
