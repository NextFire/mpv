#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

void ao_emscripten_prepare_audio(void);
void ao_emscripten_resume_audio(void);
void ao_emscripten_shutdown_audio(void);
int ao_emscripten_get_setup_state(void);

struct mpv_web_state {
    mpv_handle *mpv;
    mpv_render_context *render;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE gl;
    unsigned char *frame_buffer;
    size_t frame_stride;
    int frame_width;
    int frame_height;
    int last_error;
    char last_error_text[128];
    char last_property_text[256];
    bool using_gpu;
    bool initialized;
};

static struct mpv_web_state state;

EM_JS(void, mpv_web_console_log, (const char *prefix, const char *level,
                                  const char *text), {
    const prefixText = UTF8ToString(prefix);
    const levelText = UTF8ToString(level);
    const messageText = UTF8ToString(text).trimEnd();
    const formatted = `[mpv ${prefixText} ${levelText}] ${messageText}`;

    if (levelText === 'fatal' || levelText === 'error') {
        console.error(formatted);
    } else if (levelText === 'warn') {
        console.warn(formatted);
    } else if (levelText === 'info' || levelText === 'status') {
        console.info(formatted);
    } else {
        console.debug(formatted);
    }
});

static int remember_error(int rc)
{
    state.last_error = rc;
    const char *text = mpv_error_string(rc);
    snprintf(state.last_error_text, sizeof(state.last_error_text), "%s",
             text ? text : "unknown");
    return rc;
}

static int remember_error_at(const char *stage, int rc)
{
    remember_error(rc);
    const char *text = mpv_error_string(rc);
    snprintf(state.last_error_text, sizeof(state.last_error_text), "%s: %s",
             stage, text ? text : "unknown");
    return rc;
}

static int ensure_dir(const char *path)
{
    if (mkdir(path, 0777) == 0 || errno == EEXIST)
        return 0;
    return remember_error_at(path, MPV_ERROR_GENERIC);
}

static int set_option_string(mpv_handle *handle, const char *name, const char *value)
{
    int rc = mpv_set_option_string(handle, name, value);
    if (rc < 0) {
        remember_error(rc);
        const char *text = mpv_error_string(rc);
        snprintf(state.last_error_text, sizeof(state.last_error_text), "%s: %s",
                 name, text ? text : "unknown");
        return rc;
    }
    return 0;
}

static void *get_proc_address(void *ctx, const char *name)
{
    (void)ctx;

    void *proc = emscripten_webgl_get_proc_address(name);
    if (proc || !name || strncmp(name, "gl", 2) != 0)
        return proc;

    char aliased_name[128];
    int written = snprintf(aliased_name, sizeof(aliased_name),
                           "emscripten_%s", name);
    if (written <= 0 || written >= sizeof(aliased_name))
        return NULL;

    return emscripten_webgl_get_proc_address(aliased_name);
}

static void destroy_gl_context(void)
{
    if (state.gl) {
        emscripten_webgl_make_context_current(0);
        emscripten_webgl_destroy_context(state.gl);
        state.gl = 0;
    }
    state.using_gpu = false;
}

static int init_gpu_render_context(const char *canvas_selector)
{
    if (!canvas_selector || !canvas_selector[0])
        return MPV_ERROR_INVALID_PARAMETER;

    EmscriptenWebGLContextAttributes attributes;
    emscripten_webgl_init_context_attributes(&attributes);
    attributes.alpha = false;
    attributes.antialias = false;
    attributes.depth = true;
    attributes.stencil = false;
    attributes.premultipliedAlpha = false;
    attributes.enableExtensionsByDefault = true;
    attributes.majorVersion = 2;
    attributes.minorVersion = 0;

    state.gl = emscripten_webgl_create_context(canvas_selector, &attributes);
    if (state.gl <= 0) {
        state.gl = 0;
        return MPV_ERROR_UNSUPPORTED;
    }

    if (emscripten_webgl_make_context_current(state.gl) != EMSCRIPTEN_RESULT_SUCCESS) {
        destroy_gl_context();
        return MPV_ERROR_UNSUPPORTED;
    }

    mpv_opengl_init_params gl_init = {
        .get_proc_address = get_proc_address,
        .get_proc_address_ctx = NULL,
    };
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init},
        {0},
    };

    int rc = mpv_render_context_create(&state.render, state.mpv, params);
    if (rc < 0) {
        destroy_gl_context();
        return rc;
    }

    state.using_gpu = true;
    return 0;
}

static int init_sw_render_context(void)
{
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_SW},
        {0},
    };

    int rc = mpv_render_context_create(&state.render, state.mpv, params);
    if (rc < 0)
        return rc;

    state.using_gpu = false;
    return 0;
}

