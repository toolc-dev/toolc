#!/usr/bin/env node
// Dev-time launcher: registers the tsx loader so the CLI (and workspace deps)
// run straight from TypeScript source. A tsc build replaces this for publishing.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
