/**
 * Voice-note support: download a Telegram voice file and transcribe it locally
 * with faster-whisper (CPU `small` by default — see scripts/transcribe.py). The
 * transcript is then fed through the normal closed-vocab pipeline, so speaking
 * "find me a buddy" works exactly like typing it.
 *
 * Local + $0, consistent with running Qwen locally. GPU is an opt-in speedup
 * (set STT_DEVICE=cuda once nvidia-cublas/cudnn libs are installed).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STT_PYTHON = path.join(BOT_DIR, ".stt-venv", "bin", "python");
const STT_SCRIPT = path.join(BOT_DIR, "scripts", "transcribe.py");

// Run the faster-whisper script on a local audio file; resolve its transcript.
function transcribeAudioFile(filePath: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(STT_PYTHON, [STT_SCRIPT, filePath], { env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("transcription timed out"));
    }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`transcribe exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

// Download a Telegram voice note by file_id and return its transcript.
export async function transcribeTelegramVoice(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set — cannot fetch voice audio");

  const gfRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  if (!gfRes.ok) throw new Error(`getFile failed (${gfRes.status})`);
  const gf = (await gfRes.json()) as { ok: boolean; result?: { file_path?: string } };
  const filePath = gf.result?.file_path;
  if (!filePath) throw new Error("getFile returned no file_path");

  const dlRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!dlRes.ok) throw new Error(`voice download failed (${dlRes.status})`);
  const buf = Buffer.from(await dlRes.arrayBuffer());

  const tmp = path.join(
    os.tmpdir(),
    `viva-voice-${fileId.replace(/[^A-Za-z0-9_-]/g, "")}.ogg`
  );
  await fs.promises.writeFile(tmp, buf);
  try {
    return (await transcribeAudioFile(tmp)).trim();
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}
