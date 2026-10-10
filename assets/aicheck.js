// Looks inside a photo file for signs that it was made by an AI image generator.
// It reads what tools write into the file, it does not judge the picture itself:
//   - Content Credentials (C2PA) and the IPTC "trainedAlgorithmicMedia" source type, which
//     ChatGPT/DALL-E, Adobe Firefly, Microsoft Designer, Google and others add to generated images
//   - generation settings saved by Stable Diffusion tools (Automatic1111, ComfyUI, InvokeAI, NovelAI ...)
//   - generator names in the file's Software / description fields (Midjourney, Leonardo, ...)
// Labels can be removed (e.g. by taking a screenshot), so "no AI labels" is not proof of a real photo.
//
// checkAI(file) → { verdict: "ai" | "camera" | "unknown", reasons: [...], camera: {...} | null, credentials: bool }

const AI_GENERATORS = [
  ["dall-e", "DALL·E"], ["dall·e", "DALL·E"], ["openai", "OpenAI"], ["chatgpt", "ChatGPT"], ["gpt-4o", "ChatGPT"],
  ["midjourney", "Midjourney"], ["adobe firefly", "Adobe Firefly"], ["firefly", "Adobe Firefly"],
  ["stable diffusion", "Stable Diffusion"], ["stablediffusion", "Stable Diffusion"], ["stability.ai", "Stability AI"],
  ["sdxl", "Stable Diffusion XL"], ["comfyui", "ComfyUI"], ["automatic1111", "Automatic1111"], ["invokeai", "InvokeAI"],
  ["novelai", "NovelAI"], ["leonardo.ai", "Leonardo"], ["ideogram", "Ideogram"], ["black forest labs", "FLUX"],
  ["flux.1", "FLUX"], ["imagen", "Google Imagen"], ["gemini", "Google Gemini"], ["bing image creator", "Bing Image Creator"],
  ["microsoft designer", "Microsoft Designer"], ["image creator", "Microsoft Image Creator"], ["meta ai", "Meta AI"],
  ["grok", "Grok"], ["aurora", "Grok Aurora"], ["playground ai", "Playground"], ["nightcafe", "NightCafe"],
  ["craiyon", "Craiyon"], ["dreamstudio", "DreamStudio"], ["runway", "Runway"], ["kling", "Kling"], ["recraft", "Recraft"],
];

