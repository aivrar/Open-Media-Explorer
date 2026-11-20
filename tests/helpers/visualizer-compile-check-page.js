/* The browser half of visualizer-compile-check.py: builds each named scene's
   shader text as the tab does (scene-renderer.js prepare, every look) and
   compiles and links it on a real WebGL 2 and WebGL 1 context, returning
   the compile and link logs. Draws nothing. Loaded as a module from the
   check's local server; not part of the app. */

import { createSceneRenderer } from '../../src/visualizer/scene-renderer.js';
import * as S from '../../src/visualizer/scenes.js';
import { sceneLooks } from '../../src/visualizer/looks.js';

const heldEntries = () => [
  ...S.SCENES, ...S.HELD_SCENE_ENTRIES, ...(S.LINE_SCENE_ENTRIES || []),
  ...(S.ACCUMULATING_SCENE_ENTRIES || []), ...(S.OWN_SCENE_ENTRIES || []),
];

function compileLog(gl, sources) {
  const shader = (type, text) => {
    const made = gl.createShader(type);
    gl.shaderSource(made, text);
    gl.compileShader(made);
    return made;
  };
  const vs = shader(gl.VERTEX_SHADER, sources.vert);
  const fs = shader(gl.FRAGMENT_SHADER, sources.frag);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  const result = {
    vertex: gl.getShaderParameter(vs, gl.COMPILE_STATUS) ? '' : (gl.getShaderInfoLog(vs) || 'failed'),
    fragment: gl.getShaderParameter(fs, gl.COMPILE_STATUS) ? '' : (gl.getShaderInfoLog(fs) || 'failed'),
    link: gl.getProgramParameter(program, gl.LINK_STATUS) ? '' : (gl.getProgramInfoLog(program) || 'failed'),
  };
  gl.deleteProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return result;
}

/** ids: the scenes to check (none: World Media's own scenes). One row per
 *  scene, context and look: { id, mode, look, ok, vertex, fragment, link }. */
window.checkCompile = async (ids) => {
  const wanted = ids && ids.length ? ids : (S.OWN_SCENE_ENTRIES || []).map((entry) => entry.id);
  const rows = [];
  for (const mode of ['webgl2', 'webgl']) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const gl = canvas.getContext(mode);
    if (!gl) { rows.push({ id: '*', mode, ok: false, link: 'no context' }); continue; }
    const renderer = createSceneRenderer({ canvas, gl, mode });
    for (const id of wanted) {
      const entry = heldEntries().find((row) => row.id === id);
      if (!entry) { rows.push({ id, mode, ok: false, link: 'unknown scene' }); continue; }
      let def;
      try {
        def = renderer.register(await entry.load(), id);
      } catch (error) {
        rows.push({ id, mode, ok: false, link: `load: ${error.message}` });
        continue;
      }
      const looks = sceneLooks(def, { all: true, held: true });
      for (const look of looks.length ? looks : [{ name: '(none)', values: {} }]) {
        let prepared;
        try {
          prepared = renderer.prepare(def, { ...(entry.defaults || {}), ...look.values });
        } catch (error) {
          rows.push({ id, mode, look: look.name, ok: false, link: `prepare: ${error.message}` });
          continue;
        }
        if (prepared.sim) { rows.push({ id, mode, look: look.name, ok: true, link: 'owns its passes: not checked here' }); continue; }
        const logs = compileLog(gl, prepared.sources);
        rows.push({ id, mode, look: look.name, ok: !logs.vertex && !logs.fragment && !logs.link, ...logs });
      }
    }
    renderer.destroy();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return rows;
};

window.compileReady = true;
