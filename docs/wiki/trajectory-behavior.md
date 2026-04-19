# Trajectory behavior — flight duration and phasing

Reference notes for `src/core/map/trajectory.js`, covering how flight
duration and phase structure are computed and the non-obvious patches
applied to date.

---

## Phase structure of a ballistic flight

A `MapTrajectory` in `ballistic` (or `auto` with distance > 2000 m) mode
divides total duration into three sequential phases:

```
|-- headingDurationStart --|-- linear travel --|-- headingDuration --|
       departure orient.         pan / zoom          arrival orient.
```

- **headingDurationStart** — camera rotates from departure orientation to
  the flight direction (nadir-look yaw is invisible, see below).
- **Linear travel** — `getSmoothFactor()` interpolates position from p1 to
  p2; extent and FOV are simultaneously interpolated by the raw
  double-smoothstep factor.
- **headingDuration** — camera rotates from flight direction to the
  destination orientation. `getSmoothFactor()` returns 1.0 here, so
  position is already at the destination while the orientation settles.

`finalPhaseSample` (attached to the returned sample array) marks the start
of the arrival orientation phase so external code can react
(e.g. `fly-final-phase` autopilot event used by `waypoint.js` to apply
deferred `renderingOptions`).

---

## Base duration rules

| Distance | Base duration |
|---|---|
| < 500 m | 1,000 ms |
| 500–2,000 m | 2,000 ms |
| > 2,000 m | `distance / 100`, floored at 6,000 ms, capped at 10,000 ms |

For distance > 2,000 m with `headingDuration = 1,500 ms`:
- Both duration and `headingDuration` are multiplied by 1.8 in ballistic
  mode.
- `minDuration = 3 × headingDuration` is enforced; `maxDuration` (default
  10,000 ms) is enforced after.

---

## Patch 1 — near-nadir departure shrinks `headingDurationStart`

**Motivation:** when departing from a straight-down (nadir) view, the yaw
component of the departure orientation phase is invisible because all
compass headings look the same from directly overhead. Spending
`headingDuration` ms rotating yaw is wasted time.

**Criterion:** `startPitch < -60°` (pitch: 0 = horizontal, −90 = nadir).

**Behavior:**

```
nadirFactor = clamp((startPitch + 90) / 30, 0, 1)
            → 1 at −60°, 0 at −90°

headingDurationStart = round(headingDuration × nadirFactor)
headingSaved         = headingDuration × (1 − nadirFactor)
duration            -= headingSaved   (floored at minDuration)
```

At full nadir (−90°): `headingDurationStart = 0`, total duration shrinks by
one full `headingDuration`. The arrival phase (`headingDuration`) is
unchanged.

---

## Patch 2 — short-distance flights within a tight viewport

**Motivation:** when both waypoints show approximately the same geographic
area (similar extents) and the distance between them is small relative to
that area, the linear travel phase is barely perceptible — the scene hardly
moves. The trajectory spends most of its time on a near-stationary pan that
adds no spatial information; the useful work is the arrival orientation
change.

**Criterion:** `distance < min(e1, e2)` — the flight distance fits inside
the *smaller* of the two view extents.

The smaller extent is used deliberately. If the two extents differ greatly
(e.g. zooming from a regional view to a continental one), the mean extent
would be large and could incorrectly class a long flight as "barely
perceptible". The smaller extent is the conservative bound: if the flight
fits inside the tighter viewport, it is genuinely short from that
viewpoint.

**Behavior:**

```
minExtent  = min(e1, e2)
distRatio  = distance / minExtent            ← in [0, 1) when patch fires

linearPhase  = duration − headingDurationStart − headingDuration
scaledLinear = round(linearPhase × max(distRatio, 0.2))
                                             ← floor 0.2 prevents collapse to 0
duration     = headingDurationStart + scaledLinear + headingDuration
             (floored at minDuration)
```

The arrival phase (`headingDuration`) is intentionally preserved: it
carries the semantic payload of the transition.

**Example** (`krkonose-nadir` → `northern-escarpment`, both extents
30,194 m, distance ≈ 8,500 m, departure pitch −90°):

| Phase | Before patch | After patch |
|---|---|---|
| headingDurationStart | 0 ms (nadir patch) | 0 ms |
| linear travel | 6,400 ms | ≈ 1,800 ms |
| headingDuration | 1,800 ms | 1,800 ms |
| **total** | **8,200 ms** | **≈ 3,600 ms** |

---

## Ordering of patches

Both patches run at the end of `detectDuration()`, in this order:

1. Nadir departure patch (modifies `headingDurationStart` and `duration`).
2. Extent-proximity patch (uses the already-patched `duration` and
   `headingDurationStart`; modifies only the linear phase portion of
   `duration`).
