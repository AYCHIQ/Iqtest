'use strict';
const iidk = require('iq-node');
const TIMEOUT = 30000;
module.exports = {
  connect(options) {
    this.host = options.host;
    return iidk.connect(Object.assign({port: 'iidk'}, options));
  },
  restartModules() {
    iidk.sendEvent({
      type: 'SLAVE',
      id: this.host,
      action: 'RUN_SLAVES',
    })
  },
  startModule(module) {
    const startReact = {
      type: 'SLAVE',
      id: this.host,
      action: 'EXECUTE_SET',
      params: {
        command: module,
      }
    };
    const timer = setInterval(() => iidk.sendCoreReact(startReact), TIMEOUT);
    return new Promise((resolve, reject) => {
      iidk.on({type: 'SLAVE', action: 'EXECUTE_COMPLETE'}, (msg) => {
        if (msg.params.command.includes(module)) {
          clearInterval(timer);
          iidk.off({type: 'SLAVE', action: 'EXECUTE_COMPLETE'});
          resolve();
        }
      });
      iidk.sendCoreReact(startReact);
    });
  },
  stopModule(module) {
    const stopReact = {
      type: 'SLAVE',
      id: this.host,
      action: 'TERMINATE_SET',
      params: {
        command: module,
      }
    };
    const timer = setInterval(() => iidk.sendCoreReact(stopReact), TIMEOUT);
    return new Promise((resolve, reject) => {
      iidk.on({type: 'SLAVE', action: 'TERMINATE_COMPLETE'}, (msg) => {
        if (msg.params.command.includes(module)) {
          clearInterval(timer);
          iidk.off({type: 'SLAVE', action: 'TERMINATE_COMPLETE'});
          resolve();
        }
      });
      iidk.sendCoreReact(stopReact);
    });
  },
  updateObj(objtype, objid, settings) {
    let params = Object.assign(settings, {
      objtype,
      objid,
    });
    iidk.sendEvent({
      type: 'CORE',
      action: 'UPDATE_OBJECT',
      params,
    });
  },
};
