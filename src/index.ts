import {
	ConvertPathNode,
	stripPathNode,
	type FileData,
	type FileFormat,
	type HandlerDefinition,
} from "./FormatHandler";
import { initDefinitions } from "./handlers/index";
import { TraversionGraph } from "./TraversionGraph";
import { Converter } from "./Converter";
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { ProgressStore } from "./ProgressStore";
import { basename } from "node:path";
import Path from "path"

type FileRecord = Record<`${string}-${string}`, File>;

export type ConversionOptionsMap = Map<FileFormat, HandlerDefinition>;
export type ConversionOption = ConversionOptionsMap extends Map<infer K, infer V> ? [K, V] : never;

export const ConversionOptions: ConversionOptionsMap = new Map();

const converterMain = new Converter("Main")
const traversionGraph = new TraversionGraph()
const handlerDefs: HandlerDefinition[] = []

if(existsSync("./cache.json")) {
	handlerDefs.push(...JSON.parse(readFileSync("./cache.json", { encoding: "utf8" })))
}

async function buildOptionList() {
	ConversionOptions.clear();

	await initDefinitions(handlerDefs);

	writeFileSync("./cache.json", JSON.stringify(handlerDefs), { encoding: "utf8" })

	for (const handler of handlerDefs) {
		if (!handler.supportedFormats) {
			console.warn(`Handler "${handler.name}" doesn't support any formats`);
			continue;
		}

		for (const format of handler.supportedFormats) {
			if (!format.mime) continue;
			ConversionOptions.set(format, handler);
		}
	}
	traversionGraph.init(handlerDefs);

	converterMain.init(handlerDefs);
}

let deadEndAttempts: ConvertPathNode[][];

async function attemptConvertPath(
  originalFiles: FileData[],
  path: ConvertPathNode[],
  abort?: AbortSignal,
) {
  const pathString = path.map((c) => c.format.format).join(" → ");

  for (const deadEnd of deadEndAttempts) {
    let isDeadEnd = true;
    for (let i = 0; i < deadEnd.length; i++) {
      if (
        path[i]?.handler.name === deadEnd[i].handler.name &&
        path[i]?.format.mime === deadEnd[i].format.mime &&
        path[i]?.format.format === deadEnd[i].format.format
      )
        continue;
      isDeadEnd = false;
      break;
    }
    if (isDeadEnd) {
      const deadEndString = deadEnd
        .slice(-2)
        .map((c) => c.format.format)
        .join(" → ");
      console.warn(`Skipping ${pathString} due to dead end near ${deadEndString}.`);
      return null;
    }
  }

  ProgressStore.progress(`Trying ${pathString}...`, 0);

  let files = originalFiles;

  const totalSteps = path.length - 1;
  for (let i = 0; i < path.length - 1; i++) {
    if (!abort) abort = ProgressStore.controller.signal;
    if (abort.aborted) return null;

    const handlerDef = path[i + 1].handler;

    try {
      console.log(`Chose converter ${await converterMain.name} for ${handlerDef.name}`);

      abort.throwIfAborted();

      // this is annoying
      const restore = originalFiles.map((original) => ({
        original,
        inputIndex: files.findIndex((file) => file.bytes.buffer === original.bytes.buffer),
        offset: original.bytes.byteOffset,
        length: original.bytes.byteLength,
      }));

      const result = await converterMain.doConvert(
        handlerDef,
        [path[i], path[i + 1]],
        files,
        { currentStep: i + 1, totalSteps },
        ProgressStore
      );

      for (const { original, inputIndex, offset, length } of restore) {
        if (inputIndex !== -1) {
          // we dont want handlers messing with it but we need to mess with it
          (original as { bytes: Uint8Array }).bytes = new Uint8Array(
            result.inputFiles[inputIndex].bytes.buffer,
            offset,
            length,
          );
        }
      }

      if (result.ok) {
        files = result.outputFiles;
      } else {
        throw Object.assign(new Error(result.error.message), result.error);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw e;
      }

      abort.throwIfAborted();

      ProgressStore.log(
        `Conversion path failed: ${pathString} (${handlerDef.name}: ${path[i].format.format} → ${path[i + 1].format.format}): ${e instanceof Error ? e.message : String(e)}`,
        "error",
        handlerDef.name,
      );

      const deadEndPath = path.slice(0, i + 2);
      deadEndAttempts.push(deadEndPath);
      traversionGraph.addDeadEndPath(path.slice(0, i + 2));

      ProgressStore.progress("Looking for a valid path...", 0);
	  await new Promise(resolve => setTimeout(resolve, 1));

      return null;
    }
  }

  return { files, path };
}

async function tryConvertByTraversing (
  files: FileData[],
  from: ConvertPathNode,
  to: ConvertPathNode,
  abort?: AbortSignal,
) {
  deadEndAttempts = [];
  abort ??= ProgressStore.controller.signal;
traversionGraph.clearDeadEndPaths();
  const paths = traversionGraph.searchPathProxied(
    stripPathNode(from),
    stripPathNode(to),
	true,
	() => abort.aborted,
  );
  while (true) {
    const { value: path, done } = await paths.next();
    if (done) return null;
    if (abort?.aborted) return null;
    if (path.at(-1)?.handler === to.handler) {
      path[path.length - 1] = to;
    }
    const attempt = await attemptConvertPath(files, path, abort);
    if (attempt) return attempt;
  }
};

await buildOptionList()

/*
async function testConversion() {
	const fileName = "./test.jpg"
	const fileData: FileData = {
		name: basename(fileName),
		bytes: readFileSync(fileName),
	}
	const from = "jpg"
	const to = "png"
	const handler = handlerDefs.find((h) => h.name === "ImageMagick")!

	const output = await tryConvertByTraversing(
		[fileData],
		new ConvertPathNode(handler, handler.supportedFormats!.find((f) => f.extension === from)!),
		new ConvertPathNode(handler, handler.supportedFormats!.find((f) => f.extension === to)!),
	)
	const outputFile = output!.files[0]!

	writeFileSync(`./${outputFile.name}`, outputFile.bytes)
}

await testConversion()
*/
