FROM alpine@sha256:1c4eef651f65e2f7daee7ee785882ac164b02b78fb74503052a26dc061c90474
RUN apk add --no-cache nmap=7.95-r1 postgresql17-client=17.11-r0 redis=7.2.11-r0 \
    openssh-client-default=9.9_p2-r0 sshpass=1.10-r0 curl
RUN curl -fsSL https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_linux_amd64.zip -o /tmp/nuclei.zip && \
    echo 'ea63d4ae232808cd7c6bc00d0142428e231fab59dae01042246097d195835ab6  /tmp/nuclei.zip' | sha256sum -c - && \
    unzip -p /tmp/nuclei.zip nuclei > /usr/local/bin/nuclei && chmod 0755 /usr/local/bin/nuclei && \
    rm /tmp/nuclei.zip
USER 65534:65534
CMD ["sleep", "infinity"]

