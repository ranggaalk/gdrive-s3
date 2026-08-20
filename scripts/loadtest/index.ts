// Entry point for the Bun-native Milestone 7 load harness.

import { mainFromCli } from "./runner.ts";

await mainFromCli(process.argv.slice(2));
