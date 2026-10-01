import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  stripHandler,
  type FormatHandler,
  type HandlerDefinition,
} from "../FormatHandler";

const HANDLERS = {
  ImageMagick: [],
  FFmpeg: [],
} as const;

export type HandlerName = keyof typeof HANDLERS;

type HandlerModule = Record<string, new () => FormatHandler>;

const modules = Object.fromEntries(
  readdirSync(import.meta.dirname)
    .filter((file) => file.endsWith(".ts") || file.endsWith(".js"))
    .map((file) => [
      `./${file}`,
      () => import(join(import.meta.dirname, file)) as Promise<HandlerModule>,
    ]),
) as Record<string, () => Promise<HandlerModule>>;

const singletons = new Map<HandlerName, FormatHandler>();

export async function getHandler(name: HandlerName) {
  let handler = singletons.get(name);
  if (handler) return handler;

  const handlerEntry = HANDLERS[name];

  const [
    modulePath = `./${name}.ts`,
    exportName = "default",
  ] = handlerEntry;

  const module = modules[modulePath];

  if (!module) {
    throw new Error(`Handler module ${modulePath} was not found!`);
  }

  const HandlerClass = (await module())[exportName];

  if (!HandlerClass) {
    throw new Error(
      `Handler ${modulePath} did not have an export ${exportName}!`,
    );
  }

  handler = new HandlerClass();
  singletons.set(name, handler);

  return handler;
}

export async function initDefinitions(cache: HandlerDefinition[]) {
  for (const handlerName of Object.keys(HANDLERS) as HandlerName[]) {
    if (cache.some((handler) => handler.name === handlerName)) {
      continue;
    }

    console.warn(`Cache miss for handler "${handlerName}"`);

    try {
      const handler = await getHandler(handlerName);

      if (handler.name !== handlerName) {
        throw new Error(
          `Handler ${handlerName} reported ${handler.name} as their name?`,
        );
      }

      await handler.init();

      cache.push(stripHandler(handler));

      console.log(
        `Updated handler cache for handler "${handlerName}".`,
      );
    } catch (error) {
      console.error(
        `Error while initializing ${handlerName}:`,
        error,
      );
    }
  }
}
