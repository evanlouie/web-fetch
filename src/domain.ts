import {
  Array,
  Boolean,
  Data,
  flow,
  Match,
  Option,
  pipe,
  Record,
  Result,
  Schema,
  String as Str,
} from "effect";
import { nestingDepth } from "./markup.ts";
// Node's TextDecoder takes any label and throws on an unknown one, which
// `supported` relies on. Bun's global type admits only known labels.
import { TextDecoder } from "node:util";

export const TOOL_NAME = "web_fetch";

/** Browser families to impersonate. wreq-js resolves each to its newest profile. */
export const BROWSERS = ["chrome", "firefox", "safari", "edge"] as const;
export type Browser = (typeof BROWSERS)[number];
export const DEFAULT_BROWSER: Browser = "safari";

export const FORMATS = ["markdown", "raw"] as const;
export type Format = (typeof FORMATS)[number];
export const DEFAULT_FORMAT: Format = "markdown";

export class WebFetchError extends Schema.TaggedError<WebFetchError>()("WebFetchError", {
  message: Schema.String,
}) {}

/** A request whose URL is known to be http or https. */
export type FetchRequest = {
  readonly url: URL;
  readonly format: Format;
  readonly browser: Browser;
};

/** What the network returned, with header names in lower case. */
export type Fetched = {
  readonly requested: URL;
  readonly url: URL;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record.ReadonlyRecord<string, string>;
  readonly body: Uint8Array;
  readonly profile: string;
};

// Text limits

/** Shorten text to at most `max` characters, never splitting one, and mark the cut. */
export const clipChars =
  (max: number) =>
  (text: string): string => {
    // Two UTF-16 units hold any character, so this prefix has enough of them.
    const characters = Array.fromIterable(text.slice(0, max * 2 + 2));
    return pipe(
      characters.length > max,
      Boolean.match({
        onTrue: () => `${pipe(characters, Array.take(max), Array.join(""))}…`,
        onFalse: () => text,
      }),
    );
  };

/** Collapse line breaks and runs of whitespace, so a value stays on one line. */
export const oneLine = flow(Str.replace(/\s+/g, " "), Str.trim);

export type Limit = { readonly maxBytes: number; readonly maxLines: number };

/** How much text a tool result shows a model, as in pi's built-in tools. */
export const OUTPUT_LIMIT: Limit = { maxBytes: 50 * 1024, maxLines: 2_000 };

/** A byte count for people, such as `512B`, `50.0KB`, or `25.0MB`. */
export const formatSize = (bytes: number) =>
  pipe(
    Match.value(bytes),
    Match.when(
      (size) => size < 1024,
      (size) => `${size}B`,
    ),
    Match.when(
      (size) => size < 1024 * 1024,
      (size) => `${(size / 1024).toFixed(1)}KB`,
    ),
    Match.orElse((size) => `${(size / 1024 / 1024).toFixed(1)}MB`),
  );
export type Limited = {
  readonly text: string;
  readonly truncated: boolean;
  readonly shownLines: number;
  readonly shownBytes: number;
  readonly totalBytes: number;
};

const utf8 = new TextEncoder();
export const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

// A UTF-16 unit encodes to at least one byte, so `maxBytes` units cover the
// byte limit. A fresh streaming decoder holds back a split character.
const byteHead = (text: string, maxBytes: number) =>
  new TextDecoder().decode(utf8.encode(text.slice(0, maxBytes)).subarray(0, maxBytes), {
    stream: true,
  });

/**
 * Keep the start of a text within a byte and line limit, reading only the
 * prefix that can fit. A cut by bytes drops the partial last line, unless the
 * text is one long line, which is cut mid-line instead of vanishing.
 */
