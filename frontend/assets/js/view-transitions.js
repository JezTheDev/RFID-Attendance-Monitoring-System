// Page transitions come from @view-transition in app.css (no startViewTransition call).
// The browser rejects a transition's promises when it is aborted (tab hidden, invalid state);
// handle them here so they are not "Uncaught (in promise)" errors. Must load render-blocking
// in <head> so the pagereveal listener exists before the first frame.
(function () {
  function settle(event) {
    var transition = event.viewTransition;
    if (!transition) return;
    [transition.ready, transition.finished, transition.updateCallbackDone].forEach(function (p) {
      if (p) p.catch(function () {});
    });
    if (document.visibilityState === 'hidden') transition.skipTransition();
  }
  window.addEventListener('pageswap', settle);
  window.addEventListener('pagereveal', settle);
})();
