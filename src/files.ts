import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  pipe,
  SynchronizedRef,
} from "effect";
import { WebFetchError, type Retention } from "./domain.ts";

/** The process's download directory, created by the first save. */
type DownloadRoot = SynchronizedRef.SynchronizedRef<Option.Option<string>>;

const saveError = () =>
  new WebFetchError({
    message: "Could not save the response to a temporary file.",
  });

const removeDirectory = (fs: FileSystem.FileSystem) => (directory: string) =>
  pipe(fs.remove(directory, { recursive: true }), Effect.ignore);

/** Remove the download directory unless its files must outlive the process. */
const release = (fs: FileSystem.FileSystem, root: DownloadRoot, retention: Retention) =>
  pipe(
    Match.value(retention),
    Match.when("keep", () => Effect.void),
    Match.when("discard", () =>
      pipe(
        root,
        SynchronizedRef.getAndSet(Option.none<string>()),
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: removeDirectory(fs) })),
      ),
    ),
    Match.exhaustive,
  );

export class Downloads extends Context.Service<
  Downloads,
  {
    readonly save: (name: string, data: Uint8Array) => Effect.Effect<string, WebFetchError>;
  }
>()("mcp-web-fetch/Downloads") {
  /** Saves files until the layer closes, then keeps or removes them by retention. */
  static readonly layer = (retention: Retention) =>
    Layer.effect(
      Downloads,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root: DownloadRoot = yield* SynchronizedRef.make(Option.none<string>());
        yield* Effect.addFinalizer(() => release(fs, root, retention));

        // The first save creates the directory, and later saves reuse it.
        const created = (existing: Option.Option<string>) =>
          pipe(
            existing,
            Option.match({
              onSome: (directory) => Effect.succeed([directory, existing] as const),
              onNone: () =>
                pipe(
                  fs.makeTempDirectory({ prefix: "mcp-web-fetch-" }),
                  Effect.map((directory) => [directory, Option.some(directory)] as const),
                ),
            }),
          );
        const rootDirectory = pipe(root, SynchronizedRef.modifyEffect(created));

        // Each save gets its own directory, so names never collide. The
        // directory exists only if the whole file was written.
        const save = (name: string, data: Uint8Array) =>
          pipe(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const parent = yield* rootDirectory;
                const directory = yield* fs.makeTempDirectory({
                  directory: parent,
                  prefix: "",
                });
                const file = path.join(directory, name);
                yield* pipe(
                  restore(fs.writeFile(file, data)),
                  Effect.onError(() => removeDirectory(fs)(directory)),
                );
                return file;
              }),
            ),
            Effect.mapError(saveError),
          );

        return Downloads.of({ save });
      }),
    );
}
