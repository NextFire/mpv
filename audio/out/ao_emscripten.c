/*
 * Emscripten/browser audio output scaffold.
 *
 * This file is part of mpv.
 *
 * mpv is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * mpv is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with mpv.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "mpv_talloc.h"

#include "audio/format.h"
#include "common/common.h"
#include "common/msg.h"
#include "options/m_option.h"
#include "osdep/timer.h"
#include "ao.h"
#include "internal.h"

void ao_emscripten_prepare_audio(void);
void ao_emscripten_resume_audio(void);
void ao_emscripten_shutdown_audio(void);

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/atomic.h>
#include <emscripten/threading_legacy.h>
#include <emscripten/threading.h>
#include <emscripten/threading_primitives.h>
#include <emscripten/webaudio.h>

enum audio_setup_state {
    AUDIO_SETUP_IDLE = 0,
    AUDIO_SETUP_STARTING_THREAD,
    AUDIO_SETUP_STARTING_PROCESSOR,
    AUDIO_SETUP_READY,
    AUDIO_SETUP_FAILED,
};

struct audio_runtime {
    atomic_uint setup_state;
    atomic_bool paused;
    atomic_bool started;
    atomic_uint read_pos;
    atomic_uint write_pos;
    EMSCRIPTEN_WEBAUDIO_T context;
    EMSCRIPTEN_AUDIO_WORKLET_NODE_T node;
    float *ring_buffer;
    uint32_t ring_capacity;
    int ring_channels;
    int samplerate;
    int quantum_size;
    void *stack;
    uint32_t stack_size;
};

static struct audio_runtime runtime;

static void signal_setup_state(unsigned state)
{
    atomic_store_explicit(&runtime.setup_state, state, memory_order_release);
    emscripten_atomic_notify((void *)&runtime.setup_state,
                             EMSCRIPTEN_NOTIFY_ALL_WAITERS);
}

static void silence_outputs(int num_outputs, AudioSampleFrame *outputs)
{
    for (int index = 0; index < num_outputs; index++) {
        AudioSampleFrame *frame = &outputs[index];
        memset(frame->data, 0,
               sizeof(float) * frame->numberOfChannels * frame->samplesPerChannel);
    }
}

static uint32_t ring_used_samples(uint32_t write_pos, uint32_t read_pos)
{
    if (!runtime.ring_capacity)
        return 0;
    if (write_pos >= read_pos)
        return write_pos - read_pos;
    return runtime.ring_capacity - read_pos + write_pos;
}

static uint32_t ring_free_samples(uint32_t write_pos, uint32_t read_pos)
{
    if (!runtime.ring_capacity)
        return 0;
    return runtime.ring_capacity - ring_used_samples(write_pos, read_pos) - 1;
}

static void reset_ring_buffer(void)
{
    atomic_store_explicit(&runtime.read_pos, 0, memory_order_relaxed);
    atomic_store_explicit(&runtime.write_pos, 0, memory_order_relaxed);
}

static bool ensure_ring_buffer(int channels, uint32_t capacity)
{
    if (runtime.ring_buffer && runtime.ring_capacity == capacity &&
        runtime.ring_channels == channels)
    {
        reset_ring_buffer();
        return true;
    }

    float *next = realloc(runtime.ring_buffer,
                          (size_t)capacity * channels * sizeof(float));
    if (!next)
        return false;

    runtime.ring_buffer = next;
    runtime.ring_capacity = capacity;
    runtime.ring_channels = channels;
    reset_ring_buffer();
    return true;
}

static bool process_audio(int num_inputs, const AudioSampleFrame *inputs,
                          int num_outputs, AudioSampleFrame *outputs,
                          int num_params, const AudioParamFrame *params,
                          void *user_data)
{
    (void)num_inputs;
    (void)inputs;
    (void)num_params;
    (void)params;

    struct audio_runtime *audio = user_data;
    silence_outputs(num_outputs, outputs);

    if (!audio || num_outputs < 1)
        return true;
    if (atomic_load_explicit(&audio->paused, memory_order_relaxed))
        return true;
    if (!atomic_load_explicit(&audio->started, memory_order_relaxed))
        return true;

    AudioSampleFrame *frame = &outputs[0];
    if (!audio->ring_buffer || !audio->ring_capacity ||
        frame->numberOfChannels != audio->ring_channels)
        return true;

    uint32_t read_pos = atomic_load_explicit(&audio->read_pos, memory_order_relaxed);
    uint32_t write_pos = atomic_load_explicit(&audio->write_pos, memory_order_acquire);
    int read = MPMIN(frame->samplesPerChannel,
                     (int)ring_used_samples(write_pos, read_pos));

    for (int sample = 0; sample < read; sample++) {
        uint32_t index = (read_pos + sample) % audio->ring_capacity;
        float *src = &audio->ring_buffer[index * audio->ring_channels];
        for (int channel = 0; channel < audio->ring_channels; channel++)
            frame->data[channel * frame->samplesPerChannel + sample] = src[channel];
    }

    if (read > 0) {
        atomic_store_explicit(&audio->read_pos,
                              (read_pos + read) % audio->ring_capacity,
                              memory_order_release);
    }
    return true;
}

static void destroy_node_mainthread(void)
{
    if (!runtime.node)
        return;

    emscripten_destroy_web_audio_node(runtime.node);
    runtime.node = 0;
}

static int create_node_mainthread(int channels)
{
    if (!runtime.context)
        return 0;

    destroy_node_mainthread();

    int output_channel_counts[1] = {channels};
    EmscriptenAudioWorkletNodeCreateOptions options = {
        .numberOfInputs = 0,
        .numberOfOutputs = 1,
        .outputChannelCounts = output_channel_counts,
        .channelCount = channels,
        .channelCountMode = WEBAUDIO_CHANNEL_COUNT_MODE_EXPLICIT,
        .channelInterpretation = WEBAUDIO_CHANNEL_INTERPRETATION_SPEAKERS,
    };

    runtime.node = emscripten_create_wasm_audio_worklet_node(
        runtime.context, "mpv-output", &options, process_audio, &runtime);
    if (!runtime.node)
        return 0;

    emscripten_audio_node_connect(runtime.node, runtime.context, 0, 0);
    return runtime.node;
}

static void destroy_audio_mainthread(void)
{
    destroy_node_mainthread();
    if (runtime.context) {
        emscripten_destroy_audio_context(runtime.context);
        runtime.context = 0;
    }
    free(runtime.stack);
    runtime.stack = NULL;
    runtime.stack_size = 0;
    runtime.samplerate = 0;
    runtime.quantum_size = 0;
    atomic_store_explicit(&runtime.paused, true, memory_order_relaxed);
    atomic_store_explicit(&runtime.started, false, memory_order_relaxed);
    free(runtime.ring_buffer);
    runtime.ring_buffer = NULL;
    runtime.ring_capacity = 0;
    runtime.ring_channels = 0;
    signal_setup_state(AUDIO_SETUP_IDLE);
}

static int audio_context_state_mainthread(void)
{
    if (!runtime.context)
        return -1;
    return emscripten_audio_context_state(runtime.context);
}

static void resume_audio_mainthread(void)
{
    if (runtime.context)
        emscripten_resume_audio_context_sync(runtime.context);
}

static void processor_created(EMSCRIPTEN_WEBAUDIO_T audio_context, bool success,
                              void *user_data)
{
    (void)audio_context;
    (void)user_data;

    if (!success) {
        signal_setup_state(AUDIO_SETUP_FAILED);
        return;
    }

    runtime.samplerate = emscripten_audio_context_sample_rate(runtime.context);
    runtime.quantum_size = emscripten_audio_context_quantum_size(runtime.context);
    signal_setup_state(AUDIO_SETUP_READY);
}

static void thread_started(EMSCRIPTEN_WEBAUDIO_T audio_context, bool success,
                           void *user_data)
{
    (void)audio_context;
    (void)user_data;

    if (!success) {
        signal_setup_state(AUDIO_SETUP_FAILED);
        return;
    }

    signal_setup_state(AUDIO_SETUP_STARTING_PROCESSOR);
    WebAudioWorkletProcessorCreateOptions options = {
        .name = "mpv-output",
        .numAudioParams = 0,
        .audioParamDescriptors = NULL,
    };
    emscripten_create_wasm_audio_worklet_processor_async(
        runtime.context, &options, processor_created, NULL);
}

static void prepare_audio_mainthread(void)
{
    unsigned state = atomic_load_explicit(&runtime.setup_state, memory_order_acquire);
    if (state != AUDIO_SETUP_IDLE)
        return;

    EmscriptenWebAudioCreateAttributes attributes = {
        .latencyHint = "interactive",
        .sampleRate = 0,
        .renderSizeHint = AUDIO_CONTEXT_RENDER_SIZE_DEFAULT,
    };

    runtime.context = emscripten_create_audio_context(&attributes);
    if (!runtime.context) {
        signal_setup_state(AUDIO_SETUP_FAILED);
        return;
    }

    if (!runtime.stack) {
        runtime.stack_size = 1024 * 1024;
        runtime.stack = aligned_alloc(16, runtime.stack_size);
        if (!runtime.stack) {
            emscripten_destroy_audio_context(runtime.context);
            runtime.context = 0;
            signal_setup_state(AUDIO_SETUP_FAILED);
            return;
        }
    }

    runtime.samplerate = emscripten_audio_context_sample_rate(runtime.context);
    runtime.quantum_size = emscripten_audio_context_quantum_size(runtime.context);
    signal_setup_state(AUDIO_SETUP_STARTING_THREAD);
    emscripten_start_wasm_audio_worklet_thread_async(
        runtime.context, runtime.stack, runtime.stack_size, thread_started, NULL);
}

EMSCRIPTEN_KEEPALIVE void ao_emscripten_prepare_audio(void)
{
    if (emscripten_is_main_runtime_thread()) {
        prepare_audio_mainthread();
    } else {
        emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_V,
                                                   prepare_audio_mainthread);
    }
}

static bool wait_for_audio_ready(void)
{
    ao_emscripten_prepare_audio();

    while (1) {
        unsigned state = atomic_load_explicit(&runtime.setup_state, memory_order_acquire);
        if (state == AUDIO_SETUP_READY)
            return true;
        if (state == AUDIO_SETUP_FAILED)
            return false;

        if (emscripten_is_main_runtime_thread())
            return false;

        emscripten_atomic_wait_u32((void *)&runtime.setup_state, state,
                                   100000000);
    }
}

EMSCRIPTEN_KEEPALIVE void ao_emscripten_resume_audio(void)
{
    ao_emscripten_prepare_audio();
    if (emscripten_is_main_runtime_thread()) {
        resume_audio_mainthread();
    } else {
        emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_V,
                                                    resume_audio_mainthread);
    }
}

EMSCRIPTEN_KEEPALIVE void ao_emscripten_shutdown_audio(void)
{
    if (emscripten_is_main_runtime_thread()) {
        destroy_audio_mainthread();
    } else {
        emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_V,
                                                   destroy_audio_mainthread);
    }
}

EMSCRIPTEN_KEEPALIVE int ao_emscripten_get_setup_state(void)
{
    return atomic_load_explicit(&runtime.setup_state, memory_order_acquire);
}
#else
void ao_emscripten_prepare_audio(void) {}
void ao_emscripten_resume_audio(void) {}
void ao_emscripten_shutdown_audio(void) {}
int ao_emscripten_get_setup_state(void) { return 0; }
#endif

struct priv {
    bool paused;
    float bufferlen;
    int outburst;
};

static int init(struct ao *ao)
{
    struct priv *priv = ao->priv;

    ao->format = AF_FORMAT_FLOAT;

    struct mp_chmap_sel sel = {.tmp = ao};
    mp_chmap_sel_add_any(&sel);
    if (!ao_chmap_sel_adjust(ao, &sel, &ao->channels))
        mp_chmap_from_channels(&ao->channels, 2);

    if (!wait_for_audio_ready()) {
        MP_VERBOSE(ao, "browser audio worklet unavailable\n");
        return -1;
    }

    if (runtime.samplerate > 0)
        ao->samplerate = runtime.samplerate;

    atomic_store_explicit(&runtime.paused, true, memory_order_relaxed);
    atomic_store_explicit(&runtime.started, false, memory_order_relaxed);

#ifdef __EMSCRIPTEN__
    int node = emscripten_is_main_runtime_thread()
        ? create_node_mainthread(ao->channels.num)
        : emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_II,
                                                     create_node_mainthread,
                                                     ao->channels.num);
    if (!node) {
        MP_ERR(ao, "failed to create browser audio worklet node\n");
        return -1;
    }
#endif

    int period = runtime.quantum_size > 0 ? runtime.quantum_size : 128;
    priv->outburst = period;
    ao->device_buffer = MPMAX(period * 8, (int)(ao->samplerate * priv->bufferlen));
    if (!ensure_ring_buffer(ao->channels.num, ao->device_buffer + 1)) {
        MP_ERR(ao, "failed to allocate browser audio ring buffer\n");
        return -1;
    }
    return 0;
}

static void uninit(struct ao *ao)
{
    (void)ao;

    atomic_store_explicit(&runtime.paused, true, memory_order_relaxed);
    atomic_store_explicit(&runtime.started, false, memory_order_relaxed);
    reset_ring_buffer();

#ifdef __EMSCRIPTEN__
    if (emscripten_is_main_runtime_thread()) {
        destroy_node_mainthread();
    } else {
        emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_V,
                                                   destroy_node_mainthread);
    }
#endif
}

static void reset(struct ao *ao)
{
    (void)ao;

    atomic_store_explicit(&runtime.paused, true, memory_order_relaxed);
    atomic_store_explicit(&runtime.started, false, memory_order_relaxed);
    reset_ring_buffer();
}

static void start(struct ao *ao)
{
    struct priv *priv = ao->priv;

    priv->paused = false;
    atomic_store_explicit(&runtime.paused, false, memory_order_relaxed);
    atomic_store_explicit(&runtime.started, true, memory_order_relaxed);
}

static bool set_pause(struct ao *ao, bool paused)
{
    struct priv *priv = ao->priv;

    priv->paused = paused;
    atomic_store_explicit(&runtime.paused, paused, memory_order_relaxed);
    return true;
}

static bool audio_write(struct ao *ao, void **data, int samples)
{
    if (!runtime.ring_buffer || !runtime.ring_capacity)
        return false;

    const float *src = data[0];
    uint32_t write_pos = atomic_load_explicit(&runtime.write_pos, memory_order_relaxed);
    uint32_t read_pos = atomic_load_explicit(&runtime.read_pos, memory_order_acquire);
    uint32_t free_samples = ring_free_samples(write_pos, read_pos);
    if ((uint32_t)samples > free_samples)
        samples = free_samples;
    if (samples <= 0)
        return true;

    int channels = runtime.ring_channels;
    int first = MPMIN(samples, (int)(runtime.ring_capacity - write_pos));
    memcpy(&runtime.ring_buffer[write_pos * channels], src,
           (size_t)first * channels * sizeof(float));
    if (samples > first) {
        memcpy(runtime.ring_buffer, src + first * channels,
               (size_t)(samples - first) * channels * sizeof(float));
    }

    atomic_store_explicit(&runtime.write_pos,
                          (write_pos + samples) % runtime.ring_capacity,
                          memory_order_release);
    return true;
}

static void get_state(struct ao *ao, struct mp_pcm_state *state)
{
    struct priv *priv = ao->priv;

    uint32_t read_pos = atomic_load_explicit(&runtime.read_pos, memory_order_relaxed);
    uint32_t write_pos = atomic_load_explicit(&runtime.write_pos, memory_order_acquire);
    int queued = ring_used_samples(write_pos, read_pos);
    int free_samples = ring_free_samples(write_pos, read_pos);

    state->free_samples = free_samples / priv->outburst * priv->outburst;
    state->queued_samples = queued;
    state->delay = queued / (double)ao->samplerate;
    state->playing = atomic_load_explicit(&runtime.started, memory_order_relaxed) &&
                     queued > 0 &&
                     !atomic_load_explicit(&runtime.paused, memory_order_relaxed);
}

#define OPT_BASE_STRUCT struct priv

const struct ao_driver audio_out_emscripten = {
    .description = "Emscripten Wasm Audio Worklet output",
    .name = "emscripten",
    .init = init,
    .uninit = uninit,
    .reset = reset,
    .get_state = get_state,
    .set_pause = set_pause,
    .write = audio_write,
    .start = start,
    .priv_size = sizeof(struct priv),
    .priv_defaults = &(const struct priv) {
        .bufferlen = 0.2,
        .outburst = 128,
    },
    .options = (const struct m_option[]) {
        {"buffer", OPT_FLOAT(bufferlen), M_RANGE(0, 10)},
        {0}
    },
    .options_prefix = "ao-emscripten",
};
