import { Boolean, Cause, Console, Effect, pipe, Runtime, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  BROWSERS,
  DEFAULT_BROWSER,
  DEFAULT_FORMAT,
  FORMATS,
  type WebFetchError,
} from "./domain.ts";
import { failureText, WebFetch } from "./fetch.ts";
import type { Rendered } from "./output.ts";
import * as Server from "./server.ts";
import {
  BROWSER_DESCRIPTION,
  decodeRequest,
  FORMAT_DESCRIPTION,
  URL_DESCRIPTION,
  type Arguments,
} from "./tool.ts";

/** A failure that the CLI has printed. It only sets the exit code. */
class Reported extends Schema.TaggedError<Reported>()("Reported", {}) {
  override readonly [Runtime.errorReported] = false;
}

// A blocked or refused page still prints, but exits with an error.
const print = (json: boolean) => (rendered: Rendered) =>
  pipe(
    json,
    Boolean.match({
      onFalse: () => rendered.text,
      onTrue: () => JSON.stringify(rendered.structured, null, 2),
    }),
    Console.log,
    Effect.andThen(
      pipe(
        rendered.isError,
        Boolean.match({
          onFalse: () => Effect.void,
          onTrue: () => Effect.fail(new Reported()),
        }),
      ),
    ),
  );

const complain = (cause: Cause.Cause<WebFetchError>) =>
  pipe(failureText(cause), Console.error, Effect.andThen(Effect.fail(new Reported())));

const fetchUrl = Effect.fn("cli.fetch")(function* ({
  json,
  ...args
}: Arguments & { readonly json: boolean }) {
  const webFetch = yield* WebFetch;
  return yield* pipe(
    decodeRequest(args),
    Effect.flatMap(webFetch.fetch),
    Effect.matchCauseEffect({ onSuccess: print(json), onFailure: complain }),
  );
});

const fetchCommand = pipe(
  Command.make(
    "fetch",
    {
      url: pipe(Argument.String("url"), Argument.withDescription(URL_DESCRIPTION)),
      format: pipe(
        Flag.Literals("format", FORMATS),
        Flag.withDescription(FORMAT_DESCRIPTION),
        Flag.withDefault(DEFAULT_FORMAT),
      ),
      browser: pipe(
        Flag.Literals("browser", BROWSERS),
        Flag.withDescription(BROWSER_DESCRIPTION),
        Flag.withDefault(DEFAULT_BROWSER),
      ),
      json: pipe(
        Flag.Boolean("json"),
        Flag.withDescription(
          "Print the result as JSON, the structuredContent that MCP clients receive.",
        ),
        Flag.withDefault(false),
      ),
    },
    fetchUrl,
  ),
  Command.withDescription(
    "Fetch a URL and print what the web_fetch tool returns. Saved files outlive the command.",
  ),
  Command.withExamples([
    {
      command: "mcp-web-fetch fetch https://example.com",
      description: "Print a page's main content as Markdown",
    },
    {
      command: "mcp-web-fetch fetch https://example.com --format raw --browser chrome",
      description: "Print the HTML source, impersonating Chrome",
    },
  ]),
  Command.provide(WebFetch.layer("keep")),
);

const serveCommand = (version: string) =>
  pipe(
    Command.make("serve", {}, () => Server.serve(version)),
    Command.withDescription(
      "Run an MCP server with the web_fetch tool on stdin and stdout. Saved files are removed when it stops.",
    ),
  );

export const cli = (version: string) =>
  pipe(
    Command.make("mcp-web-fetch"),
    Command.withDescription(
      "Fetch web pages as Markdown with a real browser's TLS and HTTP/2 fingerprint.",
    ),
    Command.withSubcommands([fetchCommand, serveCommand(version)]),
  );
