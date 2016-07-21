'use strict';
const blessed = require('blessed');
const contrib = require('blessed-contrib');

const screen = blessed.screen({
  smartCSR: true,
});
const exInfo = blessed.box({
  left: 0,
  top: 1,
  content: 'stream info',
  width: '50%',
  height: 4,
  scrollable: 'alwaysScroll',
  tags: true,
  style: {
    fg: 'green',
  }
});
const progressBar = blessed.ProgressBar({
  left: 0,
  top: 0,
  width: '100%',
  height: 1,
  pch: '▄',
});
const progressBox = blessed.box({
  right: 0,
  top: 1,
  content: 'progress',
  tags: true,
  width: 40,
  height: 4,
});
const attemptInfo = blessed.box({
  left: 0,
  top: 5,
  tags: true,
  width: 30,
  height: 10, 
});
const line = contrib.line({
  left: '40%+1',
  top: '15%',
  width: '60%-1',
  height: '85%',
  style: {
    line: 'yellow',
    text: 'green',
    baseline: 'black'
  },
  label: 'Cameras',
});
const logBox = blessed.Log({
  left: 0,
  top: 17,
  content: 'log',
  width: '30%',
  height: 'shrink',
  scrollable: 'alwaysScroll',
  tags: true,
});
screen.title = 'Intellect Platform Tester';
screen.append(exInfo);
screen.append(progressBar);
screen.append(progressBox);
screen.append(attemptInfo);
screen.append(line);
screen.append(logBox);
screen.render();

function logError(msg) {
  logBox.log(msg);
  screen.render();
};

function showExInfo(e) {
  if (!e) {
    exInfo.pushLine('');
    return;
  }
  const s = e.streamAttr;
  const counts = e.attempts.map(a => a.count);
  
  exInfo.popLine();
  exInfo.pushLine(`${s.vendor} ${s.format} ${s.width}x${s.height}@${s.fps}fps{|}${counts}`);
  exInfo.setScrollPerc(100);
  screen.render();
}

function showAttemptInfo(a, progressStr) {
  const allFpsOut = a.fpsOut();


  attemptInfo.setContent([
      ['fps:', a.fpsIn.toFixed(2)].join('{|}'),
      ['count:', a.count.toString()].join('{|}'),
      ['D:', a.lastDev.toFixed(3)].join('{|}'),
      ['θ:', a.options.fpsThreshold.toFixed(3)].join('{|}'),
      ['CPU:', processorUsageString(a)].join('{|}'),
  ].join('\n'));

  line.setData([{
      title: 'num',
      x: a.camHistory.map((v, i) => i),
      y: a.camHistory,
  }]);
  screen.render();
}

function showProgress(streams, streamIdx, timing) {
  const doneStreams = streamIdx - 1;
  const rate = timing.elapsed('global') / doneStreams;
  const estimatedMs = (streams.length - doneStreams) * rate;

  progressBar.setProgress((streamIdx / streams.length) * 100);
  progressBox.setContent([
    ['Elapsed time:', timing.elapsedString('global')].join('{|}'),
    ['Remaining time:', timing.getTimeString(estimatedMs)].join('{|}'),
    ['Stream:', streamIdx + '/' + streams.length].join('{|}'),
  ].join('\n'));
  screen.render();
}

/**
 * Returns a string of processor usage values
 * @param {Attempt} attempt - attempt to get usage values from
 * @returns {string} string of following format: min%…mean%…max%
 */
function processorUsageString(attempt) {
  const cpuUsage = attempt.cpu;
  const min = cpuUsage.min || 'n/a';
  const mean = cpuUsage.mean || 'n/a';
  const max = cpuUsage.max || 'n/a';

  return `${min}%…${mean}%…${max}%`;
}

module.exports = {
  logError,
  showExInfo,
  showAttemptInfo,
  showProgress,
}
