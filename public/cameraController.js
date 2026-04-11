(function bootstrapCameraController(global) {
  function createCameraController({ socket, canUseCameraSockets, handlers }) {
    let initialized = false;
    const bound = {
      cameraVideoCommand: (payload) => handlers.onCameraVideoCommand?.(payload),
      sessionAuthorized: (payload) => handlers.onSessionAuthorized?.(payload),
      existingCameras: (payload) => handlers.onExistingCameras?.(payload),
      cameraJoined: (payload) => handlers.onCameraJoined?.(payload),
      signal: (payload) => handlers.onSignal?.(payload),
      cameraLeft: (payload) => handlers.onCameraLeft?.(payload),
      cameraVideoState: (payload) => handlers.onCameraVideoState?.(payload)
    };

    function init() {
      if (initialized || !canUseCameraSockets()) return;
      socket.on("camera-video-command", bound.cameraVideoCommand);
      socket.on("session-authorized", bound.sessionAuthorized);
      socket.on("existing-cameras", bound.existingCameras);
      socket.on("camera-joined", bound.cameraJoined);
      socket.on("signal", bound.signal);
      socket.on("camera-left", bound.cameraLeft);
      socket.on("camera-video-state", bound.cameraVideoState);
      initialized = true;
    }

    function destroy() {
      if (!initialized) return;
      socket.off("camera-video-command", bound.cameraVideoCommand);
      socket.off("session-authorized", bound.sessionAuthorized);
      socket.off("existing-cameras", bound.existingCameras);
      socket.off("camera-joined", bound.cameraJoined);
      socket.off("signal", bound.signal);
      socket.off("camera-left", bound.cameraLeft);
      socket.off("camera-video-state", bound.cameraVideoState);
      initialized = false;
    }

    function emit(eventName, payload, callback) {
      if (!canUseCameraSockets()) {
        if (typeof callback === "function") {
          callback({ ok: false, error: "Camera socket events only run on the view camera feeds page." });
        }
        return false;
      }

      socket.emit(eventName, payload, callback);
      return true;
    }

    return { init, destroy, emit, isInitialized: () => initialized };
  }

  global.createCameraController = createCameraController;
})(window);
