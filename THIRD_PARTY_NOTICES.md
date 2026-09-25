# Third-party notices

## SoL-Pi — MIT

This plugin is a port of **SoL-Pi** to the PI-Desktop plugin API:

- Upstream: https://github.com/NVlabs/SoL-Pi
- Package: `sol-pi` 0.1.0
- License: MIT

Files in this repository that carry an upstream derivation are:

| This repository | Derived from (upstream) |
| --- | --- |
| `lib/action-fusion.js` | `src/sol-pi/extensions/action-fusion/{index,tool,file-queue,then-run}.ts` |
| `lib/observation-pack.js` | `src/sol-pi/extensions/observation-pack/{observation,index}.ts` |
| `lib/reducer.js` | `src/sol-pi/extensions/evidence-preserving-reducer/{receipt,provider,archive,candidate,journal,config,index}.ts` |
| `lib/compact-plan.js` | `src/sol-pi/extensions/online-context-compact/plan.ts` |
| `lib/compact-economics.js` | `src/sol-pi/extensions/online-context-compact/economics.ts` |
| `lib/compact-state.js` | `src/sol-pi/extensions/online-context-compact/state.ts` |
| `lib/config.js` | `src/sol-pi/config.ts` and `.../evidence-preserving-reducer/config.ts` |
| `lib/paths.js` | `src/sol-pi/runtime-paths.ts` |
| `skills/*.md` | The upstream extension documentation for the same four mechanisms |

The behaviour preserved from upstream — thresholds, byte limits, id and hash
derivations, receipt schema and field set, marker strings, reason codes and the
economics constants — is listed in `docs/PORT-NOTES.md`.

### Upstream license text

```
Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## No other third-party code

The plugin uses Node.js built-ins only (`node:fs`, `node:path`,
`node:crypto`, `node:child_process`, `node:url`, `node:os`). It does not bundle,
vendor or fetch any dependency, and it makes no network request of its own: the
only model access is the host's own `pi.agent.complete`.
