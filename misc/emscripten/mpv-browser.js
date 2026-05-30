import createMpvModule from './mpv.js';

const POLL_FILE_LOADED = 1 << 0;
const AUDIO_SETUP_IDLE = 0;
const AUDIO_SETUP_READY = 3;
const AUDIO_SETUP_FAILED = 4;
const forceSoftware = new URLSearchParams(window.location.search).get('gpu') === '0';

const elements = {
    stage: document.querySelector('.stage'),
    canvasGpu: document.querySelector('#mpv-canvas-gpu'),
    canvasSw: document.querySelector('#mpv-canvas-sw'),
    fileInput: document.querySelector('#file-input'),
    playPause: document.querySelector('#play-pause'),
    seek: document.querySelector('#seek'),
    volume: document.querySelector('#volume'),
    status: document.querySelector('#status-text'),
    clock: document.querySelector('#clock-text'),
    title: document.querySelector('#media-title'),
};

const state = {
    module: null,
    modulePromise: null,
    audioBridge: null,
    ready: false,
    ticking: false,
    draggingSeek: false,
    currentPath: null,
    forcedRender: true,
    context2d: null,
    imageData: null,
    usingGpu: false,
    currentMountPoint: null,
};

function setStatus(text) {
    elements.status.textContent = text;
}

function getErrorDetail(error, fallback = 'unknown') {
    const message = error instanceof Error ? error.message : String(error || fallback);

    if (state.module) {
        try {
            const lastError = api().getLastErrorString();
            if (lastError)
                return `${message} (${lastError})`;
        } catch {
            // Ignore follow-up reporting failures and preserve the original error.
        }
    }

    return message;
}

function ensureAudioBridge() {
    if (state.audioBridge)
        return state.audioBridge;

    state.audioBridge = {
        async start() {
            if (state.module)
                api().resumeAudio();
            return true;
        },
    };
    return state.audioBridge;
}

function unlockAudioOnGesture() {
    try {
        return (async () => {
            await ensureAudioBridge().start();
            if (state.module)
                await waitForAudioReady();
            return true;
        })();
    } catch (error) {
        return Promise.reject(error);
    }
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '--:--';

    const whole = Math.floor(seconds);
    const hrs = Math.floor(whole / 3600);
    const mins = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    if (hrs > 0)
        return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function removeMountedFile(path) {
    if (!path)
        return;

    try {
        state.module.FS.unlink(path);
    } catch {
        // Ignore stale paths.
    }
}

function unmountCurrentFile() {
    if (!state.module)
        return;

    if (state.currentMountPoint) {
        try {
            state.module.FS.unmount(state.currentMountPoint);
        } catch {
            // Ignore stale mounts.
        }

        try {
            state.module.FS.rmdir(state.currentMountPoint);
        } catch {
            // Ignore stale directories.
        }

        state.currentMountPoint = null;
    }

    removeMountedFile(state.currentPath);
    state.currentPath = null;
}

function api() {
    const module = state.module;
    return {
        init: (canvasSelector) => module.ccall('mpv_web_init', 'number', ['string'], [canvasSelector]),
        destroy: () => module.ccall('mpv_web_destroy', null, [], []),
        pollEvents: () => module.ccall('mpv_web_poll_events', 'number', [], []),
        needsRender: () => !!module.ccall('mpv_web_needs_render', 'number', [], []),
        render: (width, height) => module.ccall('mpv_web_render', 'number', ['number', 'number'], [width, height]),
        getFramePtr: () => module.ccall('mpv_web_get_frame_ptr', 'number', [], []),
        getFrameStride: () => module.ccall('mpv_web_get_frame_stride', 'number', [], []),
        loadFile: (path) => module.ccall('mpv_web_loadfile', 'number', ['string'], [path]),
        seekAbsolute: (seconds) => module.ccall('mpv_web_seek_absolute', 'number', ['number'], [seconds]),
        setPause: (paused) => module.ccall('mpv_web_set_property_flag', 'number', ['string', 'number'], ['pause', paused ? 1 : 0]),
        getPause: () => !!module.ccall('mpv_web_get_property_flag', 'number', ['string', 'number'], ['pause', 0]),
        setVolume: (value) => module.ccall('mpv_web_set_property_double', 'number', ['string', 'number'], ['volume', value]),
        getTimePos: () => module.ccall('mpv_web_get_property_double', 'number', ['string', 'number'], ['time-pos', 0]),
        getDuration: () => module.ccall('mpv_web_get_property_double', 'number', ['string', 'number'], ['duration', 0]),
        getPropertyString: (name) => module.ccall('mpv_web_get_property_string', 'string', ['string'], [name]),
        getLastError: () => module.ccall('mpv_web_get_last_error', 'number', [], []),
        getLastErrorString: () => module.ccall('mpv_web_get_last_error_string', 'string', [], []),
        getAudioSetupState: () => module.ccall('mpv_web_get_audio_setup_state', 'number', [], []),
        resumeAudio: () => module.ccall('mpv_web_resume_audio', null, [], []),
        usesGpu: () => !!module.ccall('mpv_web_uses_gpu', 'number', [], []),
    };
}

function delayFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForAudioReady(timeoutMs = 4000) {
    const deadline = performance.now() + timeoutMs;

    while (true) {
        const setupState = api().getAudioSetupState();
        if (setupState === AUDIO_SETUP_READY)
            return;
        if (setupState === AUDIO_SETUP_FAILED)
            throw new Error('browser audio initialization failed');

        if (setupState === AUDIO_SETUP_IDLE)
            api().resumeAudio();

        if (performance.now() >= deadline)
            throw new Error('timed out waiting for browser audio');

        await delayFrame();
    }
}

function renderModeLabel() {
    return state.usingGpu ? 'WebGL' : 'Software';
}

function setDropTarget(active) {
    elements.stage.classList.toggle('is-drop-target', active);
}

function activeCanvas() {
    return state.usingGpu ? elements.canvasGpu : elements.canvasSw;
}

function syncCanvasVisibility() {
    elements.canvasGpu.hidden = !state.usingGpu;
    elements.canvasSw.hidden = state.usingGpu;
}

function softwareCanvasContext() {
    if (!state.context2d)
        state.context2d = elements.canvasSw.getContext('2d', { alpha: false });
    return state.context2d;
}

function resizeCanvas() {
    const rect = activeCanvas().getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));

    let changed = false;
    for (const canvas of [elements.canvasGpu, elements.canvasSw]) {
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            changed = true;
        }
    }

    if (changed)
        state.forcedRender = true;
}

