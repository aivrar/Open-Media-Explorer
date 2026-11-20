import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FEEDBACK_FILES, STAND_IN_RUNNER, VENDOR_DIR, checkDrift, sceneDefinitions, sha256,
} from '../scripts/import_psychedelia.mjs';

/* The drift check reads the scenes hosted by the Shadertoy adapter
   (feedback-loop.js, reaction-diffusion.js) with a stand-in runner. A scene
   that registers through it keeps a render of its own, so it is judged by
   its file hash like the others and is not reported as gone. */

/** A file shaped as Psychedelia's original: the runner's hooks become the
 *  scene's. */
const adapterScene = (name) => [
  '(function () {',
  '  var L = ShadertoyEffectRunner.lines;',
  '  var pass = ShadertoyEffectRunner.pass;',
  "  var project = { source: L(['void mainImage() {}']), image: pass({}, 'image') };",
  '  var runner = ShadertoyEffectRunner.make({ project: project });',
  '  EffectRegistry.register({',
  `    name: '${name}', label: '${name}', _usesShadertoyGraph: true,`,
  '    init: runner.init, cleanup: runner.cleanup, render: runner.render,',
  '    resetSimulation: runner.reset, getDiagnostics: runner.getDiagnostics',
  '  });',
  '})();',
  '',
].join('\n');

function withRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'psy-adapter-'));
  try {
    const effects = join(root, 'src', 'effects');
    mkdirSync(effects, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(effects, `${name}.js`), text);
    return fn(root, effects);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('import drift check: the scenes the Shadertoy adapter hosts register with a render through the stand-in runner', () => {
  for (const hook of ['init', 'cleanup', 'render', 'reset', 'getDiagnostics']) assert.equal(typeof STAND_IN_RUNNER[hook], 'function', hook);
  assert.equal(STAND_IN_RUNNER.render(), undefined, 'draws nothing');
  withRoot(Object.fromEntries(FEEDBACK_FILES.map((name) => [name, adapterScene(name.replace(/-/g, '_'))])), (root) => {
    const defs = sceneDefinitions(root);
    for (const name of FEEDBACK_FILES) {
      assert.equal(defs.get(name)?.length, 1, `${name} registers`);
      assert.equal(typeof defs.get(name)[0].render, 'function', `${name}: a render of its own`);
    }
  });
});

test('import drift check: an unchanged adapter-hosted scene is the same, not gone; a changed one is changed by its hash; one without a render is gone', () => {
  const files = Object.fromEntries(FEEDBACK_FILES.map((name) => [name, adapterScene(name.replace(/-/g, '_'))]));
  const manifest = {
    files: FEEDBACK_FILES.map((name) => ({ source: `src/effects/${name}.js`, target: `effects/${name}.js`, sha256: sha256(files[name]) })),
    notices: [],
  };
  withRoot(files, (root, effects) => {
    const report = checkDrift(root, manifest);
    assert.equal(report.same, FEEDBACK_FILES.length);
    assert.deepEqual(report.changed, []);
    for (const name of FEEDBACK_FILES) assert.ok(!report.goneScenes.includes(name), `${name} is not reported as gone`);
    assert.deepEqual(readdirSync(effects).sort(), FEEDBACK_FILES.map((name) => `${name}.js`).sort(), 'nothing written');
  });
  // Changed upstream (still through the runner): changed, by its hash only.
  const [first, second] = FEEDBACK_FILES;
  withRoot({ ...files, [first]: `${files[first]}// a comment\n` }, (root) => {
    const report = checkDrift(root, manifest);
    assert.deepEqual(report.changed.map((row) => row.source), [`src/effects/${first}.js`]);
    assert.ok(!report.goneScenes.includes(first));
  });
  // No longer a scene with a render of its own: still reported.
  withRoot({ ...files, [second]: `EffectRegistry.register({ name: 'plain', shader: 'void main() {}' });\n` }, (root) => {
    assert.ok(checkDrift(root, manifest).goneScenes.includes(second));
  });
});

test('import drift check: the imported feedback scenes, as they stand in the vendor folder, register with a render', () => {
  for (const name of FEEDBACK_FILES) {
    const text = readFileSync(join(VENDOR_DIR, 'effects', `${name}.js`), 'utf8');
    assert.match(text, /ShadertoyEffectRunner\.make\(/, `${name} registers through the runner`);
    assert.match(text, /render: runner\.render/, `${name} takes its render from the runner`);
  }
});
