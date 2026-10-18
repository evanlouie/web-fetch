import { Iterable, Match, pipe, String as Str } from "effect";

// Elements that never contain children, so they never add a level.
const VOID_ELEMENTS: ReadonlyArray<string> = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
];
// Comments and raw-text elements are skipped whole, so markup inside them
// does not count. Every other tag is an opening or closing tag.
const TOKENS =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[\s\S]*?(?:<\/\1\s*>|$)|<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/gi;

type Nesting = { readonly depth: number; readonly deepest: number };

const step = (nesting: Nesting, token: RegExpExecArray): Nesting =>
  pipe(
    Match.value(token),
    Match.when(
      ([, rawText, , name, selfClosing]) =>
        rawText !== undefined ||
        name === undefined ||
        selfClosing === "/" ||
        VOID_ELEMENTS.includes(Str.toLowerCase(name)),
      () => nesting,
    ),
    Match.when(
      ([, , closing]) => closing === "/",
      () => ({
        depth: Math.max(0, nesting.depth - 1),
        deepest: nesting.deepest,
      }),
    ),
    Match.orElse(() => ({
      depth: nesting.depth + 1,
      deepest: Math.max(nesting.deepest, nesting.depth + 1),
    })),
  );

/**
 * Estimate how deeply elements nest, in one linear pass over the markup.
 * Defuddle's cost grows with the square of the depth, so a deep page is
 * cheaper to decline than to convert.
 */
export const nestingDepth = (html: string) =>
  pipe(html.matchAll(TOKENS), Iterable.reduce({ depth: 0, deepest: 0 }, step)).deepest;
