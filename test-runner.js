#!/usr/bin/node
'use strict';
const fs = require('fs');
const uuid = require('uuid');
const nconf = require('nconf');
const iidk = require('./iidk');
const video = require('./video');
const timing = require('./timing');
const dash = require('./dashboard');

/* Initialize parameters */
nconf.argv()
  nconf.argv()
  .file({file: './config.json'});

const IP = nconf.get('ip');
const WSAUTH = nconf.get('wsauth');
const IIDK_ID = nconf.get('iidk');
const MONITOR = nconf.get('monitor');
const HEADLESS = nconf.get('headless');
const STREAM = nconf.get('stream');
const STREAM_PATH = nconf.get('stream-list');
const STAT_INTERVAL = nconf.get('interval');
const STAT_TIMEOUT = STAT_INTERVAL * 5;
const CPU_INTERVAL = nconf.get('cpu-interval');
const CPU_THRESHOLD = nconf.get('cpu-threshold');
const CPU_READY = nconf.get('cpu-ready-threshold');
const CPU_SAMPLES = nconf.get('cpu-samples');
const FPS_THRESHOLD = nconf.get('fps-threshold');
const FPS_SAMPLES = nconf.get('fps-samples');
const FREEMB_THRESHOLD = nconf.get('freemb-threshold');
const stopOnExit = nconf.get('stop');
const REC_PATH = nconf.get('rec');
const INIT_COUNT = nconf.get('cams');
const REPORT_PATH = nconf.get('report-path');
const VALIDATE_COUNT = nconf.get('validate');
const DROP_RATIO = 1 - nconf.get('drop');
const MAX_FAILS = nconf.get('monitor-fails');

/** Suite tools */
const {Attempt, Experiment} = require('./suite');
const {
  fetchHostname, fetchBoardInfo, fetchOSInfo,
  fetchCPUInfo, fetchDate,
  fetchCPU, fetchMem,
} = require('./wsutils')({ip: IP, auth: WSAUTH});
const {report, getId, debounce, throttle} = require('./utils');
const getResources = () => Promise.all([fetchCPU(), fetchMem()]);

/* General constants */
const VIDEO = 'video.run core';
const OK = true;
const FAILED = false;
const HIRES = true;

/* @global */
const streams = [];
let host = '';
let fileStream;
let streamIdx = 0;
let ex = new Experiment();

timing.init('global');

process.on('exit', () => {
  if (stopOnExit) {
    iidk.stopModule(VIDEO);
  } 
});
process.on('uncaughtException', (err) => {
  stderr('Caught exception:', err);
});
process.on('unhandledRejection', (reason, p) => {
  stderr('Unhandled Rejection at: Promise', p, 'reason: ', reason.stack);
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
  stderr('Fetching platform description');
  return Promise.all([fetchHostname(), fetchBoardInfo(), fetchOSInfo(), fetchCPUInfo()])
    .then(([hostname, board, {osName, ramSize}, processor]) => {
      const dateString = new Date().toISOString();
      const path = REPORT_PATH + '/' + (`${hostname}_${processor}_${dateString}.tsv`).replace(/[^A-Za-z0-9-_.]/g, '_'); 

      dash.showHostInfo(IP, hostname);

      /** @global */
      host = hostname;
      fileStream = fs.createWriteStream(path);

      fileStream.write(`OS\t${osName}\n`);
      fileStream.write(`CPU\t${processor}\n`);
      fileStream.write(`Board\t${board}\n`);
      fileStream.write(`RAM\t${ramSize.toFixed(2)}GB\n`);
      fileStream.write(`Attempts\t${VALIDATE_COUNT}\n`);
      fileStream.write(`Stat. interval\t${STAT_INTERVAL}\n`);
      fileStream.write(`CPU usage samples\t${CPU_SAMPLES}\n`);
      fileStream.write(`FPS samples\t${FPS_SAMPLES}\n`);
      fileStream.write(`FPS threshold\t${FPS_THRESHOLD}\n`);
      fileStream.write(`Vendor\tFormat\tWidth\tHeight\tFPS\tFPS(input)\tMax.cameras\tσ\tCPU\tScore\tStart time\tElapsed time\n`);
    });
})
.then(() => iidk.connect({ip: IP, host, iidk: IIDK_ID, reconnect: true}))
.then(() => video.connect({ip: IP, host, reconnect: true}))
.catch(stderr);

iidk.onconnect(function () {
  if (ex.isPending) {
    teardown('Lost connection during Attempt');
  } else {
    bootstrap();
  }
});
iidk.onconnect(() => stderr('IIDK connected'));
iidk.ondisconnect(() => stderr('IIDK disconnected'));

