/**
 * The density labs' worker (density-host.js starts it as a module worker;
 * the build bundles it as a file of its own, loaded from the app's own
 * address). It is Psychedelia's progressive density worker, vendored by
 * scripts/import_psychedelia.mjs: in a worker it answers the host's
 * 'accumulate' messages with the picture so far.
 */

import load from './vendor/psychedelia/workers/progressive-density-worker.js';

load({});
