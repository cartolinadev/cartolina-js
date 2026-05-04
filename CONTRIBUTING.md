# Contributing to cartolina-js

`cartolina-js` is a feature-driven fork of `vts-browser-js`. Contributions
are welcome, but the project is not trying to preserve the full legacy API.
Before starting larger work, read `README.md` and the wiki index at
`docs/wiki/index.md`.

## Code of Conduct

Participation in this project is covered by `CODE_OF_CONDUCT.md`.

## Contributor Terms

By submitting a contribution, you agree that:

- the contribution may be used, modified, sublicensed, and redistributed
  under the project license in `LICENSE`
- you have the right to submit the contribution under those terms
- the contribution is your original work, or is derived from work that you
  have the right to submit under compatible open-source terms
- you will identify any third-party code, data, generated output, or license
  terms that apply to the contribution
- to the extent permitted by law, you will defend and indemnify the project
  maintainers from third-party claims caused by your breach of these terms

These terms are an inbound-equals-outbound contribution policy. Copyright
ownership is not assigned to the project; contributors keep ownership of
their own contributions while granting the project the rights needed to
release them under the project license.

Maintainers may ask for a signed-off commit, a separate written
certification, or clarification of source provenance before accepting a
contribution.

## Contribution Scope

Good contributions include:

- bug reports with a reproducible URL, style, or demo case
- fixes for current demos and test URLs
- focused rendering, terrain, style, or API improvements
- TypeScript migration work tied to a feature or cleanup already in flight
- documentation that records current behavior or non-obvious findings

Out of scope by default:

- restoring old `vts-browser-js` compatibility surfaces
- new JavaScript source modules
- speculative abstractions for future features
- broad rewrites that are not tied to a tested behavior change

## Development Setup

Use the Node version from `.nvmrc`:

```bash
source ~/.nvm/nvm.sh && nvm use
npm install
npm start
```

The dev server serves demos from `http://localhost:8080/demos/` and the
test index from `http://localhost:8080/test/`.

## Coding Guidelines

Follow the repository instructions in `AGENTS.md` and the current code near
the change. In short:

- new source files are TypeScript, not JavaScript
- new shaders use GLSL ES 3.00 for WebGL2
- keep changes small and feature-driven
- prefer deleting unused legacy code over wrapping it
- use existing renderer, map, and style APIs before adding new helpers
- preserve or update JSDoc when moving or changing documented code

Run TypeScript checks for TypeScript-facing changes:

```bash
npm run typecheck
```

For rendering changes, compare the canonical test URLs:

```bash
node test/screenshot.js simple-terrain
node test/screenshot.js complex-terrain
node test/screenshot.js full-terrain
```

Run the entries sequentially. Performance tests are only needed when the
change may affect frame rate or load time.

## Pull Requests

Use a branch with a short descriptive name. Include in the pull request:

- the problem or feature being addressed
- the main implementation decisions
- the tests or visual checks run
- screenshots when the change affects rendering
- any wiki pages updated

Documentation-only changes do not need rendering tests. Code changes that
alter public behavior should update demos, tests, or docs in the same pull
request.

## Wiki Updates

The wiki in `docs/wiki/` is part of the development process. Update it when
a change affects architecture notes, non-obvious behavior, migration rules,
or contributor workflow. Significant work should add a brief entry to
`docs/wiki/session-log.md`.

## Reporting Bugs

Report bugs on the project issue tracker. Include:

- the cartolina-js version or commit
- the browser and operating system
- the URL, style file, or demo needed to reproduce the issue
- the viewport size for visual bugs
- console or network errors, if present
- screenshots for visual regressions

For rendering regressions, identify the known-good version when possible.