function ensureSoftwareCanvasSize(width, height) {
    if (elements.canvasSw.width !== width || elements.canvasSw.height !== height) {
        elements.canvasSw.width = width;
        elements.canvasSw.height = height;
    }
}

function presentFrame(width, height) {
    if (state.usingGpu)
        return;

    ensureSoftwareCanvasSize(width, height);
    const context2d = softwareCanvasContext();
    if (!context2d)
        throw new Error('2D canvas context is unavailable');

    const player = api();
    const ptr = player.getFramePtr();
    const stride = player.getFrameStride();
    if (!ptr || !stride)
        return;

    if (!state.imageData || state.imageData.width !== width || state.imageData.height !== height)
        state.imageData = context2d.createImageData(width, height);

    const bytes = width * height * 4;
    const source = state.module.HEAPU8.subarray(ptr, ptr + Math.max(bytes, stride * height));
    state.imageData.data.set(source.subarray(0, bytes));
    for (let index = 3; index < state.imageData.data.length; index += 4)
        state.imageData.data[index] = 255;

    context2d.putImageData(state.imageData, 0, 0);
}

async function mountFile(file) {
    const module = state.module;
    const workerFs = module?.FS?.filesystems?.WORKERFS;

    if (workerFs) {
        const mountedFile = file.name ? file : new File([file], 'input.bin', {
            type: file.type,
            lastModified: file.lastModified,
        });
        const mountPoint = '/input/current';

        unmountCurrentFile();
        module.FS.mkdirTree(mountPoint);
        module.FS.mount(workerFs, { files: [mountedFile] }, mountPoint);

        state.currentMountPoint = mountPoint;
        state.currentPath = `${mountPoint}/${mountedFile.name}`;
        elements.title.textContent = mountedFile.name;
        setStatus('Loading media');

        const rc = api().loadFile(state.currentPath);
        if (rc < 0)
            throw new Error(`loadfile failed: ${rc}`);

        state.forcedRender = true;
        return;
    }

    const buffer = await file.arrayBuffer();
    return mountBytes(file.name || 'input.bin', new Uint8Array(buffer));
}

async function mountBytes(name, bytes) {
    const module = state.module;
    const sanitized = sanitizeFilename(name);
    const path = `/input/${sanitized}`;

    unmountCurrentFile();

    module.FS.writeFile(path, bytes);
    state.currentPath = path;
    elements.title.textContent = name;
    setStatus('Loading media');

    const rc = api().loadFile(path);
    if (rc < 0)
        throw new Error(`loadfile failed: ${rc}`);

    state.forcedRender = true;
}

