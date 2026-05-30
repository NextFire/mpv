#!/bin/bash -e

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

deps_root=${1:-$repo_root/build-emscripten-deps}
prefix="$deps_root/prefix"
src_root="$deps_root/src"
build_root="$deps_root/build"
download_root="$deps_root/downloads"
ports_pc_root="$deps_root/ports-pkgconfig"
cross_file="$repo_root/ci/emscripten-cross.ini"

jobs=${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}

for tool in curl git tar meson ninja emcc emconfigure emmake emar emranlib; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "error: required tool '$tool' is not in PATH" >&2
        exit 1
    fi
done

mkdir -p "$prefix" "$src_root" "$build_root" "$download_root" "$ports_pc_root"

export PKG_CONFIG=pkg-config
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$ports_pc_root:$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export CFLAGS="${CFLAGS:-} -pthread"
export CXXFLAGS="${CXXFLAGS:-} -pthread"
export LDFLAGS="${LDFLAGS:-} -pthread"

download() {
    local url=$1
    local output=$2

    if [ ! -f "$output" ]; then
        curl -L "$url" -o "$output"
    fi
}

extract() {
    local archive=$1
    local dest=$2

    rm -rf "$dest"
    mkdir -p "$dest"
    tar -xf "$archive" -C "$dest" --strip-components=1
}

write_port_pc() {
    local name=$1
    local description=$2
    local version=$3
    local flag=$4

    cat >"$ports_pc_root/$name.pc" <<EOF
prefix=/emscripten/ports
exec_prefix=
libdir=
includedir=

Name: $name
Description: $description
Version: $version
Libs: $flag
Cflags: $flag
EOF
}

setup_port_pkgconfig() {
    write_port_pc freetype2 "Emscripten FreeType port" 9999 -sUSE_FREETYPE=1
    write_port_pc harfbuzz "Emscripten HarfBuzz port" 9999 -sUSE_HARFBUZZ=1
}

build_fribidi() {
    local version=1.0.16
    local archive="$download_root/fribidi-$version.tar.xz"
    local srcdir="$src_root/fribidi-$version"
    local builddir="$build_root/fribidi"

    download "https://github.com/fribidi/fribidi/releases/download/v$version/fribidi-$version.tar.xz" "$archive"
    extract "$archive" "$srcdir"
    rm -rf "$builddir"
    mkdir -p "$builddir"

    pushd "$builddir" >/dev/null
    emconfigure "$srcdir/configure" \
        --host=wasm32-unknown-emscripten \
        --prefix="$prefix" \
        --disable-shared \
        --enable-static
    emmake make -j"$jobs"
    emmake make install
    popd >/dev/null
}

build_libass() {
    local version=0.17.3
    local archive="$download_root/libass-$version.tar.xz"
    local srcdir="$src_root/libass-$version"
    local builddir="$build_root/libass"

    download "https://github.com/libass/libass/releases/download/$version/libass-$version.tar.xz" "$archive"
    extract "$archive" "$srcdir"
    rm -rf "$builddir"

    meson setup "$builddir" "$srcdir" \
        --cross-file "$cross_file" \
        --prefix "$prefix" \
        -Ddefault_library=static \
        -Dfontconfig=disabled \
        -Dcoretext=disabled \
        -Ddirectwrite=disabled \
        -Dasm=disabled \
        -Dlibunibreak=disabled \
        -Drequire-system-font-provider=false
    meson compile -C "$builddir"
    meson install -C "$builddir"
}

build_libplacebo() {
    local version=7.360.1
    local srcdir="$src_root/libplacebo-v$version"
    local builddir="$build_root/libplacebo"

    rm -rf "$srcdir"
    git clone --depth 1 --branch "v$version" --recurse-submodules \
        https://code.videolan.org/videolan/libplacebo.git "$srcdir"
    rm -rf "$builddir"

    meson setup "$builddir" "$srcdir" \
        --cross-file "$cross_file" \
        --prefix "$prefix" \
        -Ddefault_library=static \
        -Ddemos=false \
        -Dtests=false \
        -Dbench=false \
        -Dfuzz=false \
        -Dvulkan=disabled \
        -Dvk-proc-addr=disabled \
        -Dd3d11=disabled \
        -Dglslang=disabled \
        -Dshaderc=disabled \
        -Dlcms=disabled \
        -Ddovi=disabled \
        -Dlibdovi=disabled \
        -Dunwind=disabled
    meson compile -C "$builddir"
    meson install -C "$builddir"
}

build_ffmpeg() {
    local version=7.1.1
    local archive="$download_root/ffmpeg-$version.tar.xz"
    local srcdir="$src_root/ffmpeg-$version"
    local builddir="$build_root/ffmpeg"

    download "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz" "$archive"
    extract "$archive" "$srcdir"
    rm -rf "$builddir"
    mkdir -p "$builddir"

    pushd "$builddir" >/dev/null
    emconfigure "$srcdir/configure" \
        --prefix="$prefix" \
        --cc=emcc \
        --cxx=em++ \
        --ar=emar \
        --ranlib=emranlib \
        --nm=emnm \
        --pkg-config=pkg-config \
        --target-os=none \
        --arch=wasm32 \
        --enable-cross-compile \
        --enable-pthreads \
        --disable-asm \
        --disable-autodetect \
        --disable-debug \
        --disable-doc \
        --disable-network \
        --disable-programs \
        --extra-cflags="-pthread" \
        --extra-cxxflags="-pthread" \
        --extra-ldflags="-pthread"
    emmake make -j"$jobs"
    emmake make install
    popd >/dev/null
}

setup_port_pkgconfig
build_fribidi
build_libass
build_libplacebo
build_ffmpeg

cat <<EOF
Built Emscripten dependencies under: $deps_root
Meson browser builds read from: $repo_root/build-emscripten-deps
Build wrapper shortcut:
    ci/build-emscripten.sh
EOF
