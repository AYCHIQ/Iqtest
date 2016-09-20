const nconf = require('nconf');
const wsman = require('./wsman');
const video = require('./video');
const timing = require('./timing');

/* Initialize parameters */
nconf.argv()
  nconf.argv()
  .file({file: './config.json'});

const auth = nconf.get('wsauth');
const ip = nconf.get('ip');
const WS = {
  Board: 'Win32_BaseBoard',
  OS: 'Win32_OperatingSystem',
  Computer: 'Win32_ComputerSystem',
  LocalTime: 'Win32_LocalTime',
  Processor: 'Win32_Processor',
  ProcessorPerf: 'Win32_PerfFormattedData_PerfOS_Processor',
  MemoryPerf: 'Win32_PerfFormattedData_PerfOS_Memory',
  Process: 'Win32_Process',
}

module.exports = {
  fetchCPU() {
    return wsman.enumerate({auth, ip, resource: WS.ProcessorPerf})
      .then(items => {
        const usageArr = items.filter((u) => u.Name === '_Total')
          .map((u) => (100 - u.PercentIdleTime));
        return parseFloat(usageArr[0]);
      })
  },
  fetchMem() {
    return wsman.enumerate({auth, ip, resource: WS.MemoryPerf})
      .then(memArr => {
        return parseInt(memArr[0].AvailableMBytes);
      })
  },
  fetchHostname() {
    return wsman.enumerate({auth, ip, resource: WS.Computer})
      .then(items => items[0].Name)
  },
  fetchBoardInfo() {
    return wsman.enumerate({auth, ip, resource: WS.Board})
      .then(items => `${items[0].Manufacturer} ${items[0].Product}`);
  },
  fetchOSInfo() {
    return wsman.enumerate({auth, ip, resource: WS.OS})
      .then(items => ({
        osName: items[0].Caption,
        ramSize: items[0].TotalVisibleMemorySize / Math.pow(2, 20),
      }))
  },
  fetchCPUInfo() {
    return wsman.enumerate({auth, ip, resource: WS.Processor})
      .then(items => items[0].Name)
  },
  fetchDate() {
    return wsman.enumerate({auth, ip, resource: WS.LocalTime})
      .then(items => {
        const d = items[0];
        return `${d.Year}-` +
          `${timing.toDoubleDigit(d.Month)}-` +
          `${timing.toDoubleDigit(d.Day)} ` +
          `${timing.toDoubleDigit(d.Hour)}:` +
          `${timing.toDoubleDigit(d.Minute)}:` +
          `${timing.toDoubleDigit(d.Second)}`;
      })
  },
};
