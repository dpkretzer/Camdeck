const startCameraBtn = document.getElementById("startCamera");
const video = document.getElementById("video");

startCameraBtn.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    video.srcObject = stream;
  } catch (err) {
    console.error("Camera error:", err);
    alert("Camera access denied or not working");
  }
});
