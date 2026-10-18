import {
  Array,
  Boolean,
  Chunk,
  Context,
  Effect,
  Layer,
  Option,
  pipe,
  Predicate,
  Record,
  Stream,
  String as Str,
  type Scope,
} from "effect";
import { createSession, resolveProfile, type Response, type Session } from "wreq-js";
import { clipChars, WebFetchError, type Browser, type Fetched } from "./domain.ts";
import type { FetchRequested, Relay } from "./protocol.ts";

export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ERROR = 1_000;
const shortUrl = clipChars(300);

const errorText = (error: unknown) =>
  pipe(
    error,
    Option.liftPredicate(Predicate.isError),
    Option.map(({ message }) => message),
    Option.getOrElse(() => String(error)),
    Str.replace(/^(?:Error: )+/, ""),
    clipChars(MAX_ERROR),
  );

const openSession = (browser: Browser) =>
  Effect.tryPromise({
    try: () => createSession({ browser }),
    catch: (error) =>
      new WebFetchError({
        message: `Could not start a ${browser} session: ${errorText(error)}`,
      }),
  });
const closeSession = (session: Session) =>
  pipe(
    Effect.tryPromise(() => session.close()),
    Effect.ignore,
  );

// wreq-js stops listening to the signal once headers arrive. Reading the body
// through an interruptible stream keeps the rest of the transfer cancellable.
const send = (session: Session, input: string | Request, target: string) =>
  Effect.tryPromise({
    try: (signal) => session.fetch(input, { signal }),
    catch: (error) =>
      new WebFetchError({
        message: `Request to ${shortUrl(target)} failed: ${errorText(error)}`,
      }),
  });

const tooLarge = () =>
  new WebFetchError({
    message: `The response is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB, so web_fetch stopped reading it. Save large files with a download tool that streams to disk.`,
  });

type Collected = {
  readonly size: number;
  readonly chunks: Chunk.Chunk<Uint8Array>;
};
// Chunk appends in amortized constant time, so many small chunks stay linear.
const collect = (collected: Collected, chunk: Uint8Array) =>
  pipe(
    collected.size + chunk.byteLength > MAX_BODY_BYTES,
    Boolean.match({
      onTrue: () => Effect.fail(tooLarge()),
      onFalse: () =>
        Effect.succeed<Collected>({
          size: collected.size + chunk.byteLength,
          chunks: pipe(collected.chunks, Chunk.append(chunk)),
        }),
    }),
  );

// Stop reading at the limit, so a huge or endless body cannot exhaust memory.
const readStream = (body: ReadableStream<Uint8Array>) =>
  pipe(
    Stream.fromReadableStream({
      evaluate: () => body,
      onError: (error) =>
        new WebFetchError({
          message: `Reading the response failed: ${errorText(error)}`,
        }),
    }),
    Stream.runFoldEffect((): Collected => ({ size: 0, chunks: Chunk.empty() }), collect),
    Effect.map(({ chunks }) => new Uint8Array(Buffer.concat(Chunk.toReadonlyArray(chunks)))),
  );
const readBody = (response: Response) =>
  pipe(
    Option.fromNullishOr(response.body),
    Option.match({
      onNone: () => Effect.succeed(new Uint8Array()),
      onSome: readStream,
    }),
  );

const headerEntries = (response: Response) =>
  pipe(
    Array.fromIterable(response.headers),
    Array.map(([name, value]): [string, string] => [Str.toLowerCase(name), value]),
  );

// Statuses whose responses cannot carry a body in the Fetch standard.
const NULL_BODY_STATUSES: ReadonlyArray<number> = [101, 103, 204, 205, 304];
const replyBody = (status: number, body: Uint8Array) =>
  pipe(
    NULL_BODY_STATUSES.includes(status),
    Boolean.match({ onTrue: () => null, onFalse: () => body.slice().buffer }),
  );

const relayRequest = (requested: FetchRequested) =>
  Effect.try({
    try: () =>
      new Request(requested.url, {
        method: requested.method,
        headers: pipe(
          requested.headers,
          Array.map(([name, value]): [string, string] => [name, value]),
        ),
        body: pipe(
          requested.body.byteLength > 0,
          Boolean.match({ onTrue: () => requested.body, onFalse: () => null }),
        ),
      }),
    catch: (error) => new WebFetchError({ message: `Invalid request: ${errorText(error)}` }),
  });

const get = Effect.fn("Web.Client.get")(function* (session: Session, browser: Browser, url: URL) {
  const response = yield* send(session, url.href, url.href);
  const body = yield* readBody(response);
  return {
    requested: url,
    url: new URL(response.url),
    status: response.status,
    statusText: response.statusText,
    headers: Record.fromEntries(headerEntries(response)),
    body,
    profile: resolveProfile(browser),
  };
});

const fetched = Effect.fnUntraced(function* (session: Session, requested: FetchRequested) {
  const request = yield* relayRequest(requested);
  const response = yield* send(session, request, requested.url);
  const body = yield* readBody(response);
  return {
    _tag: "Fetched" as const,
    id: requested.id,
    status: response.status,
    statusText: response.statusText,
    headers: headerEntries(response),
    body: replyBody(response.status, body),
    url: response.url,
    redirected: response.redirected,
  };
});

const relayThrough =
  (session: Session): Relay =>
  (requested) =>
    pipe(
      fetched(session, requested),
      Effect.catch(({ message }) =>
        Effect.succeed({
          _tag: "FetchFailed" as const,
          id: requested.id,
          message,
        }),
      ),
    );

/** Requests through one browser session, usable until the scope that opened it closes. */
export type Client = {
  readonly get: (url: URL) => Effect.Effect<Fetched, WebFetchError>;
  /** Serve a request that Defuddle made in a conversion worker. */
  readonly relay: Relay;
};

const clientOf =
  (browser: Browser) =>
  (session: Session): Client => ({
    get: (url) => get(session, browser, url),
    relay: relayThrough(session),
  });

// A session holds a native connection pool. acquireRelease opens it
// uninterruptibly, so an interruption cannot abandon one that has started.
const open = (browser: Browser) =>
  pipe(Effect.acquireRelease(openSession(browser), closeSession), Effect.map(clientOf(browser)));

export class Web extends Context.Service<
  Web,
  {
    /** Open a browser session that closes with the scope. */
    readonly open: (browser: Browser) => Effect.Effect<Client, WebFetchError, Scope.Scope>;
  }
>()("web-fetch/Web") {
  static readonly layer = Layer.succeed(Web, Web.of({ open }));
}