export const limitText = (text: string, { maxBytes, maxLines }: Limit): Limited => {
  const head = byteHead(text, maxBytes);
  const lines = pipe(head, Str.split("\n"));
  const whole = pipe(
    head.length < text.length && lines.length > 1,
    Boolean.match({
      onTrue: () => pipe(lines, Array.dropRight(1)),
      onFalse: () => lines,
    }),
    Array.take(maxLines),
  );
  const shown = pipe(whole, Array.join("\n"));
  return {
    text: shown,
    truncated: shown.length < text.length,
    shownLines: whole.length,
    shownBytes: byteLength(shown),
    totalBytes: byteLength(text),
  };
};

// Requests

const WEB_PROTOCOLS: ReadonlyArray<string> = ["http:", "https:"];
const MAX_ECHO = 200;

/** Accept only absolute http and https URLs. */
export const parseUrl = (raw: string): Result.Result<URL, WebFetchError> =>
  pipe(
    Result.try({
      try: () => new URL(Str.trim(raw)),
      catch: () =>
        new WebFetchError({
          message: `Invalid URL: ${pipe(raw, clipChars(MAX_ECHO), JSON.stringify)}`,
        }),
    }),
    Result.filterOrFail(
      (url) => WEB_PROTOCOLS.includes(url.protocol),
      (url) =>
        new WebFetchError({
          message: `Only http and https URLs can be fetched, not ${clipChars(MAX_ECHO)(url.protocol)}`,
        }),
    ),
  );

// Media

const latin1 = new TextDecoder("latin1");
/** Read the start of a body as bytes, for signatures and declarations written in ASCII. */
const asciiPrefix = (body: Uint8Array, bytes: number) => latin1.decode(body.subarray(0, bytes));

export const contentType = (fetched: Fetched) =>
  pipe(fetched.headers, Record.get("content-type"), Option.filter(Str.isNonEmpty));

const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
/** The media type without parameters, such as `text/html`, when it is well formed. */
export const mimeType = (fetched: Fetched) =>
  pipe(
    contentType(fetched),
    Option.map(flow(Str.split(";"), Array.headNonEmpty, Str.trim, Str.toLowerCase)),
    Option.filter((type) => MEDIA_TYPE.test(type)),
  );

/** How a body is read. Text formats differ in how their charset is found. */
export type Media = Data.TaggedEnum<{
  Html: {};
  Xml: {};
  Json: {};
  Text: {};
  Binary: {};
}>;
export const Media = Data.taggedEnum<Media>();

const HTML_TYPES: ReadonlyArray<string> = ["text/html", "application/xhtml+xml"];
const JSON_TYPES: ReadonlyArray<string> = ["application/json", "application/x-ndjson"];
const XML_TYPES: ReadonlyArray<string> = ["application/xml", "text/xml"];
const TEXT_TYPES: ReadonlyArray<string> = [
  "application/ecmascript",
  "application/graphql",
  "application/javascript",
  "application/sql",
  "application/toml",
  "application/x-javascript",
  "application/x-sh",
  "application/x-yaml",
  "application/yaml",
];

const mediaOf = (mime: string): Media =>
  pipe(
    Match.value(mime),
    Match.when(
      (type) => HTML_TYPES.includes(type),
      () => Media.Html(),
    ),
    Match.when(
      (type) => JSON_TYPES.includes(type) || Str.endsWith("+json")(type),
      () => Media.Json(),
    ),
    Match.when(
      (type) => XML_TYPES.includes(type) || Str.endsWith("+xml")(type),
      () => Media.Xml(),
    ),
    Match.when(
      (type) => Str.startsWith("text/")(type) || TEXT_TYPES.includes(type),
      () => Media.Text(),
    ),
    Match.orElse(() => Media.Binary()),
  );

const SNIFF_BYTES = 8_192;
const UTF8_BOM = "\u00ef\u00bb\u00bf";
const UTF16_BOMS: ReadonlyArray<string> = ["\u00fe\u00ff", "\u00ff\u00fe"];
// The tags that the WHATWG MIME sniffing standard treats as HTML, after any
// leading comments.
const HTML_START =
  /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|script|iframe|h1|div|font|table|a|style|title|b|body|br|p)[\s>]/i;
