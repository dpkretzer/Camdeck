(function initCameraController(global) {
  const VIEWER_CAMERA_EVENTS = ["existing-cameras", "camera-joined", "camera-left", "camera-video-state"];

  function isViewerContextActive(isViewerPageActive) {
    return typeof isViewerPageActive === "function" && isViewerPageActive() && global.location.pathname === "/";
  }

  /**
   * Registers camera-related socket listeners, but only forwards events while the viewer page is active.
   * This keeps camera feed events isolated from non-viewer pages/screens.
   */
  function bindViewerCameraListeners(socket, handlers, isViewerPageActive) {
    const subscriptions = [];

    VIEWER_CAMERA_EVENTS.forEach((eventName) => {
      const handler = handlers?.[eventName];
      if (typeof handler !== "function") return;

      const guardedHandler = (...args) => {
        if (!isViewerContextActive(isViewerPageActive)) return;
        handler(...args);
      };

      socket.on(eventName, guardedHandler);
      subscriptions.push({ eventName, guardedHandler });
    });

    return () => {
      subscriptions.forEach(({ eventName, guardedHandler }) => {
        socket.off(eventName, guardedHandler);
      });
    };
  }

  /**
   * Sends a viewer-only camera control command if (and only if) the viewer page is active.
   */
  function emitViewerCameraCommand(socket, payload, callback, isViewerPageActive) {
    if (!isViewerContextActive(isViewerPageActive)) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Camera commands are only available on the View camera feeds page." });
      }
      return;
    }

    socket.emit("viewer-camera-video-toggle", payload, callback);
  }

  global.CameraController = {
    bindViewerCameraListeners,
    emitViewerCameraCommand
  };
})(window);
