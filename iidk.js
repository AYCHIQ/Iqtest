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
    return new Promise((resolve, reject) => {
      iidk.on({type: 'SLAVE', action: 'EXECUTE_COMPLETE'}, (msg) => {
        if (msg.params.command.includes(module)) {
          resolve();
        }
      });
      iidk.sendCoreReact({
        type: 'SLAVE',
        id: this.host,
        action: 'EXECUTE_SET',
        params: {
          command: module,
        }
      });
      setTimeout(() => reject(`${module}: start time out`), TIMEOUT);
    });
  },
  stopModule(module) {
    return new Promise((resolve, reject) => {
      iidk.on({type: 'SLAVE', action: 'TERMINATE_COMPLETE'}, (msg) => {
        if (msg.params.command.includes(module)) {
          resolve();
        }
      });
      iidk.sendCoreReact({
        type: 'SLAVE',
        id: this.host,
        action: 'TERMINATE_SET',
        params: {
          command: module,
        }
      });
      setTimeout(() => reject(`${module}: stop time out`), TIMEOUT);
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
