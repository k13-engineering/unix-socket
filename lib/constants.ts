const AF_UNIX = BigInt(1);
const SOCK_STREAM = BigInt(1);
const SOCK_NONBLOCK = BigInt(2048);
const SOCK_CLOEXEC = BigInt(0x80000);

const EINPROGRESS = 115;
const EAGAIN = 11;
const EPIPE = 32;
const ENOENT = 2;
const EPERM = 1;
const EACCES = 13;
const ENOTDIR = 20;
const ELOOP = 40;
const EPROTOTYPE = 91;
const ECONNREFUSED = 111;
const ECONNRESET = 104;

const F_GETFD = BigInt(1);
const F_SETFD = BigInt(2);
const F_GETFL = BigInt(3);
const F_SETFL = BigInt(4);
const F_DUPFD_CLOEXEC = BigInt(1030);
const FD_CLOEXEC = BigInt(1);
const O_NONBLOCK = BigInt(2048);

const SOL_SOCKET = BigInt(1);
const SO_ERROR = BigInt(4);

const SCM_RIGHTS = BigInt(0x01);

const MSG_PEEK = BigInt(0x02);
const MSG_CTRUNC = BigInt(0x08);
const MSG_TRUNC = BigInt(0x20);
const MSG_CMSG_CLOEXEC = BigInt(0x40000000);

export {
  AF_UNIX,
  SOCK_STREAM,
  SOCK_NONBLOCK,
  SOCK_CLOEXEC,

  EINPROGRESS,
  EAGAIN,
  EPIPE,
  ENOENT,
  EPERM,
  EACCES,
  ENOTDIR,
  ELOOP,
  EPROTOTYPE,
  ECONNREFUSED,
  ECONNRESET,

  F_GETFD,
  F_SETFD,
  F_GETFL,
  F_SETFL,
  F_DUPFD_CLOEXEC,
  FD_CLOEXEC,
  O_NONBLOCK,

  SOL_SOCKET,
  SO_ERROR,

  SCM_RIGHTS,

  MSG_PEEK,
  MSG_CTRUNC,
  MSG_TRUNC,
  MSG_CMSG_CLOEXEC
};
