'use strict';
const fs = require('fs');
const uuid = require('uuid');
const _ = require('lodash');
const nconf = require('nconf');
const iidk = require('./iidk');
const video = require('./video');
const wsman = require('./wsman');

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

let processorUsage = [];
let maxCounts = [];
let startCount = 0;
let tryNum = 0;
let startTime = 0;
let stream = STREAM;
let timer = null;

process.on('exit', () => {
  if (stopOnExit) {
    iidk.stopModule(VIDEO);
  } 
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
  /* Connect to IIDK */
  const deferIIDK = iidk.connect({ip: IP, host: HOST, iidk: IIDK_ID});

  video.stats(STAT_INTERVAL);
  
  Promise.all([deferOSInfo, deferCPUInfo, deferIIDK])
    .then(() => {
      stdout(`OS:\t${osName}`);
      stdout(`CPU:\t${processor}`);
      stdout(`Board:\t${board}`);
      stdout(`RAM:\t${ramSize.toFixed(2)}GB`);
      stdout(`Tries:\t{VALIDATE_COUNT}`);
    })
    .then(() => bootstrap())
    .catch(logError);

})
.catch(logError);

function bootstrap() {
  processorUsage = [];
  maxCounts = [];
  startCount = 0;
  tryNum = 0;
  stream = streams.pop();
  if (stream) {
    stdout(`RTSP:\t${formatUri(stream)}`);
    initTest();
  } else {
    stderr('Done!');
    process.exit();
  }
}

function initTest () {
  startTime = Date.now();
  return iidk.stopModule(VIDEO)
    .then(() => iidk.startModule(VIDEO))
    .then(() => video.connect({ip: IP, host: HOST}))
    .then(runTest)
    .catch(logError);
}
function resetTimer () {
  clearTimeout(timer);
  timer = setTimeout(() => {
    tryNum -= 1;
    teardown('Statistics timeout');
  }, STAT_TIMEOUT);
}

function runTest() {
  tryNum += 1;
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
  const isCurrentCam = (id) => id.toString() === nextId.toString();

  function addCams(n) {
    let i = 0;
    stderr(`Adding ${n} cams`);
    for (i; i < n; i += 1) {
      nextId = gen.next().value;
    }
  }

  /* Create initial number of cameras if defined */
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
      if (fps !== 0) {
        let input = GrabberFps.get(id);
        let oldFps = MonitorFps.has(id) ?  MonitorFps.get(id) : input;
        let delta = fps - oldFps;
        let avg = oldFps + A * delta;
        let isCalm = Math.abs(delta / input) < TOLERANCE;
        MonitorFps.set(id, avg);
        if (isCalm) {
          /* Added camera has stable FPS -> iteration is complete */
          if (isCurrentCam(id) && processorUsage.length > CPU_MIN_SAMPLES) {
            const camsCount = GrabberFps.size;
            const usage = medianWin(processorUsage);
            const specificUsage = usage / camsCount;
            const n = Math.floor(Math.max(0, (CPU_THRESHOLD - usage)) / specificUsage) + 1;
            stderr(`Cams (CPU%):\t${camsCount} (${processorUsageString()})`);
            processorUsage = [];
            /* Add next batch of cameras */ 
            addCams(n);
          }
          if (!hasFullFps(id)) {
            teardown();
          }
        }
      } else if (isCurrentCam(id)) {
        monitorFails += 1;
        if (monitorFails > MAX_MONITOR_FAILS) {
          tryNum -= 1;
          teardown(`No fps received in ${monitorFails} reports`); 
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
  const max = GrabberFps.size;
  const elapsed = new Date(Date.now() - startTime).toISOString().slice(-10,-1);
  MonitorFps.clear();
  GrabberFps.clear();
  video.offstats();
  /* Re-run test to get enough validation points */
  if (tryNum < VALIDATE_COUNT) {
    if (!err) {
      stderr(`Max: ${max}, finished in ${elapsed}`);
      maxCounts.push(max);
      startCount = Math.floor(maxCounts[-1] || 0);
    } else {
      stderr(err);
    }
    initTest();
  } else {
    stdout(`Maximum: ${medianWin(maxCounts)}`);
    bootstrap();
  }
}

function hasFullFps(id) {
  let ratio = 1.0;
  let ret = true;

  let input = GrabberFps.get(id);
  let output = MonitorFps.get(id);
  if (!!input && !!output) {
    ratio = output / input;
    if (FPS_THRESHOLD > ratio) {
      ret = false;
    }
  }
  return ret;
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
  return `${min}% ${median}% ${max}%`;
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

function stdout(m) {
  process.stdout.write(`${m}\n`);
}
function stderr(m) {
  process.stderr.write(`${m}\n`);
}
function logError (e) {
  stderr(e)
  process.exit();
};