static void destroy_render_context(void)
{
    if (state.render) {
        mpv_render_context_free(state.render);
        state.render = NULL;
    }

    destroy_gl_context();

    free(state.frame_buffer);
    state.frame_buffer = NULL;
    state.frame_stride = 0;
    state.frame_width = 0;
    state.frame_height = 0;
}

static int ensure_frame_buffer(int width, int height)
{
    if (width <= 0 || height <= 0)
        return remember_error_at("frame_buffer", MPV_ERROR_INVALID_PARAMETER);

    if (state.frame_buffer && width == state.frame_width && height == state.frame_height)
        return 0;

    size_t stride = (size_t)width * 4;
    size_t size = stride * height;
    unsigned char *next = realloc(state.frame_buffer, size);
    if (!next)
        return remember_error_at("frame_buffer", MPV_ERROR_NOMEM);

    state.frame_buffer = next;
    state.frame_stride = stride;
    state.frame_width = width;
    state.frame_height = height;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_init(const char *canvas_selector)
{
    if (state.initialized)
        return 0;

    memset(&state, 0, sizeof(state));

    int rc = ensure_dir("/mpv");
    if (rc < 0)
        return rc;
    rc = ensure_dir("/input");
    if (rc < 0)
        return rc;

    state.mpv = mpv_create();
    if (!state.mpv)
        return remember_error_at("mpv_create", MPV_ERROR_NOMEM);

    const struct {
        const char *name;
        const char *value;
    } options[] = {
        {"terminal", "no"},
        {"config", "no"},
        {"keep-open", "yes"},
        {"idle", "yes"},
        {"vo", "libmpv"},
        {"ao", "emscripten"},
        {"audio-fallback-to-null", "no"},
        {"msg-level", "all=v"},
    };

    for (size_t index = 0; index < sizeof(options) / sizeof(options[0]); index++) {
        rc = set_option_string(state.mpv, options[index].name, options[index].value);
        if (rc < 0)
            return rc;
    }

    rc = mpv_initialize(state.mpv);
    if (rc < 0)
        return remember_error_at("mpv_initialize", rc);

    mpv_request_log_messages(state.mpv, "v");
    ao_emscripten_prepare_audio();

    rc = init_gpu_render_context(canvas_selector);
    if (rc < 0) {
        rc = init_sw_render_context();
        if (rc < 0)
            return remember_error_at("mpv_render_context_create", rc);
    }

    state.initialized = true;
    state.last_error = 0;
    state.last_error_text[0] = '\0';
    return 0;
}

EMSCRIPTEN_KEEPALIVE void mpv_web_destroy(void)
{
    destroy_render_context();

    if (state.mpv) {
        mpv_terminate_destroy(state.mpv);
        state.mpv = NULL;
    }

    ao_emscripten_shutdown_audio();

    memset(&state, 0, sizeof(state));
}

EMSCRIPTEN_KEEPALIVE int mpv_web_poll_events(void)
{
    if (!state.mpv)
        return remember_error(MPV_ERROR_UNINITIALIZED);

    int flags = 0;
    while (1) {
        mpv_event *event = mpv_wait_event(state.mpv, 0);
        if (!event || event->event_id == MPV_EVENT_NONE)
            break;

        switch (event->event_id) {
        case MPV_EVENT_LOG_MESSAGE: {
            mpv_event_log_message *msg = event->data;
            if (msg && msg->prefix && msg->level && msg->text)
                mpv_web_console_log(msg->prefix, msg->level, msg->text);
            break;
        }
        case MPV_EVENT_FILE_LOADED:
            flags |= 1 << 0;
            break;
        case MPV_EVENT_END_FILE:
            flags |= 1 << 1;
            break;
        case MPV_EVENT_VIDEO_RECONFIG:
            flags |= 1 << 2;
            break;
        case MPV_EVENT_SHUTDOWN:
            flags |= 1 << 3;
            break;
        default:
            break;
        }
    }

    return flags;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_needs_render(void)
{
    if (!state.render)
        return 0;

    return !!(mpv_render_context_update(state.render) & MPV_RENDER_UPDATE_FRAME);
}

EMSCRIPTEN_KEEPALIVE int mpv_web_render(int width, int height)
{
    if (!state.render)
        return remember_error(MPV_ERROR_UNINITIALIZED);

    if (width <= 0 || height <= 0)
        return remember_error(MPV_ERROR_INVALID_PARAMETER);

    if (state.using_gpu) {
        if (emscripten_webgl_make_context_current(state.gl) != EMSCRIPTEN_RESULT_SUCCESS)
            return remember_error(MPV_ERROR_GENERIC);

        mpv_opengl_fbo fbo = {
            .fbo = 0,
            .w = width,
            .h = height,
            .internal_format = 0,
        };
        int flip_y = 1;
        mpv_render_param params[] = {
            {MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
            {MPV_RENDER_PARAM_FLIP_Y, &flip_y},
            {0},
        };

        int rc = mpv_render_context_render(state.render, params);
        if (rc < 0)
            return remember_error(rc);
        mpv_render_context_report_swap(state.render);
        return 0;
    }

    int rc = ensure_frame_buffer(width, height);
    if (rc < 0)
        return rc;

    int size[2] = {width, height};
    char *format = "rgb0";
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_SW_SIZE, size},
        {MPV_RENDER_PARAM_SW_FORMAT, format},
        {MPV_RENDER_PARAM_SW_STRIDE, &state.frame_stride},
        {MPV_RENDER_PARAM_SW_POINTER, state.frame_buffer},
        {0},
    };

    rc = mpv_render_context_render(state.render, params);
    if (rc < 0)
        return remember_error(rc);
    return 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t mpv_web_get_frame_ptr(void)
{
    if (state.using_gpu)
        return 0;
    return (uintptr_t)state.frame_buffer;
}

EMSCRIPTEN_KEEPALIVE size_t mpv_web_get_frame_stride(void)
{
    if (state.using_gpu)
        return 0;
    return state.frame_stride;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_uses_gpu(void)
{
    return state.using_gpu;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_loadfile(const char *path)
{
    if (!state.mpv || !path || !path[0])
        return remember_error(MPV_ERROR_INVALID_PARAMETER);

    const char *cmd[] = {"loadfile", path, NULL};
    int rc = mpv_command(state.mpv, cmd);
    return rc < 0 ? remember_error(rc) : 0;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_seek_absolute(double seconds)
{
    if (!state.mpv)
        return remember_error(MPV_ERROR_UNINITIALIZED);

    char value[64];
    snprintf(value, sizeof(value), "%.6f", seconds);
    const char *cmd[] = {"seek", value, "absolute+exact", NULL};
    int rc = mpv_command(state.mpv, cmd);
    return rc < 0 ? remember_error(rc) : 0;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_set_property_flag(const char *name, int value)
{
    if (!state.mpv || !name || !name[0])
        return remember_error(MPV_ERROR_INVALID_PARAMETER);

    int flag = !!value;
    int rc = mpv_set_property(state.mpv, name, MPV_FORMAT_FLAG, &flag);
    return rc < 0 ? remember_error(rc) : 0;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_set_property_double(const char *name, double value)
{
    if (!state.mpv || !name || !name[0])
        return remember_error(MPV_ERROR_INVALID_PARAMETER);

    int rc = mpv_set_property(state.mpv, name, MPV_FORMAT_DOUBLE, &value);
    return rc < 0 ? remember_error(rc) : 0;
}

EMSCRIPTEN_KEEPALIVE double mpv_web_get_property_double(const char *name, double fallback)
{
    if (!state.mpv || !name || !name[0])
        return fallback;

    double value = fallback;
    int rc = mpv_get_property(state.mpv, name, MPV_FORMAT_DOUBLE, &value);
    return rc < 0 ? fallback : value;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_get_property_flag(const char *name, int fallback)
{
    if (!state.mpv || !name || !name[0])
        return fallback;

    int value = 0;
    int rc = mpv_get_property(state.mpv, name, MPV_FORMAT_FLAG, &value);
    return rc < 0 ? fallback : value;
}

EMSCRIPTEN_KEEPALIVE int mpv_web_get_last_error(void)
{
    return state.last_error;
}

EMSCRIPTEN_KEEPALIVE const char *mpv_web_get_last_error_string(void)
{
    return state.last_error_text;
}

EMSCRIPTEN_KEEPALIVE const char *mpv_web_get_property_string(const char *name)
{
    if (!state.mpv || !name)
        return NULL;

    char *value = mpv_get_property_string(state.mpv, name);
    if (!value)
        return NULL;

    snprintf(state.last_property_text, sizeof(state.last_property_text), "%s", value);
    mpv_free(value);
    return state.last_property_text;
}

EMSCRIPTEN_KEEPALIVE void mpv_web_resume_audio(void)
{
    ao_emscripten_resume_audio();
}

EMSCRIPTEN_KEEPALIVE int mpv_web_get_audio_setup_state(void)
{
    return ao_emscripten_get_setup_state();
}
