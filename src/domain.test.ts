import assert from "node:assert/strict";
import { test } from "bun:test";
import { pipe, Result, Struct } from "effect";
import {
  classifyMedia,
  clipChars,
  convertible,
  decodeText,
  displayable,
  fileName,
  formatSize,
  judge,
  limitJsonText,
  limitText,
  Media,
  parseUrl,
  plan,
  Reading,
  Unconverted,
  Verdict,
  type Fetched,
} from "./domain.ts";

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);
const bytes = (...parts: ReadonlyArray<ArrayLike<number>>) =>
  new Uint8Array(parts.flatMap((part) => Array.from(part)));
const response = ({
  url = new URL("https://example.com/"),
  status = 200,
  headers = {},
  body = text("hello"),
}: {
  readonly url?: URL;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array;
} = {}): Fetched => ({
  requested: url,
  url,
  status,
  statusText: "",
  headers,
  body,
  profile: "chrome_149",
});
const typed = (type: string, body: Uint8Array) =>
  response({ headers: { "content-type": type }, body });

test("parseUrl accepts http and https only, and bounds its echo", () => {
  const parsed = pipe(parseUrl(" https://example.com/a "), Result.map(String), Result.getOrNull);
  assert.equal(parsed, "https://example.com/a");
  assert.ok(Result.isFailure(parseUrl("ftp://example.com/")));
  const { message } = pipe(parseUrl("!".repeat(60_000)), Result.flip, Result.getOrThrow);
  assert.ok(message.length < 300);
});

test("classifyMedia follows the declared type and sniffs without one", () => {
  const cases: ReadonlyArray<readonly [Fetched, Media["_tag"]]> = [
    [typed("text/html; charset=utf-8", text("<p>x</p>")), "Html"],
    [typed("application/vnd.api+json", text("{}")), "Json"],
    [typed("image/svg+xml", text("<svg/>")), "Xml"],
    [typed("text/plain", text("x")), "Text"],
    [typed("application/pdf", text("%PDF")), "Binary"],
    [response({ body: text("<!-- c -->\n<!DOCTYPE html><html></html>") }), "Html"],
    [response({ body: text("<h1>A heading</h1><p>Text</p>") }), "Html"],
    [
      response({
        body: bytes([0xef, 0xbb, 0xbf], text("<html><body>x</body></html>")),
      }),
      "Html",
    ],
    [response({ body: text("plain words") }), "Text"],
    [response({ body: text("%PDF-1.7 plain looking bytes") }), "Binary"],
    [response({ body: bytes([1, 2, 3, 4]) }), "Binary"],
  ];
  cases.forEach(([fetched, tag]) => assert.equal(classifyMedia(fetched)._tag, tag));
});

test("decodeText picks the charset a browser would for each media type", () => {
  const nihon = [0x93, 0xfa, 0x96, 0x7b]; // 日本 in Shift_JIS
  const decode = (fetched: Fetched) => decodeText(fetched, classifyMedia(fetched));
  const same = (type: string, source: string) =>
    assert.equal(decode(typed(type, text(source))), source);
  assert.equal(
    decode(typed("text/html", bytes(text('<meta charset="shift_jis">'), nihon))),
    '<meta charset="shift_jis">日本',
  );
  assert.equal(decode(typed("text/plain; charset=Shift_JIS", bytes(nihon))), "日本");
  // A byte order mark wins over the header.
  assert.equal(
    decode(typed("text/plain; charset=latin1", bytes([0xef, 0xbb, 0xbf], text("é")))),
    "é",
  );
  // An unsupported header charset gives way to the page's declaration.
  const declared = bytes(text("<meta charset=shift_jis>"), nihon);
  assert.equal(decode(typed("text/html; charset=bogus", declared)), "<meta charset=shift_jis>日本");
  // Declarations count only in HTML tags outside comments, by attribute name,
  // and HTML reads a declared UTF-16 as UTF-8.
  same("application/json", '{"a":"<meta charset=shift_jis>é"}');
  same("text/html", '<!-- <meta charset="shift_jis"> -->é');
  same("text/html", '<meta charset="utf-8" data-charset="shift_jis">é');
  same("text/html", '<meta charset="utf-16"><p>café</p>');
});

