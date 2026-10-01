import type { FileData, FileFormat, FormatHandler } from "../FormatHandler";
import type { ConvertContext } from "../ProgressStore.js";

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import mime from "mime";
import normalizeMimeType from "../normalizeMimeType";
import CommonFormats, { Category } from "src/CommonFormats";
import { InitializationError } from "src/errors";

class FFmpegHandler implements FormatHandler {
  static formatNames: Map<string, string> = new Map([
    ["mp4", CommonFormats.MP4.name],
    ["m4a", "MPEG-4 Audio"],
    ["flac", CommonFormats.FLAC.name],
    ["wav", CommonFormats.WAV.name],
    ["mp3", CommonFormats.MP3.name],
    ["ogg", CommonFormats.OGG.name],
    ["matroska", "Matroska / WebM"],
    ["mov", "QuickTime / MOV"],
    ["3gp", "3GPP Multimedia Container"],
    ["3g2", "3GPP2 Multimedia Container"],
    ["asf", "Windows Media Video (WMV)"],
  ]);

  public name: string = "FFmpeg";
  public supportedFormats: FileFormat[] = [];
  public ready: boolean = false;
  public offload: boolean = false;

  #ffmpegPath: string = process.env.FFMPEG_PATH || "ffmpeg";
  #activeProcesses = new Set<ChildProcess>();

