# mcp-web-fetch

A `web_fetch` tool that fetches web pages and files with a real browser's TLS and HTTP/2 fingerprint, as a command-line tool or as an MCP server over stdio. [wreq-js] does the fingerprinting in native code, so requests pass many bot checks that block curl and Node's `fetch`.

It is a standalone port of the `web-fetch` extension for the pi coding agent, with the same behavior and libraries: [Effect], [wreq-js], [Defuddle], and [linkedom]. The MCP server and the command line use Effect's own `effect/ai` and `effect/cli` modules, so the port adds no dependencies.

## Install

You need [Bun] 1.4.3 or later.

```sh
bun install
bun link
```

`bun link` puts `mcp-web-fetch` on your `PATH`. Without it, run `bun src/main.ts` in its place.

## Fetch a page from the command line

```sh
mcp-web-fetch fetch https://example.com
mcp-web-fetch fetch https://example.com --format raw --browser chrome
mcp-web-fetch fetch https://example.com --json
```

`fetch` prints what the MCP tool returns. By default that is the report a model reads. With `--json`, it prints the tool's `structuredContent` instead. Run `mcp-web-fetch fetch --help` for every flag.

| Exit code | Meaning |
| --- | --- |
| `0` | The server delivered the response. |
| `1` | The server answered with a bot challenge or an error status, and the report still prints. Or the fetch failed, and the reason prints to stderr. |
| `130` | You interrupted the command. |

## Connect an MCP client

Add the server to the client's configuration. Most clients take this shape:

```json
{
  "mcpServers": {
    "web-fetch": {
      "command": "bun",
      "args": ["/absolute/path/to/mcp-web-fetch/src/main.ts", "serve"]
    }
  }
}
```

For Claude Code, run:

```sh
claude mcp add web-fetch -- bun /absolute/path/to/mcp-web-fetch/src/main.ts serve
```

The server speaks MCP 2024-11-05 through 2026-07-28 and uses the newest revision that the client offers. It sends the client short instructions on when to use the tool. It stops with exit code `0` when the client closes stdin, and its stdout carries only MCP messages. Logs go to stderr.

## The `web_fetch` tool

| Argument  | Values                                                               | Default    |
| --------- | -------------------------------------------------------------------- | ---------- |
| `url`     | An http or https URL                                                 | Required   |
| `format`  | `markdown` or `raw`. `raw` returns an HTML page's source.            | `markdown` |
| `browser` | `chrome`, `firefox`, `safari`, or `edge`, each at its newest version | `safari`   |

| Response | Result |
| --- | --- |
| HTML | The main content as Markdown, from Defuddle with linkedom as the DOM |
| HTML with `format: "raw"` | The HTML source |
| Other text, such as JSON or XML | The text as sent |
| Binary, such as a PDF or image | Saved to a temporary file. The result gives the path. |
| A bot challenge | An error that names the vendor, with the page's text |

Each result has two parts:

- `content` holds one text block: a header of checked facts, a warning that untrusted web content follows, the page's metadata, and the body. The block is limited to 2000 lines or 50 KB. Longer text is saved to a temporary file, and the block ends with its path. A single long line is cut rather than dropped.
- `structuredContent` holds the same facts as data, with up to 1 MiB of the original text. The tool's `outputSchema` describes it.

A bot challenge or an error status sets `isError`, and the result still carries the page. A failed fetch, such as a refused connection or a timeout, returns a result with `isError` and the reason. Arguments that don't match the input schema fail with an invalid-params error. From MCP 2025-11-25 on, that error arrives as a result with `isError`, as the revision specifies.

Text is decoded with the charset a browser would choose for its media type.

## Conversion

Parsing and Defuddle's extraction are synchronous, so each conversion runs in its own worker thread, and the server keeps answering. At most two conversions run at once. A page returns as HTML source, with the reason, when:

- it is larger than 5 MiB or nests elements more than 400 levels deep, which is checked before converting;
- converting takes longer than 30 seconds; or
- converting uses more than 1.5 GiB. Bun ignores a worker's heap limit, so the process's memory growth is watched instead.

The worker silences its console, since Defuddle logs errors that quote the page. Nothing from the worker reaches stdout.

## Sessions

Each call opens a wreq-js session for its browser and closes it when the call ends, even when the call fails, times out, or is cancelled. A call starts with no cookies, and no cookies or connections carry over to the next call, so earlier calls cannot change what a later call sends. Each call makes new TCP and TLS connections, which adds about 0.2 seconds to a call to a distant host.

Defuddle's site extractors, such as YouTube transcripts, make their own requests. The worker relays them to the call's session, so they share its cookies, size limit, and cancellation.

## Saved files

Each process saves files in one private temporary directory, named `mcp-web-fetch-` and a random suffix. A save that fails or is cancelled leaves nothing behind.

- `serve` removes the directory when the server stops. The paths mean something only to the conversation the server serves.
- `fetch` keeps the directory, so the paths it prints stay valid. The operating system clears its temporary directory in time.

## Limits

- It cannot run JavaScript. JavaScript challenges, such as Cloudflare Turnstile or DataDome, and pages that render only in the browser need a browser automation tool.
- Responses larger than 25 MiB fail, and each call times out after 60 seconds.
- wreq-js does not close a connection whose body was cancelled, even when its session closes. The connection stays open until the server ends it. No wreq-js option bounds this.
- Legacy encodings, such as Shift_JIS, decode with Bun's `TextDecoder`.
- wreq-js ships prebuilt binaries for macOS, Linux (glibc and musl), Windows, and Android. Other platforms need a Rust toolchain.
- wreq-js trusts its bundled root certificates, not the macOS Keychain. A network that inspects TLS traffic breaks it.

## Develop

```sh
bun run check
```

`check` runs the formatter's check, oxlint with type-aware rules and type checking, and the tests in `src/`. `bun run format` formats the code.

`repos/effect/` holds Effect's source at the installed version, as a read-only reference for its APIs and idioms. `effect` and `@effect/platform-node` are pinned to the same version, which must match `repos/effect/`. Update all three together.

[Bun]: https://bun.com
[Defuddle]: https://github.com/kepano/defuddle
[Effect]: https://effect.website
[linkedom]: https://github.com/WebReflection/linkedom
[wreq-js]: https://github.com/sqdshguy/wreq-js
