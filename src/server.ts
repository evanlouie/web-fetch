import {
  absurd,
  Boolean,
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  flow,
  Layer,
  pipe,
  Schema,
} from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { TOOL_NAME } from "./domain.ts";
import { failureText, WebFetch } from "./fetch.ts";
import { Structured, type Rendered } from "./output.ts";
import { Arguments, decodeRequest, description, instructions } from "./tool.ts";

// A client gets the newest revision that it offers.
const PROTOCOLS = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

// Closed, so a client sees that no other properties are allowed.
const jsonSchemaOf = (schema: Schema.Top) =>
  Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema;

const toolResult = ({ text, structured, isError }: Rendered) =>
  new McpSchema.CallToolResult({
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError,
  });

// A failed fetch is a tool result rather than a protocol error, so the model
// sees why it failed.
const errorResult = (text: string) =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text }], isError: true });

const decodeArguments = flow(
  Schema.decodeUnknownEffect(Arguments, { onExcessProperty: "error" }),
  Effect.mapError(({ message }) => new McpSchema.InvalidParams({ message })),
);

const register = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const webFetch = yield* WebFetch;
  const inputSchema = yield* pipe(
    jsonSchemaOf(Arguments),
    Schema.decodeUnknownEffect(McpSchema.ToolJson),
    Effect.orDie,
  );
  const outputSchema = yield* pipe(
    jsonSchemaOf(Structured),
    Schema.decodeUnknownEffect(McpSchema.ToolOutputJson),
    Effect.orDie,
  );
  const answer = (args: Arguments) =>
    pipe(
      decodeRequest(args),
      Effect.flatMap(webFetch.fetch),
      Effect.matchCause({ onSuccess: toolResult, onFailure: flow(failureText, errorResult) }),
    );
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: TOOL_NAME,
      title: "Web fetch",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),
    annotations: Context.empty(),
    handle: flow(decodeArguments, Effect.flatMap(answer)),
  });
});

/**
 * An MCP server on stdin and stdout with the web_fetch tool. Files it saves
 * last until it stops. The fetch service starts first, so it stops last,
 * after every call in flight.
 */
const layer = (version: string) =>
  pipe(
    Layer.effectDiscard(register),
    Layer.provide(
      McpServer.layerStdio({ name: "mcp-web-fetch", version, instructions, protocols: PROTOCOLS }),
    ),
    Layer.provide(WebFetch.layer("discard")),
  );

const stopped = (cause: Cause.Cause<Cause.IllegalArgumentError>) =>
  pipe(
    Cause.hasInterruptsOnly(cause),
    Boolean.match({
      onTrue: () => Effect.void,
      onFalse: () => Effect.failCause(cause),
    }),
  );

/**
 * Run the server until the client closes stdin, which is how MCP clients stop
 * a stdio server. The transport stops by interrupting the fiber that started
 * it, so the server runs in a child fiber whose interruption is a clean stop.
 * A signal interrupts the main fiber instead, and still exits with 130.
 */
export const serve = (version: string) =>
  pipe(
    Layer.launch(layer(version)),
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap(Exit.match({ onSuccess: absurd<Effect.Effect<void>>, onFailure: stopped })),
  );
