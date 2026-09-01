# Throwaway image for verifying the Linux build (see `capture.rs`'s
# `press_copy_chord`) actually compiles and its copy-chord simulation
# actually works against a real (virtual) X11 server. Not part of the
# release/distribution story — see scripts/linux-test.sh for how it's used.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
	curl ca-certificates build-essential pkg-config \
	libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
	libayatana-appindicator3-dev libssl-dev \
	libx11-dev libxtst-dev libxi-dev libxdo-dev \
	xvfb xdotool xclip \
	python3-gi gir1.2-gtk-3.0 \
	&& rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.93.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /work