function bootstrap() {
  const stream = streams[streamIdx];
  streamIdx += 1;
  if (!stream) {
    stderr('Done!');
    process.exit();
  }

  ex = new Experiment({
    fpsLen: FPS_SAMPLES,
    cpuLen: CPU_SAMPLES,
    dropRatio: DROP_RATIO,
    fpsThreshold: FPS_THRESHOLD,
    cpuThreshold: CPU_THRESHOLD,
    validateCount: VALIDATE_COUNT,
    maxFails: MAX_FAILS,
    monitorId: MONITOR,
    refRe: /GRABBER.*Receive/,
    metricRe: HEADLESS ? /FileRecorder.*OUT/ : /CAM.*OUT/,
    isHeadless: HEADLESS,
  });
  ex.stream = stream;
  ex.handlers = {
    add(id) { 
      video.setupIpCam(id, stream, {drives: REC_PATH});
      !ex.options.isHeadless && video.showCam(id, ex.options.monitorId);
    },
    remove(id) {
      !ex.options.isHeadless && video.hideCam(id, ex.options.monitorId);
      video.removeIpCam(id);
    },
    teardown,
  };
  timing.init('stream');
  fetchDate().then(d => ex.start = d);
  dash.showExInfo();
  dash.showProgress(streams, streamIdx, timing);
  initTest();
  stderr('Commence testing');
}

video.onconnect(warmUp);
video.onconnect(() => stderr('Video connected'));
video.ondisconnect(() => stderr('Video disconnected'));

function initTest () {
  ex.newAttempt();
  timing.init('test');
  return iidk.stopModule(VIDEO).then(() => iidk.startModule(VIDEO))
    .catch(stderr);
}
/**
 * Make sure system is ready
 * @returns {Promise}
 */
function chkSysReady(readyUsage) {
  let fails =  0;
  return new Promise((resolve, reject) => {
    stderr('Waiting for CPU');
    pollUsage((cpu, freemb) => {
      stderr(`{cyan-fg}${cpu}{/}`);
      if (cpu < readyUsage) {
        stderr('CPU OK');
        resolve();
        return false;
      }
      if (cpu > readyUsage && ++fails > MAX_FAILS) {
        reject('Settling too long');
        return false;
      }
      return true;
    });
  });
}

/**
 * Capture input stream FPS
 * @returns {Promise}
 */
function captureFps() {
  const testCamId = 1;

  stderr('Determining FPS');
  ex.handlers.add(testCamId);
  return new Promise((resolve, reject) => {
    pollStats();
    onstats((msg) => {
      const isMetric =  ex.options.refRe.test(msg.id);

      if (isMetric && ex.attempt.fpsIn === 0) {
        const fps = parseFloat(msg.params.fps);

        ex.attempt.addFpsIn(fps);
      }
      if (isMetric && ex.attempt.fpsIn !== 0) {
        ex.handlers.remove(testCamId);
        stderr(`FPS: ${ex.attempt.fpsIn.toFixed(2)}`);
        resolve();
        return;
      }
      dash.showAttemptInfo(ex.attempt);
      pollStats();
    });
  });
}

function warmUp() {
  const {GET_FPS, TESTING} = ex.attempt;
  switch (ex.attempt.stage) {
    case TESTING:
      teardown('Lost connection during attempt');
      return;
    case GET_FPS:
      return
    default:
      ex.attempt.nextStage(GET_FPS);
  }
  stderr('Warming up...');
  chkSysReady(CPU_READY).then(captureFps).then(runTest)
    .catch(teardown);
}

