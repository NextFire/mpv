type TypedArrayView =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array;

type BinaryBufferSource = ArrayBuffer | TypedArrayView;
type LoadSource = string | File | Blob | BinaryBufferSource;
type RenderMode = "WebGL" | "Software";
type EmptyDetail = Record<string, never>;

interface MpvFs {
    filesystems?: { WORKERFS?: unknown };
    mkdirTree(path: string): void;
    mount(type: unknown, options: { files: File[] }, mountPoint: string): void;
    rmdir(path: string): void;
    unlink(path: string): void;
    unmount(mountPoint: string): void;
    writeFile(path: string, data: Uint8Array): void;
}

interface MpvModule {
    ccall(
        ident: string,
        returnType: string | null,
        argTypes: string[],
        args: unknown[],
    ): any;
    FS: MpvFs;
    HEAPU8: Uint8Array;
    pthreadPoolReady?: Promise<void>;
}

interface MpvApi {
    addSubtitle(path: string): number;
    commandString(command: string): number;
    destroy(): void;
    getAudioSetupState(): number;
    getDuration(): number;
    getFramePtr(): number;
    getFrameStride(): number;
    getLastErrorString(): string | null;
    getPause(): boolean;
    getPropertyDouble(name: string, fallback: number): number;
    getPropertyFlag(name: string, fallback: number): number;
    getPropertyString(name: string): string | null;
    getTimePos(): number;
    init(canvasSelector: string): number;
    loadFile(path: string): number;
    needsRender(): boolean;
    pollEvents(): number;
    render(width: number, height: number): number;
    resumeAudio(): void;
    seekAbsolute(seconds: number): number;
    setPause(paused: boolean): number;
    setPropertyDouble(name: string, value: number): number;
    setPropertyFlag(name: string, value: boolean): number;
    setPropertyString(name: string, value: string): number;
    setVolume(value: number): number;
    usesGpu(): boolean;
}

type MpvModuleFactoryOptions = Record<string, unknown> & {
    locateFile: (file: string) => string;
    printErr: (message: string) => void;
};

type MpvModuleFactory = (
    options: MpvModuleFactoryOptions,
) => Promise<MpvModule>;

type ResolvedMpvPlayerOptions = {
    target: HTMLElement;
    autoActivate: boolean;
    aspectRatio: string;
    gpu: boolean;
    initialVolume: number;
    locateFile: ((file: string) => string) | undefined;
    moduleOptions: Record<string, unknown>;
    printErr: ((message: string) => void) | undefined;
};

interface MpvPlayerOptionsInput {
    target?: HTMLElement;
    autoActivate?: boolean;
    aspectRatio?: string;
    gpu?: boolean;
    initialVolume?: number;
    locateFile?: (file: string) => string;
    moduleOptions?: Record<string, unknown>;
    printErr?: (message: string) => void;
}

export interface MpvPlayerState {
    duration: number;
    paused: boolean;
    position: number;
    ready: boolean;
    renderMode: RenderMode;
    title: string;
}

export interface MpvPlayerOptions {
    target: HTMLElement;
    autoActivate?: boolean;
    aspectRatio?: string;
    gpu?: boolean;
    initialVolume?: number;
    locateFile?: (file: string) => string;
    moduleOptions?: Record<string, unknown>;
    printErr?: (message: string) => void;
}

export interface MpvLoadOptions {
    activate?: boolean;
    fetchOptions?: RequestInit;
    name?: string;
}

export interface MpvPlayerEventMap {
    destroy: CustomEvent<EmptyDetail>;
    ended: CustomEvent<MpvPlayerState>;
    error: CustomEvent<{ error: unknown; message: string }>;
    fileloaded: CustomEvent<MpvPlayerState>;
    ready: CustomEvent<{ renderMode: RenderMode }>;
    shutdown: CustomEvent<EmptyDetail>;
    statechange: CustomEvent<MpvPlayerState>;
    statuschange: CustomEvent<{ status: string }>;
}

type EventDetail<K extends keyof MpvPlayerEventMap> =
    MpvPlayerEventMap[K] extends CustomEvent<infer Detail> ? Detail : never;

