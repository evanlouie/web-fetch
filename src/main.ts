#!/usr/bin/env bun
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger, pipe } from "effect";
import { Command } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };
import { cli } from "./cli.ts";

// stdout carries fetched pages or MCP messages, so logs go to stderr.
const platform = Layer.merge(NodeServices.layer, Layer.succeed(Logger.LogToStderr, true));

pipe(
  cli(packageJson.version),
  Command.run({ version: packageJson.version }),
  Effect.provide(platform),
  NodeRuntime.runMain,
);
