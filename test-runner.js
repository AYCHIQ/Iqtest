'use strict';
const fs = require('fs');
const uuid = require('uuid');
const _ = require('lodash');
const nconf = require('nconf');
const iidk = require('./iidk');
const video = require('./video');
const wsman = require('./wsman');
const timing = require('./timing');

/* Initialize parameters */
nconf.argv()
  nconf.argv()
  .file({file: './config.json'});

const HOST = nconf.get('host');
const IP = nconf.get('ip');
const IIDK_ID = nconf.get('iidk');
const WSMAN_AUTH = nconf.get('wsauth');
const MONITOR = nconf.get('monitor');
const STREAM = nconf.get('stream');
const STREAM_PATH = nconf.get('stream-list');
const STAT_INTERVAL = nconf.get('interval');
const STAT_TIMEOUT = STAT_INTERVAL * 10;
const TOLERANCE = nconf.get('tolerance');
const CPU_THRESHOLD = nconf.get('cpu-threshold');
const CPU_SAMPLES = nconf.get('cpu-samples');
const FPS_THRESHOLD = nconf.get('fps-threshold');
const FPS_SAMPLES = nconf.get('fps-samples');
const stopOnExit = nconf.get('stop');
const INIT_COUNT = nconf.get('cams');
const VALIDATE_COUNT = nconf.get('validate');
const DROP_RATIO = 1 - nconf.get('drop');
const MAX_MONITOR_FAILS = nconf.get('monitor-fails');

/* General constants */
const VIDEO = 'video.run core';
const WS = {
  Board: 'Win32_BaseBoard',
  OS: 'Win32_OperatingSystem',
  LocalTime: 'Win32_LocalTime',
  Processor: 'Win32_Processor',
  ProcessorPerf: 'Win32_PerfFormattedData_PerfOS_Processor',
  Process: 'Win32_Process',
}

/* Global variables */
const streams = [];
/**
 * @class
 * @param {object} options -- attempt options
 * @property {map} monitorFps -- FPS displayed in monitor
 * @property {map} grabberFps -- FPS received from driver
 * @property {array} cpuSamples -- last CPU usage samples
 * @property {number} monitorFails -- number of time we suspected failure
 * @property {number} count -- number of added cameras
 * @property {object} cpu -- returns min, mean, max CPU usage
 * @property {number} fps -- mean input FPS
 * @property {number} camsQuota -- number of cameras we can safely add
 * @method addFps -- add FPS sample
 * @method addCpu -- add CPU sample
 * @method clearCpu -- clear CPU samples 
 * @method hasEnoughFps -- check readiness by FPS samples
 * @method hasEnoughCpu -- check readiness by CPU samples
 * @method isCalm -- check that system metrics has stabilised
 */
