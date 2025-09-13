// ... keep your previous helpers (json, cors, parseBearer, safeEqual, SECURITY_HEADERS)

const DEFAULT_W = 1024;
const DEFAULT_H = 1024;
const MIN_DIM = 256;
const MAX_DIM = 2048;

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function parseAspectRatio(ar) {
  // Accept "16:9", "4/3", "1.777..."
  if (typeof ar !== "string") return null;
  const s = ar.trim();
  if (!s) return null;
  if (s.includes(":") || s.includes("/")) {
    const [a, b] = s.split(/[:/]/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return a / b;
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pickDims({ width, height, aspectRatio, longEdge = 1024 }) {
  // Priority: explicit width/height > aspectRatio > defaults
  let w = Number(width), h = Number(height);

  // If caller provided explicit dims, clamp to allowed range.
  if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) {
    return {
      width: clamp(w, MIN_DIM, MAX_DIM),
      height: clamp(h, MIN_DIM, MAX_DIM),
    };
  }

  // If only one dimension supplied, infer the other using aspect ratio or 1:1.
  const ar = parseAspectRatio(aspectRatio) || 1;
  if (Number.isInteger(w) && w > 0) {
    h = Math.round(w / ar);
  } else if (Number.isInteger(h) && h > 0) {
    w = Math.round(h * ar);
  } else if (ar) {
    // No explicit dims: use longEdge along the larger side implied by ar
    if (ar >= 1) {
      w = longEdge;
      h = Math.round(longEdge / ar);
    } else {
      h = longEdge;
      w = Math.round(longEdge * ar);
    }
  }

  w = clamp(w || DEFAULT_W, MIN_DIM, MAX_DIM);
  h = clamp(h || DEFAULT_H, MIN_DIM, MAX_DIM);

  return { width: w, height: h };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname !== "/" || request.method !== "POST") {
      return cors(json({ error: "Method not allowed" }, 405, { "Allow": "POST, OPTIONS" }));
    }

    const authHeader = request.headers.get("Authorization") || "";
    const token = parseBearer(authHeader);
    if (!token || !(await safeEqual(token, env.API_KEY))) {
      return cors(json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="service"' }));
    }

    const ctype = request.headers.get("Content-Type") || "";
    if (!ctype.toLowerCase().includes("application/json")) {
      return cors(json({ error: "Unsupported Media Type, expected application/json" }, 415));
    }

    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: "Invalid JSON body" }, 400)); }

    let { prompt, model, width, height, aspectRatio, longEdge } = body || {};
    if (typeof prompt !== "string" || !(prompt = prompt.trim())) {
      return cors(json({ error: "Prompt is required (non-empty string)" }, 400));
    }
    if (prompt.length > 800) return cors(json({ error: "Prompt too long (max 800 chars)" }, 413));

    const MODEL_WHITELIST = new Set([
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      "@cf/blackforestlabs/ux-1-schnell",
      "@cf/bytedance/stable-diffusion-xl-lightning",
      "@cf/lykon/dreamshaper-8-lcm",
      "@cf/runwayml/stable-diffusion-v1-5-img2img",
      "@cf/runwayml/stable-diffusion-v1-5-inpainting",
    ]);
    const selectedModel = MODEL_WHITELIST.has(model)
      ? model
      : "@cf/stabilityai/stable-diffusion-xl-base-1.0";

    // Compute dimensions
    const dims = pickDims({ width, height, aspectRatio, longEdge });
    // Optionally: round to multiples of 8 for diffusion backends; usually safe to pass as-is.

    try {
      const result = await env.AI.run(selectedModel, {
        prompt,
        width: dims.width,
        height: dims.height,
      });

      const resp = new Response(result, {
        headers: {
          // Docs note JPEG or PNG; output schema shows PNG. Use PNG unless you detect otherwise.
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="image-${dims.width}x${dims.height}.png"`,
          ...SECURITY_HEADERS,
        },
      });
      return cors(resp);
    } catch {
      return cors(json({ error: "Failed to generate image" }, 500));
    }
  },
};