const POLL_FILE_LOADED = 1 << 0;
const POLL_END_FILE = 1 << 1;
const POLL_VIDEO_RECONFIG = 1 << 2;
const POLL_SHUTDOWN = 1 << 3;

const AUDIO_SETUP_IDLE = 0;
const AUDIO_SETUP_READY = 3;
const AUDIO_SETUP_FAILED = 4;

const EMPTY_DETAIL = Object.freeze({}) as EmptyDetail;

let nextPlayerId = 0;

async function loadMpvModuleFactory(): Promise<MpvModuleFactory> {
    const moduleUrl = new URL("./mpv.js", import.meta.url).href;
    const importedModule = (await import(moduleUrl)) as {
        default: MpvModuleFactory;
    };
    return importedModule.default;
}

function isElement(value: unknown): value is HTMLElement {
    return value instanceof HTMLElement;
}

function isFile(value: unknown): value is File {
    return typeof File !== "undefined" && value instanceof File;
}

function isBlob(value: unknown): value is Blob {
    return typeof Blob !== "undefined" && value instanceof Blob;
}

function isTypedArray(value: unknown): value is TypedArrayView {
    return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function sanitizeFilename(name?: string | null): string {
    return String(name || "input.bin").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function inferNameFromUrl(url: string): string {
    try {
        const parsed = new URL(url, window.location.href);
        const name = parsed.pathname.split("/").pop();
        return name || "input.bin";
    } catch {
        return "input.bin";
    }
}

function toUint8Array(input: BinaryBufferSource): Uint8Array {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (isTypedArray(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError("Expected Uint8Array, TypedArray, or ArrayBuffer");
}

function snapshotsEqual(
    left: MpvPlayerState | null,
    right: MpvPlayerState | null,
): boolean {
    if (!left || !right) return false;

    return (
        left.ready === right.ready &&
        left.paused === right.paused &&
        left.duration === right.duration &&
        left.position === right.position &&
        left.title === right.title &&
        left.renderMode === right.renderMode
    );
}

function buildEvent<K extends keyof MpvPlayerEventMap>(
    name: K,
    detail: EventDetail<K>,
): MpvPlayerEventMap[K] {
    return new CustomEvent(name, { detail }) as MpvPlayerEventMap[K];
}

function normalizeOptions(
    options: HTMLElement | MpvPlayerOptionsInput | undefined,
): MpvPlayerOptionsInput {
    if (isElement(options)) return { target: options };
    return options || {};
}

export class MpvPlayer extends EventTarget {
    readonly options: MpvPlayerOptions;

    private readonly resolvedOptions: ResolvedMpvPlayerOptions;
    private readonly id: number;
    private module: MpvModule | null;
    private modulePromise: Promise<MpvModule> | null;
    private readyState: boolean;
    private running: boolean;
    private animationFrame: number;
    private draggingSeek: boolean;
    private forceRender: boolean;
    private context2d: CanvasRenderingContext2D | null;
    private imageData: ImageData | null;
    private currentMountPoint: string | null;
    private currentPath: string | null;
    private currentTitle: string;
    private auxiliaryPathSeq: number;
    private readonly auxiliaryPaths: Set<string>;
    private lastSnapshot: MpvPlayerState | null;
    private lastStatus: string;
    private lastTickError: string;
    private usingGpu: boolean;
    private autoActivateHandler: ((event: Event) => void) | null;
    private readonly root: HTMLDivElement;
    private readonly canvasGpu: HTMLCanvasElement;
    private readonly canvasSw: HTMLCanvasElement;
    private readonly resizeObserver: ResizeObserver;

    constructor(options: MpvPlayerOptions | HTMLElement);
    constructor(options: MpvPlayerOptions | HTMLElement = {} as MpvPlayerOptions) {
        super();

        const normalized = normalizeOptions(options);
        if (!isElement(normalized.target)) {
            throw new TypeError("MpvPlayer requires a target HTMLElement");
        }

        const resolvedOptions: ResolvedMpvPlayerOptions = {
            target: normalized.target,
            autoActivate: normalized.autoActivate !== false,
            aspectRatio: normalized.aspectRatio || "16 / 9",
            gpu: normalized.gpu !== false,
            initialVolume: normalized.initialVolume ?? 100,
            locateFile: normalized.locateFile,
            moduleOptions: normalized.moduleOptions || {},
            printErr: normalized.printErr,
        };

        this.options = resolvedOptions;
        this.resolvedOptions = resolvedOptions;
        this.id = ++nextPlayerId;
        this.module = null;
        this.modulePromise = null;
        this.readyState = false;
        this.running = false;
        this.animationFrame = 0;
        this.draggingSeek = false;
        this.forceRender = true;
        this.context2d = null;
        this.imageData = null;
        this.currentMountPoint = null;
        this.currentPath = null;
        this.currentTitle = "";
        this.auxiliaryPathSeq = 0;
        this.auxiliaryPaths = new Set();
        this.lastSnapshot = null;
        this.lastStatus = "";
        this.lastTickError = "";
        this.usingGpu = false;
        this.autoActivateHandler = null;

        this.root = document.createElement("div");
        this.root.className = "mpv-player-root";
        this.root.style.position = "relative";
        this.root.style.width = "100%";
        this.root.style.height = "100%";
        this.root.style.aspectRatio = this.resolvedOptions.aspectRatio;
        this.root.style.overflow = "hidden";
        this.root.style.borderRadius = "inherit";
        this.root.style.background = "#101516";

        this.canvasGpu = document.createElement("canvas");
        this.canvasSw = document.createElement("canvas");
        this.canvasGpu.id = `mpv-player-${this.id}-gpu`;
        this.canvasSw.id = `mpv-player-${this.id}-sw`;

        for (const canvas of [this.canvasGpu, this.canvasSw]) {
            canvas.style.position = "absolute";
            canvas.style.inset = "0";
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            canvas.style.display = "block";
            canvas.style.background = "#101516";
            canvas.style.borderRadius = "inherit";
            this.root.appendChild(canvas);
        }

        this.canvasGpu.style.zIndex = "1";
        this.canvasSw.style.zIndex = "0";

        this.resolvedOptions.target.replaceChildren(this.root);
        this.syncCanvasVisibility(false);

        this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        this.resizeObserver.observe(this.root);

        if (this.resolvedOptions.autoActivate) {
            const autoActivateHandler = () => {
                this.activate().catch(() => {});
            };
            this.autoActivateHandler = autoActivateHandler;
            this.resolvedOptions.target.addEventListener(
                "pointerdown",
                autoActivateHandler,
                { passive: true },
            );
            this.resolvedOptions.target.addEventListener(
                "keydown",
                autoActivateHandler,
            );
        }
    }

    get ready(): boolean {
        return this.readyState;
    }

    on<K extends keyof MpvPlayerEventMap>(
        type: K,
        listener: (event: MpvPlayerEventMap[K]) => void,
        options?: AddEventListenerOptions | boolean,
    ): this;
    on(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean,
    ): this;
    on(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean,
    ): this {
        this.addEventListener(type, listener, options);
        return this;
    }

    off<K extends keyof MpvPlayerEventMap>(
        type: K,
        listener: (event: MpvPlayerEventMap[K]) => void,
        options?: EventListenerOptions | boolean,
    ): this;
    off(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean,
    ): this;
    off(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean,
    ): this {
        this.removeEventListener(type, listener, options);
        return this;
    }

    async initialize(): Promise<this> {
        if (this.readyState) return this;

        await this.ensureModuleLoaded();

        const rc = this.api().init(
            this.resolvedOptions.gpu ? `#${this.canvasGpu.id}` : "",
        );
        if (rc < 0) {
            throw new Error(
                `mpv_web_init failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
            );
        }

        this.readyState = true;
        this.usingGpu = this.api().usesGpu();
        if (!this.usingGpu) this.context2d = this.softwareCanvasContext();

        this.syncCanvasVisibility(this.usingGpu);
        this.resizeCanvas();
        void this.setVolume(this.resolvedOptions.initialVolume);
        this.emitStatus(`Player ready (${this.renderMode})`);
        this.dispatchEvent(buildEvent("ready", { renderMode: this.renderMode }));
        this.emitStateChange();
        this.startTicking();
        return this;
    }

    async activate(timeoutMs = 4000): Promise<true> {
        await this.initialize();
        this.api().resumeAudio();

        const deadline = performance.now() + timeoutMs;
        while (true) {
            const setupState = this.api().getAudioSetupState();
            if (setupState === AUDIO_SETUP_READY) return true;
            if (setupState === AUDIO_SETUP_FAILED) {
                throw new Error("browser audio initialization failed");
            }
            if (setupState === AUDIO_SETUP_IDLE) this.api().resumeAudio();
            if (performance.now() >= deadline) {
                throw new Error("timed out waiting for browser audio");
            }
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            });
        }
    }

    async load(source: LoadSource, options: MpvLoadOptions = {}): Promise<this> {
        await this.initialize();

        if (options.activate !== false) await this.activate();

        if (typeof source === "string") return this.loadUrl(source, options);
        if (isFile(source)) return this.loadFile(source);
        if (isBlob(source)) return this.loadBlob(source, options.name);
        if (source instanceof ArrayBuffer || isTypedArray(source)) {
            return this.loadBytes(source, options.name || "input.bin");
        }

        throw new TypeError("Unsupported source type for load()");
    }

    async loadUrl(url: string, options: MpvLoadOptions = {}): Promise<this> {
        const response = await fetch(url, options.fetchOptions);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch media: ${response.status} ${response.statusText}`,
            );
        }

        const buffer = await response.arrayBuffer();
        return this.loadBytes(buffer, options.name || inferNameFromUrl(url));
    }

    async loadBlob(blob: Blob, name = "input.bin"): Promise<this> {
        if (isFile(blob)) return this.loadFile(blob);
        if (typeof File !== "undefined") {
            return this.loadFile(new File([blob], name, { type: blob.type }));
        }
        return this.loadBytes(await blob.arrayBuffer(), name);
    }

    async loadFile(file: File): Promise<this> {
        await this.initialize();
        this.emitStatus("Loading media");

        const module = this.module;
        if (!module) throw new Error("Mpv module is not loaded");

        const workerFs = module.FS.filesystems?.WORKERFS;
        if (workerFs) {
            const mountedFile =
                file.name || typeof File === "undefined"
                    ? file
                    : new File([file], "input.bin", {
                          type: file.type,
                          lastModified: file.lastModified,
                      });
            const mountPoint = "/input/current";

            this.unmountCurrentFile();
            module.FS.mkdirTree(mountPoint);
            module.FS.mount(workerFs, { files: [mountedFile] }, mountPoint);

            this.currentMountPoint = mountPoint;
            this.currentPath = `${mountPoint}/${mountedFile.name}`;
            this.currentTitle = mountedFile.name;

            const rc = this.api().loadFile(this.currentPath);
            if (rc < 0) {
                throw new Error(
                    `loadfile failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
                );
            }

            this.forceRender = true;
            this.emitStateChange();
            return this;
        }

        const buffer = await file.arrayBuffer();
        return this.loadBytes(buffer, file.name || "input.bin");
    }

    async loadBytes(bytes: BinaryBufferSource, name = "input.bin"): Promise<this> {
        await this.initialize();

        const data = toUint8Array(bytes);
        const path = `/input/${sanitizeFilename(name)}`;
        const module = this.module;
        if (!module) throw new Error("Mpv module is not loaded");

        this.unmountCurrentFile();
        module.FS.writeFile(path, data);

        this.currentPath = path;
        this.currentTitle = name;
        this.emitStatus("Loading media");

        const rc = this.api().loadFile(path);
        if (rc < 0) {
            throw new Error(
                `loadfile failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
            );
        }

        this.forceRender = true;
        this.emitStateChange();
        return this;
    }

    async addSubtitle(
        source: LoadSource,
        options: MpvLoadOptions = {},
    ): Promise<this> {
        await this.initialize();

        if (typeof source === "string") {
            return this.addSubtitleUrl(source, options);
        }
        if (isFile(source)) return this.addSubtitleFile(source);
        if (isBlob(source)) return this.addSubtitleBlob(source, options.name);
        if (source instanceof ArrayBuffer || isTypedArray(source)) {
            return this.addSubtitleBytes(source, options.name || "subtitle.srt");
        }

        throw new TypeError("Unsupported source type for addSubtitle()");
    }

    async addSubtitleUrl(
        url: string,
        options: MpvLoadOptions = {},
    ): Promise<this> {
        const response = await fetch(url, options.fetchOptions);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch subtitle: ${response.status} ${response.statusText}`,
            );
        }

        const buffer = await response.arrayBuffer();
        return this.addSubtitleBytes(
            buffer,
            options.name || inferNameFromUrl(url),
        );
    }

    async addSubtitleBlob(blob: Blob, name = "subtitle.srt"): Promise<this> {
        if (isFile(blob)) return this.addSubtitleFile(blob);
        if (typeof File !== "undefined") {
            return this.addSubtitleFile(
                new File([blob], name, { type: blob.type }),
            );
        }
        return this.addSubtitleBytes(await blob.arrayBuffer(), name);
    }

    async addSubtitleFile(file: File): Promise<this> {
        const buffer = await file.arrayBuffer();
        return this.addSubtitleBytes(buffer, file.name || "subtitle.srt");
    }

    async addSubtitleBytes(
        bytes: BinaryBufferSource,
        name = "subtitle.srt",
    ): Promise<this> {
        await this.initialize();

        const path = this.writeAuxiliaryFile(
            "subtitles",
            name,
            toUint8Array(bytes),
        );
        const rc = this.api().addSubtitle(path);
        if (rc < 0) {
            throw new Error(
                `add subtitle failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
            );
        }

        this.emitStatus(`Attached subtitles: ${name}`);
        this.forceRender = true;
        this.emitStateChange();
        return this;
    }

    async play(): Promise<this> {
        await this.initialize();
        await this.activate();
        this.api().setPause(false);
        this.forceRender = true;
        this.emitStateChange();
        return this;
    }

    async pause(): Promise<this> {
        await this.initialize();
        this.api().setPause(true);
        this.forceRender = true;
        this.emitStateChange();
        return this;
    }

    async togglePause(): Promise<this> {
        await this.initialize();
        if (this.api().getPause()) return this.play();
        return this.pause();
    }

    async seek(seconds: number): Promise<this> {
        await this.initialize();
        const rc = this.api().seekAbsolute(seconds);
        if (rc < 0) {
            throw new Error(
                `seek failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
            );
        }
        this.forceRender = true;
        this.emitStateChange();
        return this;
    }

    async seekPercent(value: number): Promise<this> {
        await this.initialize();
        const duration = this.getNumberProperty("duration", 0);
        if (duration > 0) {
            await this.seek(Math.max(0, Math.min(1, value)) * duration);
        }
        return this;
    }

    async setVolume(value: number): Promise<this> {
        await this.initialize();
        const rc = this.api().setVolume(value);
        if (rc < 0) {
            throw new Error(
                `set volume failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
            );
        }
        this.emitStateChange();
        return this;
    }

    async setProperty(
        name: string,
        value: boolean | number | string,
    ): Promise<this> {
        await this.initialize();

        let rc: number;
        if (typeof value === "boolean") {
            rc = this.api().setPropertyFlag(name, value);
        } else if (typeof value === "number") {
            rc = this.api().setPropertyDouble(name, value);
        } else {
            rc = this.api().setPropertyString(name, value);
        }

        if (rc < 0) {
            throw new Error(
                `set property failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
            );
        }

        this.forceRender = true;
        this.emitStateChange();
        return this;
    }

    getBooleanProperty(name: string, fallback = false): boolean {
        return !!this.api().getPropertyFlag(name, fallback ? 1 : 0);
    }

    getNumberProperty(name: string, fallback = 0): number {
        return this.api().getPropertyDouble(name, fallback);
    }

    getStringProperty(name: string, fallback = ""): string {
        return this.api().getPropertyString(name) ?? fallback;
    }

    async command(command: string): Promise<this> {
        await this.initialize();
        const rc = this.api().commandString(command);
        if (rc < 0) {
            throw new Error(
                `command failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
            );
        }
        this.forceRender = true;
        this.emitStateChange();
        return this;
    }

    getState(): MpvPlayerState {
        if (!this.readyState) {
            return {
                duration: 0,
                paused: true,
                position: 0,
                ready: false,
                renderMode: this.resolvedOptions.gpu ? "WebGL" : "Software",
                title: this.currentTitle,
            };
        }

        return {
            duration: this.getNumberProperty("duration", 0),
            paused: this.getBooleanProperty("pause", false),
            position: this.getNumberProperty("time-pos", 0),
            ready: true,
            renderMode: this.renderMode,
            title: this.currentTitle || this.getStringProperty("media-title", ""),
        };
    }

    async destroy(): Promise<void> {
        cancelAnimationFrame(this.animationFrame);
        this.running = false;

        this.unmountCurrentFile();
        this.clearAuxiliaryFiles();

        if (this.readyState) this.api().destroy();

        this.readyState = false;
        this.module = null;
        this.modulePromise = null;
        this.lastSnapshot = null;
        this.context2d = null;
        this.imageData = null;

        this.resizeObserver.disconnect();
        if (this.autoActivateHandler) {
            this.resolvedOptions.target.removeEventListener(
                "pointerdown",
                this.autoActivateHandler,
            );
            this.resolvedOptions.target.removeEventListener(
                "keydown",
                this.autoActivateHandler,
            );
        }

        this.root.remove();
        this.dispatchEvent(buildEvent("destroy", EMPTY_DETAIL));
    }

    get renderMode(): RenderMode {
        return this.usingGpu ? "WebGL" : "Software";
    }

    private api(): MpvApi {
        const module = this.module;
        if (!module) throw new Error("Mpv module is not loaded");

        return {
            addSubtitle: (path) =>
                module.ccall("mpv_web_sub_add", "number", ["string"], [path]),
            commandString: (command) =>
                module.ccall(
                    "mpv_web_command_string",
                    "number",
                    ["string"],
                    [command],
                ),
            destroy: () => module.ccall("mpv_web_destroy", null, [], []),
            getAudioSetupState: () =>
                module.ccall("mpv_web_get_audio_setup_state", "number", [], []),
            getFramePtr: () =>
                module.ccall("mpv_web_get_frame_ptr", "number", [], []),
            getFrameStride: () =>
                module.ccall("mpv_web_get_frame_stride", "number", [], []),
            getLastErrorString: () =>
                module.ccall("mpv_web_get_last_error_string", "string", [], []),
            getPropertyDouble: (name, fallback) =>
                module.ccall(
                    "mpv_web_get_property_double",
                    "number",
                    ["string", "number"],
                    [name, fallback],
                ),
            getPropertyFlag: (name, fallback) =>
                module.ccall(
                    "mpv_web_get_property_flag",
                    "number",
                    ["string", "number"],
                    [name, fallback],
                ),
            getPropertyString: (name) =>
                module.ccall(
                    "mpv_web_get_property_string",
                    "string",
                    ["string"],
                    [name],
                ),
            getPause: () =>
                !!module.ccall(
                    "mpv_web_get_property_flag",
                    "number",
                    ["string", "number"],
                    ["pause", 0],
                ),
            getTimePos: () =>
                module.ccall(
                    "mpv_web_get_property_double",
                    "number",
                    ["string", "number"],
                    ["time-pos", 0],
                ),
            getDuration: () =>
                module.ccall(
                    "mpv_web_get_property_double",
                    "number",
                    ["string", "number"],
                    ["duration", 0],
                ),
            init: (canvasSelector) =>
                module.ccall(
                    "mpv_web_init",
                    "number",
                    ["string"],
                    [canvasSelector],
                ),
            loadFile: (path) =>
                module.ccall("mpv_web_loadfile", "number", ["string"], [path]),
            needsRender: () =>
                !!module.ccall("mpv_web_needs_render", "number", [], []),
            pollEvents: () =>
                module.ccall("mpv_web_poll_events", "number", [], []),
            render: (width, height) =>
                module.ccall(
                    "mpv_web_render",
                    "number",
                    ["number", "number"],
                    [width, height],
                ),
            resumeAudio: () =>
                module.ccall("mpv_web_resume_audio", null, [], []),
            seekAbsolute: (seconds) =>
                module.ccall(
                    "mpv_web_seek_absolute",
                    "number",
                    ["number"],
                    [seconds],
                ),
            setPause: (paused) =>
                module.ccall(
                    "mpv_web_set_property_flag",
                    "number",
                    ["string", "number"],
                    ["pause", paused ? 1 : 0],
                ),
            setPropertyDouble: (name, value) =>
                module.ccall(
                    "mpv_web_set_property_double",
                    "number",
                    ["string", "number"],
                    [name, value],
                ),
            setPropertyFlag: (name, value) =>
                module.ccall(
                    "mpv_web_set_property_flag",
                    "number",
                    ["string", "number"],
                    [name, value ? 1 : 0],
                ),
            setPropertyString: (name, value) =>
                module.ccall(
                    "mpv_web_set_property_string",
                    "number",
                    ["string", "string"],
                    [name, value],
                ),
            setVolume: (value) =>
                module.ccall(
                    "mpv_web_set_property_double",
                    "number",
                    ["string", "number"],
                    ["volume", value],
                ),
            usesGpu: () => !!module.ccall("mpv_web_uses_gpu", "number", [], []),
        };
    }

    private async ensureModuleLoaded(): Promise<MpvModule> {
        if (this.module) return this.module;

        if (!this.modulePromise) {
            this.modulePromise = (async () => {
                this.emitStatus("Initializing WebAssembly module");

                const createMpvModule = await loadMpvModuleFactory();
                const module = await createMpvModule({
                    ...this.resolvedOptions.moduleOptions,
                    locateFile: (file) => {
                        if (this.resolvedOptions.locateFile) {
                            return this.resolvedOptions.locateFile(file);
                        }
                        return new URL(file, import.meta.url).href;
                    },
                    printErr: (message) => {
                        if (this.resolvedOptions.printErr) {
                            this.resolvedOptions.printErr(message);
                        } else {
                            console.error(message);
                        }
                    },
                });

                if (module.pthreadPoolReady) {
                    this.emitStatus("Preparing worker pool");
                    await module.pthreadPoolReady;
                }

                this.module = module;
                return module;
            })().catch((error: unknown) => {
                this.modulePromise = null;
                this.module = null;
                throw error;
            });
        }

        return this.modulePromise;
    }

    private emitStatus(status: string): void {
        if (status === this.lastStatus) return;
        this.lastStatus = status;
        this.dispatchEvent(buildEvent("statuschange", { status }));
    }

    private emitStateChange(): MpvPlayerState {
        const snapshot = this.getState();
        if (snapshotsEqual(snapshot, this.lastSnapshot)) return snapshot;
        this.lastSnapshot = snapshot;
        this.dispatchEvent(buildEvent("statechange", snapshot));
        return snapshot;
    }

    private startTicking(): void {
        if (this.running) return;
        this.running = true;

        const tick = () => {
            if (!this.running) return;

            try {
                this.resizeCanvas();

                const flags = this.api().pollEvents();
                if (flags & POLL_FILE_LOADED) {
                    this.emitStatus("Ready");
                    this.dispatchEvent(buildEvent("fileloaded", this.getState()));
                }
                if (flags & POLL_END_FILE) {
                    this.dispatchEvent(buildEvent("ended", this.getState()));
                }
                if (flags & POLL_VIDEO_RECONFIG) this.forceRender = true;
                if (flags & POLL_SHUTDOWN) {
                    this.dispatchEvent(buildEvent("shutdown", EMPTY_DETAIL));
                }

                if (this.forceRender || this.api().needsRender()) {
                    const canvas = this.activeCanvas();
                    const rc = this.api().render(canvas.width, canvas.height);
                    if (rc < 0) {
                        throw new Error(
                            `render failed: ${rc} (${this.api().getLastErrorString() || "unknown"})`,
                        );
                    }
                    this.presentFrame(canvas.width, canvas.height);
                    this.forceRender = false;
                }

                this.emitStateChange();
                this.lastTickError = "";
            } catch (error: unknown) {
                const message =
                    error instanceof Error ? error.message : String(error);
                if (message !== this.lastTickError) {
                    this.lastTickError = message;
                    this.dispatchEvent(buildEvent("error", { error, message }));
                }
            }

            this.animationFrame = requestAnimationFrame(tick);
        };

        this.animationFrame = requestAnimationFrame(tick);
    }

    private activeCanvas(): HTMLCanvasElement {
        return this.usingGpu ? this.canvasGpu : this.canvasSw;
    }

    private syncCanvasVisibility(usingGpu: boolean): void {
        this.canvasGpu.hidden = !usingGpu;
        this.canvasSw.hidden = usingGpu;
        this.canvasGpu.style.display = usingGpu ? "block" : "none";
        this.canvasSw.style.display = usingGpu ? "none" : "block";
    }

    private resizeCanvas(): void {
        const rect = this.activeCanvas().getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));

        let changed = false;
        for (const canvas of [this.canvasGpu, this.canvasSw]) {
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                changed = true;
            }
        }

        if (changed) this.forceRender = true;
    }

    private softwareCanvasContext(): CanvasRenderingContext2D | null {
        if (!this.context2d) {
            this.context2d = this.canvasSw.getContext("2d", { alpha: false });
        }
        return this.context2d;
    }

    private presentFrame(width: number, height: number): void {
        if (this.usingGpu) return;

        const context2d = this.softwareCanvasContext();
        if (!context2d) throw new Error("2D canvas context is unavailable");
        const module = this.module;
        if (!module) throw new Error("Mpv module is not loaded");

        const ptr = this.api().getFramePtr();
        const stride = this.api().getFrameStride();
        if (!ptr || !stride) return;

        if (
            !this.imageData ||
            this.imageData.width !== width ||
            this.imageData.height !== height
        ) {
            this.imageData = context2d.createImageData(width, height);
        }

        const bytes = width * height * 4;
        const source = module.HEAPU8.subarray(
            ptr,
            ptr + Math.max(bytes, stride * height),
        );
        this.imageData.data.set(source.subarray(0, bytes));

        for (let index = 3; index < this.imageData.data.length; index += 4) {
            this.imageData.data[index] = 255;
        }

        context2d.putImageData(this.imageData, 0, 0);
    }

    private removeMountedFile(path: string | null): void {
        const module = this.module;
        if (!path || !module) return;

        try {
            module.FS.unlink(path);
        } catch {}
    }

    private unmountCurrentFile(): void {
        if (!this.module) return;

        if (this.currentMountPoint) {
            try {
                this.module.FS.unmount(this.currentMountPoint);
            } catch {}

            try {
                this.module.FS.rmdir(this.currentMountPoint);
            } catch {}

            this.currentMountPoint = null;
        }

        this.removeMountedFile(this.currentPath);
        this.currentPath = null;
    }

    private writeAuxiliaryFile(
        kind: string,
        name: string,
        data: Uint8Array,
    ): string {
        const dir = `/input/${kind}`;
        const path = `${dir}/${this.auxiliaryPathSeq++}-${sanitizeFilename(name)}`;
        const module = this.module;
        if (!module) throw new Error("Mpv module is not loaded");

        module.FS.mkdirTree(dir);
        module.FS.writeFile(path, data);
        this.auxiliaryPaths.add(path);
        return path;
    }

    private clearAuxiliaryFiles(): void {
        if (!this.module) return;

        for (const path of this.auxiliaryPaths) this.removeMountedFile(path);

        this.auxiliaryPaths.clear();
    }
}

export async function createPlayer(
    options: MpvPlayerOptions | HTMLElement,
): Promise<MpvPlayer> {
    const player = new MpvPlayer(options);
    await player.initialize();
    return player;
}

export default createPlayer;