class Attempt {
  constructor(options) {
    this.options = options;
    this.monitorFps = new Map();
    this.grabberFps = new Map();
    this.cpuSamples = [];
    this.monitorFails = 0;
  }
  /**
   * Add FPS sample for camera
   *
   * @param {number} id -- camera Id
   * @param {number} fps -- FPS sample
   * @returns
   */
  addFps(id, fps) {
    let samples = this.monitorFps.get(id) || [];
    samples.push(fps);
    this.monitorFps.set(id, samples.slice(-this.options.fpsLen));
    this.monitorFails = 0;
  }
  /**
   * @param {number} cpu -- CPU usage sample
   * @returns
   */
  addCpu(cpu) {
    if (isFinite(cpu)) {
      this.cpuSamples.push(parseFloat(cpu));
      this.cpuSamples = this.cpuSamples.slice(-this.options.cpuLen);
    }
  }
  /**
   * @returns
   */
  clearCpu() {
    this.cpuSamples = [];
  }
  get cpu() {
    return {
      min: Math.min.apply(null, this.cpuSamples),
      mean: medianWin(this.cpuSamples),
      max: Math.max.apply(null, this.cpuSamples),
    }
  }
  get fps() {
    return aMean(Array.from(this.grabberFps).map(kv => kv[1]));
  }
  /**
   * @param {number} id -- camera Id
   * @return {boolean}
   */
  hasEnoughFps(id) {
    return this.monitorFps.get(id).length === this.options.fpsLen;
  }
  hasEnoughCpu() {
    return this.cpuSamples.length === this.options.cpuLen;
  }
  isCalm(id) {
    const input = this.grabberFps.get(id);
    const samples = this.monitorFps.get(id);

    return this.hasEnoughFps(id) && (stdDev(samples) / input) < this.options.tolerance;
  }
  get count() {
    return this.grabberFps.size;
  }
  get camsQuota() {
    const camsCount = this.count;
    const usage = this.cpu.mean;
    const cpuThreshold = this.options.cpuThreshold;
    const specificUsage = usage / camsCount;

    return Math.floor(Math.max(0, (cpuThreshold - usage)) / specificUsage) + 1;
  }
  hasFullFps(id) {
    let ratio = 1.0;

    const input = this.grabberFps.get(id);
    const output = medianWin(this.monitorFps.get(id));
    if (!!input && !!output) {
      ratio = output / input;
      if (this.options.fpsThreshold > ratio) {
        return false;
      }
    }
    return true;
  }
}
/** 
 * @class
 *
 * @param {object} options -- experiment options
 * @property {string} start -- start time fetched from tested server
 * @property {string} elapsed -- time spent for single stream test
 * @property {number} startCount -- number of cameras to start attempt with
 * @property {string} stream -- RTSP stream URI
 * @property {object} streamAttr -- RTSP stream attributes (parsed)
 * @property {array} attempts -- experiment attempts
 * @property {Attempt} attempt -- current test Attempt
 * @property {number} numAttempt -- number of completed Attempts
 * @property {number} cpu -- mean CPU usage over Attempts
 * @property {number} cams -- mean maximum camera number over Attempts
 * @property {number} fps -- mean FPS over Attempts
 * @property {boolean} isPending -- needs more Attempts to complete
 * @method newAttempt -- create new test Attempt
 * @method invalidAtmp -- remove last Attempt
 * @method dropCound -- calculate startCount according to dropRatio
 */
class Experiment {
  constructor(options) {
    /**
     * @namespace
     * @member {number} fpsLen -- length of FPS sample window
     * @member {number} cpuLen -- length of CPU usage sample window
     * @member {number} tolerance -- tolerance for FPS standard deviation
     * @member {number} dropRatio -- relative decrease of startCount for next iteration
     * @member {number} fpsThreshold -- threshold of FPS acceptability 
     * @member {number} cpuThreshold -- threshold of CPU high load
     * @member {number} validateCount -- number of Attempts that
     *                                   must be completed to finish Experiment
     */
    this.options = options;
    this.start = '';
    this.elapsed = '';
    this.streamUri = '';
    this._sattr = {};
    this.attempts = [];
    this.startCount = 1;
  }
  newAttempt() {
    this.attempts.push(new Attempt(this.options));
  }
  get attempt() {
    const last = this.attempts.length - 1;
    return this.attempts[last];
  }
  invalidAtmp() {
    this.attempts.pop();
  }
  set stream(uri) {
    this.streamUri = uri;
    if (uri){
      this._sattr = parseUri(uri);
    }
  }
  get stream() {
    return this.streamUri;
  }
  get streamAttr() {
    return this._sattr;
  }
  dropCount() {
    this.startCount = Math.ceil((this.attempt.count || 1) * this.options.dropRatio);
  }
  get isPending() {
    return this.attempts.length < this.options.validateCount;
  }
  get cams() {
    return Math.round(aMean(this.attempts.map(a => a.count)));
  }
  get cpu() {
    return aMean(this.attempts.map(a => a.cpu.mean));
  }
  get fps() {
    return aMean(this.attempts.map(a => a.fps));
  }
  get score() {
    const width = parseInt(this.streamAttr.width);
    const height = parseInt(this.streamAttr.height);
    const cams = this.cams;
    const fps = this.fps;
    const cpu = this.cpu;

    return (width * height * cams * fps) / (Math.pow(2, 20) * cpu);
  }

}
let streamIdx = 0;
let timer = null;
let ex = new Experiment();

timing.init('global');

