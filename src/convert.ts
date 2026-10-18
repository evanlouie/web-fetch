import { Worker } from "node:worker_threads";
import {
  Boolean,
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Match,
  Option,
  pipe,
  Queue,
  Result,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  String as Str,
} from "effect";
import { clipChars, convertible, Unconverted } from "./domain.ts";
import {
  WorkerMessage,
  type Converted,
  type Relay,
  type Reply,
  type WorkerInput,
} from "./protocol.ts";

/** The main content of a page as Markdown, with the metadata Defuddle found. */
export type Article = {
  readonly markdown: string;
  readonly title: Option.Option<string>;
  readonly author: Option.Option<string>;
  readonly published: Option.Option<string>;
  readonly site: Option.Option<string>;
  readonly words: number;
};

/** A page as Markdown, or the reason it stays HTML. */
export type Conversion = Data.TaggedEnum<{
  Converted: { readonly article: Article };
  Declined: { readonly reason: Unconverted };
}>;
export const Conversion = Data.taggedEnum<Conversion>();

const WORKER = new URL("./convert-worker.ts", import.meta.url);
// A conversion gets half of the tool's deadline, so the HTML can still be
// shown when it runs out.
const BUDGET = Duration.seconds(25);
// Node enforces the heap limit. Bun and Deno ignore it, so the process's
// memory growth is watched as well.
const HEAP_LIMIT_MB = 1_536;
const MEMORY_LIMIT_BYTES = HEAP_LIMIT_MB * 1024 * 1024;
const MEMORY_CHECK = Schedule.spaced("100 millis");
const CONCURRENT_CONVERSIONS = 2;

// Metadata comes from the page, so a hostile page could make it any length.
const METADATA_CHARACTERS = 500;
const present = (text: string) =>
  pipe(
    Str.trim(text),
    Option.liftPredicate(Str.isNonEmpty),
    Option.map(clipChars(METADATA_CHARACTERS)),
  );
const articleOf = (converted: Converted): Article => ({
  markdown: Str.trim(converted.markdown),
  title: present(converted.title),
  author: present(converted.author),
  published: present(converted.published),
  site: present(converted.site),
  words: converted.words,
});

const declined = (reason: Unconverted) => Conversion.Declined({ reason });
const failed = (message: string) =>
  declined(Unconverted.Failed({ message: clipChars(300)(message) }));

const workerFailure = (error: Error & { readonly code?: unknown }) =>
  pipe(
    error.code === "ERR_WORKER_OUT_OF_MEMORY",
    Boolean.match({
      onTrue: () => Unconverted.OutOfMemory(),
      onFalse: () => Unconverted.Failed({ message: clipChars(300)(error.message) }),
    }),
  );

// The worker's own output stays in the worker, so nothing reaches the terminal
// or the MCP server's stdout.
const spawn = (input: WorkerInput) =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new Worker(WORKER, {
          workerData: input,
          resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
          stdout: true,
          stderr: true,
        }),
    ),
    (worker) =>
      pipe(
        Effect.tryPromise(() => worker.terminate()),
        Effect.ignore,
      ),
  );

// A worker ends only by posting a result, so an error or an exit before that
// is a failure.
const messagesOf = (worker: Worker) =>
  Stream.callback<unknown, Unconverted>((queue) =>
    Effect.sync(() => {
      worker.on("message", (message: unknown) => Queue.offerUnsafe(queue, message));
      worker.on("error", (error: Error) =>
        Queue.failCauseUnsafe(queue, Cause.fail(workerFailure(error))),
      );
      worker.on("exit", (code: number) =>
        Queue.failCauseUnsafe(
          queue,
          Cause.fail(
            Unconverted.Failed({
              message: `The converter exited with code ${code}.`,
            }),
          ),
        ),
      );
    }),
  );

// A relayed body moves to the worker rather than being copied.
const transferOf = (reply: Reply): Array<ArrayBuffer> =>
  pipe(
    Match.value(reply),
    Match.tagsExhaustive({
      Fetched: ({ body }) => pipe(Option.fromNullishOr(body), Option.toArray),
      FetchFailed: () => [],
    }),
  );

const decodeMessage = Schema.decodeUnknownEffect(WorkerMessage);

const watchMemory = Effect.gen(function* () {
  const baseline = process.memoryUsage.rss();
  yield* pipe(
    Effect.sync(() => process.memoryUsage.rss() - baseline),
    Effect.repeat({
      schedule: MEMORY_CHECK,
      until: (growth) => growth > MEMORY_LIMIT_BYTES,
    }),
  );
  return declined(Unconverted.OutOfMemory());
});

export class Converter extends Context.Service<
  Converter,
  {
    readonly convert: (html: string, url: URL, relay: Relay) => Effect.Effect<Conversion>;
  }
>()("web-fetch/Converter") {
  static readonly layer = Layer.effect(
    Converter,
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(CONCURRENT_CONVERSIONS);

      const run = Effect.fnUntraced(
        function* (html: string, url: URL, relay: Relay) {
          const worker = yield* spawn({ html, url: url.href });
          const relays = yield* FiberMap.make<string>();
          const reply = (message: Reply) =>
            Effect.sync(() => worker.postMessage(message, transferOf(message)));
          const handle = WorkerMessage.match({
            FetchRequested: (requested) =>
              pipe(
                relay(requested),
                Effect.flatMap(reply),
                FiberMap.run(relays, requested.id),
                Effect.as(Option.none<Conversion>()),
              ),
            FetchAborted: ({ id }) =>
              pipe(FiberMap.remove(relays, id), Effect.as(Option.none<Conversion>())),
            Converted: (converted) =>
              Effect.succeedSome(Conversion.Converted({ article: articleOf(converted) })),
            ConversionFailed: ({ message }) => Effect.succeedSome(failed(message)),
          });
          return yield* pipe(
            messagesOf(worker),
            Stream.mapEffect((message) =>
              pipe(
                decodeMessage(message),
                Effect.mapError(() =>
                  Unconverted.Failed({
                    message: "The converter sent an invalid message.",
                  }),
                ),
              ),
            ),
            Stream.mapEffect(handle),
            Stream.filterMap(Result.fromOption(() => undefined)),
            Stream.runHead,
            Effect.map(Option.getOrElse(() => failed("The converter stopped without a result."))),
            Effect.catch((reason) => Effect.succeed(declined(reason))),
          );
        },
        Effect.scoped,
        Effect.raceFirst(watchMemory),
        Effect.timeoutOrElse({
          duration: BUDGET,
          orElse: () =>
            Effect.succeed(declined(Unconverted.TimedOut({ seconds: Duration.toSeconds(BUDGET) }))),
        }),
      );

      // Size and depth are checked first, since both are cheap and a page that
      // fails either would only exhaust the budget.
      const convert = (html: string, url: URL, relay: Relay) =>
        pipe(
          convertible(html),
          Result.match({
            onFailure: (reason) => Effect.succeed(declined(reason)),
            onSuccess: (page) => pipe(run(page, url, relay), Semaphore.withPermit(permits)),
          }),
        );

      return Converter.of({ convert });
    }),
  );
}
