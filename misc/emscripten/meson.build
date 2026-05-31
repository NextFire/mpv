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

browser_web_source = files('mpv_web_api.c')

subdir('demo')
subdir('lib')

run_target('serve-emscripten-browser',
    command: [python, join_paths(source_root, 'ci/serve-emscripten-browser.py'), meson.current_build_dir()],
    depends: emscripten_browser,
)