process.on('exit', () => {
  if (stopOnExit) {
    iidk.stopModule(VIDEO);
  } 
});
process.on('uncaughtException', (err) => {
  console.error(`\n${progressTime()}\nCaught exception:`, err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error(`\n${progressTime()}\nUnhandled Rejection at: Promise `, p, 'reason: ', reason.stack);
});

/* Prepare video stream URI */
new Promise ((resolve, reject) => {
  fs.access(STREAM_PATH, fs.R_OK, (err) => {
    if (err) {
      streams.push(STREAM);
      resolve();
    } else {
      fs.readFile(STREAM_PATH, 'utf8', (errRead, data) => {
        if (errRead) {
          reject(`${STREAM_PATH} read error`);
        } else {
          data.trim().split('\n').forEach((s) => streams.push(s));
          resolve();
        }
      });
    }
  });
})
.then(() => {
  /* Get system info */
  let board = '';
  let processor = '';
  let osName= '';
  let ramSize = 0;
  const deferBoardInfo = wsman.enumerate({ip: IP, resource: WS.Board, auth: WSMAN_AUTH})
    .then((items) => board = `${items[0].Manufacturer} ${items[0].Product}`);
  const deferOSInfo = wsman.enumerate({ip: IP, resource: WS.OS, auth: WSMAN_AUTH})
    .then((items) => {
      osName = items[0].Caption;
      ramSize = items[0].TotalVisibleMemorySize / Math.pow(1024, 2);
    });
  const deferCPUInfo = wsman.enumerate({ip: IP, resource: WS.Processor, auth: WSMAN_AUTH})
    .then((items) => processor = items[0].Name);

  video.stats(STAT_INTERVAL);
  
  Promise.all([deferOSInfo, deferCPUInfo])
    .then(() => {
      stdout(`OS\t${osName}\n`);
      stdout(`CPU\t${processor}\n`);
      stdout(`Board\t${board}\n`);
      stdout(`RAM\t${ramSize.toFixed(2)}GB\n`);
      stdout(`Max.cam. samples\t${VALIDATE_COUNT}\n`);
      stdout(`CPU usage samples\t${CPU_MIN_SAMPLES}\n`);
      stdout(`Stat. interval\t${STAT_INTERVAL}\n`);
      stdout(`FPS threshold\t${FPS_THRESHOLD * 100}%\n`);
      stdout(`FPS tolerance\t${TOLERANCE * 100}%\n`);
      stdout(`Stream\tMax.cameras\tElapsed time\n`);

      iidk.connect({ip: IP, host: HOST, iidk: IIDK_ID, reconnect: true});
    })
    .catch(logError);

})
.catch(logError);

iidk.onconnect(() => bootstrap());
iidk.ondisconnect(() => streamIdx -= 1);

function bootstrap() {
  ex = new Experiment({
    fpsLen: FPS_SAMPLES,
    cpuLen: CPU_SAMPLES,
    tolerance: TOLERANCE,
    dropRatio: DROP_RATIO,
    fpsThreshold: FPS_THRESHOLD,
    cpuThreshold: CPU_THRESHOLD,
    validateCount: VALIDATE_COUNT,
  });
  ex.stream = streams[streamIdx];
  streamIdx += 1;
  timing.init('stream');
  if (ex.stream) {
    initTest();
  } else {
    stderr('Done!\n');
    process.exit();
  }
}

video.onconnect(() => runTest());

function initTest () {
  ex.newAttempt();
  timing.init('test');
  return iidk.stopModule(VIDEO)
    .then(() => iidk.startModule(VIDEO))
    .then(() => video.connect({ip: IP, host: HOST, reconnect: true}))
    .catch(logError);
}
function resetTimer () {
  clearTimeout(timer);
  timer = setTimeout(() => {
    teardown('Statistics timeout');
  }, STAT_TIMEOUT);
}

function runTest() {
  /**
   * Commence Test
   */
  const options = {
    host: HOST,
    src: STREAM,
  };
  let nextId = 0; 
  let count = ex.startCount;
  const gen = genRTSP(options);

  function addCams(n) {
    let i = 0;
    stderr(`+${n}`);
    for (i; i < n; i += 1) {
      nextId = gen.next().value;
    }
  }

  addCams(count);
  video.onstats((msg) => {
    if (/GRABBER.*Receive/.test(msg.id)) {
      const id = /\d+/.exec(msg.id)[0];
      const fps = parseFloat(msg.params.fps);
      ex.attempt.grabberFps.set(id, fps);
      if (!ex.attempt.monitorFps.has(id)) {
        video.showCam(id, MONITOR);
      }
    }
  });
  video.onstats((msg) => {
    if (/MONITOR.*CAM.*IN/.test(msg.id)) {
      const id = /\[CAM]\[(\d+)]/.exec(msg.id)[1];
      const fps = parseFloat(msg.params.fps);
      const isCurrentCam = id.toString() === nextId.toString();

      if (fps !== 0) {
        ex.attempt.addFps(id, fps);
        if (ex.attempt.isCalm(id)) {
          if (ex.attempt.hasEnoughCpu()) {
            if (!ex.attempt.hasFullFps(id)) {
              teardown();
            }
            /* Added camera has stable FPS -> iteration is complete */
            else if(isCurrentCam) {
              const camsCount = ex.attempt.count;
              const n = ex.attempt.camsQuota;

              stderr(`=${ex.attempt.count}\t${processorUsageString()}\t`);
              ex.attempt.clearCpu();
              /* Add next batch of cameras */ 
              addCams(n);
            }
          }
        }
      } else if (isCurrentCam) {
        ex.attempt.monitorFails += 1;
        if ((ex.attempt.monitorFails % (MAX_MONITOR_FAILS / STAT_INTERVAL)) === 0) {
          video.startVideo(id, MONITOR);
        }
        if (ex.attempt.monitorFails > MAX_MONITOR_FAILS) {
          teardown(`\nNo fps received in ${ex.attempt.monitorFails} reports\n`); 
        }
      }
    }
  });
  video.onstats((msg) => {
    if (/MONITOR/.test(msg.id) && msg.id.includes(nextId.toString())) {
      /* Fetch processor usage */
      wsman.enumerate({ip: IP, resource: WS.ProcessorPerf, auth: WSMAN_AUTH})
        .then((items) => {
          const usage = items.filter((u) => u.Name === '_Total')
            .map((u) => (100 - u.PercentIdleTime));
          ex.attempt.addCpu(usage); 
        })
        .catch((items, error) => stderr(`\n${error}\n`));
    }
  });
  video.setupMonitor(MONITOR);
}

function teardown(err) {
  const testTime = timing.elapsedString('test');

  ex.dropCount();
  video.offstats();
  if (err) {
    streamIdx -= 1;
    ex.invalidAtmp();
    stderr(err);
    initTest();
    return;
  }
  /* Re-run test to get enough validation points */
  stderr(`\nMax: ${ex.attempt.count}, finished in ${testTime}\n`);
  if (ex.isPending) {
    initTest();
  } else {
    ex.elapsed = timing.elapsedString('stream');
    stdout(report(ex));
    stderr(`\n${progressTime()} ${streamIdx}/${streams.length}\n`);
    bootstrap();
  }
  return;
}

function* genRTSP(options) {
  let id = 0;
  while (true) {
    id += 1;
    video.setupIpCam(id, ex.stream);
    yield id;
  }
}

function processorUsageString() {
  const min = ex.attempt.cpu.min;
  const mean = ex.attempt.cpu.mean;
  const max = ex.attempt.cpu.max;

function formatUri(uri) {
  const locationRe = /location=([^`]+).+?!/;
  if (locationRe.test(uri)) {
    return locationRe.exec(uri)[1];
  } else {
    return uri;
  }
}

function aMean(arr) {
  const sum = arr.reduce((sum, val) => sum += val, 0);
  return sum / arr.length;
}
function gMean(arr) {
  const product = arr.reduce((p, val) => p *= val > 0 ? val : 1, 1);
  return Math.pow(product, 1 / arr.length);
}

function medianWin(arr) {
  switch (arr.length) {
    case 0:
      return undefined;
    case 1:
      return arr[0];
    case 2:
      return (arr[0] + arr[1]) / 2;
    default: {
      const len1_3 = arr.length / 3;
      let win1_2 = 0;
      let win = [];
      let mA = 0;
      let mB = 0;

      arr.sort(function (a,b) { return a - b; });
      win = arr.slice(Math.floor(len1_3), Math.ceil(2*len1_3));
      win1_2 = win.length / 2;
      mA = Math.ceil(win1_2);
      mB = mA === win1_2 ? mA + 1 : mA ;
      return  (win[mA-1] + win[mB-1]) / 2;
    }
  }
}
function progressTime() {
  const doneStreams = streamIdx;
  const rate = timing.elapsed('global') / doneStreams;
  const estimatedMs = (streams.length - doneStreams) * rate;

  return `Elapsed time: ${timing.elapsedString('global')}, Estimated remaining time: ${timing.getTimeString(estimatedMs)}`;
}
function stdout(m) {
  process.stdout.write(m);
}
function stderr(m) {
  process.stderr.write(m);
}
function logError (e) {
  console.error(e);
};
