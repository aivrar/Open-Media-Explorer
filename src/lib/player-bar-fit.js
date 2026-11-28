// Measure the footer itself so font metrics, extra actions and the Picture
// button all contribute their actual width. The trials finish before paint.
export function bindPlayerBarFit(bar, { ResizeObserver, MutationObserver } = globalThis) {
  const steps = ['meter', 'time', 'record', 'eq'];
  let previousWidth;
  function fit() {
    const width = bar.getBoundingClientRect().width;
    previousWidth = width;
    if (!width || bar.hidden || bar.classList.contains('is-capture-only')) {
      delete bar.dataset.fit;
      return;
    }
    bar.dataset.measuring = '';
    let result = 'stack';
    const trackStep = bar.querySelector('.player-track-button:not([hidden])') ? ['tracks'] : [];
    for (const step of ['full', ...trackStep, ...steps]) {
      bar.dataset.fit = step;
      if (bar.getBoundingClientRect().width <= width) {
        result = step;
        break;
      }
    }
    delete bar.dataset.measuring;
    bar.dataset.fit = result;
  }
  const resize = new ResizeObserver(() => {
    if (bar.getBoundingClientRect().width !== previousWidth) fit();
  });
  resize.observe(bar);
  const changes = new MutationObserver(records => {
    // The fixed-width clock, volume readout and progress indicators update
    // during playback. Only structural or width-changing updates need a fit.
    const affectsWidth = records.some(({ target, type, attributeName, oldValue }) => {
      if (type === 'attributes') return target.getAttribute(attributeName) !== oldValue;
      const element = target.nodeType === 3 ? target.parentElement : target;
      return element.closest('.player-actions, .player-controls');
    });
    if (affectsWidth) fit();
  });
  changes.observe(bar, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'inert', 'class', 'data-state'],
    childList: true, characterData: true });
  fit();
  return () => { changes.disconnect(); resize.disconnect(); };
}