function runTest() {
  const attempt = ex.attempt;
  /**
   * Commence Test, when we are ready
   */
  /** SETUP */
  !ex.options.isHeadless && video.setupMonitor(attempt.options.monitorId);
  /**/
  attempt.nextStage(attempt.TESTING);
  attempt.clearCpu();
  attempt.targetCams(ex.startCount);
  dash.showExInfo(ex);
  stderr('Testing stage');

  onstats((msg) => {
    const isMetric = ex.options.metricRe.test(msg.id);
    const id = isMetric ? parseInt(getId(msg.id)) : -1;
    const fps = isMetric ? parseFloat(msg.params.fps) : -1;
    const isTargetCam = isMetric && id === attempt.target;
    const isCurrentCam = isMetric && id === attempt.camId;

    if (isMetric && fps > 0) {
      attempt.addOutFps(id, fps);
      dash.showProgress(streams, streamIdx, timing);
    }

    /**
     * Sanity check
     * If current camera statistics provides FPS add next one
     */
    if ((isCurrentCam && !isTargetCam && attempt.hasOutFps(id)) ||
         attempt.camId === 0) {
      const {target, count, cpu, hasEnoughSamples, hasSaneFps, fpsOut} = attempt;
      const {cpuThreshold} = attempt.options;
      /**
       * Stop adding estimated cameras if CPU is overloaded
       * or FPS doesn't pass sanity check
       */
      if ((target > count && cpu.mean > cpuThreshold) || (hasEnoughSamples && !hasSaneFps)) {

        stderr(`Sanity alert {grey-fg}CPU:${cpu.max}% FPS:${fpsOut.toFixed(2)}{/}`);
        attempt.pendingGen.return();
        attempt.finaliseCams();
      }
      attempt.pendingGen.next();
      return;
    }

    /** Ignore irrelevant statistics */
    if (!isMetric) {
      pollStats();
      return;
    }
    if (isMetric && fps <= 0) {
      return;
    }

    const shouldCalculate = isMetric && isTargetCam && attempt.hasEnoughCpu;
    const isCalm = shouldCalculate ? attempt.isCalm : false;
    const hasFullFps = shouldCalculate ? attempt.hasFullFps : false;
    const isReady = shouldCalculate && isCalm;

    /**
     *  Cameras has stable FPS means iteration is complete 
     **/
    if (isReady && attempt.ignoreCPU) {
      attempt.seek(hasFullFps);
      return;
    }

    /** 
     * Add more cameras to saturate CPU,
     */
    const estimateByCPU = isReady && !attempt.ignoreCPU && hasFullFps;
    const n = estimateByCPU ? attempt.estimate : -Infinity; 

    /** Make sure that estimated number is higher than actual */
    if (estimateByCPU && n > attempt.count) {
      stderr(`Estimation {gray-fg}${n}{/}`);
      attempt.targetCams(n);
      return;
    } 
    if (estimateByCPU && n <= attempt.count) {
      stderr(`Estimated less than current {gray-fg}${n}{/}`);
      attempt.seek(OK);
      return;
    }

    /**
     * We exceeded limit, and must seek to find it
     */
    if (isReady && !hasFullFps) {
      stderr(`Estimation overreached (fps: {gray-fg}${attempt.samples.median.toFixed(2)}{/})`);
      attempt.seek(FAILED);
      return;
    }

    /**
     * FPS is settling down too long, presumably system is overloaded
     */
    if (shouldCalculate && !isCalm && attempt.calmFails > ex.options.maxFails) {
      stderr('Samples too random');
      attempt.seek(FAILED);
      return;
    }

    dash.showAttemptInfo(attempt);
    pollStats();
  });
  pollStats();
  pollUsage((cpu, freeMB) => {
    attempt.addCpu(cpu);
    if (freeMB < FREEMB_THRESHOLD) {
      stderr('Not enough memory to continue');
      teardown();
    }
    dash.showAttemptInfo(attempt);

    return attempt.isRunning;
  });
}

function teardown(err) {
  const testTime = timing.elapsedString('test');

  ex.dropCount();
  /** Make sure data makes sense */
  if (ex.attempt.count === 1 && ex.attempt.samples.median === 0) {
    err = 'Data is invalid!';
  }
  if (err) {
    ex.invalidAtmp();
    stderr(err);
    initTest();
    return;
  }
  /** Re-run test to get enough validation points */
  stderr(`Max: ${ex.attempt.count}, finished in ${testTime}`);
  if (ex.isPending) {
    ex.maxCount = ex.attempt.count;
    initTest();
  } else {
    ex.elapsed = timing.elapsedString('stream');
    stdout(report(ex));
    bootstrap();
  }
  return;
}


function stdout(m) {
  fileStream.write(m);
}

function stderr(e) {
  Array.prototype.forEach.call(arguments, a => {
    if (a instanceof Error) {
      dash.log(a.message);
      dash.log(a.stack);
    } else {
      dash.log(a);
    }
  });
}
function onstats(fn) {
  video.onstats(function (msg) {
    checkStatRTT();
    ex.attempt.stattimeL = timing.elapsed('stat');
    dash.showStatTs();
    fn(msg);
  })
}
const checkStatRTT = throttle(function () {
  ex.attempt.stattime1 = timing.elapsed('stat');
}, STAT_INTERVAL);
const pollStats = debounce(function () {
  timing.init('stat', HIRES);
  video.requestStats();
}, STAT_INTERVAL);
const pollUsage = (function () {
  let timerId = null;
  /**
   * Poll resource usage after delay and call function to process it
   * @param {number} interval -- poll interval
   * @param {function} cb -- callback function, must return boolean:
   *                          true: continue polling
   *                          false: stop polling
   * @returns {number} timer id
   */
  return function poll(cb) {
    clearTimeout(timerId);
    timerId = setTimeout(function () {
      timing.init('poll', HIRES);
      Promise.all([fetchCPU(), fetchMem()])
        .then(resources => {
	 ex.attempt.wstime = timing.elapsed('poll');
          const shouldPoll = cb.apply(null, resources);
          if (shouldPoll) {
            poll(cb);
          }
        })
        .catch(reason => {
          poll(cb);
        })
      }, CPU_INTERVAL);
  }
})();
