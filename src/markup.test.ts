import assert from "node:assert/strict";
import { test } from "bun:test";
import { nestingDepth } from "./markup.ts";

test("nestingDepth counts open elements, not void ones or markup in comments and scripts", () => {
  assert.equal(nestingDepth("<div>".repeat(40) + "x" + "</div>".repeat(40)), 40);
  assert.equal(nestingDepth("<p>a<br><img src=x><input/></p>"), 1);
  assert.equal(nestingDepth("<!-- <div><div> --><script>'<div><div>'</script><p>x</p>"), 1);
  assert.equal(nestingDepth("</div></div><p>x</p>"), 1);
});