function refreshUi() {
    const player = api();
    const paused = player.getPause();
    const duration = player.getDuration();
    const position = player.getTimePos();

    elements.playPause.textContent = paused ? 'Play' : 'Pause';
    elements.clock.textContent = `${formatTime(position)} / ${formatTime(duration)}`;

    if (!state.draggingSeek && duration > 0) {
        elements.seek.value = String(Math.min(1000, Math.max(0, (position / duration) * 1000)));
    }
}

function tick() {
    if (!state.ready)
        return;

    resizeCanvas();

    const flags = api().pollEvents();
    if (flags & POLL_FILE_LOADED)
        setStatus('Ready');

    if (state.forcedRender || api().needsRender()) {
        const canvas = activeCanvas();
        api().render(canvas.width, canvas.height);
        presentFrame(canvas.width, canvas.height);
        state.forcedRender = false;
    }

    refreshUi();
    requestAnimationFrame(tick);
}

async function ensureModuleLoaded() {
    if (state.module)
        return;

    if (!state.modulePromise) {
        state.modulePromise = (async () => {
            try {
                setStatus('Initializing WebAssembly module');

                state.module = await createMpvModule({
                    locateFile: (file) => new URL(file, import.meta.url).href,
                    printErr: (message) => console.error(message),
                });

                if (state.module.pthreadPoolReady) {
                    setStatus('Preparing worker pool');
                    await state.module.pthreadPoolReady;
                }
            } catch (error) {
                state.module = null;
                state.modulePromise = null;
                throw error;
            }
        })();
    }

    await state.modulePromise;
}

async function ensurePlayerInitialized() {
    if (state.ready)
        return;

    await ensureModuleLoaded();

    const rc = api().init(forceSoftware ? '' : '#mpv-canvas-gpu');
    if (rc < 0)
        throw new Error(`mpv_web_init failed: ${rc} (${api().getLastErrorString() || 'unknown'})`);

    state.usingGpu = api().usesGpu();
    if (!state.usingGpu)
        state.context2d = softwareCanvasContext();
    syncCanvasVisibility();

    state.ready = true;
    setStatus(`Choose a file to start playback (${renderModeLabel()})`);

    if (!state.ticking) {
        state.ticking = true;
        requestAnimationFrame(tick);
    }
}

async function bootstrap() {
    setStatus('Choose a file to start playback');
    syncCanvasVisibility();
    ensureAudioBridge();

    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(elements.canvasGpu);

    elements.fileInput.addEventListener('change', async (event) => {
        const [file] = event.target.files || [];
        if (!file)
            return;

        try {
            await ensurePlayerInitialized();
            const audioReady = unlockAudioOnGesture();
            await audioReady;
            await mountFile(file);
        } catch (error) {
            console.error(error);
            setStatus(`Load failed: ${getErrorDetail(error)}`);
        }
    });

    elements.stage.addEventListener('dragenter', (event) => {
        event.preventDefault();
        setDropTarget(true);
    });

    elements.stage.addEventListener('dragover', (event) => {
        event.preventDefault();
        setDropTarget(true);
    });

    elements.stage.addEventListener('dragleave', (event) => {
        if (event.target === elements.stage || event.target === elements.canvasGpu || event.target === elements.canvasSw)
            setDropTarget(false);
    });

    elements.stage.addEventListener('drop', async (event) => {
        event.preventDefault();
        setDropTarget(false);
        const [file] = event.dataTransfer?.files || [];
        if (!file)
            return;

        try {
            await ensurePlayerInitialized();
            const audioReady = unlockAudioOnGesture();
            await audioReady;
            await mountFile(file);
        } catch (error) {
            console.error(error);
            setStatus(`Drop failed: ${getErrorDetail(error)}`);
        }
    });

    elements.playPause.addEventListener('click', async () => {
        await ensurePlayerInitialized();
        const audioReady = unlockAudioOnGesture();
        await audioReady;
        const paused = api().getPause();
        api().setPause(!paused);
        state.forcedRender = true;
    });

    elements.seek.addEventListener('input', () => {
        state.draggingSeek = true;
    });

    elements.seek.addEventListener('change', () => {
        if (!state.ready) {
            state.draggingSeek = false;
            return;
        }
        const duration = api().getDuration();
        if (duration > 0)
            api().seekAbsolute((Number(elements.seek.value) / 1000) * duration);
        state.draggingSeek = false;
        state.forcedRender = true;
    });

    elements.volume.addEventListener('input', () => {
        if (!state.ready)
            return;
        api().setVolume(Number(elements.volume.value));
    });
}

bootstrap().catch((error) => {
    console.error(error);
    setStatus(String(error));
});
