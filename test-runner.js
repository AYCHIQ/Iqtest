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
const STAT_TIMEOUT = (STAT_INTERVAL + 10) * 1000;
const FPS_TOLERANCE = nconf.get('fps-tolerance');
const CPU_THRESHOLD = nconf.get('cpu-threshold');
const CPU_READY = nconf.get('cpu-ready-threshold');
const CPU_SAMPLES = nconf.get('cpu-samples');
const FPS_THRESHOLD = nconf.get('fps-threshold');
const FPS_SAMPLES = nconf.get('fps-samples');
const stopOnExit = nconf.get('stop');
const REC_PATH = nconf.get('rec');
const INIT_COUNT = nconf.get('cams');
const VALIDATE_COUNT = nconf.get('validate');
const DROP_RATIO = 1 - nconf.get('drop');
const MAX_MONITOR_FAILS = nconf.get('monitor-fails');

/* General constants */
const VIDEO = 'video.run core';
const FAILED = false;
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
 * @param {number} prevCount -- cameras count known from previous attempts
 * @property {map} monitorFps -- FPS displayed in monitor
 * @property {number} fpsIn -- calculated input FPS
 * @property {array} cpuSamples -- last CPU usage samples
 * @property {number} monitorFails -- number of time we suspected failure
 * @property {number} calmFails -- number of time samples were not calm
 * @property {number} count -- number of added cameras
 * @property {object} cpu -- returns min, mean, max CPU usage
 * @property {number} camsQuota -- number of cameras we can safely add
 * @property {number} camId -- recent camera Id
 * @property {array} camHistory -- history of camera numbers since begining 
 * @property {array} ffHistory -- history of fullFps calculation
 * @property {number} lastDev -- recent deviation value 
 * @property {boolean} ignoreCPU -- whether we exceeded CPU limit
 *                                  and should ignore CPU usage
 * @property {boolean} hasEnoughFps -- whether we have enough FPS samples
 * @property {boolean} hasEnoughCpu -- whether we have enough CPU usage samples
 * @property {boolean} isCalm -- whether system metrics have stabilised
 * @property {boolean} hasFullFps -- calculate whether system renders all frames it receives
 * @member {array} streamFps -- FPS series of input video stream
 * @member {number} fps -- input FPS calculated value
 * @method addOutFps -- add camera FPS sample
 * @method addCpu -- add CPU sample
 * @method targetCams -- add/remove cameras to match target number
 * @method seek -- remove half of last camera number
 * @method clearCpu -- clear CPU samples 
 * @method {number} fpsOut -- mean output FPS
 */
