# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - Not yet released

First version. Not published to any package registry.

### Added

- `scan` and `doctor`: bounded, read-only project analysis and environment checks; `doctor --recover` for interrupted operations.
- `search`, `recommend`, and `sources list`: bundled catalog 0.1.0 (28 verified skills from 13 publishers), explicit public GitHub repository discovery, and deterministic `fit-v1` ranking with explanations.
- `review`: commit-pinned payload fetching with per-file Git object ID and SHA-256 checks, payload policy `payload-v2` (text plus inert PNG/JPEG/GIF/WebP), static rule set `rules-v1`, and license evidence.
- `plan`: complete install plans with a 24-hour expiry and a domain-separated digest; medium findings need exact acknowledgment.
- `install`: approval by full digest or typed confirmation; transactional installation with a mutation lock, journal, staged promotion, atomic lockfile, and rollback or recovery. Identical managed installs are a no-op.
- `list` and `remove` (removal plans applied through `install`).
- Portable Agent Skill in `skills/skillpilot/` for Claude Code and Codex.
- JSON Schemas for every command output and persisted format in `schemas/`.
