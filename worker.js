export default {
  async fetch(request, env) {
    const API_KEY = env.API_KEY;
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // --- Auth (simple Bearer check, same style as your original) ---
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${API_KEY}`) {
      return cors(json({ error: "Unauthorized" }, 401));
    }

    // --- Only allow POST to "/" ---
    if (request.method !== "POST" || url.pathname !== "/") {
      return cors(json({ error: "Not allowed" }, 405, { "Allow": "POST, OPTIONS" }));
    }

    try {
      // Ensure JSON body
      const ctype = request.headers.get("Content-Type") || "";
      if (!ctype.toLowerCase().includes("application/json")) {
        return cors(json({ error: "Unsupported Media Type, expected application/json" }, 415));
      }

      const body = await request.json();
      const prompt = (body?.prompt || "").trim();
      if (!prompt) return cors(json({ error: "Prompt is required" }, 400));

      // Optional inputs
      const model = typeof body?.model === "string"
        ? body.model
        : "@cf/stabilityai/stable-diffusion-xl-base-1.0";

      // --- Dimension parsing / validation ---
      let w = parseDim(body?.width);
      let h = parseDim(body?.height);
      const ar = parseAspectRatio(body?.aspectRatio) ?? 1;
      const longEdge = parseDim(body?.longEdge) ?? 1024;

      // Priority: explicit width+height > infer from one side + AR > AR + longEdge > default 1024x1024
      if (w && h) {
        // both provided, keep as-is (already clamped/aligned)
      } else if (w && !h) {
        h = parseDim(Math.round(w / ar));
      } else if (!w && h) {
        w = parseDim(Math.round(h * ar));
      } else {
        if (ar >= 1) { w = parseDim(longEdge); h = parseDim(Math.round(longEdge / ar)); }
        else { h = parseDim(longEdge); w = parseDim(Math.round(longEdge * ar)); }
      }

      // Final defaults (shouldn't be needed, but safe)
      w = w || 1024;
      h = h || 1024;

      // --- Generate image with dynamic size ---
      const result = await env.AI.run(model, {
        prompt,
        width: w,
        height: h,
      });

      return cors(new Response(result, {
        headers: {
          "Content-Type": "image/png", // most Workers AI image models return PNG bytes
          "Content-Disposition": `inline; filename="image-${w}x${h}.png"`,
          "Cache-Control": "no-store",
        },
      }));
    } catch (err) {
      // Don't leak internals; keep message simple
      return cors(json({ error: "Failed to generate image" }, 500));
    }
  },
};

/* ---------------- helpers ---------------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// Basic permissive CORS; swap "*" with your site origin for stricter security
function cors(response) {
  const h = new Headers(response.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Access-Control-Max-Age", "600");
  return new Response(response.body, { status: response.status, headers: h });
}

// Parse a dimension from string/number, clamp to model limits, align to multiple of 8
function parseDim(v, { min = 256, max = 2048, align = 8 } = {}) {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n);
  const clamped = Math.min(max, Math.max(min, rounded));
  return Math.max(align, Math.round(clamped / align) * align); // multiple of 8
}

// Accepts "16:9", "4/3", or numeric like "1.777"
function parseAspectRatio(ar) {
  if (typeof ar !== "string") return null;
  const s = ar.trim();
  if (!s) return null;
  if (s.includes(":") || s.includes("/")) {
    const [a, b] = s.split(/[:/]/).map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 ? a / b : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
