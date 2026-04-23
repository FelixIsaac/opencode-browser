#!/usr/bin/env node
// Generate Tandem brand icons via Gemini (Nano Banana Pro).
// Usage: GEMINI_API_KEY=... node scripts/gen-icons.mjs [prompt-override]
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "extension", "icons");
const MODEL = process.env.TANDEM_IMAGE_MODEL || "gemini-3-pro-image-preview";

const DEFAULT_PROMPT = `Minimalist square app icon for "Tandem" — a browser automation tool for AI agents. Two offset chevrons (») or linked rings arranged to imply motion and pairing, in solid cyan (#00BCD4) on a fully transparent background. Flat vector style, no gradients, no text, no shadow, crisp geometric shapes. Must read clearly at 16×16 pixels. Centered with generous padding. Dev-tool aesthetic, clean, modern.`;

const prompt = process.argv.slice(2).join(" ") || DEFAULT_PROMPT;
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY not set");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

console.log(`[tandem] model=${MODEL}`);
console.log(`[tandem] prompt: ${prompt.slice(0, 120)}...`);

const response = await ai.models.generateContent({
  model: MODEL,
  contents: prompt,
  config: { responseModalities: ["IMAGE"] },
});

const parts = response.candidates?.[0]?.content?.parts ?? [];
const imgPart = parts.find((p) => p.inlineData?.data);
if (!imgPart) {
  console.error("No image in response:", JSON.stringify(response, null, 2));
  process.exit(1);
}

const srcBuf = Buffer.from(imgPart.inlineData.data, "base64");
const sourcePath = join(__dirname, "icon-source.png");
writeFileSync(sourcePath, srcBuf);
console.log(`[tandem] wrote ${sourcePath} (${srcBuf.length} bytes)`);

for (const size of [16, 48, 128]) {
  const outPath = join(OUT_DIR, `icon${size}.png`);
  await sharp(srcBuf)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outPath);
  console.log(`[tandem] wrote ${outPath}`);
}
