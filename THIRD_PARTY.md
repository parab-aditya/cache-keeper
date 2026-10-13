# Third-party code

cache-keeper is MIT-licensed (see `LICENSE`). Parts of it are adapted from two other MIT-licensed Claude Code mods. Each adapted source file also carries a one-line comment naming its source. Their licence texts follow, as the licences require.

## claude-code-cache-warmer

- Source: https://github.com/paulbkim-dev/claude-code-cache-warmer
- Author: Paul B. Kim
- Adapted: the idea of keeping the cache warm with `$.model.fork` (a tiny refresh request that adds nothing to the conversation); tracking the anchor (the last main-thread request) from `turn.step`; the `outcomeOf` rule (a refresh that read under half the prefix means the cache had expired) and `deadlineOf` (a timer that fired too late, for example after the Mac slept); the claim object that stops two refreshes running at once; the serialized write chain for the log file; and the test world (`tests/world.ts`: clock, env, store and file stubs, and the held write that freezes a fork mid-flight).

```
MIT License

Copyright (c) 2026 Paul B. Kim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## effortless

- Source: https://github.com/HeyCubit/effortless
- Author: HeyCubit
- Adapted: the structure of the desktop band (a rounded root with absolutely placed art layers, a dot, the line and the controls); controls drawn as an `Svg` with a blank `Button` laid over them; the art techniques, including `inPhase` (animations locked to the clock), `cacheClockSvg` (a countdown that ticks with no redraw) and the glowing rim; the saved-defaults pattern (a value the `/config` row refuses is kept in the store and merged over the row's options); and the measured cell metrics of the desktop app.

```
MIT License

Copyright (c) 2026 HeyCubit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
