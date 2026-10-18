#!/usr/bin/env bun
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger, pipe, Runtime } from "effect";
import { Command } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };
import { cli } from "./cli.ts";

// stdout carries fetched pages or MCP messages, so logs go to stderr.
const platform = Layer.merge(NodeServices.layer, Layer.succeed(Logger.LogToStderr, true));

// wreq-js can keep a cancelled response's connection open after its session
// closes, which would keep the process alive. The process ends with the
// program, after its finalizers have run.
const teardown: Runtime.Teardown = (exit) =>
  Runtime.defaultTeardown(exit, (code) => process.exit(code));

pipe(
  cli(packageJson.version),
  Command.run({ version: packageJson.version }),
  Effect.provide(platform),
  NodeRuntime.runMain({ teardown }),
);
