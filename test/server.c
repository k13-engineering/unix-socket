#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/types.h>
#include <errno.h>

#define SOCKET_PATH "/tmp/my-unix-socket"
#define BUFFER_SIZE 2048
#define CMSG_BUF_SIZE 1024 // Large enough to hold several file descriptors

void handle_client(int client_fd) {
    char buffer[BUFFER_SIZE];
    char cmsg_buf[CMSG_BUF_SIZE];
    struct iovec iov[1];
    struct msghdr msg;
    ssize_t bytes_read;

    while (1) {
        // Clear structures for each read
        memset(&msg, 0, sizeof(msg));
        memset(buffer, 0, sizeof(buffer));
        memset(cmsg_buf, 0, sizeof(cmsg_buf));

        // Setup the iovec for regular data payload
        iov[0].iov_base = buffer;
        iov[0].iov_len = sizeof(buffer) - 1; // Leave 1 byte for null terminator

        msg.msg_iov = iov;
        msg.msg_iovlen = 1;

        // Setup the control message buffer
        msg.msg_control = cmsg_buf;
        msg.msg_controllen = sizeof(cmsg_buf);

        // Receive the message
        bytes_read = recvmsg(client_fd, &msg, 0);

        if (bytes_read < 0) {
            perror("recvmsg failed");
            break;
        } else if (bytes_read == 0) {
            printf("[*] Client disconnected.\n");
            break;
        }

        // Print the standard message data
        buffer[bytes_read] = '\0';
        printf(">>> Received message (%zd bytes): %s\n", bytes_read, buffer);

        // Iterate through all control messages (ancillary data)
        struct cmsghdr *cmsg;
        for (cmsg = CMSG_FIRSTHDR(&msg); cmsg != NULL; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
            printf("    [CMSG] Received control message: level=%d, type=%d\n",
                   cmsg->cmsg_level, cmsg->cmsg_type);

            // Check if this control message contains file descriptors
            if (cmsg->cmsg_level == SOL_SOCKET && cmsg->cmsg_type == SCM_RIGHTS) {

                // Calculate how many file descriptors were sent
                size_t payload_size = cmsg->cmsg_len - CMSG_LEN(0);
                size_t fd_count = payload_size / sizeof(int);

                int *fds = (int *)CMSG_DATA(cmsg);

                printf("    [CMSG] Extracted %zu file descriptor(s).\n", fd_count);

                for (size_t i = 0; i < fd_count; i++) {
                    int received_fd = fds[i];
                    printf("           Closing FD: %d\n", received_fd);
                    close(received_fd); // Close to prevent FD exhaustion attacks/leaks
                }
            }
        }

        // Check for MSG_TRUNC or MSG_CTRUNC flags
        if (msg.msg_flags & MSG_CTRUNC) {
            printf("    [WARNING] Control message was truncated! Buffer too small.\n");
        }
        printf("\n");
    }
    close(client_fd);
}

int main() {
    int server_fd, client_fd;
    struct sockaddr_un addr;

    // 1. Create the Unix domain socket
    if ((server_fd = socket(AF_UNIX, SOCK_STREAM, 0)) == -1) {
        perror("Socket creation failed");
        exit(EXIT_FAILURE);
    }

    // 2. Prepare the sockaddr_un structure
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, SOCKET_PATH, sizeof(addr.sun_path) - 1);

    // Unlink the path just in case it already exists from a previous crash
    unlink(SOCKET_PATH);

    // 3. Bind the socket to the file system path
    if (bind(server_fd, (struct sockaddr*)&addr, sizeof(addr)) == -1) {
        perror("Bind failed");
        close(server_fd);
        exit(EXIT_FAILURE);
    }

    // 4. Listen for incoming connections
    if (listen(server_fd, 5) == -1) {
        perror("Listen failed");
        close(server_fd);
        exit(EXIT_FAILURE);
    }

    printf("[*] Listening on Unix socket: %s\n", SOCKET_PATH);

    // 5. Accept loop
    while (1) {
        if ((client_fd = accept(server_fd, NULL, NULL)) == -1) {
            perror("Accept failed");
            continue;
        }
        printf("[*] New client connected.\n");
        handle_client(client_fd);
    }

    // Cleanup (unreachable in this infinite loop, but good practice)
    close(server_fd);
    unlink(SOCKET_PATH);
    return 0;
}
