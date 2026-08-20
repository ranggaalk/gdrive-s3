// Bounded concurrency driver for the load-test scenarios. Emits a JSON
// summary per scenario with rate + latency distribution.

import { CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { LatencySamples } from "./percentiles.ts";
import { startLoadGateway } from "./live.ts";
import { buildScenario, type ScenarioName } from "./scenarios.ts";

export interface LoadRunOptions {
  scenarios: ScenarioName[];
  durationMs: number;
  concurrency: number;
}

export interface ScenarioResult {
  scenario: ScenarioName;
  concurrency: number;
  durationMs: number;
  count: number;
  errors: number;
  rps: number;
  latency: ReturnType<LatencySamples["summary"]>;
}

export async function runLoadTest(options: LoadRunOptions): Promise<ScenarioResult[]> {
  const gateway = startLoadGateway();
  const results: ScenarioResult[] = [];
  try {
    await gateway.client.send(new CreateBucketCommand({ Bucket: gateway.bucket }));
    for (const scenario of options.scenarios) {
      const op = await buildScenario(scenario, gateway.client, gateway.bucket);
      results.push(await runOne(scenario, op, options));
    }
    await gateway.client.send(new DeleteBucketCommand({ Bucket: gateway.bucket })).catch(() => {});
  } finally {
    gateway.close();
  }
  return results;
}

async function runOne(
  scenario: ScenarioName,
  op: () => Promise<void>,
  options: LoadRunOptions,
): Promise<ScenarioResult> {
  const samples = new LatencySamples();
  const startedAt = performance.now();
  const endAt = startedAt + options.durationMs;
  let count = 0;
  let errors = 0;

  async function worker(): Promise<void> {
    while (performance.now() < endAt) {
      const start = performance.now();
      try {
        await op();
        samples.record(performance.now() - start);
        count++;
      } catch (err) {
        errors++;
        // Log the first error per worker to stderr for diagnostics; drop the
        // rest to keep the report deterministic.
        if (errors === 1) {
          process.stderr.write(
            `load-test ${scenario} error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  const elapsedMs = performance.now() - startedAt;
  return {
    scenario,
    concurrency: options.concurrency,
    durationMs: Math.round(elapsedMs),
    count,
    errors,
    rps: Math.round((count / elapsedMs) * 1000 * 100) / 100,
    latency: samples.summary(),
  };
}

function parseCli(argv: string[]): LoadRunOptions {
  const options: LoadRunOptions = {
    scenarios: ["put", "get", "list"],
    durationMs: 5000,
    concurrency: 16,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenarios" && argv[i + 1]) {
      options.scenarios = argv[++i]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name as ScenarioName);
    } else if (arg === "--duration" && argv[i + 1]) {
      options.durationMs = parseDuration(argv[++i]!);
    } else if (arg === "--concurrency" && argv[i + 1]) {
      options.concurrency = Math.max(1, Number(argv[++i]));
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: bun scripts/loadtest/index.ts [--scenarios put,get,list,multipart]" +
          " [--duration 10s|500ms] [--concurrency 16]\n",
      );
      process.exit(0);
    }
  }
  return options;
}

function parseDuration(raw: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!match) throw new Error(`invalid duration: ${raw}`);
  const value = Number(match[1]);
  switch (match[2] ?? "ms") {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    default:
      return value;
  }
}

export function mainFromCli(argv: string[]): Promise<void> {
  const options = parseCli(argv);
  return runLoadTest(options).then((results) => {
    process.stdout.write(JSON.stringify({ options, results }, null, 2) + "\n");
  });
}
