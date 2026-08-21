# Oxelot all-in-one dev toolchain.
#
# Everything heavy/messy lives here so the host stays clean: Node 22, Rust
# (stable + wasm32-wasip1), zig 0.16 (C compiler for the WASM build), and
# Playwright system libraries for Chromium. The repo itself is NOT copied
# into the image — it is bind-mounted at runtime (see docker-compose.yml /
# .devcontainer), so rebuilds never invalidate layers.
#
# Pins mirror CI (.github/workflows/ci.yml): Node 22, rust stable +
# wasm32-wasip1, zig 0.16.0. PLAYWRIGHT_VERSION must match the version
# resolved in package-lock.json; system deps are baked here while browser
# binaries download once at runtime into a named volume using the repo's own
# playwright version (always revision-exact).
FROM node:22-bookworm

ARG ZIG_VERSION=0.16.0
ARG PLAYWRIGHT_VERSION=1.62.1
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git bash-completion procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Rust stable + wasm32-wasip1 target (CI: dtolnay/rust-toolchain@stable).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
  && rustup target add wasm32-wasip1

# zig 0.16 as the C compiler for wasm32-wasip1 (same tarball layout as CI).
RUN case "${TARGETARCH}" in \
      amd64) zig_arch="x86_64-linux" ;; \
      arm64) zig_arch="aarch64-linux" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${zig_arch}-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz \
  && mkdir -p /opt/zig \
  && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
  && rm /tmp/zig.tar.xz
ENV PATH=/opt/zig:${PATH}

# Playwright system dependencies baked at build time. Browser BINARIES are
# intentionally NOT baked: they are downloaded on first use by the repo's own
# playwright dependency into the `oxelot_playwright` volume, so the revision
# always matches package-lock.json exactly.
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
  && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
  && npm uninstall -g playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright-browsers

# The repo is bind-mounted from a Windows host; silence dubious-ownership.
RUN git config --global --add safe.directory '*'

# Login shells (`bash -l`, VS Code terminals) source /etc/profile which resets
# PATH; re-export the toolchain paths there so every shell flavor finds them.
RUN printf 'export PATH=/opt/zig:/usr/local/cargo/bin:%s\n' '"$PATH"' > /etc/profile.d/oxelot-toolchain.sh

WORKDIR /app
CMD ["bash"]
