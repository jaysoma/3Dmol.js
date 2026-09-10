# Animation-path benchmark

Measures the cost of advancing a trajectory frame in 3Dmol two ways, on the same model and the
same frames:

- **baseline** — `setFrame(i)`, the existing API. It swaps the model's atom list and nulls
  `molObj`, so the next render rebuilds every geometry: style resolution per atom, colours,
  radii, face indices, fresh typed arrays, full buffer upload.
- **fast** — `setFrame(i, {fast: true})`: the same API with the replay option, which installs
  frame *i*'s atom list and calls `GLModel.syncAtomPositions()` to rewrite position data in the
  existing arrays (atoms resolved by index), letting the renderer respecify only those buffers.
  If the replay cannot apply, `setFrame` falls back to the rebuild; the page counts that as a
  refusal rather than letting it pass as a fast frame.

Both draw the same picture. The page proves it: every position buffer in the model is hashed
after each path draws the same frame, and the run refuses to report timings if the hashes differ.

## Run

```
npm install
npm run build:dev
node bench/animation/run.mjs
```

Defaults use only fixtures already in `tests/auto/data` (two small proteins with synthesised
frames, and `temp_1_2_28.pdb`, a 29-frame multi-model trajectory), so no network and no extra
data. To extend the size ladder:

```
node bench/animation/run.mjs --fetch AF-A6H8Y1-F1 --fetch AF-P07942-F1     # AlphaFold DB (20k / 14k atoms)
node bench/animation/run.mjs --pdb path/to/big.pdb --frames-file path/to/traj.pdb
```

Chrome is located automatically; override with `CHROME=/path/to/chrome`. `puppeteer-core` comes
with the repo's `glcheck` dev dependency.

## What is reported, and what each number can and cannot see

| number | how | blind to |
|---|---|---|
| frame time (median, p95) | `performance.now()` around update + render + one rAF yield; 10 warm-up frames discarded; repeats alternate baseline/fast so thermal drift lands on both | which stage inside the frame cost what |
| bytes allocated per frame | typed-array constructors wrapped in the page, in a **separate** pass so the wrappers never sit inside a timed loop | anything allocated through captured constructors (the run says so if the counter sees nothing) |
| GC pause per frame | a `v8.gc` DevTools trace around **each timed pass**, so baseline and fast are attributed separately; reported as the union of GC intervals (V8 nests its phases) | the work that caused the pressure |
| main-thread time per frame | renderer-process `TaskDuration` delta around each pass; close to wall time means the frame is CPU-bound, well under it means the page is waiting on the GPU | GPU-process work |

A workload whose output hashes differ is refused by default; `--no-strict` times it anyway and
flags it (see the topology note below).

Not used: `performance.memory`. Typed-array backing stores live outside the JS heap it reports,
so it cannot see the allocations this benchmark is about.

Absolute milliseconds are machine-specific and are reported with the renderer string and CPU
model. The claims that travel between machines are the **ratio** and how it **scales with atom
count**. On integrated graphics the upload share is smaller than on a discrete card (no bus
crossing) and the CPU and GPU contend for one memory bus; both effects are small and opposite,
and neither touches the CPU-side buckets.

## Isolating the memory cost: the no-allocation variant

Timing cannot put a stopwatch on "allocation" inside the rebuild, so it is measured by
subtraction: a variant build that removes **only** allocation, run through the same page.
Branch `bench-noalloc` (never for merge) changes one thing — `Geometry.addGeoGroup()` takes its
full-capacity group arrays from a pool that discarded builds refill, instead of allocating fresh
— and nothing else in the rebuild. The page's hash guard covers positions, normals and colours,
so a stale-array read-before-write would be caught.

```
git checkout bench-noalloc && npm run build:dev
cp build/3Dmol.js bench/animation/variants/3Dmol-noalloc.js
git checkout - && npm run build:dev
node bench/animation/run.mjs --out real.json
node bench/animation/run.mjs --bundle bench/animation/variants/3Dmol-noalloc.js --out noalloc.json
```

`real baseline − no-allocation baseline` = what allocating, zero-filling and collecting the
group arrays costs per frame. The variant's allocation counter reading 0 confirms the pool is
doing its job. (The fast path never allocates, so it should be unchanged between the two.)

## Two notes on the fast path's contract

**Atom identity.** The replay records atoms by *index* into the list the geometry was built
from and resolves them against the model's current atom list, so it stays correct when
`setFrame` installs a different atom list per frame. It assumes the same atoms in the same
order — the definition of a trajectory — and refuses (falling back to a rebuild) if the atom
count differs. The `fast` option is off by default; nothing changes for existing callers.

**Topology.** The fast path assumes bonds do not change between frames — the definition of a
trajectory. `setFrame` makes no such assumption: it re-derives bonds by distance on every frame,
so under large motion its stick geometry can gain or lose bonds from one frame to the next. The
two paths then draw different pictures, and the hash guard refuses to compare them. The
29-frame fixture (`temp_1_2_28.pdb`, atoms moving up to 12.7 Å) triggers exactly this with the
default `ballstick` style and passes with `--style sphere`. For real MD output the fixed topology
is the correct one; the per-frame re-derivation is the artifact.
