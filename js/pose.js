/* MediaPipe Pose (WASM) wrist tracking for swing detection.
   Falls back to null when the model can't load — the caller then uses
   plain frame-difference motion instead. */
const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

let landmarker = null;
let loadPromise = null;
export let poseActive = false;

export function initPose(onStatus){
  if (landmarker) return Promise.resolve(true);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const { PoseLandmarker, FilesetResolver } = await import(VISION_URL);
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO", numPoses: 1,
        minPoseDetectionConfidence: 0.4, minTrackingConfidence: 0.4
      });
      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, opts("GPU"));
      } catch(e) {
        landmarker = await PoseLandmarker.createFromOptions(vision, opts("CPU"));
      }
      poseActive = true;
      onStatus && onStatus(true);
      return true;
    } catch(e) {
      poseActive = false;
      onStatus && onStatus(false);
      return false;
    }
  })();
  return loadPromise;
}

/* Returns wrist midpoint {x, y} in normalized coords, or null if no pose. */
export function wristPos(sourceCanvas){
  if (!poseActive || !landmarker) return null;
  try {
    const res = landmarker.detectForVideo(sourceCanvas, performance.now());
    const lm = res.landmarks && res.landmarks[0];
    if (!lm || !lm[15] || !lm[16]) return null;
    const a = lm[15], b = lm[16];
    if ((a.visibility || 0) < 0.3 && (b.visibility || 0) < 0.3) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  } catch(e){ return null; }
}
