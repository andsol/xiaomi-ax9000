FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive
# gcc-multilib exists only on amd64; OpenWrt does not need it on arm64 build hosts.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential clang flex bison g++ gawk \
        gettext git libncurses5-dev libssl-dev python3-setuptools python3-pip \
        rsync swig unzip zlib1g-dev file wget zstd ca-certificates curl \
        squashfs-tools device-tree-compiler python3-pytest gosu ccache \
        libelf-dev xsltproc patch diffutils \
    && if [ "$(dpkg --print-architecture)" = amd64 ]; then \
           apt-get install -y --no-install-recommends gcc-multilib g++-multilib; \
       fi \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --break-system-packages ubi_reader

RUN useradd -m -u 1000 -s /bin/bash builder \
    && mkdir -p /work /out \
    && chown builder:builder /work /out

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
