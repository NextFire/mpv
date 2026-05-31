npx = find_program('npx')

emscripten_browser_lib_typescript = custom_target('emscripten-browser-lib-typescript',
    input: files('index.ts'),
    output: ['index.js', 'index.d.ts'],
    command: [
        npx,
        '--yes',
        '-p',
        'typescript',
        'tsc',
        '--project',
        join_paths(meson.current_source_dir(), 'tsconfig.json'),
        '--outDir',
        '@OUTDIR@',
    ],
    depend_files: files('tsconfig.json'),
    build_by_default: true,
)
configure_file(input: 'README.md', output: 'README.md', copy: true)

browser_package_conf = configuration_data()
browser_package_conf.set('PACKAGE_VERSION', meson.project_version())

configure_file(
    input: 'package.json.in',
    output: 'package.json',
    configuration: browser_package_conf,
)

emscripten_browser_command = [
    emcc,
    browser_web_source,
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
    '-sEXPORTED_FUNCTIONS=[_malloc,_free,_mpv_web_command_string,_mpv_web_destroy,_mpv_web_get_audio_setup_state,_mpv_web_get_frame_ptr,_mpv_web_get_frame_stride,_mpv_web_get_last_error,_mpv_web_get_last_error_string,_mpv_web_get_property_double,_mpv_web_get_property_flag,_mpv_web_get_property_string,_mpv_web_init,_mpv_web_loadfile,_mpv_web_needs_render,_mpv_web_poll_events,_mpv_web_render,_mpv_web_resume_audio,_mpv_web_seek_absolute,_mpv_web_set_property_double,_mpv_web_set_property_flag,_mpv_web_set_property_string,_mpv_web_sub_add,_mpv_web_uses_gpu]',
    '--no-entry',
    '-o', '@OUTPUT0@',
]

emscripten_browser = custom_target('emscripten-browser',
    output: ['mpv.js', 'mpv.wasm'],
    command: emscripten_browser_command,
    depends: emscripten_browser_lib_typescript,
    build_by_default: false,
)
