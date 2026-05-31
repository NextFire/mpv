// @ts-check
import { createPlayer } from "../lib/index.js";

/** @typedef {import("../lib/index.js").MpvPlayer} MpvPlayer */
/** @typedef {import("../lib/index.js").MpvPlayerState} MpvPlayerState */

/**
 * @template {typeof Element} T
 * @param {string} selector
 * @param {T} type
 * @returns {InstanceType<T>}
 */
function requireElement(selector, type) {
    const element = document.querySelector(selector);
    if (!(element instanceof type)) {
        throw new TypeError(`Expected ${selector} to match ${type.name}`);
    }
    return /** @type {InstanceType<T>} */ (element);
}

const forceSoftware =
    new URLSearchParams(window.location.search).get("gpu") === "0";

const elements = {
    stage: requireElement(".stage", HTMLElement),
    playerRoot: requireElement("#player-root", HTMLDivElement),
    fileInput: requireElement("#file-input", HTMLInputElement),
    subtitleInput: requireElement("#subtitle-input", HTMLInputElement),
    playPause: requireElement("#play-pause", HTMLButtonElement),
    seek: requireElement("#seek", HTMLInputElement),
    volume: requireElement("#volume", HTMLInputElement),
    status: requireElement("#status-text", HTMLElement),
    clock: requireElement("#clock-text", HTMLElement),
    title: requireElement("#media-title", HTMLElement),
};

/** @type {{
 *   player: MpvPlayer | null,
 *   playerPromise: Promise<MpvPlayer> | null,
 *   draggingSeek: boolean,
 *   pendingSubtitle: File | null,
 *   snapshot: MpvPlayerState | null,
 * }} */
const state = {
    player: null,
    playerPromise: null,
    draggingSeek: false,
    pendingSubtitle: null,
    snapshot: null,
};

/** @param {string} text */
function setStatus(text) {
    elements.status.textContent = text;
}

/**
 * @param {unknown} error
 * @param {string} [fallback]
 */
function getErrorDetail(error, fallback = "unknown") {
    return error instanceof Error ? error.message : String(error || fallback);
}

/** @param {number} seconds */
function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";

    const whole = Math.floor(seconds);
    const hrs = Math.floor(whole / 3600);
    const mins = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    if (hrs > 0)
        return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** @param {boolean} active */
function setDropTarget(active) {
    elements.stage.classList.toggle("is-drop-target", active);
}

function refreshUi() {
    const snapshot = state.snapshot;
    const paused = snapshot?.paused ?? true;
    const duration = snapshot?.duration ?? 0;
    const position = snapshot?.position ?? 0;

    elements.playPause.textContent = paused ? "Play" : "Pause";
    elements.clock.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
    elements.title.textContent = snapshot?.title || "No file loaded";

    if (!state.draggingSeek && duration > 0) {
        elements.seek.value = String(
            Math.min(1000, Math.max(0, (position / duration) * 1000)),
        );
    } else if (!state.draggingSeek) {
        elements.seek.value = "0";
    }
}

/** @param {MpvPlayer} player */
function bindPlayer(player) {
    player.on("statuschange", (event) => {
        setStatus(event.detail.status);
    });

    player.on("ready", (event) => {
        setStatus(
            `Choose a file to start playback (${event.detail.renderMode})`,
        );
        state.snapshot = player.getState();
        refreshUi();
    });

    player.on("statechange", (event) => {
        state.snapshot = event.detail;
        refreshUi();
    });

    player.on("fileloaded", () => {
        state.snapshot = player.getState();
        setStatus("Ready");
        refreshUi();
    });

    player.on("error", (event) => {
        const message = event.detail?.message || "unknown error";
        setStatus(`Player error: ${message}`);
    });
}

/** @returns {Promise<MpvPlayer>} */
async function ensurePlayer() {
    if (state.player) return state.player;

    if (!state.playerPromise) {
        state.playerPromise = createPlayer({
            target: elements.playerRoot,
            gpu: !forceSoftware,
            autoActivate: true,
        })
            .then((player) => {
                state.player = player;
                bindPlayer(player);
                return player;
            })
            .catch((error) => {
                state.playerPromise = null;
                throw error;
            });
    }

    return state.playerPromise;
}

/** @param {File} file */
async function loadFile(file) {
    const player = await ensurePlayer();
    elements.title.textContent = file.name || "Loading media";
    setStatus("Loading media");
    await player.load(file);
    if (state.pendingSubtitle) {
        await player.addSubtitle(state.pendingSubtitle);
        state.pendingSubtitle = null;
        elements.subtitleInput.value = "";
    }
    state.snapshot = player.getState();
    refreshUi();
}

/** @param {File} file */
async function attachSubtitle(file) {
    const player = await ensurePlayer();
    setStatus(`Loading subtitles: ${file.name}`);
    await player.addSubtitle(file);
    state.snapshot = player.getState();
    refreshUi();
}

async function bootstrap() {
    setStatus("Choose a file to start playback");
    refreshUi();

    elements.fileInput.addEventListener("change", async (event) => {
        const input = event.currentTarget;
        if (!(input instanceof HTMLInputElement)) return;
        const [file] = input.files || [];
        if (!file) return;

        try {
            await loadFile(file);
        } catch (error) {
            console.error(error);
            setStatus(`Load failed: ${getErrorDetail(error)}`);
        }
    });

    elements.subtitleInput.addEventListener("change", async (event) => {
        const input = event.currentTarget;
        if (!(input instanceof HTMLInputElement)) return;
        const [file] = input.files || [];
        if (!file) return;

        if (!state.snapshot?.title) {
            state.pendingSubtitle = file;
            setStatus(
                `Subtitle selected: ${file.name}. Load media to apply it.`,
            );
            return;
        }

        try {
            await attachSubtitle(file);
        } catch (error) {
            console.error(error);
            setStatus(`Subtitle load failed: ${getErrorDetail(error)}`);
        }
    });

    elements.stage.addEventListener("dragenter", (event) => {
        event.preventDefault();
        setDropTarget(true);
    });

    elements.stage.addEventListener("dragover", (event) => {
        event.preventDefault();
        setDropTarget(true);
    });

    elements.stage.addEventListener("dragleave", (event) => {
        const nextTarget = event.relatedTarget;
        if (
            !(nextTarget instanceof Node) ||
            !elements.stage.contains(nextTarget)
        )
            setDropTarget(false);
    });

    elements.stage.addEventListener("drop", async (event) => {
        event.preventDefault();
        setDropTarget(false);
        const [file] = event.dataTransfer?.files || [];
        if (!file) return;

        try {
            await loadFile(file);
        } catch (error) {
            console.error(error);
            setStatus(`Drop failed: ${getErrorDetail(error)}`);
        }
    });

    elements.playPause.addEventListener("click", async () => {
        const player = await ensurePlayer();
        await player.togglePause();
    });

    elements.seek.addEventListener("input", () => {
        state.draggingSeek = true;
    });

    elements.seek.addEventListener("change", () => {
        if (!state.player) {
            state.draggingSeek = false;
            return;
        }
        state.player
            .seekPercent(Number(elements.seek.value) / 1000)
            .finally(() => {
                state.draggingSeek = false;
            });
    });

    elements.volume.addEventListener("input", () => {
        if (!state.player) return;
        state.player.setVolume(Number(elements.volume.value));
    });
}

bootstrap().catch((error) => {
    console.error(error);
    setStatus(String(error));
});
