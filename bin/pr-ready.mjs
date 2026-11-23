#!/usr/bin/env node
import { runPrReady } from './pr-readiness.mjs';

process.exitCode = await runPrReady(process.argv.slice(2));
