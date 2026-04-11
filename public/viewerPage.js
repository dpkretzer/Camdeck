(function initViewerPage(global) {
  /**
   * Viewer page orchestrator.
   * Only this module is allowed to attach camera-event listeners and emit viewer camera commands.
   */
  function create({ socket, isViewerPageActive, handlers }) {
    let unbindCameraListeners = null;

    function activate() {
      if (unbindCameraListeners) return;
      unbindCameraListeners = global.CameraController.bindViewerCameraListeners(
        socket,
        handlers,
        isViewerPageActive
      );
    }

    function deactivate() {
      if (!unbindCameraListeners) return;
      unbindCameraListeners();
      unbindCameraListeners = null;
    }

    function requestCameraToggle(targetCameraId, enabled, callback) {
      global.CameraController.emitViewerCameraCommand(
        socket,
        { targetCameraId, enabled },
        callback,
        isViewerPageActive
      );
    }

    return {
      activate,
      deactivate,
      requestCameraToggle
    };
  }

  global.ViewerPageController = { create };
})(window);
