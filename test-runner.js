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
const CPU_MIN_SAMPLES = nconf.get('cpu-samples');
const FPS_THRESHOLD = nconf.get('fps-threshold');
const A = nconf.get('alpha');
const stopOnExit = nconf.get('stop');
const INIT_COUNT = nconf.get('cams');
const VALIDATE_COUNT = nconf.get('validate');
const DROP_RATIO = 1 - nconf.get('drop');
const MAX_MONITOR_FAILS = nconf.get('monitor-fails');

/* General constants */
const SECONDS = 1000;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;
const VIDEO = 'video.run core';
const WS = {
  Board: 'Win32_BaseBoard',
  OS: 'Win32_OperatingSystem',
  Processor: 'Win32_Processor',
  ProcessorPerf: 'Win32_PerfFormattedData_PerfOS_Processor',
  Process: 'Win32_Process',
}

/* Global variables */
const MonitorFps = new Map();
const GrabberFps = new Map();
const streams = [];

let streamIdx = 0;
let processorUsage = [];
let maxCounts = [];
let startCount = 0;
let tryNum = 0;
let stream = STREAM;
let timer = null;

timing.init('global');

process.on('exit', () => {
  if (stopOnExit) {
    iidk.stopModule(VIDEO);
  } 
});
process.on('uncaughtException', (err) => {
  stderr(`\n${progressTime()}\nCaught exception: ${err}\n`);
});
process.on('unhandledRejection', (reason, p) => {
  stderr(`\n${progressTime()}\nUnhandled Rejection at: Promise ${p} reason: ${reason}\n`);
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
      stdout(`FPS toleranxe\t${TOLERANCE * 100}%\n`);
      stdout(`Stream\tMax.cameras\tElapsed time\n`);

      iidk.connect({ip: IP, host: HOST, iidk: IIDK_ID, reconnect: true});
    })
    .catch(logError);

})
.catch(logError);

iidk.onconnect(() => bootstrap());
iidk.ondisconnect(() => streamIdx -= 1);

function bootstrap() {
  processorUsage = [];
  maxCounts = [];
  startCount = 0;
  tryNum = 0;
  stream = streams[streamIdx];
  streamIdx += 1;
  timing.init('stream');
  if (stream) {
    stdout(`${formatUri(stream)}`);
    initTest();
  } else {
    stderr('Done!\n');
    process.exit();
  }
}

video.onconnect(() => runTest());

function initTest () {
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
  let count = startCount || INIT_COUNT ;
  let monitorFails = 0;
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
      let id = /\d+/.exec(msg.id)[0];
      let fps = parseFloat(msg.params.fps);
      GrabberFps.set(id, fps);
      if (!MonitorFps.has(id)) {
        video.showCam(id, MONITOR);
      }
    }
  });
  video.onstats((msg) => {
    if (/MONITOR.*CAM.*IN/.test(msg.id)) {
      let id = /\[CAM]\[(\d+)]/.exec(msg.id)[1];
      let fps = parseFloat(msg.params.fps);
      const isCurrentCam = id.toString() === nextId.toString();

      if (fps !== 0) {
        let input = GrabberFps.get(id);
        let oldFps = MonitorFps.has(id) ?  MonitorFps.get(id) : input;
        let delta = fps - oldFps;
        let avg = oldFps + A * delta;
        let isCalm = Math.abs(delta / input) < TOLERANCE;
        MonitorFps.set(id, avg);
        monitorFails = 0;
        if (isCalm) {
          /* Added camera has stable FPS -> iteration is complete */
          if (isCurrentCam && processorUsage.length > CPU_MIN_SAMPLES) {
            const camsCount = GrabberFps.size;
            const usage = medianWin(processorUsage);
            const specificUsage = usage / camsCount;
            const n = Math.floor(Math.max(0, (CPU_THRESHOLD - usage)) / specificUsage) + 1;
            stderr(`=${camsCount}\t${processorUsageString()}\t`);
            processorUsage = [];
            /* Add next batch of cameras */ 
            addCams(n);
          }
          if (!hasFullFps(id)) {
            teardown();
          }
        }
      } else if (isCurrentCam) {
        monitorFails += 1;
        if ((monitorFails % MAX_MONITOR_FAILS / STAT_INTERVAL) === 0) {
          video.startVideo(id, MONITOR);
        }
        if (monitorFails > MAX_MONITOR_FAILS) {
          tryNum -= 1;
          teardown(`\nNo fps received in ${monitorFails} reports\n`); 
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
          processorUsage.push(parseFloat(usage)); 
        });
    }
  });
  video.setupMonitor(MONITOR);
}

function teardown(err) {
  const max = MonitorFps.size;
  const testTime = getTime(timing.elapsed('test');

  MonitorFps.clear();
  GrabberFps.clear();
  video.offstats();
  if (err) {
    tryNum -= 1;
    stderr(err);
    startCount = Math.ceil((max || 1) * DROP_RATIO);
    initTest();
    return;
  }
  /* Re-run test to get enough validation points */
  if (tryNum < VALIDATE_COUNT) {
    const testTime = getTime(timing.elapsed('test'));
    stderr(`\nMax: ${max}, finished in ${testTime}\n`);
    maxCounts.push(max);
    startCount = Math.ceil((max || 1) * DROP_RATIO);
    tryNum += 1;
    initTest();
  } else {
    const streamTime = getTime(timing.elapsed('stream'));
    stdout(`\t${medianWin(maxCounts)}\t${streamTime}\n`);
    stderr(`\n${progressTime()} ${streamIdx}/${streams.length}\n`);
    bootstrap();
  }
  return;
}

function hasFullFps(id) {
  let ratio = 1.0;

  let input = GrabberFps.get(id);
  let output = MonitorFps.get(id);
  if (!!input && !!output) {
    ratio = output / input;
    if (FPS_THRESHOLD > ratio) {
      return false;
    }
  }
  return true;
}

function* genRTSP(options) {
  let id = 0;
  while (true) {
    id += 1;
    video.setupIpCam(id, stream);
    yield id;
  }
}

function processorUsageString() {
  let median = medianWin(processorUsage); 
  let min = Math.min.apply(null, processorUsage);
  let max = Math.max.apply(null, processorUsage);
  // let arith = aMean(processorUsage).toFixed(2);
  // let geom = gMean(processorUsage).toFixed(2);
  //return `min: ${min}, max: ${max}, arithmetic: ${arith}, geometric: ${geom}, median ${median}`;
  return `${min}%…${median}%…${max}%`;
}

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
  const elapsedMs = Date.now() - globalStartTime;
  const doneStreams = streamIdx;
  const rate = elapsedMs / doneStreams;
  const estimatedMs = (streams.length - doneStreams) * rate;

  return `Elapsed time: ${getTime(elapsedMs)}, Estimated remaining time: ${getTime(estimatedMs)}`;
}
function getTime(t) {
  const hrs = toDoubleDigit(t / HOURS);
  const m = t % HOURS;
  const min = toDoubleDigit(Math.trunc(m / MINUTES));
  const s = m % MINUTES;
  const sec = toDoubleDigit(m / MINUTES);

  return `${hrs}:${min}:${sec}`;
}
function toDoubleDigit(x) {
  return `00${x.toFixed(0)}`.slice(-2);
}
function stdout(m) {
  process.stdout.write(m);
}
function stderr(m) {
  process.stderr.write(m);
}
function logError (e) {
  stderr(e)
};