  terminateFFmpeg() {
    for (const child of this.#activeProcesses) child.kill("SIGTERM");
  }

  async execSafe(
    args: string[],
    timeout: number = -1,
    ctx?: ConvertContext,
    cwd?: string,
  ): Promise<string> {
    ctx?.throwIfAborted();

    return await new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpegPath, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.#activeProcesses.add(child);

      let stdout = "";
      let stderr = "";
      let stdoutPending = "";
      let stderrPending = "";
      let processedSeconds = 0;
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const abortHandler = () => child.kill("SIGTERM");
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        ctx?.signal.removeEventListener("abort", abortHandler);
        this.#activeProcesses.delete(child);
      };
      const logStderr = (text: string) => {
        stderrPending += text;
        const lines = stderrPending.split(/\r?\n/);
        stderrPending = lines.pop() || "";
        for (const line of lines) {
          if (line) ctx?.log(line, "warn");
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        stdoutPending += text;
        const lines = stdoutPending.split(/\r?\n/);
        stdoutPending = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("out_time_ms=")) {
            const time = Number(line.slice("out_time_ms=".length));
            if (Number.isFinite(time)) processedSeconds = time / 1_000_000;
          } else if (line === "progress=continue") {
            ctx?.progress(`Transcoding... (${processedSeconds.toFixed(1)}s processed)`, (p) =>
              Math.min(0.95, p + 0.001),
            );
          }
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        logStderr(text);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new InitializationError(
            `Unable to start FFmpeg at "${this.#ffmpegPath}". Ensure FFmpeg is installed or set FFMPEG_PATH. ${error.message}`,
          ),
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stderrPending) ctx?.log(stderrPending, "warn");

        const output = `${stderr}\n${stdout}`;
        if (ctx?.signal.aborted) {
          reject(new DOMException("Conversion cancelled", "AbortError"));
        } else if (timedOut) {
          reject(new Error(`FFmpeg timed out after ${timeout}ms.\n${output}`));
        } else if (code !== 0) {
          reject(new Error(output || `FFmpeg exited with code ${code ?? signal}.`));
        } else {
          resolve(output);
        }
      });

      ctx?.signal.addEventListener("abort", abortHandler, { once: true });
      if (ctx?.signal.aborted) abortHandler();
      if (timeout !== -1) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout);
      }
    });
  }

  async init() {
    const getMuxerDetails = async (muxer: string) => {
      const stdout = await this.execSafe(["-hide_banner", "-h", "muxer=" + muxer], 3000);

      return {
        extension: stdout.split("Common extensions: ")[1].split(".")[0].split(",")[0],
        mimeType: stdout.split("Mime type: ")[1].split("\n")[0].split(".").slice(0, -1).join("."),
      };
    };

    const stdout = await this.execSafe(["-formats", "-hide_banner"], 3000);
    const formatLines = stdout.split(/\r?\n/);
    const separatorIndex = formatLines.findIndex((line) => /^\s*-{2,}\s*$/.test(line));
    if (separatorIndex < 0) throw new InitializationError("Unable to parse FFmpeg formats.");
    const lines = formatLines.slice(separatorIndex + 1);

    for (let line of lines) {
      let len;
      do {
        len = line.length;
        line = line.replaceAll("  ", " ");
      } while (len !== line.length);
      line = line.trim();

      const parts = line.split(" ");
      if (parts.length < 2) continue;

      const flags = parts[0];
      const description = parts.slice(2).join(" ");
      const formats = parts[1].split(",");

      if (description.startsWith("piped ")) continue;
      if (description.toLowerCase().includes("subtitle")) continue;
      if (description.toLowerCase().includes("manifest")) continue;

      for (const format of formats) {
        let primaryFormat = formats[0];
        if (primaryFormat === "png") primaryFormat = "apng";

        let extension, mimeType;
        try {
          const details = await getMuxerDetails(primaryFormat);
          extension = details.extension;
          mimeType = details.mimeType;
        } catch {
          extension = format;
          mimeType = mime.getType(format) || "video/" + format;
        }
        mimeType = normalizeMimeType(mimeType);

        let category = mimeType.split("/")[0];
        if (
          description.includes("PCM") ||
          description.includes("PWM") ||
          primaryFormat === "aptx" ||
          primaryFormat === "aptx_hd" ||
          primaryFormat === "codec2" ||
          primaryFormat === "codec2raw" ||
          primaryFormat === "apm" ||
          primaryFormat === "alp"
        ) {
          category = "audio";
          mimeType = "audio/" + mimeType.split("/")[1];
        } else if (category !== "audio" && category !== "video" && category !== "image") {
          if (description.toLowerCase().includes("audio")) category = "audio";
          else category = "video";
        }

        const name =
          FFmpegHandler.formatNames.get(format) ||
          description + (formats.length > 1 ? " / " + format : "");

        this.supportedFormats.push({
          name: name,
          format,
          extension,
          mime: mimeType,
          from: flags.includes("D"),
          to: flags.includes("E"),
          internal: format,
          category,
          lossless: ["png", "bmp", "tiff"].includes(format),
        });
      }
    }

    // ====== Manual fine-tuning ======

    const prioritize = ["webm", "mp4", "gif", "wav"];
    prioritize.reverse();

    this.supportedFormats.sort((a, b) => {
      const priorityIndexA = prioritize.indexOf(a.format);
      const priorityIndexB = prioritize.indexOf(b.format);
      return priorityIndexB - priorityIndexA;
    });

    // AV1 image support is excluded because it cannot be used reliably here.
    this.supportedFormats.splice(
      this.supportedFormats.findIndex((c) => c.mime === "image/avif"),
      1,
    );
    // HEVC stalls when attempted
    this.supportedFormats.splice(
      this.supportedFormats.findIndex((c) => c.internal === "hevc"),
      1,
    );
    // RTSP stalls when attempted
    this.supportedFormats.splice(
      this.supportedFormats.findIndex((c) => c.internal === "rtsp"),
      1,
    );

    // Add .qta (QuickTime Audio) support - uses same mov demuxer
    this.supportedFormats.push({
      name: "QuickTime Audio",
      format: "qta",
      extension: "qta",
      mime: "video/quicktime",
      from: true,
      to: true,
      internal: "mov",
      category: Category.AUDIO,
      lossless: false,
    });

    // Add .wmv (Windows Media Video) support - uses ASF container
    this.supportedFormats.push({
      name: "Windows Media Video",
      format: "wmv",
      extension: "wmv",
      mime: "video/x-ms-asf",
      from: true,
      to: true,
      internal: "asf",
      category: Category.VIDEO,
    });

    // Add .mts (AVCHD) support — camcorder footage using the MPEG-TS container.
    // FFmpeg auto-discovers "mpegts" but assigns the "" extension, leaving
    // ".mts" files (JVC, Sony, Panasonic AVCHD camcorders) unrecognised.
    this.supportedFormats.push({
      name: "AVCHD Video",
      format: "mts",
      extension: "mts",
      mime: "video/mp2t",
      from: true,
      to: false,
      internal: "mpegts",
      category: Category.VIDEO,
    });

    // Add .m2ts (Blu-ray BDMV) support — same MPEG-TS container, different extension.
    this.supportedFormats.push({
      name: "Blu-ray BDMV Video",
      format: "m2ts",
      extension: "m2ts",
      mime: "video/mp2t",
      from: true,
      to: false,
      internal: "mpegts",
      category: Category.VIDEO,
    });

    // Normalize Bink metadata to ensure ".bik" files are detected by extension.
    const binkFormats = this.supportedFormats.filter(
      (f) => f.internal === "bink" || f.format === "bink" || f.extension === "bik",
    );
    if (binkFormats.length > 0) {
      for (const binkFormat of binkFormats) {
        binkFormat.name = "Bink Video";
        binkFormat.format = "bik";
        binkFormat.extension = "bik";
        binkFormat.mime = "video/x-bink";
        binkFormat.from = true;
        binkFormat.to = false;
        binkFormat.internal = "bink";
        binkFormat.category = "video";
      }
    }

    // Add PNG input explicitly - FFmpeg otherwise treats both PNG and
    // APNG as the same thing.
    this.supportedFormats.push(CommonFormats.PNG.builder("png").allowFrom());

    // Encoding-specific formats
    this.supportedFormats.push(
      CommonFormats.OGG.builder("ogg").named("Ogg Vorbis Audio").withFormat("ogg-vorbis").allowTo(),
    );

    this.supportedFormats.push(
      CommonFormats.OGG.builder("ogg").named("Ogg Opus Audio").withFormat("ogg-opus").allowTo(),
    );

    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    args?: string[],
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    if (!this.ready) {
      throw new InitializationError("Handler not initialized.");
    }

    ctx?.throwIfAborted();
    if (inputFiles.length === 0) throw new Error("At least one input file is required.");

    const workingDirectory = await mkdtemp(join(tmpdir(), "quickconvert-"));
    try {
      let forceFPS = 0;
      if (inputFormat.mime === "image/png" || inputFormat.mime === "image/jpeg") {
        forceFPS = inputFiles.length < 30 ? 1 : 30;
      }

      const listLines: string[] = [];
      ctx?.log(`Preparing ${inputFiles.length} input files...`);
      for (const [index, file] of inputFiles.entries()) {
        ctx?.throwIfAborted();
        const entryName = `file_${index}.${inputFormat.extension}`;
        await writeFile(join(workingDirectory, entryName), file.bytes);
        listLines.push(`file '${entryName}'`);
        if (forceFPS) listLines.push(`duration ${1 / forceFPS}`);
      }
      await writeFile(join(workingDirectory, "list.txt"), listLines.join("\n") + "\n");

      const command = ["-hide_banner", "-progress", "pipe:1", "-nostats", "-f", "concat", "-safe", "0", "-i", "list.txt", "-f", outputFormat.internal];
      if (outputFormat.mime === "video/mp4") {
        command.push("-pix_fmt", "yuv420p");
      } else if (outputFormat.internal === "dvd") {
        command.push("-vf", "setsar=1", "-target", "ntsc-dvd", "-pix_fmt", "rgb24");
      } else if (outputFormat.internal === "vcd") {
        command.push("-vf", "scale=352:288,setsar=1", "-target", "pal-vcd", "-pix_fmt", "rgb24");
      } else if (outputFormat.internal === "asf") {
        command.push("-b:v", "15M", "-b:a", "192k");
      } else if (outputFormat.format === "ogg-vorbis") {
        command.push("-c:a", "libvorbis");
      } else if (outputFormat.format === "ogg-opus") {
        command.push("-c:a", "libopus");
      }
      if (args) command.push(...args);
      command.push("output");

      let stdout = "";
      let executionFailed = false;
      try {
        stdout = await this.execSafe(command, -1, ctx, workingDirectory);
      } catch (error) {
        ctx?.throwIfAborted();
        executionFailed = true;
        stdout = error instanceof Error ? error.message : String(error);
      }

      ctx?.throwIfAborted();
      if (executionFailed || stdout.includes("Conversion failed!\n")) {
      ctx?.log("Conversion failed, attempting auto-fix...", "error");
      const oldArgs = args ?? [];
      if (stdout.includes(" not divisible by") && !oldArgs.includes("-vf")) {
        const division = stdout.split(" not divisible by ")[1].split(" ")[0];
        return this.doConvert(
          inputFiles,
          inputFormat,
          outputFormat,
          [
            ...oldArgs,
            "-vf",
            `pad=ceil(iw/${division})*${division}:ceil(ih/${division})*${division}`,
          ],
          ctx,
        );
      }
      if (stdout.includes("width and height must be a multiple of") && !oldArgs.includes("-vf")) {
        const division = stdout
          .split("width and height must be a multiple of ")[1]
          .split(" ")[0]
          .split("")[0];
        return this.doConvert(
          inputFiles,
          inputFormat,
          outputFormat,
          [
            ...oldArgs,
            "-vf",
            `pad=ceil(iw/${division})*${division}:ceil(ih/${division})*${division}`,
          ],
          ctx,
        );
      }
      if (stdout.includes("Valid sizes are") && !oldArgs.includes("-s")) {
        const newSize = stdout.split("Valid sizes are ")[1].split(".")[0].split(" ").pop();
        if (typeof newSize !== "string") throw stdout;
        return this.doConvert(
          inputFiles,
          inputFormat,
          outputFormat,
          [...oldArgs, "-s", newSize],
          ctx,
        );
      }
      if (
        stdout.includes("does not support that sample rate, choose from (") &&
        !oldArgs.includes("-ar")
      ) {
        const acceptedBitrate = stdout
          .split("does not support that sample rate, choose from (")[1]
          .split(", ")[0];
        return this.doConvert(
          inputFiles,
          inputFormat,
          outputFormat,
          [...oldArgs, "-ar", acceptedBitrate],
          ctx,
        );
      }

      throw stdout;
      }

      ctx?.log("Reading output file...");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(workingDirectory, "output")));
      } catch (error) {
        ctx?.log(`Output file not created: ${error}`, "error");
        throw new Error(`Output file not created: ${error}`);
      }

      if (bytes.length === 0) {
        ctx?.log("FFmpeg failed to produce output file", "error");
        throw new Error("FFmpeg failed to produce output file");
      }

      const baseName = inputFiles[0].name.split(".").slice(0, -1).join(".");
      const name = baseName + "." + outputFormat.extension;

      ctx?.progress("Conversion complete!", 1);
      ctx?.log(`Successfully converted to ${name} (${bytes.length} bytes)`);

      return [{ bytes, name }];
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

export default FFmpegHandler;
