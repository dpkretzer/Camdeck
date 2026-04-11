(function bootstrapViewerPage(global) {
  const VIEWER_PATH = "/viewer";

  function isViewerFeedsPage() {
    return window.location.pathname === VIEWER_PATH;
  }

  function enterViewerFeedsPage() {
    if (isViewerFeedsPage()) return;
    window.history.pushState({ page: "viewer-feeds" }, "", VIEWER_PATH);
  }

  function leaveViewerFeedsPage() {
    if (!isViewerFeedsPage()) return;
    window.history.pushState({ page: "home" }, "", "/");
  }

  global.viewerPage = {
    VIEWER_PATH,
    isViewerFeedsPage,
    enterViewerFeedsPage,
    leaveViewerFeedsPage
  };
})(window);
