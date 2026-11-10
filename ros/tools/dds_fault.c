/* 専用E2EだけのUDP blackhole。TCP/MQTT、process、host firewallには触れない。 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <sys/socket.h>
#include <unistd.h>

static int blocked(int fd) {
  const char *mode = getenv("BRIDGE_INTEGRATION");
  if (!mode || strcmp(mode, "true") || access("/data/fleet/dds-cutoff", F_OK)) return 0;
  int type = 0;
  socklen_t size = sizeof(type);
  int drop = getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) == 0 && type == SOCK_DGRAM;
  static atomic_int reported = 0;
  if (drop && !atomic_exchange(&reported, 1)) {
    const char message[] = "DDS_TEST_UDP_DROPPED\n";
    (void)write(STDERR_FILENO, message, sizeof(message)-1);
  }
  return drop;
}
ssize_t send(int fd, const void *buf, size_t n, int flags) {
  ssize_t (*real)(int,const void *,size_t,int) = dlsym(RTLD_NEXT,"send");
  return blocked(fd) ? (ssize_t)n : real(fd,buf,n,flags);
}
ssize_t recv(int fd, void *buf, size_t n, int flags) {
  ssize_t (*real)(int,void *,size_t,int) = dlsym(RTLD_NEXT,"recv");
  ssize_t result = real(fd,buf,n,flags);
  if (result >= 0 && blocked(fd)) { errno=EAGAIN; return -1; }
  return result;
}
ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
  ssize_t (*real)(int,const struct msghdr *,int) = dlsym(RTLD_NEXT,"sendmsg");
  if (!blocked(fd)) return real(fd,msg,flags);
  size_t size = 0;
  for (size_t i=0;i<msg->msg_iovlen;i++) size += msg->msg_iov[i].iov_len;
  return size;
}
ssize_t sendto(int fd, const void *buf, size_t n, int flags,
               const struct sockaddr *address, socklen_t length) {
  ssize_t (*real)(int,const void *,size_t,int,const struct sockaddr *,socklen_t)
    = dlsym(RTLD_NEXT,"sendto");
  return blocked(fd) ? (ssize_t)n : real(fd,buf,n,flags,address,length);
}
ssize_t recvmsg(int fd, struct msghdr *msg, int flags) {
  ssize_t (*real)(int,struct msghdr *,int) = dlsym(RTLD_NEXT,"recvmsg");
  ssize_t result = real(fd,msg,flags);
  if (result >= 0 && blocked(fd)) { errno=EAGAIN; return -1; }
  return result;
}
ssize_t recvfrom(int fd, void *buf, size_t n, int flags,
                 struct sockaddr *address, socklen_t *length) {
  ssize_t (*real)(int,void *,size_t,int,struct sockaddr *,socklen_t *)
    = dlsym(RTLD_NEXT,"recvfrom");
  ssize_t result = real(fd,buf,n,flags,address,length);
  if (result >= 0 && blocked(fd)) { errno=EAGAIN; return -1; }
  return result;
}