class Attempt {
  constructor(options, prevCount) {
    this.options = options;
    this.monitorFps = new Map();
    this.streamFps = [];
    this.fps = 0;
    this.cpuSamples = [];
    this.monitorFails = 0;
    this.calmFails = 0;
    this.camId = 0;
    this.camHistory = [];
    this.ffHistory = [true];
    this.lastDev = Infinity;
    this.ignoreCPU = false;
    if (prevCount) {
      this.camHistory.push(prevCount);
    }
  }
  /**
   * Add FPS sample for camera
   *
   * @param {number} id -- camera Id
   * @param {number} fps -- FPS sample
   * @returns
   */
  addOutFps(id, fps) {
    if (this.monitorFps.has(+id)) {
      let samples = this.monitorFps.get(+id);
      samples.push(fps);
      this.monitorFps.set(+id, samples.slice(-this.options.fpsLen));
    }
    this.monitorFails = 0;
  }
  addCpu(cpu) {
    if (isFinite(cpu)) {
      this.cpuSamples.push(parseFloat(cpu));
    }
    this.cpuSamples = this.cpuSamples.slice(-this.options.cpuLen);
  }
  /**
   * @returns
   */
  clearCpu() {
    this.cpuSamples = [];
  }
  /**
   * Get CPU usage statistic 
   * @return {object} min/mean/max
   */
  get cpu() {
    const cmin = min(this.cpuSamples);
    const cmean = mean(this.cpuSamples);
    const cmax = max(this.cpuSamples);

    return {
      min: isFinite(cmin) ? cmin : undefined,
      mean: isFinite(cmean) ? cmean : undefined,
      max: isFinite(cmax) ? cmax : undefined,
    }
  }
  get fpsIn() {
    return this.fps;
  }
  set fpsIn(fps) {
    if (fps > 0) {
      this.streamFps.push(fps);
      this.streamFps = this.streamFps.slice(-this.options.fpsLen);
//stderr(` [ ${mad(this.streamFps)} ]`);
      if (this.streamFps.length === this.options.fpsLen &&
          mad(this.streamFps) < this.options.fpsTolerance) {
        this.fps = Math.round(median(this.streamFps));
      }
    }
  }
  /**
   * Get mean output FPS
   * @param {number} id -- camera Id
   * @returns {number}
   */
  fpsOut(id) {
    if (id) {
      return mean(this.monitorFps.get(+id));
    } else {
      return Array.from(this.monitorFps).reduce((r, kv) => r.concat(kv[1]), []);
    }
  }
  get hasEnoughFps() {
    return this.monitorFps.get(+id).length === this.options.fpsLen;
  }
  get hasEnoughCpu() {
    return this.cpuSamples.length === this.options.cpuLen;
  }
  get isCalm() {
    const allFpsOut = this.fpsOut();
    const allHaveEnoughFps = allFpsOut.length === (this.monitorFps.size * this.options.fpsLen);
    const dev = stdDev(allFpsOut);
    const matchTolerance = Math.abs(this.lastDev - dev) < Math.pow(this.options.fpsTolerance, 2);

//stderr(` [ ${Math.abs(this.lastDev - dev).toFixed(2)} < ${Math.pow(this.options.fpsTolerance, 2)}] `);
    this.lastDev = dev;
    if (allHaveEnoughFps && matchTolerance) {
      this.calmFails = 0;
    } else {
      this.calmFails += 1;
    }
    return allHaveEnoughFps && matchTolerance;
  }
  get count() {
    return this.camId;
  }
  get camsQuota() {
    const camsCount = this.count;
    const usage = this.cpu.mean;
    const cpuThreshold = this.options.cpuThreshold;
    const specificUsage = usage / camsCount;
    const estimated = cpuThreshold / specificUsage;
    const diff = estimated - this.camId;

    return this.count + Math.round(sigmoid(diff, estimated)) + 1;
  }
  get hasFullFps() {
    const allFpsOut = Array.from(this.monitorFps).map(kv => mean(kv[1]));
    const delta = Math.trunc(max(allFpsOut.map(f => Math.abs(this.fpsIn - f))));
    const value = delta <= this.options.fpsThreshold;

//stderr(` (${delta.toFixed(3)} < ${this.options.fpsThreshold}) `);
    return value;
  }
  targetCams(target) {
    let id = this.camId;

    this.camHistory.push(target);
    //stderr(`${processorUsageString()}`);
    switch (Math.sign(target - id)) {
      case 1:
        stderr('+');
        for (id += 1; id <= target; id += 1) {
          video.setupIpCam(id, ex.stream, ex.options.cam);
          video.showCam(id, this.options.monitorId);
          this.monitorFps.set(id, []);
          this.camId = id;
        }
        this.clearCpu();
        break;
      case -1:
        stderr('-');
        for (id; id >= (target + 1) && id > 1; id -= 1) {
          video.hideCam(id, this.options.monitorId);
          video.removeIpCam(id);
          this.monitorFps.delete(id);
          this.camId = id - 1;
        }
        this.clearCpu();
        break;
      case 0:
        teardown();
        return;
        break;
      default:
        break;
    }
    /** Reset calm metrics */
    this.monitorFps.forEach(resetSample);
    this.lastDev = Infinity;
    this.calmFails = 0;
    stderr(`=${this.camId}\t`);
  }
  seek(isOK = !FAILED) {
    const camHist3 = this.camHistory.slice(-3);
    const camHist3dt = camHist3.map((v, i, a) => (isFinite(a[i - 1]) ? v - a[i - 1] : 0));
    const ffNow = isOK ? this.hasFullFps : FAILED;
    const ffLast = this.ffHistory[this.ffHistory.length - 1];
    let target = camHist3[camHist3.length - 1];
    let diff = Math.abs(camHist3dt[camHist3dt.length - 1]);

    this.ffHistory.push(ffNow);

    if (ffNow !== ffLast) {
      diff = Math.floor(diff / 2);
    }
    /** 
     * If last failed and difference is zero, we still fail
     * and must reiterate 
     */
    if (diff === 0 && ffNow === FAILED) {
      diff += 1;
    }
    this.ignoreCPU = true;
    target += ffNow ? diff : -diff;

    stderr('S');
    this.targetCams(target); 
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
 * @property {number} camsDispersion -- standard deviation of maximum number across Attempts
 * @property {number} fps -- mean FPS over Attempts
 * @property {boolean} isPending -- needs more Attempts to complete
 * @method newAttempt -- create new test Attempt
 * @method invalidAtmp -- remove last Attempt
 * @method dropCount -- calculate startCount according to dropRatio
 */
class Experiment {
  constructor(options) {
    /**
     * @namespace
     * @member {number} fpsLen -- length of FPS sample window
     * @member {number} cpuLen -- length of CPU usage sample window
     * @member {number} fpsTolerance -- tolerance for FPS deviation
     * @member {number} cpuTolerance -- tolerance for CPU deviation
     * @member {number} dropRatio -- relative decrease of startCount for next iteration
     * @member {number} fpsThreshold -- threshold of FPS acceptability 
     * @member {number} cpuThreshold -- threshold of CPU high load
     * @member {number} validateCount -- number of Attempts that
     *                                   must be completed to finish Experiment
     * @member {number} maxFails -- maximum number of various fails
     * @member {number} monitorId -- Monitor Id used by test
     * @member {number} maxCount -- known maximum (used to prevent overloading)
     */
    this.options = options;
    this.start = '';
    this.elapsed = '';
    this.streamUri = '';
    this._sattr = {};
    this.attempts = [];
    this.startCount = 1;
    this.maxCount = null;
  }
  newAttempt() {
    this.attempts.push(new Attempt(this.options, this.maxCount));
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
    return Math.round(mean(this.attempts.map(a => a.count)));
  }
  get camsDispersion() {
    return stdDev(this.attempts.map(a => a.count));
  }
  get cpu() {
    return mean(this.attempts.map(a => a.cpu.mean));
  }
  get fps() {
    return mean(this.attempts.map(a => a.fpsIn));
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
    .then((items) => board = `${items[0].Manufacturer} ${items[0].Product}`)
    .catch(logError);
  const deferOSInfo = wsman.enumerate({ip: IP, resource: WS.OS, auth: WSMAN_AUTH})
    .then((items) => {
      osName = items[0].Caption;
      ramSize = items[0].TotalVisibleMemorySize / Math.pow(2, 20);
    })
    .catch(logError);
  const deferCPUInfo = wsman.enumerate({ip: IP, resource: WS.Processor, auth: WSMAN_AUTH})
    .then((items) => processor = items[0].Name)
    .catch(logError);

  video.stats(STAT_INTERVAL);
  
  Promise.all([deferOSInfo, deferCPUInfo])
    .then(() => {
      stdout(`OS\t${osName}\n`);
      stdout(`CPU\t${processor}\n`);
      stdout(`Board\t${board}\n`);
      stdout(`RAM\t${ramSize.toFixed(2)}GB\n`);
      stdout(`Attempts\t${VALIDATE_COUNT}\n`);
      stdout(`Stat. interval\t${STAT_INTERVAL}\n`);
      stdout(`CPU usage samples\t${CPU_SAMPLES}\n`);
      stdout(`FPS samples\t${FPS_SAMPLES}\n`);
      stdout(`FPS threshold\t${FPS_THRESHOLD}\n`);
      stdout(`FPS tolerance\t${FPS_TOLERANCE}\n`);
      stdout(`Vendor\tFormat\tWidth\tHeight\tFPS\tFPS(input)\tMax.cameras\tσ\tCPU\tScore\tStart time\tElapsed time\n`);

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
    fpsTolerance: FPS_TOLERANCE,
    dropRatio: DROP_RATIO,
    fpsThreshold: FPS_THRESHOLD,
    cpuThreshold: CPU_THRESHOLD,
    validateCount: VALIDATE_COUNT,
    maxFails: MAX_MONITOR_FAILS,
    monitorId: MONITOR,
    interval: STAT_INTERVAL,
    cam: {
      drives: REC_PATH,
    },
    metricRe: /CAM.*OUT/,
  });
  ex.stream = streams[streamIdx];
  streamIdx += 1;
  timing.init('stream');
  wsman.enumerate({ip: IP, resource: WS.LocalTime, auth: WSMAN_AUTH})
    .then(items => {
      const d = items[0];
      ex.start = `${d.Year}-` +
        `${timing.toDoubleDigit(d.Month)}-` +
        `${timing.toDoubleDigit(d.Day)} ` +
        `${timing.toDoubleDigit(d.Hour)}:` +
        `${timing.toDoubleDigit(d.Minute)}:` +
        `${timing.toDoubleDigit(d.Second)}`;
    });
  if (ex.stream) {
    initTest();
  } else {
    stderr('Done!\n');
    process.exit();
  }
}

video.onconnect(() => warmUp());

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
/**
 * Make sure system is ready
 * @returns
 */
function chkSysReady() {
  return new Promise((resolve, reject) => {
    const cpuCheck = () => fetchCPU().then(cpu => {
      if (cpu < CPU_READY) {
        stderr('\nCPU OK\t');
        resolve();
      } else {
        setTimeout(cpuCheck, STAT_INTERVAL * 1000);
      }
    });
    cpuCheck();
  });
}

/**
 * Capture input stream FPS
 * @returns
 */
function captureFps() {
  const testCamId = 1;
  video.setupIpCam(testCamId, ex.stream);
  return new Promise((resolve, reject) => {
    video.onstats((msg) => {
      if (ex.attempt.fpsIn === 0 && /GRABBER.*Receive/.test(msg.id)) {
        const id = getId(msg.id);
        const fps = parseFloat(msg.params.fps);

        ex.attempt.fpsIn = fps;
      }
      if (ex.attempt.fpsIn !== 0) {
        video.offstats();
        video.removeIpCam(testCamId);
        stderr(`FPS: ${ex.attempt.fpsIn.toFixed(2)}\n`);
        resolve();
      }
    });
  });
}

function warmUp() {
  chkSysReady().then(captureFps).then(runTest);
}

function runTest() {
  /**
   * Commence Test, when we are ready
   */
  video.setupMonitor(MONITOR);
  ex.attempt.targetCams(ex.startCount);

  video.onstats((msg) => {
    if (ex.options.metricRe.test(msg.id)) {
      const id = getId(msg.id);
      const fps = parseFloat(msg.params.fps);
      const isCurrentCam = id === ex.attempt.camId.toString();

      if (fps === 0) {
        return;
      }
      ex.attempt.addOutFps(id, fps);
      if (isCurrentCam && ex.attempt.hasEnoughCpu) {
        if (ex.attempt.isCalm) {
          /* Cameras has stable FPS -> iteration is complete */
          if (ex.attempt.ignoreCPU) {
            ex.attempt.seek();
          }
          /** 
           * Add more cameras to saturate CPU,
           */
          else if (ex.attempt.hasFullFps) {
            let n = ex.attempt.camsQuota;

            stderr('E');
            ex.attempt.targetCams(n);
          } 
          /**
           * We exceeded limit, and must seek to find it
           */
          else {
            ex.attempt.seek();
          }
        }
        /**
         * FPS is settling down too long, presumably system is overloaded
         */
        else if (ex.attempt.calmFails > ex.options.maxFails) {
          stderr('F');
          ex.attempt.seek(FAILED);
        }
      }
    }
  });
  video.onstats((msg) => {
    if (ex.options.metricRe.test(msg.id)) {
      const id = getId(msg.id);
      const isCurrentCam = id === ex.attempt.camId.toString();

      /* Fetch processor usage */
      if (isCurrentCam) {
        fetchCPU().then((cpu) => ex.attempt.addCpu(cpu));
      }
    }
  });
}

function fetchCPU() {
  return wsman.enumerate({ip: IP, resource: WS.ProcessorPerf, auth: WSMAN_AUTH})
    .then((items) => {
      const usageArr = items.filter((u) => u.Name === '_Total')
        .map((u) => (100 - u.PercentIdleTime));
      return usageArr[0];
    })
  .catch((items, error) => stderr(`\nFailed to fetch CPU usage\n`));
};

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
    ex.maxCount = ex.attempt.count;
    initTest();
  } else {
    ex.elapsed = timing.elapsedString('stream');
    stdout(report(ex));
    stderr(`\n${progressTime()} ${streamIdx}/${streams.length}\n`);
    bootstrap();
  }
  return;
}

function processorUsageString() {
  const cpuUsage = ex.attempt.cpu;
  const min = cpuUsage.min || 'n/a';
  const mean = cpuUsage.mean || 'n/a';
  const max = cpuUsage.max || 'n/a';

  return `${min}%…${mean}%…${max}%`;
}

/**
 * Extract stream information encoded in filename
 * within RTSP URI.
 * Vendor+Name_H264_800x600_30.ts ->
 * {
 *  vendor: Vendor Name,
 *  format: H264,
 *  width: 800,
 *  height: 600,
 *  fps: 30
 * }
 * @params {string}
 * returns {object}
 */
function parseUri(uri) {
  const locationRe = /location=([^`]+).+?!/;
  const keys = ['vendor', 'format', 'width', 'height', 'fps'];
  if (locationRe.test(uri)) {
    return locationRe.exec(uri)[1] //get "location=..." fragment
      .replace(/.+\//, '') //remove folder ".../"
      .replace(/\..*/, '') //remove extension ".*"
      .replace(/\+/g, ' ')
      .replace(/_/g, '\t')
      .replace(/(\d+)x(\d+)/g, '$1\t$2') //split WxH
      .split('\t')
      .reduce((r, val, idx) => {
          r.res[r.keys[idx]] = val;
            return r;
      }, {res: {}, keys})
      .res;
  } else {
    return {
      vendor: uri,
    };
  }
}

/**
 * Format experiment report
 * @param {Experiment} e
 * @returns {string}
 */
function report(e) {
  const s = e.streamAttr;
  const vendor = s.vendor;
  const format = s.format;
  const width = s.width;
  const height = s.height;
  const sfps = s.fps;
  const cpu = e.cpu.toFixed(2);
  const fps = (e.fps / e.options.interval).toFixed(2);
  const cams = e.cams;
  const sigma = e.camsDispersion.toFixed(2);
  const score = e.score.toFixed(2);
  const start = e.start;
  const elapsed = e.elapsed;

  return `${vendor}\t${format}\t${width}\t${height}\t` +
    `${sfps}\t${fps}\t${cams}\t${sigma}\t${cpu}\t` +
    `${score}\t${start}\t${elapsed}\n`;
}

/**
 * @param {array} arr -- array of numbers
 * @returns {number} sum
 */
function sum(arr) {
  return arr.reduce((sum, val) => sum + val, 0);
}
/**
 * Clear samples
 * @param {object} value
 * @param {object} key
 * @param {map} m
 */
function resetSample (value, key, m) {
  m.set(key, []);
}
/**
 * Mean calculation
 * @param {array} arr -- array of numbers
 * @returns {number} mean
 */
function mean(arr) {
  if (Array.isArray(arr)) {
    return sum(arr) / arr.length;
  } else {
    return undefined;
  }
}
/**
 * Maximum
 * @param {array} arr -- array of numbers
 * @returns {number}
 */
function max(arr) {
  return Math.max.apply(null, arr);
}

/**
 * Minimum
 * @param {array} arr -- array of numbers
 * @returns {number}
 */
function min(arr) {
  return Math.min.apply(null, arr);
}

/**
 * Standard deviation from mean
 * @param {array} arr -- array of numbers
 * @returns {number}
 */
function stdDev(samples) {
  if (Array.isArray(samples)) {
    const smean = mean(samples);
    const deviation = samples.map((val) => Math.pow(val - smean, 2));
    const variance = mean(deviation);
    const sd = Math.sqrt(variance);
    return sd;
  } else {
    return undefined;
  }
}

/**
 * Generates mapping function that calculates
 * deviation of values relative to reference value
 * @param {number} ref -- reference value
 * @returns {function}
 */
function devFrom(ref) {
  return (val, idx) => Math.abs(1 - val / ref);
}

/**
 * Extract id from message id string
 * @param {string} msgId -- message id string (e.g. [MONITOR][1][CAM][10][OUT])
 * @returns {string} id
 */
function getId(msgId) {
  return /([0-9]+)[^0-9]*$/.exec(msgId)[1];
}

/**
 * Median
 * @param {array} arr -- array of numbers
 * @return {number} median
 */
function median(arr) {
  if (Array.isArray(arr)) {
    if (arr.length > 0) {
      arr.sort(function (a,b) { return a - b; });
      const centre = arr.length / 2;
      const mA = Math.ceil(centre);
      const mB = mA === centre ? mA + 1 : mA ;
      return (arr[mA-1] + arr[mB-1]) / 2;
    }
  } else {
    return undefined;
  }
}

/** Median absolute deviation
 * @param {array} arr
 * @returns {number}
 */
function mad(arr) {
  if (Array.isArray(arr)) {
    const med = median(arr);
    const medDev = arr.map(v => Math.abs(v - med));
    
    return median(medDev);
  } else {
    return undefined;
  }
}
/**
 * Sigmoid function
 * @param {number} x
 * @param {number} max -- sigmoid maximum
 * @returns {number}
 */
function sigmoid(x, max) {
    return (1 / (1 + Math.exp(-x / max)) - 0.5) * max * 2;
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

function logError() {
  console.error(arguments);
};
