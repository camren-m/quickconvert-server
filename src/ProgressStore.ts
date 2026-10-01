export type LogLevel = "log" | "error" | "debug" | "warn";

export interface LogEntry {
  timestamp: number;
  plugin?: string;
  message: string;
  level: LogLevel;
}

export interface ConvertContext {
  progress: (message: string, value: number | ((prev: number) => number)) => void;
  log: (message: string, level?: LogLevel) => void;
  signal: AbortSignal;
  throwIfAborted: () => void;
}

export interface IProgressStore {
  progress: (message: string, percent: number) => void;
  log: (message: string, level?: LogLevel, pluginName?: string, relayToConsole?: boolean) => void;
}

export const ProgressStore = {
  percent: 0,
  message: "",
  logs: [] as LogEntry[],
  controller: new AbortController(),

  reset() {
    this.percent = 0;
    this.message = "";
    this.logs = [];
    this.controller = new AbortController();
  },

  abort() {
    this.controller.abort();
  },

  progress(message: string, percent: number) {
    this.message = message;
    this.percent = Math.max(0, Math.min(1, percent));
  },

  log(
    message: string,
    level: LogLevel = "log",
    pluginName?: string,
    relayToConsole: boolean = true,
  ) {
    this.logs = [
      ...this.logs,
      { timestamp: Date.now(), plugin: pluginName, message, level },
    ];
    if (relayToConsole) console[level](`[${pluginName}] ${message}`);
  },
};

export function createRemoteContext(
  store: IProgressStore,
  pluginName: string,
  abort: AbortSignal,
): ConvertContext {
  let prevVal = 0;

  return {
    progress: (msg, val) => {
      let nextVal = typeof val === "function" ? val(prevVal) : val;
      store.progress(msg, nextVal);
      prevVal = nextVal;
    },
    log: (msg, level = "log") => {
      store.log(msg, level, pluginName, false);
      console[level](`[${pluginName}] ${msg}`);
    },
    signal: abort,
    throwIfAborted() {
      if (abort.aborted) throw new DOMException("Conversion cancelled", "AbortError");
    },
  };
}
