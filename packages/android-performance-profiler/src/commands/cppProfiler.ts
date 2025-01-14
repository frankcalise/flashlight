import { Logger } from "@perf-profiler/logger";
import { ChildProcess, execSync } from "child_process";
import fs from "fs";
import os from "os";
import { getAbi } from "./getAbi";
import { executeAsync, executeCommand, executeLongRunningProcess } from "./shell";
import { POLLING_INTERVAL } from "@perf-profiler/types";

const CppProfilerName = `BAMPerfProfiler`;
const deviceProfilerPath = `/data/local/tmp/${CppProfilerName}`;

// Since Flipper uses esbuild, we copy the bin folder directly
// into the Flipper plugin directory
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const binaryFolder = global.Flipper
  ? `${__dirname}/bin`
  : `${__dirname}/../..${__dirname.includes("dist") ? "/.." : ""}/cpp-profiler/bin`;

let hasInstalledProfiler = false;
let aTraceProcess: ChildProcess | null = null;

const startATrace = () => {
  Logger.debug("Stopping atrace and flushing output...");
  /**
   * Since output from the atrace --async_stop
   * command can be quite big, seems like buffer overflow can happen
   * Let's ignore the output then
   *
   * See https://stackoverflow.com/questions/63796633/spawnsync-bin-sh-enobufs
   */
  execSync("adb shell atrace --async_stop", { stdio: "ignore" });
  Logger.debug("Starting atrace...");
  aTraceProcess = executeAsync("adb shell atrace -c view -t 999");
};

const stopATrace = () => {
  aTraceProcess?.kill();
  aTraceProcess = null;
};

/**
 * Main setup function for the cpp profiler
 *
 * It will:
 * - install the C++ profiler for the correct architecture on the device
 * - Starts the atrace process (the c++ profiler will then starts another thread to read from it)
 * - Populate needed values like CPU clock tick and RAM page size
 *
 * This needs to be done before measures and can take a few seconds
 */
export const ensureCppProfilerIsInstalled = () => {
  if (!hasInstalledProfiler) {
    const sdkVersion = parseInt(executeCommand("adb shell getprop ro.build.version.sdk"), 10);

    if (sdkVersion < 24) {
      throw new Error(
        `Your Android version (sdk API level ${sdkVersion}) is not supported. Supported versions > 23.`
      );
    }

    const abi = getAbi();
    Logger.info(`Installing C++ profiler for ${abi} architecture`);

    const binaryPath = `${binaryFolder}/${CppProfilerName}-${abi}`;
    const binaryTmpPath = `${os.tmpdir()}/flashlight-${CppProfilerName}-${abi}`;

    // When running from standalone executable, we need to copy the binary to an actual file
    fs.copyFileSync(binaryPath, binaryTmpPath);

    executeCommand(`adb push ${binaryTmpPath} ${deviceProfilerPath}`);
    executeCommand(`adb shell chmod 755 ${deviceProfilerPath}`);

    Logger.success(`C++ Profiler installed in ${deviceProfilerPath}`);

    retrieveCpuClockTick();
    retrieveRAMPageSize();
  }
  if (!aTraceProcess) startATrace();
  hasInstalledProfiler = true;
};

let cpuClockTick: number;
let RAMPageSize: number;

const retrieveCpuClockTick = () => {
  cpuClockTick = parseInt(executeCommand(`adb shell ${deviceProfilerPath} printCpuClockTick`), 10);
};

const retrieveRAMPageSize = () => {
  RAMPageSize = parseInt(executeCommand(`adb shell ${deviceProfilerPath} printRAMPageSize`), 10);
};

export const getCpuClockTick = () => {
  ensureCppProfilerIsInstalled();
  return cpuClockTick;
};

export const getRAMPageSize = () => {
  ensureCppProfilerIsInstalled();
  return RAMPageSize;
};

type CppPerformanceMeasure = {
  pid: string;
  cpu: string;
  ram: string;
  atrace: string;
  timestamp: number;
};

export const parseCppMeasure = (measure: string): CppPerformanceMeasure => {
  Logger.trace(measure);

  const DELIMITER = "=SEPARATOR=";
  const START_MEASURE_DELIMITER = "=START MEASURE=";

  const measureSplit = measure.split(START_MEASURE_DELIMITER);
  const measureContent = measureSplit[measureSplit.length - 1];

  const [pid, cpu, ram, atrace, timings] = measureContent.split(DELIMITER).map((s) => s.trim());

  const [timestampLine, execTimings] = timings.split(/\r\n|\n|\r/);

  const timestamp = parseInt(timestampLine.split(": ")[1], 10);

  Logger.debug(`C++ Exec timings:${execTimings}ms`);

  return { pid, cpu, ram, atrace, timestamp };
};

export const pollPerformanceMeasures = (
  pid: string,
  onData: (measure: CppPerformanceMeasure) => void,
  onPidChanged?: (pid: string) => void
) => {
  ensureCppProfilerIsInstalled();

  const DELIMITER = "=STOP MEASURE=";

  const process = executeLongRunningProcess(
    `adb shell ${deviceProfilerPath} pollPerformanceMeasures ${pid} ${POLLING_INTERVAL}`,
    DELIMITER,
    (data: string) => {
      onData(parseCppMeasure(data));
    }
  );

  process.stderr?.on("data", (data) => {
    const log = data.toString();

    // Ignore errors, it might be that the thread is dead and we can't read stats anymore
    if (log.includes("CPP_ERROR_CANNOT_OPEN_FILE")) {
      Logger.debug(log);
    } else if (log.includes("CPP_ERROR_MAIN_PID_CLOSED")) {
      onPidChanged?.(pid);
    } else {
      Logger.error(log);
    }
  });

  return {
    stop: () => {
      process.kill();
      // We need to close this process, otherwise tests will hang
      Logger.debug("Stopping atrace process...");
      stopATrace();
    },
  };
};
