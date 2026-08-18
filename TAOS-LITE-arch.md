# TAOS-LITE Architecture

**Author:** Grok-XAI  
**Project:** TAOS-LITE  
**Type:** Next.js web application with specialized dev/funnel modes  
**Date of analysis:** 2026-06-28

---

## Overview

TAOS-LITE is a Next.js-based application, serving as a lighter or specialized variant (possibly a funnel or demo version) of TAOS-GPT. It supports custom development flows, including a "funnel" mode for controlled environments, along with standard build and type-checking workflows.

It is positioned as one of the priority products for AI Driver testing via launch profiles.

---

## Tech Stack

- **Framework**: Next.js
- **Language**: TypeScript / JavaScript
- **Build & Dev**: npm scripts for dev, build, start, lint, typecheck
- **Styling/Config**: Standard Next + Tailwind/PostCSS likely

---

## High-Level Architecture

Standard Next.js app structure with app/ or pages/, lib/, components/.

Additional custom scripts for "funnel" dev mode that likely sets up a specific environment or proxy for testing flows.

---

## Core Flows

- Development: `npm run dev` (or custom port)
- Build & Production: `npm run build` then `npm run start`
- Specialized: dev:funnel flows for targeted testing
- Quality: lint + typecheck

---

## Main Components

- Standard Next.js app directory
- Custom scripts/ for funnel start/stop
- Components and lib for app logic

---

## Configuration

- next.config.js
- tsconfig.json
- Specific port configurations (e.g. 3017 in some profiles)

---

## Security & Operational Notes

Typical for Next.js: local dev vs production start.

Funnel modes suggest controlled, possibly shareable test surfaces.

---

## Summary

TAOS-LITE serves as a focused, launchable surface for driver testing in the AI Driver paradigm. Its multiple dev profiles make it a good candidate for the .mc-launch / launch.json model.
