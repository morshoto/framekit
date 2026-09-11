# FrameKit Wiki

This directory is the editorial source for the public FrameKit site. It adds a
creator-first discovery layer without replacing or deleting the repository's
existing `docs/` knowledge base.

## Content layers

- `product/` explains the value of FrameKit before its implementation details.
- `use-cases/` connects creator goals to capability-accurate workflows.
- `learn/` answers broad AI video-editing questions and supports organic search.
- `docs/` introduces the canonical technical documentation in `../../docs/`.
- `blog/` is the source for ongoing product and project updates.

English is the default locale and has no URL prefix. Japanese uses `/ja/`.
Content files share a `translationKey`, while titles, descriptions, keywords,
slugs, and copy remain independently localized.

## Capability claims

Marketing copy must follow `_data/capabilities.json`. Every entry links to an
authoritative file under `docs/` and uses one of these states:

- `available`: usable now within the scope stated on the card.
- `experimental`: opt-in or guarded behavior with explicit prerequisites.
- `coming-soon`: part of the product direction, not currently available.
- `unavailable`: explicitly unsupported by the referenced backend.

Never promote fixture, FCPXML artifact, metadata-only, or provider-contract
evidence into a claim about editing the open Final Cut timeline.

## Web application

`apps/web/` renders this content as a statically exported Next.js site. The
site is intentionally prerenderable for GitHub Pages and emits canonical URLs,
locale alternates, structured data, a sitemap, and robots metadata at build
time.
