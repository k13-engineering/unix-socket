const AF_UNIX = BigInt(1);
const SOCK_STREAM = BigInt(1);

const EINPROGRESS = 115;
const EAGAIN = 11;
const EPIPE = 32;
const ENOENT = 2;

const F_SETFL = BigInt(4);
const O_NONBLOCK = BigInt(2048);

const SOL_SOCKET = BigInt(1);
const SO_ERROR = BigInt(4);

const SCM_RIGHTS = BigInt(0x01);

const MSG_PEEK = BigInt(0x02);

export {
  AF_UNIX,
  SOCK_STREAM,

  EINPROGRESS,
  EAGAIN,
  EPIPE,
  ENOENT,

  F_SETFL,
  O_NONBLOCK,

  SOL_SOCKET,
  SO_ERROR,

  SCM_RIGHTS,

  MSG_PEEK
};
