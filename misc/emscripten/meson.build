emcc = find_program('emcc')
pkg_config = find_program('pkg-config')

browser_link_dependencies = [
    'libavcodec',
    'libavfilter',
    'libavformat',
    'libavutil',
    'libplacebo',
    'libass',
    'libswresample',
    'libswscale',
]

browser_deps_dir = join_paths(source_root, 'build-emscripten-deps')

browser_pkg_config = run_command(pkg_config,
    '--cflags', '--libs', '--static',
    browser_link_dependencies,
    check: true,
    env: {
        'PKG_CONFIG_PATH': '',
        'PKG_CONFIG_LIBDIR': ':'.join([
            join_paths(browser_deps_dir, 'ports-pkgconfig'),
            join_paths(browser_deps_dir, 'prefix', 'lib', 'pkgconfig'),
            join_paths(browser_deps_dir, 'prefix', 'share', 'pkgconfig'),
        ]),
    },
)

browser_pkg_args = []
browser_pkg_stdout = browser_pkg_config.stdout().strip()
if browser_pkg_stdout != ''
    browser_pkg_args = browser_pkg_stdout.split()
endif

configure_file(input: 'index.html', output: 'index.html', copy: true)
configure_file(input: 'mpv-browser.js', output: 'mpv-browser.js', copy: true)

emscripten_browser_command = [
    emcc,
    files('mpv-web.c'),
    libmpv,
    '-I' + source_root,
    '-I' + join_paths(source_root, 'include'),
] + browser_pkg_args + [
    '-pthread',
    '-sUSE_PTHREADS=1',
    '-sWASM_WORKERS=1',
    '-sAUDIO_WORKLET=1',
    '-sPTHREAD_POOL_SIZE=' + meson.get_external_property('mpv_wasm_pthread_pool_size', '16'),
    '-sPTHREAD_POOL_DELAY_LOAD=1',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sFILESYSTEM=1',
    '-sINITIAL_MEMORY=268435456',
    '-sGL_ENABLE_GET_PROC_ADDRESS=1',
    '-sMAX_WEBGL_VERSION=2',
    '-sMIN_WEBGL_VERSION=2',
    '-sMODULARIZE=1',
    '-sEXPORT_ES6=1',
    '-sEXPORT_NAME=createMpvModule',
    '-sNO_EXIT_RUNTIME=1',
    '-sEXPORTED_RUNTIME_METHODS=[ccall,cwrap,FS,HEAPF32,HEAPU8]',
    '-sEXPORTED_FUNCTIONS=[_malloc,_free,_mpv_web_destroy,_mpv_web_get_audio_setup_state,_mpv_web_get_frame_ptr,_mpv_web_get_frame_stride,_mpv_web_get_last_error,_mpv_web_get_last_error_string,_mpv_web_get_property_double,_mpv_web_get_property_flag,_mpv_web_init,_mpv_web_loadfile,_mpv_web_needs_render,_mpv_web_poll_events,_mpv_web_render,_mpv_web_resume_audio,_mpv_web_seek_absolute,_mpv_web_set_property_double,_mpv_web_set_property_flag,_mpv_web_uses_gpu]',
    '--no-entry',
    '-o', '@OUTPUT0@',
]

emscripten_browser = custom_target('emscripten-browser',
    output: ['mpv.js', 'mpv.wasm'],
    command: emscripten_browser_command,
    build_by_default: false,
)

run_target('serve-emscripten-browser',
    command: [python, join_paths(source_root, 'ci/serve-emscripten-browser.py'), meson.current_build_dir()],
    depends: emscripten_browser,
)
