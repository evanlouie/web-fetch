import { type Effect, Schema } from "effect";

/** What the main thread gives a conversion worker. */
export type WorkerInput = { readonly html: string; readonly url: string };

/** What a conversion worker sends to the main thread. */
export const WorkerMessage = Schema.TaggedUnion({
  // Defuddle's site extractors make their own requests. The main thread
  // sends them through the tool call's browser session.
  FetchRequested: {
    id: Schema.String,
    url: Schema.String,
    method: Schema.String,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    body: Schema.instanceOf(ArrayBuffer),
  },
  FetchAborted: { id: Schema.String },
  Converted: {
    markdown: Schema.String,
    title: Schema.String,
    author: Schema.String,
    published: Schema.String,
    site: Schema.String,
    words: Schema.Int,
  },
  ConversionFailed: { message: Schema.String },
});
export type WorkerMessage = typeof WorkerMessage.Type;
export type FetchRequested = (typeof WorkerMessage.cases.FetchRequested)["Type"];
export type Converted = (typeof WorkerMessage.cases.Converted)["Type"];

/** What the main thread sends back for a relayed request. */
export type Reply =
  | {
      readonly _tag: "Fetched";
      readonly id: string;
      readonly status: number;
      readonly statusText: string;
      readonly headers: Array<[string, string]>;
      readonly body: ArrayBuffer | null;
      readonly url: string;
      readonly redirected: boolean;
    }
  | {
      readonly _tag: "FetchFailed";
      readonly id: string;
      readonly message: string;
    };

/** Answers a relayed request. A failed request becomes a FetchFailed reply. */
export type Relay = (requested: FetchRequested) => Effect.Effect<Reply>;
