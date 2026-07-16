// Regression guard: the server renders client JS as strings inside template literals, so a
// server-side `node --check` cannot catch a syntax error in the *browser* script (e.g. a raw
// newline inside a string from writing \n instead of \\n in the template). Compile every
// inline <script> block of each page with node:vm — vm.Script parses without executing, so
// undefined browser globals are irrelevant and only genuine syntax errors throw.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { renderIndexPage, renderGraph3dPage } from "./server.mjs";

function inlineScripts(html) {
  const out = [];
  const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc=/.test(m[1])) continue; // external script (has src=) — no inline body
    out.push(m[2]);
  }
  return out;
}

for (const [name, render] of [["renderIndexPage", renderIndexPage], ["renderGraph3dPage", renderGraph3dPage]]) {
  test(`${name}: inline <script> blocks are syntactically valid`, () => {
    const scripts = inlineScripts(render());
    assert.ok(scripts.length > 0, `${name} should have at least one inline script`);
    for (const body of scripts) {
      assert.doesNotThrow(() => new vm.Script(body), `${name} emitted an inline script with a syntax error`);
    }
  });
}