test("judge trusts challenge headers on any status and page markers only on errors", () => {
  const verdict = (status: number, body: string, headers: Record<string, string> = {}) => {
    const fetched = response({
      status,
      headers: pipe({ "content-type": "text/html" }, Struct.assign(headers)),
      body: text(body),
    });
    return judge(fetched, classifyMedia(fetched));
  };
  const passive = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
  assert.deepEqual(
    verdict(202, "<p>wait</p>", { "x-amzn-waf-action": "challenge" }),
    Verdict.Challenged({ vendor: "AWS WAF" }),
  );
  assert.deepEqual(verdict(200, passive), Verdict.Delivered());
  assert.deepEqual(verdict(404, passive), Verdict.Refused());
  assert.deepEqual(verdict(404, "Not found", { "x-datadome": "protected" }), Verdict.Refused());
  assert.deepEqual(
    verdict(403, "<script>window._cf_chl_opt={}</script>"),
    Verdict.Challenged({ vendor: "Cloudflare" }),
  );
  assert.deepEqual(
    verdict(403, '<script src="https://ct.captcha-delivery.com/c.js">'),
    Verdict.Challenged({ vendor: "DataDome" }),
  );
});

test("plan reads every nonempty body by media and format", () => {
  const page = typed("text/html", text("<p>x</p>"));
  assert.deepEqual(plan(page, Media.Html(), "markdown"), Reading.Convert());
  assert.deepEqual(plan(page, Media.Html(), "raw"), Reading.Decode());
  assert.deepEqual(plan(page, Media.Binary(), "markdown"), Reading.Save());
  assert.deepEqual(
    plan(response({ body: new Uint8Array() }), Media.Html(), "markdown"),
    Reading.Empty(),
  );
});

test("convertible declines pages that are too deep to convert in time", () => {
  const deep = pipe(
    convertible("<div>".repeat(500) + "x" + "</div>".repeat(500)),
    Result.flip,
    Result.getOrNull,
  );
  const shallow = pipe(convertible("<p>x</p>"), Result.getOrNull);
  assert.deepEqual(deep, Unconverted.TooDeep({ depth: 500 }));
  assert.equal(shallow, "<p>x</p>");
});

test("limitText keeps whole lines, but cuts one long line instead of dropping it", () => {
  const long = limitText("x".repeat(100), { maxBytes: 10, maxLines: 5 });
  assert.equal(long.text, "x".repeat(10));
  assert.ok(long.truncated);
  assert.equal(limitText("ab\ncd\nef", { maxBytes: 7, maxLines: 5 }).text, "ab\ncd");
  assert.equal(limitText("a\nb\nc", { maxBytes: 100, maxLines: 2 }).text, "a\nb");
  // A cut never splits a character.
  assert.equal(limitText("é".repeat(5), { maxBytes: 5, maxLines: 5 }).text, "éé");
  assert.equal(limitText("same\n", { maxBytes: 100, maxLines: 5 }).truncated, false);
});

test("limitJsonText keeps the longest start that fits once escaped as JSON", () => {
  const limit = { maxBytes: 1_000, maxLines: 2_000 };
  const escaped = (text: string) => JSON.stringify(text).length - 2;
  const text = 'line "quoted"\n'.repeat(1_000);
  const lines = limitJsonText(text, limit);
  // 58 whole lines escape to 984 bytes, and 59 would not fit.
  assert.equal(escaped(lines.text), 984);
  assert.ok(text.startsWith(lines.text) && lines.truncated);
  // One long line of characters that all need escaping is cut, not dropped.
  assert.equal(limitJsonText("\\".repeat(100_000), limit).text, "\\".repeat(500));
  assert.equal(limitJsonText("plain", limit).text, "plain");
});

test("displayable removes what a terminal or a JSON parser would misread, and hidden text", () => {
  assert.equal(displayable("a\r\nb\x1b[31mc\x1b[0m\x00\x07\td"), "a\nbc\td");
  assert.equal(displayable("x\udc00y"), "x\ufffdy");
  assert.equal(displayable("safe\u{E0049}\u{E0047}\u202Etext"), "safetext");
  assert.equal(displayable("😀 café\u200d"), "😀 café\u200d");
});

test("clipChars never splits a character", () => {
  assert.equal(clipChars(2)("a😀b"), "a😀…");
  assert.equal(clipChars(5)("short"), "short");
});

test("fileName keeps safe path names and adds a missing extension", () => {
  const named = (path: string, headers: Record<string, string> = {}) =>
    fileName(response({ url: new URL(path, "https://example.com"), headers }));
  assert.equal(named("/files/Annual%20Report.pdf"), "Annual_Report.pdf");
  assert.equal(named("/download", { "content-type": "application/pdf" }), "download.pdf");
  assert.equal(named("/", { "content-type": "image/png" }), "download.png");
  assert.equal(named("/..%2F..%2Fetc%2Fpasswd"), "etc_passwd");
  assert.equal(named("/CON.pdf"), "_CON.pdf");
  assert.equal(named("/report."), "report");
});

test("formatSize uses the largest unit below the size", () => {
  assert.deepEqual([512, 50 * 1024, 25 * 1024 * 1024].map(formatSize), [
    "512B",
    "50.0KB",
    "25.0MB",
  ]);
});