async function checkAI(file) {
  const reasons = [];
  // Labels sit near the start of the file (and sometimes the end); read both ends of big files
  const size = file.size, head = 4 * 1024 * 1024, tail = 512 * 1024;
  const parts = size <= head + tail ? [await file.arrayBuffer()]
    : [await file.slice(0, head).arrayBuffer(), await file.slice(size - tail).arrayBuffer()];
  const bytes = parts.map(p => new Uint8Array(p));
  const text = bytes.map(b => latin1(b)).join("\n");
  const lower = text.toLowerCase();

  // 1. IPTC digital source type (inside XMP or C2PA): the standard "made by AI" label
  if (lower.includes("compositewithtrainedalgorithmicmedia")) {
    reasons.push("The file is labelled as partly made by AI (IPTC: composite with trained algorithmic media).");
  }
  if (lower.replace(/compositewithtrainedalgorithmicmedia/g, "").includes("trainedalgorithmicmedia")) {
    reasons.push("The file is labelled \"made by AI\" (IPTC digital source type: trained algorithmic media).");
  }

  // 2. Content Credentials (C2PA): note them, and name the generator if one is recorded.
  //    Generator names are only looked for right after "claim_generator", never in the pixel data,
  //    where short words like "grok" can turn up by chance.
  const credentials = lower.includes("c2pa") && /jumb|cabx|c2pa\.claim|c2pa\.actions/.test(lower);
  if (credentials) {
    for (let i = lower.indexOf("claim_generator"); i >= 0; i = lower.indexOf("claim_generator", i + 15)) {
      const near = lower.slice(i, i + 300);
      const hit = AI_GENERATORS.find(([k]) => near.includes(k));
      if (hit) { reasons.push(`Its Content Credentials say it was made with ${hit[1]}.`); break; }
    }
  }

  // 3. Saved generation settings (Stable Diffusion family, mostly PNG text chunks)
  if (/parameters\u0000[\s\S]{0,6000}?steps: ?\d+[\s\S]{0,300}?(sampler|cfg scale)/i.test(text)) {
    reasons.push("It contains Stable Diffusion generation settings (prompt, steps, sampler, CFG scale).");
  }
  if (/"class_type"\s*:\s*"(ksampler|checkpointloadersimple|cliptextencode)/i.test(text)) {
    reasons.push("It contains a ComfyUI generation workflow.");
  }
  if (/invokeai_metadata|sd-metadata|"sui_image_params"|novelai/i.test(text)) {
    reasons.push("It contains AI image-generator settings (InvokeAI / SwarmUI / NovelAI).");
  }

  // 4. EXIF camera details, and generator names in Software / description fields
  const exif = readExif(bytes[0]);
  const fields = [exif.software, exif.artist, exif.description, exif.make, exif.model].filter(Boolean).join(" | ").toLowerCase();
  const named = AI_GENERATORS.find(([k]) => fields.includes(k));
  if (named) reasons.push(`Its file details name an AI generator (${named[1]}).`);
  if (!named && /midjourney|job id: ?[0-9a-f-]{36}/i.test(text)) reasons.push("It carries a Midjourney job ID.");

  const camera = exif.make || exif.model ? { make: exif.make, model: exif.model, taken: exif.taken, software: exif.software } : null;
  const unique = [...new Set(reasons)];
  return {
    verdict: unique.length ? "ai" : camera ? "camera" : "unknown",
    reasons: unique,
    camera,
    credentials,
  };
}

// The stricter rule (on the AI check test page for now): an upload is only trusted when it carries
// camera details. Cropping, editing or screenshotting an AI image removes its AI labels, but AI
// images never had camera details, so those uploads end up here too.
function reportDecision(result, fromCamera) {
  if (fromCamera) return { allowed: true, why: "Taken with the site's own camera." };
  if (result.verdict === "ai") return { allowed: false, why: result.reasons[0] };
  if (result.verdict === "camera") return { allowed: true, why: "The photo carries camera details." };
  return { allowed: false, why: "The photo has no camera details. Cropped or edited AI images, screenshots and photos forwarded through messaging apps lose them. Use Take photo, or upload the original photo from your camera." };
}

function latin1(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return s;
}

// Minimal EXIF reader (JPEG APP1 "Exif", or a bare TIFF header elsewhere in the file): IFD0 + Exif IFD
function readExif(b) {
  const out = {};
  let start = -1;
  for (let i = 0; i < Math.min(b.length - 10, 256 * 1024); i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0) { start = i + 6; break; }
  }
  if (start < 0) return out;
  const le = b[start] === 0x49;
  const u16 = o => le ? b[o] | b[o + 1] << 8 : b[o] << 8 | b[o + 1];
  const u32 = o => (le ? (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) : (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3])) >>> 0;
  const str = (off, n) => { let s = ""; for (let i = 0; i < n && b[start + off + i]; i++) s += String.fromCharCode(b[start + off + i]); return s.trim(); };
  const names = { 0x010e: "description", 0x010f: "make", 0x0110: "model", 0x0131: "software", 0x013b: "artist", 0x9003: "taken" };
  const walk = (ifd, depth) => {
    if (depth > 2 || start + ifd + 2 > b.length) return;
    const n = u16(start + ifd);
    for (let k = 0; k < n && k < 200; k++) {
      const e = start + ifd + 2 + k * 12;
      if (e + 12 > b.length) return;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (tag === 0x8769) walk(u32(e + 8), depth + 1);           // Exif sub-IFD
      else if (names[tag] && type === 2) out[names[tag]] = count <= 4 ? str(e + 8 - start, count) : str(u32(e + 8), Math.min(count, 300));
    }
  };
  try { walk(u32(start + 4), 0); } catch {}
  return out;
}
