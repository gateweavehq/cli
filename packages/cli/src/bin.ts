#!/usr/bin/env node
import { main } from "./main.ts";
import { realSystem } from "./system.ts";

process.exitCode = await main(process.argv.slice(2), realSystem());
