FROM alpine@sha256:1c4eef651f65e2f7daee7ee785882ac164b02b78fb74503052a26dc061c90474
RUN apk add --no-cache openssh-server=9.9_p2-r0 openssh-keygen=9.9_p2-r0 && \
    adduser -D -h /home/twin synthetic && echo 'synthetic:lab-only-password' | chpasswd && \
    mkdir -p /run/sshd /run/twin
EXPOSE 2222
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/run/twin/sshd_config"]

