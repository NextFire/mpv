#!/bin/bash -e

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
deps_root="$repo_root/build-emscripten-deps"

builddir=${1:-build-emscripten}
shift $(( $# > 0 ? 1 : 0 ))

if ! command -v emcc >/dev/null 2>&1; then
    echo "error: emcc is not in PATH" >&2
    exit 1
fi

if ! command -v meson >/dev/null 2>&1; then
    echo "error: meson is not in PATH" >&2
    exit 1
fi

if [ -n "${EM_PKG_CONFIG_PATH:-}" ]; then
    export PKG_CONFIG_PATH="$EM_PKG_CONFIG_PATH"
fi

if [ -n "${EM_PKG_CONFIG_LIBDIR:-}" ]; then
    export PKG_CONFIG_LIBDIR="$EM_PKG_CONFIG_LIBDIR"
fi

if [ -z "${PKG_CONFIG_LIBDIR:-}" ]; then
    default_pkgconfig="$deps_root/ports-pkgconfig:$deps_root/prefix/lib/pkgconfig:$deps_root/prefix/share/pkgconfig"
    if [ -d "$deps_root/prefix/lib/pkgconfig" ]; then
        export PKG_CONFIG_PATH=
        export PKG_CONFIG_LIBDIR="$default_pkgconfig"
    fi
fi

check_pkg_config_provenance() {
    [ "${MPV_EMCC_ALLOW_HOST_PKG_CONFIG:-0}" = "1" ] && return 0

    local pc_data
    pc_data=$(pkg-config --cflags --libs libavcodec libplacebo libass 2>/dev/null || true)

    case "$pc_data" in
        *"/opt/homebrew/"*|*"/usr/local/"*|*"/Library/Developer/"*|*"-framework"*)
            cat >&2 <<'EOF'
error: pkg-config is resolving host libraries for the Emscripten build.
Set PKG_CONFIG_LIBDIR and/or PKG_CONFIG_PATH (or EM_PKG_CONFIG_LIBDIR / EM_PKG_CONFIG_PATH)
to a wasm-target dependency prefix before running this script. You can provision one with
ci/build-emscripten-deps.sh, which defaults to $repo_root/build-emscripten-deps.
Set MPV_EMCC_ALLOW_HOST_PKG_CONFIG=1 only if you are intentionally overriding this check.
EOF
            exit 1
            ;;
    esac
}

check_pkg_config_provenance

meson_args=(
    --cross-file ci/emscripten-cross.ini
    -Demscripten=true
    -Dcplayer=false
    -Dlibmpv=true
    -Dbuild-date=false
    -Dcdda=disabled
    -Dcplugins=disabled
    -Ddvbin=disabled
    -Ddvdnav=disabled
    -Djpeg=disabled
    -Dlua=disabled
    -Djavascript=disabled
    -Dlcms2=disabled
    -Dlibarchive=disabled
    -Dlibavdevice=disabled
    -Dlibbluray=disabled
    -Dalsa=disabled
    -Daudiounit=disabled
    -Dcoreaudio=disabled
    -Davfoundation=disabled
    -Djack=disabled
    -Dopenal=disabled
    -Daudiotrack=disabled
    -Daaudio=disabled
    -Dopensles=disabled
    -Doss-audio=disabled
    -Dpipewire=disabled
    -Dpulse=disabled
    -Drubberband=disabled
    -Dsndio=disabled
    -Dwasapi=disabled
    -Dcaca=disabled
    -Ddirect3d=disabled
    -Dd3d11=disabled
    -Ddrm=disabled
    -Degl=disabled
    -Degl-android=disabled
    -Degl-angle=disabled
    -Degl-angle-lib=disabled
    -Degl-angle-win32=disabled
    -Degl-drm=disabled
    -Degl-wayland=disabled
    -Degl-x11=disabled
    -Dgl=enabled
    -Dgl-cocoa=disabled
    -Dgl-win32=disabled
    -Dgl-x11=disabled
    -Dplain-gl=enabled
    -Dshaderc=disabled
    -Dsdl2-audio=disabled
    -Dsdl2-gamepad=disabled
    -Dsdl2-video=disabled
    -Dsixel=disabled
    -Dspirv-cross=disabled
    -Duchardet=disabled
    -Dvapoursynth=disabled
    -Dvulkan=disabled
    -Dwayland=disabled
    -Dx11=disabled
    -Dx11-clipboard=disabled
    -Dzimg=disabled
    -Dzlib=disabled
)

if [ ! -d "$builddir" ]; then
    meson setup "$builddir" "${meson_args[@]}" "$@"
else
    meson setup --wipe "$builddir" "${meson_args[@]}" "$@"
fi

meson compile -C "$builddir"
