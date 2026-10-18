import {
  Boolean,
  Cause,
  Context,
  Duration,
  Effect,
  flow,
  Layer,
  Option,
  pipe,
  Struct,
} from "effect";
import { Conversion, Converter } from "./convert.ts";
import {
  classifyMedia,
  clipChars,
  decodeText,
  fileName,
  judge,
  plan,
  Reading,
  TOOL_NAME,
  WebFetchError,
  type Fetched,
  type FetchRequest,
  type Media,
  type Retention,
} from "./domain.ts";
import { Downloads } from "./files.ts";
import { Content, renderReport, type Rendered } from "./output.ts";
import type { Relay } from "./protocol.ts";
import { Web } from "./web.ts";

/** Carry out the reading plan for one response body. */
const read = (fetched: Fetched, media: Media, relay: Relay) =>
  Reading.$match({
    Empty: () => Effect.succeed(Content.Empty()),
    Convert: () =>
      Effect.gen(function* () {
        const converter = yield* Converter;
        const html = decodeText(fetched, media);
        const conversion = yield* converter.convert(html, fetched.url, relay);
        return pipe(
          conversion,
          Conversion.$match({
            Converted: ({ article }) => Content.Article({ article }),
            Declined: ({ reason }) => Content.Fallback({ html, reason }),
          }),
        );
      }),
    Decode: () => Effect.succeed(Content.Source({ text: decodeText(fetched, media) })),
    Save: () =>
      Effect.gen(function* () {
        const downloads = yield* Downloads;
        const path = yield* downloads.save(fileName(fetched), fetched.body);
        return Content.File({ path });
      }),
  });

// Each call gets its own browser session, shared by the page and the requests
// its conversion relays. It closes when the call ends, so cookies never carry
// over to the next call.
const retrieve = Effect.fn("webFetch.retrieve")(function* (request: FetchRequest) {
  const web = yield* Web;
  const client = yield* web.open(request.browser);
  const fetched = yield* client.get(request.url);
  const media = classifyMedia(fetched);
  const verdict = judge(fetched, media);
  const reading = plan(fetched, media, request.format);
  const content = yield* pipe(reading, read(fetched, media, client.relay));
  return { request, fetched, media, verdict, content };
}, Effect.scoped);

// Clients built on the official MCP SDK give up on a request after 60 seconds,
// so a call ends sooner and can still report its own timeout.
const DEADLINE = Duration.seconds(50);
const timedOut = ({ url }: FetchRequest) =>
  new WebFetchError({
    message: `Fetching ${clipChars(300)(url.href)} timed out after ${Duration.format(DEADLINE)}.`,
  });

// The deadline covers the transfer, the conversion, and saving the result.
const fetchPage = (request: FetchRequest) =>
  pipe(
    retrieve(request),
    Effect.timed,
    Effect.map(([elapsed, retrieved]) => pipe(retrieved, Struct.assign({ elapsed }))),
    Effect.flatMap(renderReport),
    Effect.timeoutOrElse({
      duration: DEADLINE,
      orElse: () => Effect.fail(timedOut(request)),
    }),
  );

const MAX_ERROR = 2_000;
const unexpected = (cause: Cause.Cause<unknown>) =>
  pipe(
    Cause.hasInterruptsOnly(cause),
    Boolean.match({
      onTrue: () => `${TOOL_NAME} was cancelled.`,
      onFalse: () =>
        `${TOOL_NAME} failed unexpectedly: ${clipChars(MAX_ERROR)(String(Cause.squash(cause)))}`,
    }),
  );

/** A bounded message for a fetch that failed, to show a model or a terminal. */
export const failureText = (cause: Cause.Cause<WebFetchError>) =>
  pipe(
    Cause.findErrorOption(cause),
    Option.map(({ message }) => clipChars(MAX_ERROR)(message)),
    Option.getOrElse(() => unexpected(cause)),
  );

const make = Effect.gen(function* () {
  const context = yield* Effect.context<Converter | Web | Downloads>();
  const services = pipe(context, Context.pick(Converter, Web, Downloads));
  return WebFetch.of({ fetch: flow(fetchPage, Effect.provideContext(services)) });
});

export class WebFetch extends Context.Service<
  WebFetch,
  {
    /** Fetch a page within the deadline, and lay it out for a model. */
    readonly fetch: (request: FetchRequest) => Effect.Effect<Rendered, WebFetchError>;
  }
>()("web-fetch/WebFetch") {
  static readonly layer = (retention: Retention) =>
    pipe(
      Layer.effect(WebFetch, make),
      Layer.provide(Layer.mergeAll(Converter.layer, Web.layer, Downloads.layer(retention))),
    );
}