// Binary formats that start with printable ASCII. Other binary formats show
// control bytes or invalid UTF-8 early.
const BINARY_SIGNATURES: ReadonlyArray<string> = [
  "%PDF-",
  "%!PS-Adobe",
  "GIF87a",
  "GIF89a",
  "RIFF",
  "OggS",
  "ID3",
  "fLaC",
  "wOFF",
  "wOF2",
  "BZh",
];
// Bytes that the WHATWG MIME sniffing standard calls binary data bytes.
const isBinaryByte = (byte: number) =>
  byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1a) || (byte >= 0x1c && byte <= 0x1f);

// A sample cut short may end inside a character, so decode it as a stream.
// Each call needs its own decoder, since a streaming decoder keeps state.
const validUtf8 = (sample: Uint8Array, partial: boolean) =>
  pipe(
    Result.try(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(sample, {
        stream: partial,
      }),
    ),
    Result.isSuccess,
  );

// Without a declared type, look at the bytes, as browsers do.
const sniffMedia = (body: Uint8Array): Media => {
  const sample = body.subarray(0, SNIFF_BYTES);
  const start = pipe(asciiPrefix(sample, SNIFF_BYTES), Str.replace(new RegExp(`^${UTF8_BOM}`), ""));
  return pipe(
    Match.value(start),
    Match.when(
      (text) => UTF16_BOMS.some((mark) => Str.startsWith(mark)(text)),
      () => Media.Text(),
    ),
    Match.when(
      (text) => HTML_START.test(text),
      () => Media.Html(),
    ),
    Match.when(
      (text) =>
        BINARY_SIGNATURES.some((signature) => Str.startsWith(signature)(text)) ||
        sample.some(isBinaryByte),
      () => Media.Binary(),
    ),
    Match.when(
      () => validUtf8(sample, body.byteLength > SNIFF_BYTES),
      () => Media.Text(),
    ),
    Match.orElse(() => Media.Binary()),
  );
};

export const classifyMedia = (fetched: Fetched): Media =>
  pipe(
    mimeType(fetched),
    Option.match({
      onNone: () => sniffMedia(fetched.body),
      onSome: mediaOf,
    }),
  );

// Charsets

/** The canonical name of an encoding label that this runtime can decode. */
const supported = (label: string) =>
  pipe(
    Result.try(() => new TextDecoder(Str.trim(label)).encoding),
    Result.getSuccess,
  );

const BOMS: ReadonlyArray<readonly [string, string]> = [
  [UTF8_BOM, "utf-8"],
  ["\u00fe\u00ff", "utf-16be"],
  ["\u00ff\u00fe", "utf-16le"],
];
const bomCharset = (body: Uint8Array) => {
  const start = asciiPrefix(body, 3);
  return pipe(
    BOMS,
    Array.findFirst(([mark, label]) =>
      pipe(start, Option.liftPredicate(Str.startsWith(mark)), Option.as(label)),
    ),
  );
};

