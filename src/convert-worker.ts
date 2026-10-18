/**
 * Converts one HTML page to Markdown off the main thread. The main thread
 * terminates this worker on its deadline, on cancellation, or when memory
 * grows too far, since parsing and extraction are synchronous and cannot be
 * interrupted from inside.
 */
import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { Defuddle } from "defuddle/node";
import { pipe } from "effect/Function";
import * as Match from "effect/Match";
import { parseHTML } from "linkedom";
import type { Reply, WorkerInput, WorkerMessage } from "./protocol.ts";

// Defuddle logs parse errors that quote page text, which can hold terminal
// escapes. Nothing from the worker may reach the terminal, or stdout, which
// carries the MCP server's messages.
const silent = () => undefined;
console.debug = silent;
console.error = silent;
console.info = silent;
console.log = silent;
console.trace = silent;
console.warn = silent;

const post = (message: WorkerMessage, transfer: Array<ArrayBuffer> = []) =>
  parentPort?.postMessage(message, transfer);

type Fetched = Extract<Reply, { _tag: "Fetched" }>;
// A standard Response cannot take a URL, so the final URL and redirect flag
// are set on the instance, where Defuddle's extractors read them.
const toResponse = (fetched: Fetched) =>
  Object.defineProperties(
    new Response(fetched.body, {
      status: fetched.status,
      statusText: fetched.statusText,
      headers: fetched.headers,
    }),
    { url: { value: fetched.url }, redirected: { value: fetched.redirected } },
  );
const settle = (reply: Reply): Promise<Response> =>
  pipe(
    Match.value(reply),
    Match.tagsExhaustive({
      Fetched: (fetched) => Promise.resolve(fetched).then(toResponse),
      FetchFailed: ({ message }) => Promise.reject(new TypeError(message)),
    }),
  );

const waiters = new Map<string, (reply: Reply) => void>();
parentPort?.on("message", (reply: Reply) => {
  waiters.get(reply.id)?.(reply);
  waiters.delete(reply.id);
});

const send = (request: Request, body: ArrayBuffer) =>
  new Promise<Response>((resolve, reject) => {
    const id = randomUUID();
    const abort = () => {
      waiters.delete(id);
      post({ _tag: "FetchAborted", id });
      reject(request.signal.reason);
    };
    waiters.set(id, (reply) => {
      request.signal.removeEventListener("abort", abort);
      resolve(settle(reply));
    });
    request.signal.addEventListener("abort", abort, { once: true });
    post(
      {
        _tag: "FetchRequested",
        id,
        url: request.url,
        method: request.method,
        headers: Array.from(request.headers),
        body,
      },
      [body],
    );
  });

// A standard Request normalizes every form of input, including its signal.
const requestOf = (input: string | URL | Request, init?: RequestInit) =>
  pipe(
    Match.value(input),
    Match.when(Match.string, (url) => new Request(url, init)),
    Match.when({ href: Match.string }, ({ href }) => new Request(href, init)),
    Match.orElse((request) => new Request(request, init)),
  );

// The relay has no connection of its own to warm, so preconnect does nothing.
const relayFetch: typeof globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve()
      .then(() => requestOf(input, init))
      .then((request) =>
        request.arrayBuffer().then((body) => {
          request.signal.throwIfAborted();
          return send(request, body);
        }),
      ),
  { preconnect: () => undefined },
);

/** The parts of linkedom's untyped document that this worker reads. */
type PageNode = {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
};
type Page = {
  readonly documentElement: {
    readonly nodeName: string;
    readonly childNodes: Iterable<PageNode>;
  } | null;
};

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const blank = (node: PageNode) => node.nodeType === TEXT && (node.textContent ?? "").trim() === "";
const holder = (node: PageNode) =>
  (node.nodeType === ELEMENT && (node.nodeName === "HEAD" || node.nodeName === "BODY")) ||
  node.nodeType === COMMENT ||
  blank(node);
// linkedom keeps content outside an explicit body element out of the body,
// or makes the first element the root, where a browser would create html and
// body elements. A document is used as parsed only when its root holds
// nothing but head and body.
const wellFormed = (page: Page) =>
  page.documentElement !== null &&
  page.documentElement.nodeName === "HTML" &&
  Array.from(page.documentElement.childNodes).every(holder);

const parsePage = (html: string): Page => parseHTML(html).document;
const pageOf = (html: string) =>
  [parsePage(html)].find(wellFormed) ??
  parsePage(`<!doctype html><html><head></head><body>${html}</body></html>`);

const failure = (error: unknown) =>
  pipe(
    Match.value(error),
    Match.when(Match.instanceOf(Error), ({ message }) => message),
    Match.orElse((value) => String(value)),
  );

const { html, url }: WorkerInput = workerData;
void Promise.resolve()
  .then(() => Defuddle(pageOf(html), url, { markdown: true, fetch: relayFetch }))
  .then(
    (result) =>
      post({
        _tag: "Converted",
        markdown: result.content,
        title: result.title,
        author: result.author,
        published: result.published,
        site: result.site,
        words: result.wordCount,
      }),
    (error: unknown) => post({ _tag: "ConversionFailed", message: failure(error) }),
  );
