const AF_UNIX = BigInt(1);
const SOCK_STREAM = BigInt(1);
const SOCK_NONBLOCK = BigInt(2048);

const EINPROGRESS = 115;
const EAGAIN = 11;
const EPIPE = 32;
const ENOENT = 2;

const F_GETFL = BigInt(3);
const F_SETFL = BigInt(4);
const O_NONBLOCK = BigInt(2048);

const SOL_SOCKET = BigInt(1);
const SO_ERROR = BigInt(4);

const SCM_RIGHTS = BigInt(0x01);

const MSG_PEEK = BigInt(0x02);
const MSG_CTRUNC = BigInt(0x08);
const MSG_TRUNC = BigInt(0x20);

export {
  AF_UNIX,
  SOCK_STREAM,
  SOCK_NONBLOCK,

  EINPROGRESS,
  EAGAIN,
  EPIPE,
  ENOENT,

  F_GETFL,
  F_SETFL,
  O_NONBLOCK,

  SOL_SOCKET,
  SO_ERROR,

  SCM_RIGHTS,

  MSG_PEEK,
  MSG_CTRUNC,
  MSG_TRUNC
};
