# unix-socket

Synchronous, non-blocking Unix domain stream sockets for Node.js on Linux, including file descriptor passing (`SCM_RIGHTS`).

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