// Each pattern takes a whole parameter or attribute, so names such as
// data-charset do not match.
const CHARSET_PARAMETER = /(?:^|[\s;])charset\s*=\s*["']?([^"';\s]+)/i;
const captured = (pattern: RegExp) => flow(Str.match(pattern), Option.flatMap(Array.get(1)));

const headerCharset = (fetched: Fetched) =>
  pipe(
    contentType(fetched),
    Option.flatMap(captured(CHARSET_PARAMETER)),
    Option.flatMap(supported),
  );

const PRESCAN_BYTES = 1_024;
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;
const META_TAGS = /<meta\s([^>]*)>/gi;
const ATTRIBUTES = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

// When an attribute repeats, the first one counts, as in HTML parsing.
const attributesOf = (source: string) =>
  pipe(
    Array.fromIterable(source.matchAll(ATTRIBUTES)),
    Array.map(
      ([, name, doubleQuoted, singleQuoted, bare]) =>
        [Str.toLowerCase(name), doubleQuoted ?? singleQuoted ?? bare ?? ""] as const,
    ),
    Array.reverse,
    Record.fromEntries,
  );

// A meta tag declares a charset through its charset attribute, or through
// http-equiv="content-type" with a charset in its content attribute.
type Attributes = Record.ReadonlyRecord<string, string>;
const httpEquivCharset = (attributes: Attributes) =>
  pipe(
    attributes,
    Record.get("http-equiv"),
    Option.filter((value) => Str.toLowerCase(Str.trim(value)) === "content-type"),
    Option.flatMap(() => pipe(attributes, Record.get("content"))),
    Option.flatMap(captured(CHARSET_PARAMETER)),
  );
const metaDeclaration = (attributes: Attributes) =>
  pipe(
    attributes,
    Record.get("charset"),
    Option.orElse(() => httpEquivCharset(attributes)),
  );

// HTML treats a declared UTF-16 as UTF-8, since a UTF-16 page could not have
// declared it in ASCII, and x-user-defined as windows-1252.
const htmlEncoding = (encoding: string) =>
  pipe(
    Match.value(encoding),
    Match.when(Str.startsWith("utf-16"), () => "utf-8"),
    Match.when("x-user-defined", () => "windows-1252"),
    Match.orElse(() => encoding),
  );

const metaCharset = (body: Uint8Array) =>
  pipe(
    asciiPrefix(body, PRESCAN_BYTES),
    Str.replace(COMMENTS, ""),
    (prefix) => Array.fromIterable(prefix.matchAll(META_TAGS)),
    Array.findFirst(([, source]) =>
      pipe(attributesOf(source), metaDeclaration, Option.flatMap(supported)),
    ),
    Option.map(htmlEncoding),
  );

const XML_DECLARATION = /^\s*<\?xml\s[^>]*?\sencoding\s*=\s*["']([\w.:-]+)["']/;
const xmlCharset = (body: Uint8Array) =>
  pipe(asciiPrefix(body, PRESCAN_BYTES), captured(XML_DECLARATION), Option.flatMap(supported));

const firstOf =
  (...sources: ReadonlyArray<() => Option.Option<string>>) =>
  (): string =>
    pipe(
      sources,
      Array.findFirst((source) => source()),
      Option.getOrElse(() => "utf-8"),
    );

// A byte order mark always wins. HTML then trusts the header over a meta tag,
// XML trusts the header over its declaration, and JSON is always UTF-8.
const charsetOf = (fetched: Fetched, media: Media) =>
  pipe(
    media,
    Media.$match({
      Html: firstOf(
        () => bomCharset(fetched.body),
        () => headerCharset(fetched),
        () => metaCharset(fetched.body),
      ),
      Xml: firstOf(
        () => bomCharset(fetched.body),
        () => headerCharset(fetched),
        () => xmlCharset(fetched.body),
      ),
      Json: firstOf(() => bomCharset(fetched.body)),
      Text: firstOf(
        () => bomCharset(fetched.body),
        () => headerCharset(fetched),
      ),
      Binary: firstOf(),
    }),
  );

// Every label reaching here was checked, so the fallback only guards against
// a runtime that rejects its own canonical name.
const decoderFor = (label: string) =>
  pipe(
    Result.try(() => new TextDecoder(label)),
    Result.getOrElse(() => new TextDecoder("utf-8")),
  );

/** Decode a text body with the charset a browser would use for its media type. */
export const decodeText = (fetched: Fetched, media: Media) =>
  decoderFor(charsetOf(fetched, media)).decode(fetched.body);

const decodePrefix = (fetched: Fetched, media: Media, bytes: number) =>
  decoderFor(charsetOf(fetched, media)).decode(fetched.body.subarray(0, bytes), { stream: true });

// Verdicts

/** How the server answered. */
export type Verdict = Data.TaggedEnum<{
  Delivered: {};
  Challenged: { readonly vendor: string };
  Refused: {};
}>;
export const Verdict = Data.taggedEnum<Verdict>();

type Challenge = { readonly vendor: string; readonly evidence: string };

// Bot-protection services name their challenges in these headers on any status.
const CHALLENGE_HEADERS: ReadonlyArray<readonly [string, Challenge]> = [
  ["cf-mitigated", { vendor: "Cloudflare", evidence: "challenge" }],
  ["x-amzn-waf-action", { vendor: "AWS WAF", evidence: "challenge" }],
  ["x-amzn-waf-action", { vendor: "AWS WAF", evidence: "captcha" }],
];
// Challenge pages load these. Ordinary pages can load Cloudflare's passive
// script or send DataDome's header, so neither counts.
const CHALLENGE_MARKERS: ReadonlyArray<Challenge> = [
  { vendor: "Cloudflare", evidence: "_cf_chl_opt" },
  { vendor: "DataDome", evidence: "captcha-delivery.com" },
  { vendor: "HUMAN", evidence: "px-captcha" },
];
const MARKER_BYTES = 65_536;

const headerChallenge = (fetched: Fetched) =>
  pipe(
    CHALLENGE_HEADERS,
    Array.findFirst(([name, { vendor, evidence }]) =>
      pipe(
        fetched.headers,
        Record.get(name),
        Option.filter((value) => Str.toLowerCase(value).includes(evidence)),
        Option.as(vendor),
      ),
    ),
  );

const markerChallenge = (fetched: Fetched, media: Media) => {
  const sample = decodePrefix(fetched, media, MARKER_BYTES);
  return pipe(
    CHALLENGE_MARKERS,
    Array.findFirst(({ vendor, evidence }) =>
      pipe(sample, Option.liftPredicate(Str.includes(evidence)), Option.as(vendor)),
    ),
  );
};

const statusVerdict = (fetched: Fetched, media: Media): Verdict =>
  pipe(
    fetched.status >= 200 && fetched.status < 300,
    Boolean.match({
      onTrue: () => Verdict.Delivered(),
      onFalse: () =>
        pipe(
          markerChallenge(fetched, media),
          Option.match({
            onNone: () => Verdict.Refused(),
            onSome: (vendor) => Verdict.Challenged({ vendor }),
          }),
        ),
    }),
  );

/** Headers name a challenge on any status. Page markers count only on errors. */
export const judge = (fetched: Fetched, media: Media): Verdict =>
  pipe(
    headerChallenge(fetched),
    Option.match({
      onNone: () => statusVerdict(fetched, media),
      onSome: (vendor) => Verdict.Challenged({ vendor }),
    }),
  );

/** Where an unfollowed redirect points, resolved against the response URL. */
export const redirectTarget = (fetched: Fetched) =>
  pipe(
    fetched.status >= 300 && fetched.status < 400,
    Option.liftPredicate((redirect) => redirect),
    Option.flatMap(() => pipe(fetched.headers, Record.get("location"))),
    Option.flatMap((location) =>
      pipe(
        Result.try(() => new URL(location, fetched.url)),
        Result.getSuccess,
      ),
    ),
    Option.map((url) => url.href),
  );

// Reading

/** What to do with a response body. */
export type Reading = Data.TaggedEnum<{
  Empty: {};
  Convert: {};
  Decode: {};
  Save: {};
}>;
export const Reading = Data.taggedEnum<Reading>();

const readingOf = (media: Media, format: Format): Reading =>
  pipe(
    media,
    Media.$match({
      Html: () =>
        pipe(
          Match.value(format),
          Match.when("markdown", () => Reading.Convert()),
          Match.when("raw", () => Reading.Decode()),
          Match.exhaustive,
        ),
      Xml: () => Reading.Decode(),
      Json: () => Reading.Decode(),
      Text: () => Reading.Decode(),
      Binary: () => Reading.Save(),
    }),
  );

/** Every body is read, including challenge and error pages, so a misjudged response still shows. */
export const plan = (fetched: Fetched, media: Media, format: Format): Reading =>
  pipe(
    fetched.body.byteLength === 0,
    Boolean.match({
      onTrue: () => Reading.Empty(),
      onFalse: () => readingOf(media, format),
    }),
  );

// Conversion limits

/** Why a page was shown as HTML instead of Markdown. */
export type Unconverted = Data.TaggedEnum<{
  TooLarge: { readonly characters: number };
  TooDeep: { readonly depth: number };
  TimedOut: { readonly seconds: number };
  OutOfMemory: {};
  Failed: { readonly message: string };
}>;
export const Unconverted = Data.taggedEnum<Unconverted>();

// Defuddle's time grows with the square of nesting depth, and its memory
// with page size. Real pages nest 15 to 40 levels deep.
export const MAX_CONVERTIBLE_CHARACTERS = 5 * 1024 * 1024;
export const MAX_CONVERTIBLE_DEPTH = 400;

/** Decline pages that would take too long or too much memory to convert. */
export const convertible = (html: string) =>
  pipe(
    html,
    Result.liftPredicate(
      (page) => page.length <= MAX_CONVERTIBLE_CHARACTERS,
      (page) => Unconverted.TooLarge({ characters: page.length }),
    ),
    Result.map((page) => ({ page, depth: nestingDepth(page) })),
    Result.filterOrFail(
      ({ depth: nesting }) => nesting <= MAX_CONVERTIBLE_DEPTH,
      ({ depth: nesting }) => Unconverted.TooDeep({ depth: nesting }),
    ),
    Result.map(({ page }) => page),
  );

// File names

// Windows reserves these names for devices, with or without an extension.
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const SIMPLE_EXTENSION = /^[a-z0-9]{2,5}$/;
const MAX_NAME = 100;

const extensionFor = (fetched: Fetched) =>
  pipe(
    mimeType(fetched),
    Option.map(flow(Str.split("/"), Array.lastNonEmpty)),
    Option.filter((subtype) => SIMPLE_EXTENSION.test(subtype)),
  );

const safeName = (segment: string) =>
  pipe(
    Result.try(() => decodeURIComponent(segment)),
    Result.getOrElse(() => segment),
    Str.replace(/[^\w.-]+/g, "_"),
    Str.replace(/^[._]+/, ""),
    Str.replace(/[. ]+$/, ""),
    Str.slice(0, MAX_NAME),
    Str.replace(RESERVED_NAME, "_$&"),
  );

/** A safe file name for a download, from the URL path and the media type. */
export const fileName = (fetched: Fetched) => {
  const base = pipe(
    fetched.url.pathname,
    Str.split("/"),
    Array.lastNonEmpty,
    safeName,
    Option.liftPredicate(Str.isNonEmpty),
    Option.getOrElse(() => "download"),
  );
  return pipe(
    base,
    Option.liftPredicate((name) => !Str.includes(".")(name)),
    Option.flatMap((name) =>
      pipe(
        extensionFor(fetched),
        Option.map((extension) => `${name}.${extension}`),
      ),
    ),
    Option.getOrElse(() => base),
  );
};

/** The name of a saved copy of text, by what the text is. */
export const textFileName = Media.$match({
  Html: () => "page.html",
  Xml: () => "page.xml",
  Json: () => "page.json",
  Text: () => "page.txt",
  Binary: () => "page.bin",
});

// Retention

/**
 * What happens to saved files when the process ends. A CLI fetch prints paths
 * for later use, so it keeps them. An MCP server's paths mean something only
 * to the conversation it serves, which ends with the server.
 */
export type Retention = "keep" | "discard";
