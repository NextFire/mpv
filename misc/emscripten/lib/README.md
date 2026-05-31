# mpv-wasm

`mpv-wasm` packages the Emscripten browser build of mpv as an ES module that can be packed and reused from npm-compatible tooling.

## Build

```sh
./ci/build-emscripten-deps.sh
./ci/build-emscripten.sh build-emscripten-wasm
meson compile -C build-emscripten-wasm emscripten-browser
```

The generated npm package root is:

```sh
build-emscripten-wasm/misc/emscripten/lib
```

From there you can run:

```sh
npm pack
```

## Usage

```js
import { createPlayer } from 'mpv-wasm';

const player = await createPlayer({
    target: document.querySelector('#player'),
    gpu: true,
});

document.querySelector('#open').addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (file)
        await player.load(file);
});

document.querySelector('#subtitles').addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (file)
        await player.addSubtitle(file);
});

document.querySelector('#play').addEventListener('click', () => player.togglePause());
```

## API

- `createPlayer(options)` initializes an mpv instance and attaches the rendering surface to `options.target`.
- `player.load(source)` accepts `File`, `Blob`, `ArrayBuffer`, typed arrays, or a URL string.
- `player.addSubtitle(source)` accepts the same source types and attaches an external subtitle track without replacing the current media.
- `player.play()`, `player.pause()`, `player.togglePause()`, `player.seek(seconds)`, and `player.setVolume(value)` cover the common control path.
- `player.setProperty(name, value)` and `player.command(command)` provide direct access to mpv controls for advanced cases.
- `player.getState()` returns `{ ready, paused, position, duration, title, renderMode }`.
- `player` emits `ready`, `statuschange`, `statechange`, `fileloaded`, `ended`, `shutdown`, `error`, and `destroy` events.

## Notes

- This build is browser-only and expects modern ESM tooling.
- The wasm build uses pthreads, so the host page still needs cross-origin isolation headers such as COOP/COEP.
- Browser audio still has the usual user-gesture requirement. `autoActivate` is enabled by default so pointer and keyboard interaction on the target will unlock audio when possible.
